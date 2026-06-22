// Task #519 — Tests de los cubos de estado de suscripción del Panel Admin.
//
// El panel separa "Cancelará" (baja agendada) de "Activa"/"En prueba" y exige
// que (a) el número de cada tarjeta coincida exactamente con las filas que
// muestra al filtrar y (b) los cubos (activa, prueba, cancelará, canceladas,
// pago fallido) sean mutuamente excluyentes según su criterio. Esa lógica vive
// duplicada en el backend (computeAdminBusinessMetrics) y en el frontend
// (matchesMetricFilter en client/src/pages/admin.tsx). Estos tests:
//
//   (A) Fijan los casos frontera del conteo del backend con storage inyectado
//       (sin Postgres ni Stripe reales).
//   (B) Verifican, para un mismo conjunto de usuarios, que el conteo del backend
//       por estado coincide con lo que devolvería el filtro de la UI, para que
//       las dos copias no diverjan en el futuro.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.ts crea un Pool al importarse (no conecta hasta una query). Le damos una
// URL dummy para que el import no falle sin DATABASE_URL. Los tests inyectan el
// storage, así que nunca se abre una conexión real.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { computeAdminBusinessMetrics } = await import('./services/businessMetrics');

// ---------------------------------------------------------------------------
// Fixtures: usuarios + suscripciones controladas.
// ---------------------------------------------------------------------------

type TestUser = { id: string; deletedAt: Date | null };
type TestSub = {
  status: string;
  cancelAtPeriodEnd: boolean;
  paymentFailedAt: Date | null;
  planType: string;
};

// Espejo EXACTO de matchesMetricFilter (client/src/pages/admin.tsx ~802-824).
// Si el criterio del frontend cambia, hay que reflejarlo acá y el test de
// paridad (B) fallará hasta que el backend coincida, evitando divergencias.
type MetricFilter =
  | 'total'
  | 'active'
  | 'trial'
  | 'payment_failed'
  | 'cancel_scheduled'
  | 'cancelled'
  | 'no_subscription'
  | 'deleted';

function matchesMetricFilter(
  user: TestUser,
  subscription: TestSub | undefined,
  metricFilter: MetricFilter,
): boolean {
  switch (metricFilter) {
    case 'total':
      return true;
    case 'active':
      return !user.deletedAt && subscription?.status === 'active' && !subscription?.cancelAtPeriodEnd;
    case 'trial':
      return !user.deletedAt && subscription?.status === 'trialing' && !subscription?.cancelAtPeriodEnd;
    case 'payment_failed':
      return !user.deletedAt && !!subscription?.paymentFailedAt;
    case 'cancel_scheduled':
      return (
        !user.deletedAt &&
        !!subscription &&
        !subscription.paymentFailedAt &&
        !!subscription.cancelAtPeriodEnd &&
        subscription.status !== 'cancelled'
      );
    case 'cancelled':
      return !user.deletedAt && subscription?.status === 'cancelled';
    case 'no_subscription':
      return !user.deletedAt && !subscription;
    case 'deleted':
      return !!user.deletedAt;
    default:
      return true;
  }
}

// Storage mínimo inyectable: solo getAllUsers y getSubscriptionByUserId aportan
// datos; el resto devuelve vacíos/defaults para que las ramas de revenue, churn,
// CAC y deletions no exploten sin DB real.
function makeStorage(rows: Array<{ user: TestUser; sub?: TestSub }>) {
  const subByUser = new Map<string, TestSub>();
  for (const r of rows) if (r.sub) subByUser.set(r.user.id, r.sub);
  return {
    getAllUsers: async () => rows.map((r) => r.user),
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

function sub(overrides: Partial<TestSub> = {}): TestSub {
  return {
    status: 'active',
    cancelAtPeriodEnd: false,
    paymentFailedAt: null,
    planType: 'pro',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (A) Casos frontera del conteo del backend.
// ---------------------------------------------------------------------------

test('(1) active con cancelAtPeriodEnd cuenta como "cancelará", no como activa', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([{ user: { id: 'u1', deletedAt: null }, sub: sub({ status: 'active', cancelAtPeriodEnd: true }) }]),
  );
  assert.equal(m.cancelScheduledSubscriptions, 1, 'va al cubo "cancelará"');
  assert.equal(m.activeSubscriptions, 0, 'no cuenta como activa');
});

test('(2) trialing con cancelAtPeriodEnd cuenta como "cancelará", no como prueba', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([{ user: { id: 'u1', deletedAt: null }, sub: sub({ status: 'trialing', cancelAtPeriodEnd: true }) }]),
  );
  assert.equal(m.cancelScheduledSubscriptions, 1, 'va al cubo "cancelará"');
  assert.equal(m.trialingSubscriptions, 0, 'no cuenta como prueba');
});

test('(3) cancelAtPeriodEnd con paymentFailedAt NO cuenta como "cancelará"', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([
      {
        user: { id: 'u1', deletedAt: null },
        sub: sub({ status: 'active', cancelAtPeriodEnd: true, paymentFailedAt: new Date() }),
      },
    ]),
  );
  assert.equal(m.cancelScheduledSubscriptions, 0, 'el pago fallido tiene precedencia sobre "cancelará"');
  assert.equal(m.paymentFailures, 1, 'cuenta como pago fallido');
  assert.equal(m.activeSubscriptions, 0, 'sigue sin contar como activa (cancelAtPeriodEnd)');
});

test('(4) status=cancelled con cancelAtPeriodEnd NO cuenta como "cancelará"', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([
      { user: { id: 'u1', deletedAt: null }, sub: sub({ status: 'cancelled', cancelAtPeriodEnd: true }) },
    ]),
  );
  assert.equal(m.cancelScheduledSubscriptions, 0, 'una baja efectiva no es "cancelará"');
  assert.equal(m.cancelledSubscriptions, 1, 'cuenta como cancelada');
});

test('(5) active limpia cuenta como activa y no como cancelará', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([{ user: { id: 'u1', deletedAt: null }, sub: sub({ status: 'active' }) }]),
  );
  assert.equal(m.activeSubscriptions, 1);
  assert.equal(m.cancelScheduledSubscriptions, 0);
});

test('(6) usuario soft-deleted no cuenta en ningún cubo de estado', async () => {
  const m = await computeAdminBusinessMetrics(
    makeStorage([{ user: { id: 'u1', deletedAt: new Date() }, sub: sub({ status: 'active' }) }]),
  );
  assert.equal(m.activeSubscriptions, 0);
  assert.equal(m.trialingSubscriptions, 0);
  assert.equal(m.cancelScheduledSubscriptions, 0);
  assert.equal(m.cancelledSubscriptions, 0);
  assert.equal(m.paymentFailures, 0);
  assert.equal(m.totalUsers, 1, 'el total de usuarios sí lo incluye');
  assert.equal(
    m.usersWithoutSubscription,
    0,
    'un borrado no cuenta como "sin suscripción" (el filtro de la UI lo excluye)',
  );
});

// ---------------------------------------------------------------------------
// (B) Paridad backend ↔ filtro de la UI sobre un MISMO conjunto de usuarios.
//
// Población que mezcla todos los casos frontera. Para cada estado, el conteo
// del backend debe igualar la cantidad de filas que matchesMetricFilter dejaría
// pasar. Si una de las dos copias cambia el criterio, este test falla.
// ---------------------------------------------------------------------------

test('(7) el conteo del backend coincide con el filtro de la UI para cada estado', async () => {
  const rows: Array<{ user: TestUser; sub?: TestSub }> = [
    { user: { id: 'active1', deletedAt: null }, sub: sub({ status: 'active' }) },
    { user: { id: 'active2', deletedAt: null }, sub: sub({ status: 'active' }) },
    { user: { id: 'trial1', deletedAt: null }, sub: sub({ status: 'trialing' }) },
    { user: { id: 'sched-active', deletedAt: null }, sub: sub({ status: 'active', cancelAtPeriodEnd: true }) },
    { user: { id: 'sched-trial', deletedAt: null }, sub: sub({ status: 'trialing', cancelAtPeriodEnd: true }) },
    {
      user: { id: 'payfail', deletedAt: null },
      sub: sub({ status: 'active', paymentFailedAt: new Date() }),
    },
    {
      user: { id: 'payfail-sched', deletedAt: null },
      sub: sub({ status: 'active', cancelAtPeriodEnd: true, paymentFailedAt: new Date() }),
    },
    { user: { id: 'cancelled1', deletedAt: null }, sub: sub({ status: 'cancelled' }) },
    {
      user: { id: 'cancelled-sched', deletedAt: null },
      sub: sub({ status: 'cancelled', cancelAtPeriodEnd: true }),
    },
    { user: { id: 'nosub', deletedAt: null } },
    { user: { id: 'deleted1', deletedAt: new Date() }, sub: sub({ status: 'active' }) },
  ];

  const m = await computeAdminBusinessMetrics(makeStorage(rows));

  const countFilter = (f: MetricFilter) =>
    rows.filter((r) => matchesMetricFilter(r.user, r.sub, f)).length;

  assert.equal(m.activeSubscriptions, countFilter('active'), 'activa: tarjeta == filtro');
  assert.equal(m.trialingSubscriptions, countFilter('trial'), 'prueba: tarjeta == filtro');
  assert.equal(m.cancelScheduledSubscriptions, countFilter('cancel_scheduled'), 'cancelará: tarjeta == filtro');
  assert.equal(m.paymentFailures, countFilter('payment_failed'), 'pago fallido: tarjeta == filtro');
  assert.equal(m.cancelledSubscriptions, countFilter('cancelled'), 'canceladas: tarjeta == filtro');
  assert.equal(m.usersWithoutSubscription, countFilter('no_subscription'), 'sin suscripción: tarjeta == filtro');
  assert.equal(m.totalUsers, countFilter('total'), 'total: tarjeta == filtro');
});

// ---------------------------------------------------------------------------
// (C) Exclusión mutua de los cuatro cubos de estado primario: activa, prueba,
//     cancelará y cancelada. Ninguna suscripción (no borrada) puede caer en más
//     de uno. "Pago fallido" queda fuera a propósito: es un flag ortogonal que
//     puede coexistir con "activa" (una sub vigente con un cobro rechazado),
//     tanto en el backend como en el filtro de la UI. Se prueba cada
//     combinación de (status × cancelAtPeriodEnd × paymentFailedAt) aislada.
// ---------------------------------------------------------------------------

test('(8) los cuatro cubos de estado primario son mutuamente excluyentes', async () => {
  const statuses = ['active', 'trialing', 'cancelled', 'past_due'];
  for (const status of statuses) {
    for (const cancelAtPeriodEnd of [false, true]) {
      for (const failed of [false, true]) {
        const m = await computeAdminBusinessMetrics(
          makeStorage([
            {
              user: { id: 'u1', deletedAt: null },
              sub: sub({ status, cancelAtPeriodEnd, paymentFailedAt: failed ? new Date() : null }),
            },
          ]),
        );
        const buckets =
          m.activeSubscriptions +
          m.trialingSubscriptions +
          m.cancelScheduledSubscriptions +
          m.cancelledSubscriptions;
        assert.ok(
          buckets <= 1,
          `combinación status=${status} cancelAtPeriodEnd=${cancelAtPeriodEnd} failed=${failed} cae en ${buckets} cubos primarios (debe ser <=1)`,
        );
      }
    }
  }
});
