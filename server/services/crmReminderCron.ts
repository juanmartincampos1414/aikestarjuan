// =============================================================================
// AIKESTAR - Recordatorios del CRM (seguimientos vencidos)
// =============================================================================
// Cron diario: por cada organización con seguimientos vencidos, crea una
// notificación in-app para el propietario. Corre una vez al día (sin duplicar).
// =============================================================================
import * as cron from 'node-cron';
import { storage } from '../storage';
import { getOverdueFollowups } from './crmService';

let job: ReturnType<typeof cron.schedule> | null = null;

async function runOnce(): Promise<void> {
  let orgs: any[] = [];
  try { orgs = await storage.getAllOrganizations(); } catch { return; }
  for (const org of orgs) {
    try {
      const overdue = await getOverdueFollowups(org.id);
      if (overdue.length === 0) continue;
      const owner = await storage.getOrganizationOwner(org.id);
      if (!owner) continue;
      await storage.createNotification({
        userId: owner.id,
        organizationId: org.id,
        type: 'crm_followup_overdue',
        priority: 'warning',
        title: 'Seguimientos pendientes en el CRM',
        message: `Tenés ${overdue.length} oportunidad${overdue.length > 1 ? 'es' : ''} con seguimiento vencido. Revisalas en el CRM.`,
        source: 'auto',
      } as any);
    } catch (e: any) {
      console.error('[CrmReminder] org', org?.id, e?.message || e);
    }
  }
}

export function startCrmReminderCron(): void {
  if (job) return;
  // Todos los días a las 9:00 (hora Argentina).
  job = cron.schedule('0 9 * * *', () => {
    runOnce().catch((e) => console.error('[CrmReminder] error:', e?.message || e));
  }, { timezone: 'America/Argentina/Buenos_Aires' });
  console.log('[CrmReminder] cron de recordatorios CRM iniciado (9:00 AR)');
}

export { runOnce as runCrmRemindersOnce };
