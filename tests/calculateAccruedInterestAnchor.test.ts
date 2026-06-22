import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { calculateAccruedInterest } from '../client/src/lib/utils';

// Task #261 — unit tests for the client-side helper that drives every
// "yield since last reset" number on the dashboard, reports cards, asset
// valuation and weekly digest. The contract:
//   (a) if interestStartDate is set, the helper uses THAT anchor (this is
//       what makes the rendimiento restart from 0 when the user adjusts
//       the balance of an investment account — Task #259).
//   (b) if interestStartDate is NULL (legacy account, never adjusted),
//       it falls back to createdAt — preserves the pre-Task-259 behaviour
//       for accounts that were created before the column existed.
//   (c) operative accounts (no rate / no capital) return 0 regardless of
//       how old they are.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

describe('Task #261 — calculateAccruedInterest anchor precedence', () => {
  it('uses interestStartDate when it is set (post-reset anchor wins over createdAt)', () => {
    // Account opened 60 days ago, but the user adjusted its balance 1
    // minute ago — yield must be ~0 because the anchor moved to NOW.
    const now = Date.now();
    const accrued = calculateAccruedInterest({
      initialInvestment: '100000',
      interestRate: '5',
      interestFrequency: 'monthly',
      interestStartDate: new Date(now - 60 * 1000),     // 1 minute ago
      createdAt: new Date(now - SIXTY_DAYS_MS),          // 60 days ago
    });
    assert.ok(accrued < 1, `expected ~0 accrued, got ${accrued}`);
  });

  it('falls back to createdAt when interestStartDate is null (legacy accounts)', () => {
    // Plant a 30-day-old account WITHOUT interestStartDate (old account
    // from before migration 0019 ever ran on this user's data).
    const accrued = calculateAccruedInterest({
      initialInvestment: '100000',
      interestRate: '5',
      interestFrequency: 'monthly',
      interestStartDate: null,
      createdAt: new Date(Date.now() - THIRTY_DAYS_MS),
    });
    // ≈ 100000 * 0.05 * 1 month = 5000, with monthly-by-calendar-month
    // rounding. We allow a generous tolerance so the test is stable across
    // month boundaries.
    assert.ok(accrued > 4000 && accrued < 6000,
      `expected ~5000 fallback yield from createdAt, got ${accrued}`);
  });

  it('falls back to createdAt when interestStartDate is undefined (older client payloads)', () => {
    const accrued = calculateAccruedInterest({
      initialInvestment: '100000',
      interestRate: '5',
      interestFrequency: 'monthly',
      // interestStartDate omitted entirely
      createdAt: new Date(Date.now() - THIRTY_DAYS_MS),
    });
    assert.ok(accrued > 4000 && accrued < 6000,
      `expected ~5000 fallback yield from createdAt, got ${accrued}`);
  });

  it('returns 0 for operative accounts (no interestRate)', () => {
    const accrued = calculateAccruedInterest({
      initialInvestment: '100000',
      interestRate: null,
      interestFrequency: null,
      interestStartDate: null,
      createdAt: new Date(Date.now() - SIXTY_DAYS_MS),
    });
    assert.equal(accrued, 0);
  });

  it('returns 0 when interestRate is "0" string (rate-free account)', () => {
    const accrued = calculateAccruedInterest({
      initialInvestment: '100000',
      interestRate: '0',
      interestFrequency: 'monthly',
      interestStartDate: new Date(Date.now() - SIXTY_DAYS_MS),
      createdAt: new Date(Date.now() - SIXTY_DAYS_MS),
    });
    assert.equal(accrued, 0);
  });

  it('returns 0 when initialInvestment is missing (capital-less account)', () => {
    const accrued = calculateAccruedInterest({
      initialInvestment: null,
      interestRate: '5',
      interestFrequency: 'monthly',
      interestStartDate: new Date(Date.now() - SIXTY_DAYS_MS),
      createdAt: new Date(Date.now() - SIXTY_DAYS_MS),
    });
    assert.equal(accrued, 0);
  });
});
