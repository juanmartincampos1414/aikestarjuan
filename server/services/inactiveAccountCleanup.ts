import * as cron from 'node-cron';
import { db } from '../db';
import { users, memberships, organizations, type InsertAccountDeletion, type AccountDeletion } from '@shared/schema';
import { eq, isNull, isNotNull, sql, and, lt, ne } from 'drizzle-orm';
import { storage } from '../storage';
import { sendInactiveAccountReminderEmail } from './email';

const REMINDER_DAYS = 7;
const DELETION_DAYS = 30;

let cleanupJob: ReturnType<typeof cron.schedule> | null = null;

// Seam de testing: inyecta las operaciones de DB / storage / email para probar
// que la baja por inactividad se registra con reason 'inactivity' y que un fallo
// del log NO frena el soft-delete ni tira abajo el cron. En producción queda
// null y se usan db/storage/email directamente.
export interface InactiveCleanupTestDeps {
  loadActiveUsers?: () => Promise<any[]>;
  getSubscriptionByUserId?: (userId: string) => Promise<any>;
  userHasActiveMembership?: (userId: string) => Promise<boolean>;
  recordAccountDeletion?: (d: InsertAccountDeletion) => Promise<AccountDeletion>;
  softDeleteUser?: (userId: string, when: Date) => Promise<void>;
  sendReminderEmail?: (email: string, name: string | null, daysRemaining: number) => Promise<boolean>;
  markReminderSent?: (userId: string, when: Date) => Promise<void>;
}

let __testDeps: InactiveCleanupTestDeps | null = null;

export function __setInactiveCleanupDepsForTesting(deps: InactiveCleanupTestDeps | null): void {
  __testDeps = deps;
}

// Seam para poder probar `userHasActiveMembership` sin una Postgres ni el
// `storage` reales. En producción se usa `defaultMembershipCheckDeps`, que
// conserva exactamente la lógica original (mismas queries a `memberships` y
// `storage.getSubscriptionByUserId`).
export interface MembershipCheckDeps {
  // Devuelve las membresías del usuario (org + rol).
  loadUserMemberships: (userId: string) => Promise<Array<{ organizationId: string; role: string }>>;
  // Devuelve el userId del owner de la org, o null si no hay.
  loadOrgOwnerUserId: (organizationId: string) => Promise<string | null>;
  // Devuelve la suscripción del owner (o null si no tiene).
  getSubscriptionByUserId: (userId: string) => Promise<any>;
}

const defaultMembershipCheckDeps: MembershipCheckDeps = {
  loadUserMemberships: (userId) =>
    db.select({
      organizationId: memberships.organizationId,
      role: memberships.role,
    }).from(memberships).where(eq(memberships.userId, userId)),
  loadOrgOwnerUserId: async (organizationId) => {
    const ownerMembership = await db.select({ userId: memberships.userId })
      .from(memberships)
      .where(and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, 'owner')
      ))
      .limit(1);
    return ownerMembership.length > 0 ? ownerMembership[0].userId : null;
  },
  getSubscriptionByUserId: (userId) => storage.getSubscriptionByUserId(userId),
};

export async function userHasActiveMembership(
  userId: string,
  deps: MembershipCheckDeps = defaultMembershipCheckDeps,
): Promise<boolean> {
  const userMemberships = await deps.loadUserMemberships(userId);

  for (const m of userMemberships) {
    if (m.role === 'owner') continue;
    const ownerUserId = await deps.loadOrgOwnerUserId(m.organizationId);
    if (ownerUserId) {
      const ownerSub = await deps.getSubscriptionByUserId(ownerUserId);
      if (ownerSub) return true;
    }
  }
  return false;
}

async function processInactiveAccounts() {
  console.log('[InactiveCleanup] Starting inactive account check...');
  const now = new Date();

  try {
    const allUsers = __testDeps?.loadActiveUsers
      ? await __testDeps.loadActiveUsers()
      : await db.select().from(users).where(
          and(
            isNull(users.deletedAt),
            isNotNull(users.createdAt)
          )
        );

    let remindersSent = 0;
    let accountsDeleted = 0;

    for (const user of allUsers) {
      if (user.isAdmin) continue;

      try {
        const subscription = __testDeps?.getSubscriptionByUserId
          ? await __testDeps.getSubscriptionByUserId(user.id)
          : await storage.getSubscriptionByUserId(user.id);
        if (subscription) continue;

        const hasMembership = __testDeps?.userHasActiveMembership
          ? await __testDeps.userHasActiveMembership(user.id)
          : await userHasActiveMembership(user.id);
        if (hasMembership) continue;

        const daysSinceRegistration = Math.floor(
          (now.getTime() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysSinceRegistration >= DELETION_DAYS) {
          console.log(`[InactiveCleanup] Soft-deleting inactive account: ${user.email} (${daysSinceRegistration} days old)`);
          if (__testDeps?.softDeleteUser) {
            await __testDeps.softDeleteUser(user.id, now);
          } else {
            await db.update(users)
              .set({ deletedAt: now })
              .where(eq(users.id, user.id));
          }
          accountsDeleted++;
          // Registramos la baja SOLO después de confirmar el soft-delete, para
          // que la métrica del panel no cuente una baja que falló a mitad de
          // camino. Usamos la misma tabla de log que las bajas por cancelación
          // para tener un único lugar de bajas automáticas. No bloqueante: si el
          // log falla, la baja ya quedó aplicada igual.
          try {
            if (__testDeps?.recordAccountDeletion) {
              await __testDeps.recordAccountDeletion({
                userId: user.id,
                email: user.email,
                name: user.name,
                reason: 'inactivity',
                subscriptionStatus: null,
              });
            } else {
              await storage.recordAccountDeletion({
                userId: user.id,
                email: user.email,
                name: user.name,
                reason: 'inactivity',
                subscriptionStatus: null,
              });
            }
          } catch (logErr: any) {
            console.error(`[InactiveCleanup] Error logging account deletion for ${user.email}:`, logErr?.message);
          }
        } else if (daysSinceRegistration >= REMINDER_DAYS && !user.inactiveReminderSentAt) {
          const daysRemaining = DELETION_DAYS - daysSinceRegistration;
          const sent = __testDeps?.sendReminderEmail
            ? await __testDeps.sendReminderEmail(user.email, user.name, daysRemaining)
            : await sendInactiveAccountReminderEmail(user.email, user.name, daysRemaining);
          if (sent) {
            if (__testDeps?.markReminderSent) {
              await __testDeps.markReminderSent(user.id, now);
            } else {
              await db.update(users)
                .set({ inactiveReminderSentAt: now })
                .where(eq(users.id, user.id));
            }
            remindersSent++;
          }
        }
      } catch (err: any) {
        console.error(`[InactiveCleanup] Error processing user ${user.email}:`, err.message);
      }
    }

    console.log(`[InactiveCleanup] Complete. Reminders sent: ${remindersSent}, Accounts deleted: ${accountsDeleted}`);
  } catch (err: any) {
    console.error('[InactiveCleanup] Error:', err.message);
  }
}

export function startInactiveAccountCleanup() {
  if (cleanupJob) {
    cleanupJob.stop();
  }

  cleanupJob = cron.schedule('0 3 * * *', async () => {
    console.log('[InactiveCleanup] Daily cron triggered');
    await processInactiveAccounts();
  }, {
    timezone: 'America/Argentina/Buenos_Aires'
  });

  console.log('[InactiveCleanup] Daily cleanup cron started (3:00 AM Argentina time)');
}

export { processInactiveAccounts };
