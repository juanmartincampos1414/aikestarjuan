import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeRealCac } from '../server/lib/cac';
import type { AcquisitionSpend, Subscription } from '../shared/schema';

// Helper para construir filas de gasto de adquisición mínimas.
function spend(month: string, amountArs: number): AcquisitionSpend {
  return {
    month,
    amountArs,
    updatedAt: new Date('2026-01-01'),
    updatedBy: null,
  } as AcquisitionSpend;
}

// Helper para construir filas de suscripción mínimas con solo los campos que
// usa el cálculo del CAC (createdAt, stripeSubscriptionId, updatedAt).
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

describe('computeRealCac', () => {
  it('calcula el CAC blended sobre los meses con gasto', () => {
    const spends = [spend('2026-01', 100000), spend('2026-02', 50000)];
    // 2 altas en enero, 1 en febrero -> 3 altas, gasto total 150000.
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: new Date('2026-01-20T00:00:00Z') }),
      sub({ createdAt: new Date('2026-02-05T00:00:00Z') }),
    ];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.hasEnoughData, true);
    assert.equal(r.totalSpendArs, 150000);
    assert.equal(r.totalSignups, 3);
    assert.equal(r.monthsWithSpend, 2);
    assert.equal(r.cacArs, 50000);
    assert.equal(r.cacUsd, 50);
  });

  it('incluye en el numerador meses con gasto pero sin altas (no infla el CAC)', () => {
    // Febrero tiene gasto pero ninguna alta: su costo suma al total igual.
    const spends = [spend('2026-01', 100000), spend('2026-02', 100000)];
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: new Date('2026-01-20T00:00:00Z') }),
    ];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.totalSpendArs, 200000);
    assert.equal(r.totalSignups, 2);
    assert.equal(r.cacArs, 100000);
  });

  it('excluye las altas de meses sin gasto registrado', () => {
    const spends = [spend('2026-01', 100000)];
    // Una alta en enero (con gasto) y una en marzo (sin gasto): solo cuenta enero.
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: new Date('2026-03-10T00:00:00Z') }),
    ];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.totalSignups, 1);
    assert.equal(r.cacArs, 100000);
  });

  it('deduplica altas con el mismo stripeSubscriptionId', () => {
    const spends = [spend('2026-01', 90000)];
    // Dos filas duplicadas del webhook para la misma suscripción + una distinta.
    const subs = [
      sub({ stripeSubscriptionId: 'sub_1', createdAt: new Date('2026-01-05T00:00:00Z'), updatedAt: new Date('2026-01-05') }),
      sub({ stripeSubscriptionId: 'sub_1', createdAt: new Date('2026-01-05T00:00:00Z'), updatedAt: new Date('2026-01-08') }),
      sub({ stripeSubscriptionId: 'sub_2', createdAt: new Date('2026-01-15T00:00:00Z') }),
    ];
    const r = computeRealCac(spends, subs, 1000);
    // 2 altas reales (sub_1 dedupeada), no 3.
    assert.equal(r.totalSignups, 2);
    assert.equal(r.cacArs, 45000);
  });

  it('cuenta el mes del alta en UTC, no en la zona horaria local', () => {
    const spends = [spend('2026-02', 60000)];
    // 2026-01-31T23:30 en Argentina (UTC-3) es 2026-02-01T02:30 UTC -> febrero.
    const subs = [sub({ createdAt: new Date('2026-02-01T02:30:00Z') })];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.totalSignups, 1);
    assert.equal(r.cacArs, 60000);
  });

  it('devuelve vacío y hasEnoughData=false sin gasto cargado', () => {
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: new Date('2026-01-20T00:00:00Z') }),
    ];
    const r = computeRealCac([], subs, 1000);
    assert.equal(r.hasEnoughData, false);
    assert.equal(r.cacArs, null);
    assert.equal(r.cacUsd, null);
    assert.equal(r.totalSpendArs, 0);
    assert.equal(r.totalSignups, 0);
    assert.equal(r.monthsWithSpend, 0);
  });

  it('ignora filas de gasto con monto cero o no positivo', () => {
    const spends = [spend('2026-01', 0), spend('2026-02', -500)];
    const subs = [sub({ createdAt: new Date('2026-01-10T00:00:00Z') })];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.hasEnoughData, false);
    assert.equal(r.monthsWithSpend, 0);
    assert.equal(r.totalSpendArs, 0);
  });

  it('reporta el gasto pero hasEnoughData=false cuando hay gasto sin altas', () => {
    const spends = [spend('2026-01', 100000)];
    // Altas en un mes sin gasto -> no cuentan.
    const subs = [sub({ createdAt: new Date('2026-05-10T00:00:00Z') })];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.hasEnoughData, false);
    assert.equal(r.cacArs, null);
    assert.equal(r.cacUsd, null);
    assert.equal(r.totalSpendArs, 100000);
    assert.equal(r.monthsWithSpend, 1);
    assert.equal(r.totalSignups, 0);
  });

  it('cacUsd = 0 cuando usdArsRate es 0 (evita división por cero)', () => {
    const spends = [spend('2026-01', 100000)];
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: new Date('2026-01-20T00:00:00Z') }),
    ];
    const r = computeRealCac(spends, subs, 0);
    assert.equal(r.hasEnoughData, true);
    assert.equal(r.cacArs, 50000);
    assert.equal(r.cacUsd, 0);
  });

  it('ignora altas sin createdAt', () => {
    const spends = [spend('2026-01', 80000)];
    const subs = [
      sub({ createdAt: new Date('2026-01-10T00:00:00Z') }),
      sub({ createdAt: null }),
    ];
    const r = computeRealCac(spends, subs, 1000);
    assert.equal(r.totalSignups, 1);
    assert.equal(r.cacArs, 80000);
  });
});
