import * as cron from 'node-cron';
import { db } from '../db';
import { subscriptions, users, type AccountDeletionReason, type InsertAccountDeletion, type AccountDeletion } from '@shared/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { storage } from '../storage';
import { sendCancelledDataReminderEmail } from './email';

const DATA_RETENTION_DAYS = 60;
const REMINDER_DAYS = [15, 45, 55];

// Seam de testing: permite inyectar las operaciones de base de datos / storage /
// email para probar la orquestación (cálculo del motivo de baja, que un fallo
// del log NO frene el borrado, y que un fallo del borrado real NO tire abajo el
// cron) sin una Postgres ni un SendGrid reales. En producción queda null y se
// usan db/storage/email directamente.
export interface CancelledCleanupTestDeps {
  loadCancelledSubs?: () => Promise<Array<{ subscription: any; user: any }>>;
  recordAccountDeletion?: (d: InsertAccountDeletion) => Promise<AccountDeletion>;
  loadMemberships?: (userId: string) => Promise<Array<{ organization_id: string; role: string }>>;
  deleteOrgData?: (orgId: string) => Promise<void>;
  deleteMemberMembership?: (userId: string, orgId: string) => Promise<void>;
  deleteUserAndSubscription?: (userId: string) => Promise<void>;
  sendReminderEmail?: (email: string, name: string | null, daysRemaining: number) => Promise<boolean>;
  markReminderSent?: (subscriptionId: string, when: Date) => Promise<void>;
}

let __testDeps: CancelledCleanupTestDeps | null = null;

export function __setCancelledCleanupDepsForTesting(deps: CancelledCleanupTestDeps | null): void {
  __testDeps = deps;
}

// Calcula el motivo de la baja para el panel admin: una baja por falta de pago
// (hubo pago fallido o quedó en mora) se distingue de una cancelación voluntaria.
export function computeCancelledReason(subscription: { paymentFailedAt?: any; status?: string | null }): AccountDeletionReason {
  return subscription.paymentFailedAt || subscription.status === 'past_due'
    ? 'non_payment'
    : 'cancellation';
}

async function deleteUserData(
  userId: string,
  userEmail: string,
  opts?: { name?: string | null; reason?: AccountDeletionReason; subscriptionStatus?: string | null },
) {
  let allMemberships: Array<{ organization_id: string; role: string }>;
  if (__testDeps?.loadMemberships) {
    allMemberships = await __testDeps.loadMemberships(userId);
  } else {
    const membershipResult = await db.execute(sql`
      SELECT organization_id, role FROM memberships WHERE user_id = ${userId}
    `);
    allMemberships = membershipResult.rows as Array<{organization_id: string, role: string}>;
  }
  const ownedOrgIds = allMemberships.filter(m => m.role === 'owner').map(m => m.organization_id);
  const memberOnlyOrgIds = allMemberships.filter(m => m.role !== 'owner').map(m => m.organization_id);

  for (const orgId of ownedOrgIds) {
    try {
      if (__testDeps?.deleteOrgData) {
        await __testDeps.deleteOrgData(orgId);
      } else {
        await db.execute(sql`DELETE FROM transactions WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM accounts WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM clients WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM suppliers WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM products WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM assets WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM investments WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM categories WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM audit_logs WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM team_invitations WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM memberships WHERE organization_id = ${orgId}`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
      }
      console.log(`[CancelledCleanup] Deleted org ${orgId} data`);
    } catch (deleteError: any) {
      console.error(`[CancelledCleanup] Error deleting org ${orgId}:`, deleteError.message);
    }
  }

  for (const orgId of memberOnlyOrgIds) {
    if (__testDeps?.deleteMemberMembership) {
      await __testDeps.deleteMemberMembership(userId, orgId);
    } else {
      await db.execute(sql`DELETE FROM memberships WHERE user_id = ${userId} AND organization_id = ${orgId}`);
    }
  }

  if (__testDeps?.deleteUserAndSubscription) {
    await __testDeps.deleteUserAndSubscription(userId);
  } else {
    await db.execute(sql`DELETE FROM subscriptions WHERE user_id = ${userId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  }

  console.log(`[CancelledCleanup] Permanently deleted user ${userEmail} and all data`);

  // Registrar la baja SOLO después de confirmar el hard-delete de la fila de
  // users: así la métrica del panel no cuenta una baja que en realidad nunca se
  // completó. account_deletions no tiene FK a users justamente para sobrevivir a
  // este hard-delete. Si el log falla, no bloqueamos el cleanup (ya está hecho).
  try {
    if (__testDeps?.recordAccountDeletion) {
      await __testDeps.recordAccountDeletion({
        userId,
        email: userEmail,
        name: opts?.name ?? null,
        reason: opts?.reason ?? 'cancellation',
        subscriptionStatus: opts?.subscriptionStatus ?? null,
      });
    } else {
      await storage.recordAccountDeletion({
        userId,
        email: userEmail,
        name: opts?.name ?? null,
        reason: opts?.reason ?? 'cancellation',
        subscriptionStatus: opts?.subscriptionStatus ?? null,
      });
    }
  } catch (logErr: any) {
    console.error(`[CancelledCleanup] Error logging account deletion for ${userEmail}:`, logErr?.message);
  }
}

async function processCancelledAccounts() {
  console.log('[CancelledCleanup] Starting cancelled account check...');
  const now = new Date();

  try {
    const cancelledSubs = __testDeps?.loadCancelledSubs
      ? await __testDeps.loadCancelledSubs()
      : await db.select({
          subscription: subscriptions,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            deletedAt: users.deletedAt,
          }
        })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(
          and(
            eq(subscriptions.cancellationStatus, 'cancelled'),
            isNull(users.deletedAt)
          )
        );

    let remindersSent = 0;
    let accountsDeleted = 0;

    for (const { subscription, user } of cancelledSubs) {
      try {
        const expirationDate = subscription.currentPeriodEnd || subscription.updatedAt;
        const daysSinceExpiry = Math.floor(
          (now.getTime() - new Date(expirationDate).getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysSinceExpiry < 0) continue;

        if (daysSinceExpiry >= DATA_RETENTION_DAYS) {
          console.log(`[CancelledCleanup] 60-day retention expired for ${user.email} (${daysSinceExpiry} days since expiry). Deleting all data...`);
          // Distinguimos baja por falta de pago (hubo pago fallido o quedó en
          // mora) de una cancelación voluntaria, para el contador del panel.
          const reason = computeCancelledReason(subscription);
          await deleteUserData(user.id, user.email, {
            name: user.name,
            reason,
            subscriptionStatus: subscription.status,
          });
          accountsDeleted++;
          continue;
        }

        const daysRemaining = DATA_RETENTION_DAYS - daysSinceExpiry;

        const shouldSendReminder = REMINDER_DAYS.some(reminderDay => {
          const targetDaysRemaining = DATA_RETENTION_DAYS - reminderDay;
          return daysRemaining <= targetDaysRemaining && daysRemaining > targetDaysRemaining - 2;
        });

        if (!shouldSendReminder) continue;

        const lastReminderSent = subscription.lastDataReminderSentAt;
        if (lastReminderSent) {
          const daysSinceLastReminder = Math.floor(
            (now.getTime() - new Date(lastReminderSent).getTime()) / (1000 * 60 * 60 * 24)
          );
          if (daysSinceLastReminder < 5) continue;
        }

        const sent = __testDeps?.sendReminderEmail
          ? await __testDeps.sendReminderEmail(user.email, user.name, daysRemaining)
          : await sendCancelledDataReminderEmail(user.email, user.name, daysRemaining);
        if (sent) {
          if (__testDeps?.markReminderSent) {
            await __testDeps.markReminderSent(subscription.id, now);
          } else {
            await db.update(subscriptions)
              .set({ lastDataReminderSentAt: now })
              .where(eq(subscriptions.id, subscription.id));
          }
          remindersSent++;
        }
      } catch (err: any) {
        console.error(`[CancelledCleanup] Error processing user ${user.email}:`, err.message);
      }
    }

    console.log(`[CancelledCleanup] Complete. Reminders: ${remindersSent}, Deleted: ${accountsDeleted}`);
  } catch (err: any) {
    console.error('[CancelledCleanup] Error:', err.message);
  }
}

let cleanupJob: ReturnType<typeof cron.schedule> | null = null;

export function startCancelledAccountCleanup() {
  if (cleanupJob) {
    cleanupJob.stop();
  }

  cleanupJob = cron.schedule('0 4 * * *', async () => {
    console.log('[CancelledCleanup] Daily cron triggered');
    await processCancelledAccounts();
  }, {
    timezone: 'America/Argentina/Buenos_Aires'
  });

  console.log('[CancelledCleanup] Daily cleanup cron started (4:00 AM Argentina time)');
}

export { processCancelledAccounts };
