import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveAcquisitionSpendByMonth,
  buildItemCodesByTx,
  type AcquisitionDerivationConfig,
} from '../server/lib/acquisitionSpend';
import type { Transaction } from '../shared/schema';

// Helper para construir una transacción mínima con solo los campos que usa la
// derivación del gasto de adquisición.
function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'expense',
    status: 'completed',
    amount: '1000',
    currency: 'ARS',
    date: new Date('2026-05-10T15:00:00Z'),
    accountId: null,
    category: null,
    profitabilityCodeId: null,
    ...overrides,
  } as Transaction;
}

const config = (overrides: Partial<AcquisitionDerivationConfig>): AcquisitionDerivationConfig => ({
  enabled: true,
  orgId: 'org-1',
  accountIds: [],
  categories: [],
  profitabilityCodeIds: [],
  ...overrides,
});

describe('deriveAcquisitionSpendByMonth — match por código de rentabilidad (#477)', () => {
  it('matchea por el campo legacy de la transacción (single-product, sin cambios)', () => {
    const txs = [tx({ id: 't1', profitabilityCodeId: 'code-ads', amount: '5000' })];
    const result = deriveAcquisitionSpendByMonth(txs, config({ profitabilityCodeIds: ['code-ads'] }), 1);
    assert.equal(result.get('2026-05'), 5000);
  });

  it('matchea por código de renglón cuando el campo legacy está en null (multi-producto)', () => {
    const txs = [tx({ id: 't1', profitabilityCodeId: null, amount: '7000' })];
    const items = [
      { transactionId: 't1', profitabilityCodeId: 'code-otro' },
      { transactionId: 't1', profitabilityCodeId: 'code-ads' },
    ];
    const itemCodesByTx = buildItemCodesByTx(items);
    const result = deriveAcquisitionSpendByMonth(
      txs,
      config({ profitabilityCodeIds: ['code-ads'] }),
      1,
      itemCodesByTx,
    );
    assert.equal(result.get('2026-05'), 7000);
  });

  it('no matchea si ni el campo legacy ni los renglones tienen el código', () => {
    const txs = [tx({ id: 't1', profitabilityCodeId: null, amount: '7000' })];
    const itemCodesByTx = buildItemCodesByTx([
      { transactionId: 't1', profitabilityCodeId: 'code-otro' },
    ]);
    const result = deriveAcquisitionSpendByMonth(
      txs,
      config({ profitabilityCodeIds: ['code-ads'] }),
      1,
      itemCodesByTx,
    );
    assert.equal(result.size, 0);
  });

  it('cuenta el gasto una sola vez aunque varios renglones matcheen', () => {
    const txs = [tx({ id: 't1', profitabilityCodeId: null, amount: '4000' })];
    const itemCodesByTx = buildItemCodesByTx([
      { transactionId: 't1', profitabilityCodeId: 'code-ads' },
      { transactionId: 't1', profitabilityCodeId: 'code-ads' },
    ]);
    const result = deriveAcquisitionSpendByMonth(
      txs,
      config({ profitabilityCodeIds: ['code-ads'] }),
      1,
      itemCodesByTx,
    );
    assert.equal(result.get('2026-05'), 4000);
  });

  it('buildItemCodesByTx descarta los códigos nulos', () => {
    const map = buildItemCodesByTx([
      { transactionId: 't1', profitabilityCodeId: null },
      { transactionId: 't1', profitabilityCodeId: 'c1' },
      { transactionId: 't2', profitabilityCodeId: null },
    ]);
    assert.deepEqual(map.get('t1'), ['c1']);
    assert.equal(map.has('t2'), false);
  });
});
