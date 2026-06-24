// Test de remitos (lógica pura de numeración). Import dinámico para no tocar la base.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

test('formatRemitoNumber: secuencia 0001-00000001 incremental con padding', async () => {
  const { formatRemitoNumber } = await import('./services/remitoService');
  assert.equal(formatRemitoNumber(0), '0001-00000001');
  assert.equal(formatRemitoNumber(9), '0001-00000010');
  assert.equal(formatRemitoNumber(123), '0001-00000124');
});
