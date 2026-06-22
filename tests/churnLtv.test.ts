import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeChurnAndLtv,
  dedupeSubscriptionLifecycles,
  CHURN_WINDOW_MONTHS,
  CHURN_MIN_MONTHS_WITH_DATA,
  CHURN_MIN_CANCELLATIONS,
} from '../server/lib/churnLtv';
import type { Subscription } from '../shared/schema';

// Helper para construir filas de suscripción mínimas con solo los campos que
// usa el cálculo de churn/LTV.
function sub(overrides: Partial<Subscription>): Subscription {
  return {
    id: Math.random().toString(36).slice(2),
    userId: Math.random().toString(36).slice(2),
    planType: 'pro',
    status: 'active',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancellationStatus: 'active',
    cancellationRequestedAt: null,
    scheduledPlanType: null,
    scheduledChangeDate: null,
    paymentFailedAt: null,
    lastDataReminderSentAt: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  } as Subscription;
}

const NOW = new Date('2026-01-15T12:00:00Z');

describe('dedupeSubscriptionLifecycles', () => {
  it('conserva la fila más reciente por stripeSubscriptionId', () => {
    const older = sub({ stripeSubscriptionId: 'sub_1', updatedAt: new Date('2025-01-01') });
    const newer = sub({ stripeSubscriptionId: 'sub_1', updatedAt: new Date('2025-06-01') });
    const result = dedupeSubscriptionLifecycles([older, newer]);
    assert.equal(result.length, 1);
    assert.equal(result[0].updatedAt?.toISOString(), new Date('2025-06-01').toISOString());
  });

  it('preserva las filas sin stripeSubscriptionId', () => {
    const a = sub({ stripeSubscriptionId: null });
    const b = sub({ stripeSubscriptionId: null });
    const c = sub({ stripeSubscriptionId: 'sub_x' });
    const result = dedupeSubscriptionLifecycles([a, b, c]);
    assert.equal(result.length, 3);
  });
});

describe('computeChurnAndLtv', () => {
  it('marca hasEnoughData=false sin suficientes meses con datos', () => {
    const r = computeChurnAndLtv([], 1000, 10, NOW);
    assert.equal(r.hasEnoughData, false);
    assert.equal(r.ltvArs, null);
    assert.equal(r.windowMonths, CHURN_WINDOW_MONTHS);
  });

  it('marca hasEnoughData=false con cancelaciones por debajo del mínimo', () => {
    // Base estable de activas a lo largo de la ventana, pero solo 1 baja.
    const subs: Subscription[] = [];
    for (let i = 0; i < 20; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    subs.push(
      sub({
        createdAt: new Date('2024-01-01'),
        status: 'cancelled',
        currentPeriodEnd: new Date('2025-09-15'),
      }),
    );
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.ok(r.cancellationsInWindow < CHURN_MIN_CANCELLATIONS);
    assert.equal(r.hasEnoughData, false);
  });

  it('calcula churn real y LTV = ARPU / churn cuando hay datos suficientes', () => {
    // 100 activas estables + 3 bajas repartidas en 3 meses distintos.
    const subs: Subscription[] = [];
    for (let i = 0; i < 100; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'cancelled', currentPeriodEnd: new Date('2025-10-10') }));
    subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'cancelled', currentPeriodEnd: new Date('2025-11-10') }));
    subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'cancelled', currentPeriodEnd: new Date('2025-12-10') }));

    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.hasEnoughData, true);
    assert.equal(r.cancellationsInWindow, 3);
    assert.ok(r.monthlyRatePct != null && r.monthlyRatePct > 0);
    // LTV = ARPU / tasa(decimal). Coherencia interna:
    const rate = r.monthlyRatePct! / 100;
    assert.ok(Math.abs(r.ltvArs! - 1000 / rate) < 1e-6);
    assert.ok(Math.abs(r.ltvUsd! - 10 / rate) < 1e-6);
    assert.ok(Math.abs(r.avgLifetimeMonths! - 1 / rate) < 1e-6);
  });

  it('usa cancellationRequestedAt cuando falta currentPeriodEnd', () => {
    const subs: Subscription[] = [];
    for (let i = 0; i < 50; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    for (const d of ['2025-10-05', '2025-11-05', '2025-12-05']) {
      subs.push(
        sub({
          createdAt: new Date('2024-01-01'),
          status: 'cancelled',
          currentPeriodEnd: null,
          cancellationRequestedAt: new Date(d),
        }),
      );
    }
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.hasEnoughData, true);
    assert.equal(r.cancellationsInWindow, 3);
  });

  it('excluye del cálculo las bajas sin fecha imputable', () => {
    const subs: Subscription[] = [];
    for (let i = 0; i < 50; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    // Baja sin currentPeriodEnd ni cancellationRequestedAt -> se ignora.
    subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'cancelled', currentPeriodEnd: null, cancellationRequestedAt: null }));
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.cancellationsInWindow, 0);
  });

  it('reconoce cancelAtPeriodEnd con fecha futura como activa', () => {
    const subs: Subscription[] = [];
    for (let i = 0; i < 50; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    // Programada para fin de período futuro: no es baja dentro de la ventana.
    subs.push(
      sub({
        createdAt: new Date('2024-01-01'),
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date('2026-03-01'),
      }),
    );
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.cancellationsInWindow, 0);
  });

  it('acepta la grafía "canceled" de Stripe', () => {
    const subs: Subscription[] = [];
    for (let i = 0; i < 50; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    for (const d of ['2025-10-05', '2025-11-05', '2025-12-05']) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'canceled', currentPeriodEnd: new Date(d) }));
    }
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.cancellationsInWindow, 3);
    assert.equal(r.hasEnoughData, true);
  });

  it('no cuenta como base/baja a quienes se dieron de alta y baja dentro del mismo mes', () => {
    const subs: Subscription[] = [];
    for (let i = 0; i < 50; i++) {
      subs.push(sub({ createdAt: new Date('2024-01-01'), status: 'active' }));
    }
    // Alta y baja dentro de noviembre 2025: no estaba en la base al inicio.
    subs.push(sub({ createdAt: new Date('2025-11-03'), status: 'cancelled', currentPeriodEnd: new Date('2025-11-20') }));
    const r = computeChurnAndLtv(subs, 1000, 10, NOW);
    assert.equal(r.cancellationsInWindow, 0);
  });

  it('respeta los umbrales mínimos exportados', () => {
    assert.equal(CHURN_MIN_MONTHS_WITH_DATA, 2);
    assert.equal(CHURN_MIN_CANCELLATIONS, 3);
    assert.equal(CHURN_WINDOW_MONTHS, 6);
  });
});
