import * as cron from 'node-cron';
import { generateDailyNotificationsForAllUsers } from './commitmentNotifications';

let cronJob: ReturnType<typeof cron.schedule> | null = null;

export function startNotificationCron(): void {
  if (cronJob) {
    console.log('[NotificationCron] Cron job already running');
    return;
  }

  const options = { timezone: 'America/Argentina/Buenos_Aires' };
  cronJob = cron.schedule('0 8 * * *', async () => {
    console.log('[NotificationCron] Starting daily notification generation...');
    const startTime = Date.now();
    
    try {
      const result = await generateDailyNotificationsForAllUsers();
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[NotificationCron] Completed in ${duration}s - Processed ${result.usersProcessed} users, created ${result.notificationsCreated} notifications`);
    } catch (error) {
      console.error('[NotificationCron] Error generating notifications:', error);
    }
  }, options as any);

  console.log('[NotificationCron] Daily notification cron started (8:00 AM Argentina time, timezone: America/Argentina/Buenos_Aires)');
}

export function stopNotificationCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[NotificationCron] Cron job stopped');
  }
}

export async function runNotificationCronNow(): Promise<{ usersProcessed: number; notificationsCreated: number }> {
  console.log('[NotificationCron] Manual trigger - generating notifications...');
  const result = await generateDailyNotificationsForAllUsers();
  console.log(`[NotificationCron] Manual trigger complete - Processed ${result.usersProcessed} users, created ${result.notificationsCreated} notifications`);
  return result;
}
