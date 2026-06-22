// Task #526 — Navegación del modal de métricas del Panel Admin.
//
// Al clickear una tarjeta de métrica se abre un modal con varios estados:
// maximizar/restaurar, abrir el detalle de un usuario, "Volver" a la lista y
// cerrar. La paridad de CONTEOS ya está cubierta por
// admin-card-modal-parity.test.ts; lo que faltaba era cubrir las TRANSICIONES
// de UI, para evitar regresiones como:
//   - que "Volver" pierda la métrica (y mande al panel de tarjetas),
//   - que cerrar no resetee el estado (fuga: reabrir queda maximizado o con un
//     usuario seleccionado de la sesión anterior),
//   - que el detalle no exponga los campos esperados,
//   - que entrar/salir del detalle cambie el conteo del modal.
//
// Este test importa el REDUCER REAL (client/src/pages/adminMetricModalState.ts)
// —el mismo que usa admin.tsx vía useReducer— y la función REAL
// userMatchesFilter, así nunca testea una copia que se desactualice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// db.ts crea un Pool al importarse; URL dummy para que el import no falle.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { metricModalReducer, closedMetricModalState } = await import(
  '../client/src/pages/adminMetricModalState'
);
const { userMatchesFilter } = await import('../client/src/pages/adminMetricFilter');

// ---------------------------------------------------------------------------
// Fixtures: un par de usuarios "activos" con TODOS los campos que el panel de
// detalle del modal lee, para poder verificar que el detalle dispone de ellos.
// ---------------------------------------------------------------------------

type ModalUser = {
  id: string;
  email: string;
  name: string;
  accountType: string;
  isAdmin: boolean;
  createdAt: string;
  deletedAt: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscription: {
    id: string;
    planType: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    paymentFailedAt: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
};

function activeUser(id: string, name: string): ModalUser {
  return {
    id,
    email: `${id}@example.com`,
    name,
    accountType: 'empresa',
    isAdmin: false,
    createdAt: '2026-01-10T12:00:00.000Z',
    deletedAt: null,
    phoneNumber: '+5491122334455',
    phoneVerified: true,
    stripeCustomerId: `cus_${id}`,
    stripeSubscriptionId: `sub_${id}`,
    subscription: {
      id: `s_${id}`,
      planType: 'pro',
      status: 'active',
      currentPeriodStart: '2026-06-01T00:00:00.000Z',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      paymentFailedAt: null,
      cancelAtPeriodEnd: false,
    },
  };
}

const USERS: ModalUser[] = [
  activeUser('u1', 'Ana Gómez'),
  activeUser('u2', 'Bruno Díaz'),
];

// Campos que el panel de detalle del modal (admin.tsx, rama selectedModalUser)
// lee del usuario seleccionado. El test exige que el usuario clickeado los
// exponga, así "ver detalle con sus campos" no se rompe en silencio.
const DETAIL_FIELDS: Array<keyof ModalUser> = [
  'name',
  'email',
  'accountType',
  'createdAt',
  'phoneNumber',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'subscription',
];

// ---------------------------------------------------------------------------
// (A) Recorrido completo de la navegación del modal.
//
// abrir tarjeta -> lista -> maximizar/restaurar -> click en fila -> detalle con
// sus campos -> "Volver" conservando la métrica -> cerrar y reabrir limpio.
// ---------------------------------------------------------------------------

test('(A) recorrido completo: abrir, maximizar, detalle, volver, cerrar, reabrir', () => {
  // Estado inicial = modal cerrado.
  let state = closedMetricModalState<ModalUser>();
  assert.equal(state.metric, null, 'arranca cerrado');
  assert.equal(state.maximized, false);
  assert.equal(state.selectedUser, null);

  // 1) Abrir la tarjeta "active": se ve la lista (sin usuario), tamaño normal.
  state = metricModalReducer(state, { type: 'open', metric: 'active' });
  assert.equal(state.metric, 'active', 'abre con la métrica clickeada');
  assert.equal(state.selectedUser, null, 'abre en la lista, no en un detalle');
  assert.equal(state.maximized, false, 'abre en tamaño normal');

  // 2) Maximizar y restaurar.
  state = metricModalReducer(state, { type: 'toggleMaximize' });
  assert.equal(state.maximized, true, 'maximiza');
  assert.equal(state.metric, 'active', 'maximizar no toca la métrica');
  state = metricModalReducer(state, { type: 'toggleMaximize' });
  assert.equal(state.maximized, false, 'restaura el tamaño');

  // 3) Click en una fila -> abre el detalle de ESE usuario.
  const clicked = USERS[1];
  state = metricModalReducer(state, { type: 'selectUser', user: clicked });
  assert.equal(state.selectedUser, clicked, 'el detalle es del usuario clickeado');
  assert.equal(state.metric, 'active', 'entrar al detalle conserva la métrica');

  // 4) El detalle dispone de todos los campos que renderiza el panel.
  for (const field of DETAIL_FIELDS) {
    assert.ok(
      state.selectedUser![field] !== undefined,
      `el detalle necesita el campo "${String(field)}" y no está presente`,
    );
  }
  assert.equal(state.selectedUser!.name, 'Bruno Díaz');
  assert.equal(state.selectedUser!.subscription?.status, 'active');

  // 5) "Volver" cierra el detalle pero CONSERVA la métrica (no va al panel).
  state = metricModalReducer(state, { type: 'back' });
  assert.equal(state.selectedUser, null, '"Volver" cierra el detalle');
  assert.equal(state.metric, 'active', '"Volver" NO pierde la métrica');

  // 6) Cerrar -> reabrir: el estado quedó limpio (sin fuga entre sesiones).
  state = metricModalReducer(state, { type: 'close' });
  assert.equal(state.metric, null, 'cerrar resetea la métrica');
  assert.equal(state.maximized, false, 'cerrar resetea el tamaño');
  assert.equal(state.selectedUser, null, 'cerrar resetea el usuario');
});

// ---------------------------------------------------------------------------
// (B) Reabrir tras maximizar + entrar al detalle arranca SIEMPRE limpio.
//
// Regresión clave: si cerrar (o abrir) no reseteara, la siguiente apertura
// heredaría el maximizado o el usuario de la sesión anterior.
// ---------------------------------------------------------------------------

test('(B) reabrir tras maximizar y abrir detalle no arrastra estado', () => {
  let state = closedMetricModalState<ModalUser>();
  state = metricModalReducer(state, { type: 'open', metric: 'trial' });
  state = metricModalReducer(state, { type: 'toggleMaximize' }); // maximizado
  state = metricModalReducer(state, { type: 'selectUser', user: USERS[0] }); // en detalle
  assert.equal(state.maximized, true);
  assert.equal(state.selectedUser, USERS[0]);

  // Cerrar y abrir OTRA tarjeta.
  state = metricModalReducer(state, { type: 'close' });
  state = metricModalReducer(state, { type: 'open', metric: 'cancelled' });
  assert.equal(state.metric, 'cancelled', 'abre la nueva métrica');
  assert.equal(state.maximized, false, 'no hereda el maximizado anterior');
  assert.equal(state.selectedUser, null, 'no hereda el usuario anterior');
});

// ---------------------------------------------------------------------------
// (C) El conteo del modal (lista derivada de la métrica) no cambia al entrar y
// salir del detalle. La lista se calcula con userMatchesFilter sobre la
// métrica; abrir/cerrar un detalle solo toca selectedUser, nunca la métrica.
// ---------------------------------------------------------------------------

test('(C) entrar y salir del detalle no altera el conteo del modal', () => {
  // Población mixta para que la métrica filtre de verdad.
  const population: ModalUser[] = [
    ...USERS, // 2 activos
    { ...activeUser('t1', 'Trial Uno'), subscription: { ...activeUser('t1', '').subscription!, status: 'trialing' } },
  ];

  // Conteo de la lista derivado SOLO de la métrica del modal (como cardModalUsers).
  const countFor = (state: { metric: any }) =>
    population.filter((u) => userMatchesFilter(u as any, state.metric)).length;

  let state = closedMetricModalState<ModalUser>();
  state = metricModalReducer(state, { type: 'open', metric: 'active' });
  const countOnOpen = countFor(state);
  assert.equal(countOnOpen, 2, 'dos usuarios activos en la lista');

  // Entrar al detalle de una fila.
  state = metricModalReducer(state, { type: 'selectUser', user: USERS[0] });
  assert.equal(countFor(state), countOnOpen, 'entrar al detalle no cambia el conteo');

  // "Volver" a la lista.
  state = metricModalReducer(state, { type: 'back' });
  assert.equal(countFor(state), countOnOpen, 'volver del detalle no cambia el conteo');
});
