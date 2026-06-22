import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveStockLines, type StockLine } from './transactionStock';

// Task #475: deriveStockLines is the single source of truth that normalizes a
// transaction into stock lines for both single- and multi-product flows. These
// tests lock the precedence (items win over legacy) and the single-product
// regression behavior used by create/approve/edit/cancel/delete stock paths.

const item = (productId: string, quantity: string, profitabilityCodeId: string | null = null) => ({
  id: `item-${productId}`,
  transactionId: 'tx-1',
  organizationId: 'org-1',
  productId,
  description: null,
  quantity,
  unitPrice: '10',
  profitabilityCodeId,
  createdAt: new Date(),
} as any);

test('multi-product: derives one line per item, items win over legacy', () => {
  const tx = { productId: 'legacy-prod', productQuantity: '99', profitabilityCodeId: 'legacy-code' };
  const items = [item('p1', '2', 'c1'), item('p2', '5', 'c2')];
  const lines = deriveStockLines(tx, items);
  assert.deepEqual(lines, [
    { productId: 'p1', quantity: 2, profitabilityCodeId: 'c1' },
    { productId: 'p2', quantity: 5, profitabilityCodeId: 'c2' },
  ] satisfies StockLine[]);
});

test('multi-product: skips items without a product or with invalid quantity', () => {
  const items = [item('p1', '3'), item('', '4'), item('p3', '0'), item('p4', '')];
  const lines = deriveStockLines({}, items);
  assert.deepEqual(lines, [{ productId: 'p1', quantity: 3, profitabilityCodeId: null }]);
});

test('single-product regression: legacy fields produce one line', () => {
  const tx = { productId: 'p1', productQuantity: '7', profitabilityCodeId: 'c1' };
  const lines = deriveStockLines(tx, []);
  assert.deepEqual(lines, [{ productId: 'p1', quantity: 7, profitabilityCodeId: 'c1' }]);
});

test('single-product: invalid legacy quantity yields no lines', () => {
  assert.deepEqual(deriveStockLines({ productId: 'p1', productQuantity: '0' }), []);
  assert.deepEqual(deriveStockLines({ productId: 'p1', productQuantity: null }), []);
});

test('zero-product: no productId yields no lines', () => {
  assert.deepEqual(deriveStockLines({}), []);
  assert.deepEqual(deriveStockLines({ productId: null, productQuantity: '5' }), []);
});

test('net change reconciliation: edit deltas computed from old vs new lines', () => {
  // Simulates the edit reconciliation: reverse old effective lines, apply new.
  const oldLines = deriveStockLines({}, [item('p1', '2'), item('p2', '5')]);
  const newLines = deriveStockLines({}, [item('p1', '3'), item('p2', '1'), item('p3', '4')]);
  const net = new Map<string, number>();
  for (const l of oldLines) net.set(l.productId, (net.get(l.productId) || 0) + l.quantity); // reversed (added back)
  for (const l of newLines) net.set(l.productId, (net.get(l.productId) || 0) - l.quantity); // applied (subtracted)
  // For a sale: net stock delta = reversed(old) - applied(new)
  assert.equal(net.get('p1'), 2 - 3); // -1
  assert.equal(net.get('p2'), 5 - 1); // +4
  assert.equal(net.get('p3'), 0 - 4); // -4
});
