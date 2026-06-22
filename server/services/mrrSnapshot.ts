import * as cron from 'node-cron';
import { storage } from "../storage";
import { computeAdminBusinessMetrics } from "./businessMetrics";
import { LOCALE } from "@shared/constants";
import type { MrrSnapshot } from "@shared/schema";

let cronJob: ReturnType<typeof cron.schedule> | null = null;

// Mes calendario en hora Argentina ('YYYY-MM'). Coherente con getArgentinaToday:
// no se puede derivar de toISOString() (UTC), porque entre las ~21:00 y la
// medianoche argentina ya cayó al mes siguiente en UTC los últimos días del mes.
function getArgentinaMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LOCALE.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(new Date()); // 'YYYY-MM'
}

// Calcula el MRR actual y lo guarda como snapshot del mes en curso (upsert).
export async function captureMrrSnapshot(): Promise<MrrSnapshot> {
  const metrics = await computeAdminBusinessMetrics();
  const snapshot = await storage.upsertMrrSnapshot({
    snapshotMonth: getArgentinaMonth(),
    mrrArs: metrics.revenue.mrrArs,
    mrrUsd: metrics.revenue.mrrUsd,
    activeSubscriptions: metrics.revenue.activeCount,
    usdArsRate: metrics.revenue.usdArsRate,
  });
  return snapshot;
}

export function startMrrSnapshotCron(): void {
  if (cronJob) {
    console.log('[MrrSnapshotCron] Cron job already running');
    return;
  }

  // Corre todos los días a las 3:00 AM (hora Argentina) y hace upsert del mes en
  // curso: así el valor del mes actual se mantiene fresco y, al cambiar de mes,
  // queda registrado el último valor observado del mes anterior. Una sola fila
  // por mes (UNIQUE en snapshot_month).
  const options = { timezone: LOCALE.TIMEZONE };
  cronJob = cron.schedule('0 3 * * *', async () => {
    try {
      const snapshot = await captureMrrSnapshot();
      console.log(`[MrrSnapshotCron] Snapshot ${snapshot.snapshotMonth}: MRR ARS ${snapshot.mrrArs.toFixed(2)}, ${snapshot.activeSubscriptions} subs activas`);
    } catch (error) {
      console.error('[MrrSnapshotCron] Error capturing MRR snapshot:', error);
    }
  }, options as any);

  console.log('[MrrSnapshotCron] Daily MRR snapshot cron started (3:00 AM Argentina time)');

  // Captura inicial al boot para que el gráfico tenga al menos el mes en curso
  // sin esperar al primer disparo del cron. No bloquea el arranque.
  captureMrrSnapshot()
    .then((s) => console.log(`[MrrSnapshotCron] Initial snapshot ${s.snapshotMonth} captured`))
    .catch((err) => console.error('[MrrSnapshotCron] Initial snapshot error:', err?.message || err));
}

export function stopMrrSnapshotCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[MrrSnapshotCron] Cron job stopped');
  }
}
