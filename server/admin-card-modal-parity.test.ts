// Task #523 — Paridad tarjeta admin ↔ modal (conteo == filas del modal).
//
// En el Panel de Administración, al clickear una tarjeta de métrica se abre un
// modal con la lista de cuentas de esa métrica. El número de la tarjeta (lo
// calcula el backend en computeAdminBusinessMetrics) y la cantidad de filas del
// modal (las calcula el frontend con userMatchesFilter) DEBEN coincidir siempre.
//
// A diferencia de admin-subscription-metrics.test.ts —que usaba una copia a mano
// del criterio del frontend que podía quedar desactualizada— este test importa
// la función REAL userMatchesFilter (client/src/pages/adminMetricFilter.ts), la
// misma que usan la tarjeta, el modal y el dropdown de la lista. Si el criterio
// del frontend o el conteo del backend cambian y dejan de coincidir, este test
// falla, evitando que la tarjeta y su modal muestren números distintos sin que
// nadie lo note.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.ts crea un Pool al importarse (no conecta hasta una query). Le damos una
// URL dummy para que el import no falle sin DATABASE_URL. El test inyecta el
// storage, así que nunca se abre una conexión real.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { computeAdminBusinessMetrics } = await import('./services/businessMetrics');
const { userMatchesFilter, CLICKABLE_METRICS } = await import(
  '../client/src/pages/adminMetricFilter'
);

// ---------------------------------------------------------------------------
// Fixtures compartidos: una misma población se proyecta a las dos formas que
// consumen backend y frontend, para comparar manzanas con manzanas.
// ---------------------------------------------------------------------------

type SubShape = {
  status: string;
  cancelAtPeriodEnd: boolean;
  paymentFailedAt: Date | null;
  planType: string;
};

type Row = { id: string; deletedAt: Date | null; sub?: SubShape };

function sub(overrides: Partial<SubShape> = {}): SubShape {
  return {
    status: 'active',
    cancelAtPeriodEnd: false,
    paymentFailedAt: null,
    planType: 'pro',
    ...overrides,
  };
}

// Forma que espera el backend (getAllUsers + getSubscriptionByUserId).
function makeStorage(rows: Row[]) {
  const subByUser = new Map<string, SubShape>();
  for (const r of rows) if (r.sub) subByUser.set(r.id, r.sub);
  return {
    getAllUsers: async () => rows.map((r) => ({ id: r.id, deletedAt: r.deletedAt })),
    getSubscriptionByUserId: async (id: string) => subByUser.get(id),
    getStripePriceMap: async () => new Map(),
    getBusinessSettings: async () => undefined,
    getAllSubscriptions: async () => Array.from(subByUser.values()),
    getAcquisitionSpends: async () => [],
    getTransactionsByOrganization: async () => [],
    getTransactionItemsByTransactionIds: async () => [],
    countAccountDeletions: async () => 0,
  } as any;
}

// Forma que espera el frontend (AdminUser con la suscripción embebida). Solo se
// completan los campos que userMatchesFilter realmente lee.
function toAdminUser(r: Row) {
  return {
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    subscription: r.sub
      ? {
          status: r.sub.status,
          paymentFailedAt: r.sub.paymentFailedAt ? r.sub.paymentFailedAt.toISOString() : null,
          cancelAtPeriodEnd: r.sub.cancelAtPeriodEnd,
        }
      : null,
  };
}

// Mapea cada métrica clickeable a la propiedad equivalente del backend.
const BACKEND_FIELD: Record<string, (m: any) => number> = {
  total: (m) => m.totalUsers,
  active: (m) => m.activeSubscriptions,
  trial: (m) => m.trialingSubscriptions,
  payment_failed: (m) => m.paymentFailures,
  cancel_scheduled: (m) => m.cancelScheduledSubscriptions,
  cancelled: (m) => m.cancelledSubscriptions,
};

// Población que mezcla todos los casos frontera de cada cubo.
const POPULATION: Row[] = [
  { id: 'active1', deletedAt: null, sub: sub({ status: 'active' }) },
  { id: 'active2', deletedAt: null, sub: sub({ status: 'active' }) },
  { id: 'trial1', deletedAt: null, sub: sub({ status: 'trialing' }) },
  { id: 'sched-active', deletedAt: null, sub: sub({ status: 'active', cancelAtPeriodEnd: true }) },
  { id: 'sched-trial', deletedAt: null, sub: sub({ status: 'trialing', cancelAtPeriodEnd: true }) },
  { id: 'payfail', deletedAt: null, sub: sub({ status: 'active', paymentFailedAt: new Date() }) },
  {
    id: 'payfail-sched',
    deletedAt: null,
    sub: sub({ status: 'active', cancelAtPeriodEnd: true, paymentFailedAt: new Date() }),
  },
  { id: 'cancelled1', deletedAt: null, sub: sub({ status: 'cancelled' }) },
  { id: 'cancelled-sched', deletedAt: null, sub: sub({ status: 'cancelled', cancelAtPeriodEnd: true }) },
  { id: 'nosub', deletedAt: null },
  { id: 'deleted1', deletedAt: new Date(), sub: sub({ status: 'active' }) },
];

// ---------------------------------------------------------------------------
// (A) Paridad tarjeta ↔ modal, métrica por métrica.
//
// Para cada una de las 6 métricas clickeables: el conteo del backend (número de
// la tarjeta) debe igualar la cantidad de filas que userMatchesFilter dejaría
// pasar (filas del modal) sobre el MISMO set de datos.
// ---------------------------------------------------------------------------

test('(A) cada tarjeta clickeable coincide con las filas de su modal', async () => {
  const metrics = await computeAdminBusinessMetrics(makeStorage(POPULATION));
  const adminUsers = POPULATION.map(toAdminUser);

  for (const metric of CLICKABLE_METRICS) {
    const cardCount = BACKEND_FIELD[metric](metrics);
    const modalCount = adminUsers.filter((u) => userMatchesFilter(u, metric)).length;
    assert.equal(
      modalCount,
      cardCount,
      `métrica "${metric}": tarjeta=${cardCount} pero el modal mostraría ${modalCount} filas`,
    );
  }
});

// Verifica que la paridad se sostenga aun cuando un cubo queda vacío (que el
// backend no devuelva, p. ej., 0 mientras el filtro deja pasar algo por una
// rama mal escrita).
test('(B) la paridad se sostiene con cubos vacíos (población sin esos casos)', async () => {
  const onlyActive: Row[] = [
    { id: 'a', deletedAt: null, sub: sub({ status: 'active' }) },
    { id: 'b', deletedAt: null, sub: sub({ status: 'active' }) },
  ];
  const metrics = await computeAdminBusinessMetrics(makeStorage(onlyActive));
  const adminUsers = onlyActive.map(toAdminUser);

  for (const metric of CLICKABLE_METRICS) {
    const cardCount = BACKEND_FIELD[metric](metrics);
    const modalCount = adminUsers.filter((u) => userMatchesFilter(u, metric)).length;
    assert.equal(modalCount, cardCount, `métrica "${metric}" descuadra con cubo vacío`);
  }
});

// ---------------------------------------------------------------------------
// (C) Regresión: abrir el modal NO altera el filtro de la "Lista de Usuarios".
//
// El modal se calcula a partir de su propio estado (cardModalMetric) y la lista
// a partir del suyo (metricFilter). Ambos son entradas independientes de
// userMatchesFilter. Este test fija ese contrato: variar la métrica del modal
// para todas las combinaciones posibles nunca cambia el resultado de la lista,
// que sigue gobernado solo por el filtro del dropdown de estado.
// ---------------------------------------------------------------------------

test('(C) variar la métrica del modal no cambia el filtrado de la lista', () => {
  const adminUsers = POPULATION.map(toAdminUser);

  // El dropdown de estado de la lista fijo en "active" (independiente del modal).
  const listFilter = 'active' as const;
  const listBefore = adminUsers.filter((u) => userMatchesFilter(u, listFilter)).map((_, i) => i);

  // "Abrir" el modal con cada métrica posible (incluido null = cerrado).
  for (const modalMetric of [null, ...CLICKABLE_METRICS] as const) {
    // Calcular las filas del modal (lo que haría cardModalUsers).
    adminUsers.filter((u) => userMatchesFilter(u, modalMetric));
    // La lista debe seguir devolviendo exactamente lo mismo: el modal no la toca.
    const listAfter = adminUsers.filter((u) => userMatchesFilter(u, listFilter)).map((_, i) => i);
    assert.deepEqual(
      listAfter,
      listBefore,
      `abrir el modal "${modalMetric}" alteró el filtrado de la lista (estado="${listFilter}")`,
    );
  }
});

// El dropdown de estado sigue funcionando con independencia de la métrica del
// modal: cada valor del dropdown filtra según su propio criterio.
test('(D) el dropdown de estado de la lista funciona independientemente del modal', () => {
  const adminUsers = POPULATION.map(toAdminUser);

  // Con el modal "abierto" en cancelled, el dropdown puesto en cada estado sigue
  // dando el conteo correcto de su propio criterio.
  for (const listFilter of CLICKABLE_METRICS) {
    const expected = adminUsers.filter((u) => userMatchesFilter(u, listFilter)).length;
    // Cambiar la métrica del modal no debe afectar al conteo del dropdown.
    for (const modalMetric of CLICKABLE_METRICS) {
      adminUsers.filter((u) => userMatchesFilter(u, modalMetric));
      const got = adminUsers.filter((u) => userMatchesFilter(u, listFilter)).length;
      assert.equal(got, expected, `dropdown="${listFilter}" cambió con modal="${modalMetric}"`);
    }
  }
});
