// Criterio ÚNICO de pertenencia a cada cubo de métrica del Panel de Administración.
//
// Vive en su propio módulo (sin dependencias de React) para que TRES consumidores
// usen exactamente la misma definición y nunca diverjan:
//   1. El filtro de la "Lista de Usuarios" (dropdown de estado) en admin.tsx.
//   2. El modal que se abre al clickear una tarjeta de métrica (cardModalUsers).
//   3. Los tests de paridad que comparan estos conteos contra el backend
//      (server/services/businessMetrics.ts) sobre el mismo set de datos.
//
// Si se cambia un criterio acá, cambia en los tres lugares a la vez, y el test
// de paridad falla hasta que el backend coincida — evitando que la tarjeta y su
// modal muestren números distintos sin que nadie lo note.

export type MetricFilter =
  | 'total'
  | 'active'
  | 'trial'
  | 'payment_failed'
  | 'cancel_scheduled'
  | 'cancelled'
  | 'no_subscription'
  | 'deleted'
  | null;

// Subconjunto estructural de AdminUser que necesita el criterio de filtrado.
// AdminUser (admin.tsx) es asignable a este tipo, así que se puede pasar tal
// cual; los tests construyen objetos mínimos con solo estos campos.
export interface MetricFilterUser {
  deletedAt: string | null;
  subscription: {
    status: string;
    paymentFailedAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
}

// Las 6 métricas clickeables que abren un modal con la lista de cuentas.
// 'no_subscription' y 'deleted' existen como filtros de la lista pero no tienen
// tarjeta clickeable propia, por eso quedan fuera de este arreglo.
export const CLICKABLE_METRICS: Array<Exclude<MetricFilter, null>> = [
  'total',
  'active',
  'trial',
  'payment_failed',
  'cancel_scheduled',
  'cancelled',
];

// Título de la ventana modal que se abre al clickear cada tarjeta de métrica.
export const METRIC_MODAL_LABELS: Record<Exclude<MetricFilter, null>, string> = {
  total: 'Total Usuarios',
  active: 'Suscripciones Activas',
  trial: 'En Prueba',
  payment_failed: 'Pagos Fallidos',
  cancel_scheduled: 'Cancelarán (baja agendada)',
  cancelled: 'Cancelaciones',
  no_subscription: 'Sin suscripción',
  deleted: 'Eliminadas',
};

export function userMatchesFilter(user: MetricFilterUser, filter: MetricFilter): boolean {
  if (!filter) return true;
  switch (filter) {
    case 'total':
      return true;
    case 'active':
      return !user.deletedAt && user.subscription?.status === 'active' && !user.subscription?.cancelAtPeriodEnd;
    case 'trial':
      return !user.deletedAt && user.subscription?.status === 'trialing' && !user.subscription?.cancelAtPeriodEnd;
    case 'payment_failed':
      return !user.deletedAt && !!user.subscription?.paymentFailedAt;
    case 'cancel_scheduled':
      return !user.deletedAt && !!user.subscription && !user.subscription.paymentFailedAt && !!user.subscription.cancelAtPeriodEnd && user.subscription.status !== 'cancelled';
    case 'cancelled':
      return !user.deletedAt && user.subscription?.status === 'cancelled';
    case 'no_subscription':
      return !user.deletedAt && !user.subscription;
    case 'deleted':
      return !!user.deletedAt;
    default:
      return true;
  }
}
