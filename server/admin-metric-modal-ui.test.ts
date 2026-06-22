// Test de UI/navegación REAL del modal de métricas del Panel de Administración.
//
// A diferencia de admin-metric-modal-nav.test.ts (que ejercita solo el reducer),
// este test MONTA el componente real `MetricUsersModal` en un DOM (jsdom),
// dentro de un harness que reproduce exactamente cómo lo usa admin.tsx:
// `useReducer(metricModalReducer, ...)` + el filtrado real `userMatchesFilter`.
// Luego dispara clicks reales sobre los `data-testid` que ve el usuario y
// verifica las transiciones del DOM:
//
//   abrir tarjeta → lista → maximizar/restaurar → click en fila → detalle con
//   sus campos → "Volver" (conservando la métrica) → cerrar + reabrir (estado
//   limpio: ni maximizado ni con usuario).
//
// También fija la paridad de conteo: la cantidad que muestra el modal debe
// seguir siendo igual a la de la tarjeta después de entrar y salir del detalle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupJsdom } from './testJsdomEnv';

// Instalar el DOM ANTES de cargar React DOM y el componente.
const { window } = setupJsdom();

const React = (await import('react')).default;
const { useReducer } = React;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MetricUsersModal } = await import('../client/src/pages/MetricUsersModal');
const { metricModalReducer, closedMetricModalState } = await import(
  '../client/src/pages/adminMetricModalState'
);
const { userMatchesFilter, METRIC_MODAL_LABELS } = await import(
  '../client/src/pages/adminMetricFilter'
);

// Dataset fijo: distintos estados para que los filtros separen las cuentas.
function makeUser(over: Partial<any>): any {
  return {
    id: over.id!,
    email: over.email ?? `${over.id}@example.com`,
    name: over.name ?? `User ${over.id}`,
    accountType: over.accountType ?? 'personal',
    isAdmin: over.isAdmin ?? false,
    createdAt: over.createdAt ?? '2026-01-15T10:00:00.000Z',
    deletedAt: over.deletedAt ?? null,
    phoneNumber: over.phoneNumber ?? null,
    phoneVerified: over.phoneVerified ?? null,
    stripeCustomerId: over.stripeCustomerId ?? null,
    stripeSubscriptionId: over.stripeSubscriptionId ?? null,
    subscription:
      over.subscription === undefined
        ? {
            planType: 'solo',
            status: 'active',
            currentPeriodStart: '2026-06-01T00:00:00.000Z',
            currentPeriodEnd: '2026-07-01T00:00:00.000Z',
            paymentFailedAt: null,
            cancelAtPeriodEnd: false,
          }
        : over.subscription,
  };
}

const USERS: any[] = [
  makeUser({
    id: 'u1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    isAdmin: true,
    accountType: 'business',
    phoneNumber: '5491122334455',
    phoneVerified: true,
    stripeCustomerId: 'cus_AAA',
    stripeSubscriptionId: 'sub_AAA',
  }),
  makeUser({ id: 'u2', name: 'Alan Turing', email: 'alan@example.com' }),
  makeUser({
    id: 'u3',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    subscription: {
      planType: 'team',
      status: 'active',
      currentPeriodStart: '2026-06-01T00:00:00.000Z',
      currentPeriodEnd: '2026-07-01T00:00:00.000Z',
      paymentFailedAt: '2026-06-10T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    },
  }),
];

// Harness que replica el uso de admin.tsx: reducer real + filtrado real.
// Expone botones "tarjeta" para abrir cada métrica clickeable.
function Harness() {
  const [state, dispatch] = useReducer(
    metricModalReducer as typeof metricModalReducer<any>,
    undefined as unknown as ReturnType<typeof closedMetricModalState<any>>,
    () => closedMetricModalState<any>(),
  );
  const users = USERS.filter((u) => userMatchesFilter(u, state.metric));
  return React.createElement(
    'div',
    null,
    React.createElement(
      'button',
      {
        'data-testid': 'card-metric-total',
        onClick: () => dispatch({ type: 'open', metric: 'total' }),
      },
      'Total',
    ),
    React.createElement(MetricUsersModal as any, {
      metric: state.metric,
      maximized: state.maximized,
      selectedUser: state.selectedUser,
      users,
      dispatch,
      renderPlanBadge: (plan: string | undefined) =>
        plan
          ? React.createElement('span', { 'data-testid': `badge-plan-${plan}` }, plan)
          : null,
      renderStatusBadge: (u: any) =>
        React.createElement(
          'span',
          { 'data-testid': `badge-status-${u.id}` },
          u.subscription?.status ?? 'none',
        ),
      formatPhoneDisplay: (phone: string | null | undefined) =>
        phone ? `+${phone}` : '',
    }),
  );
}

// --- helpers de interacción sobre el DOM real ---
function q(testid: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
}
function mustGet(testid: string): HTMLElement {
  const el = q(testid);
  assert.ok(el, `se esperaba encontrar [data-testid="${testid}"] en el DOM`);
  return el!;
}
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

test('modal de métricas: apertura, maximizar, detalle, volver y reapertura limpia', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Harness));
  });

  // Estado inicial: modal cerrado, no hay diálogo.
  assert.equal(q('dialog-metric-users'), null, 'el modal arranca cerrado');

  // 1) Abrir la tarjeta "Total" → aparece la lista.
  await click(mustGet('card-metric-total'));
  mustGet('dialog-metric-users');
  assert.equal(
    mustGet('text-metric-modal-title').textContent,
    METRIC_MODAL_LABELS.total,
    'el título del modal corresponde a la métrica abierta',
  );
  const cardCount = USERS.filter((u) => userMatchesFilter(u, 'total')).length;
  assert.equal(
    mustGet('text-metric-modal-count').textContent,
    `${cardCount} ${cardCount === 1 ? 'cuenta' : 'cuentas'}`,
    'el conteo del modal coincide con la tarjeta',
  );
  // Hay una fila por usuario.
  for (const u of USERS) {
    mustGet(`row-metric-modal-user-${u.id}`);
  }

  // 2) Maximizar y restaurar.
  const maxBtn = mustGet('button-metric-modal-maximize');
  assert.equal(
    maxBtn.getAttribute('aria-label'),
    'Maximizar',
    'arranca en tamaño normal (botón ofrece Maximizar)',
  );
  assert.ok(
    mustGet('dialog-metric-users').className.includes('max-w-2xl'),
    'tamaño normal aplica max-w-2xl',
  );
  await click(maxBtn);
  assert.equal(
    mustGet('button-metric-modal-maximize').getAttribute('aria-label'),
    'Restaurar tamaño',
    'tras maximizar, el botón ofrece Restaurar',
  );
  assert.ok(
    mustGet('dialog-metric-users').className.includes('w-[95vw]'),
    'maximizado aplica w-[95vw]',
  );
  await click(mustGet('button-metric-modal-maximize'));
  assert.equal(
    mustGet('button-metric-modal-maximize').getAttribute('aria-label'),
    'Maximizar',
    'restaurado vuelve a tamaño normal',
  );

  // 3) Click en una fila → detalle con sus campos.
  await click(mustGet('row-metric-modal-user-u1'));
  assert.equal(q('text-metric-modal-title'), null, 'al entrar al detalle se oculta la lista');
  assert.equal(mustGet('text-user-detail-name').textContent, 'Ada Lovelace');
  assert.equal(mustGet('text-user-detail-email').textContent, 'ada@example.com');
  assert.equal(mustGet('text-user-detail-phone').textContent?.includes('+5491122334455'), true);
  assert.equal(mustGet('text-user-detail-account-type').textContent, 'business');
  assert.equal(mustGet('text-user-detail-sub-status').textContent, 'active');
  assert.equal(mustGet('text-user-detail-stripe-customer').textContent, 'cus_AAA');
  assert.equal(mustGet('text-user-detail-stripe-subscription').textContent, 'sub_AAA');
  mustGet('text-user-detail-created');
  mustGet('text-user-detail-period');
  mustGet('badge-user-detail-admin'); // u1 es admin

  // 4) "Volver" conserva la métrica → vuelve a la lista de la misma tarjeta.
  await click(mustGet('button-metric-modal-back'));
  assert.equal(q('text-user-detail-name'), null, 'el detalle se cerró');
  assert.equal(
    mustGet('text-metric-modal-title').textContent,
    METRIC_MODAL_LABELS.total,
    '"Volver" conserva la métrica (mismo título)',
  );
  // Paridad de conteo: sigue igual a la tarjeta tras entrar/salir del detalle.
  assert.equal(
    mustGet('text-metric-modal-count').textContent,
    `${cardCount} ${cardCount === 1 ? 'cuenta' : 'cuentas'}`,
    'el conteo del modal sigue igual al de la tarjeta tras entrar y salir del detalle',
  );

  // 5) Cerrar (botón X de shadcn) y reabrir → estado limpio.
  // Primero maximizar y abrir un detalle para verificar que NO se filtran al reabrir.
  await click(mustGet('button-metric-modal-maximize'));
  await click(mustGet('row-metric-modal-user-u2'));
  mustGet('text-user-detail-name');
  const closeBtn = Array.from(
    mustGet('dialog-metric-users').querySelectorAll('button'),
  ).find((b) => (b.textContent || '').includes('Close'));
  assert.ok(closeBtn, 'el modal tiene botón de cierre (X de shadcn)');
  await click(closeBtn!);
  assert.equal(q('dialog-metric-users'), null, 'el modal se cerró');

  // Reabrir: debe arrancar limpio (lista, no detalle; tamaño normal).
  await click(mustGet('card-metric-total'));
  mustGet('dialog-metric-users');
  assert.equal(q('text-user-detail-name'), null, 'reabre en la lista, sin detalle residual');
  mustGet('text-metric-modal-title');
  assert.equal(
    mustGet('button-metric-modal-maximize').getAttribute('aria-label'),
    'Maximizar',
    'reabre en tamaño normal, sin maximizado residual',
  );

  await act(async () => {
    root.unmount();
  });
});
