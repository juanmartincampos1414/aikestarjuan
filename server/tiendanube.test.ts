// Tests de la integración Tiendanube. Corren sin Postgres real:
// - Cifrado de tokens (round-trip + tamper).
// - Verificación HMAC de webhooks (válido / inválido / ausente).
// - Parsing de pedidos (gateway, cliente, pagado) — import dinámico para no
//   tocar la base (DATABASE_URL se setea lazy; el Pool no conecta sin query).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptToken, decryptToken, isTiendanubeCryptoConfigured } from './lib/tiendanubeCrypto';
import { verifyWebhookHmac } from './lib/tiendanube';

// Config para los tests
process.env.TIENDANUBE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.TIENDANUBE_CLIENT_SECRET = 'super-secret-test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

test('crypto: encrypt/decrypt round-trip del token', () => {
  assert.equal(isTiendanubeCryptoConfigured(), true);
  const token = 'abc123-token-de-tiendanube';
  const enc = encryptToken(token);
  assert.notEqual(enc, token);
  assert.equal(decryptToken(enc), token);
});

test('crypto: un payload manipulado no descifra', () => {
  const enc = encryptToken('hola');
  const tampered = enc.slice(0, -4) + (enc.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.throws(() => decryptToken(tampered));
});

test('webhook HMAC: firma correcta verifica', () => {
  const body = JSON.stringify({ store_id: '1', event: 'order/paid', id: 99 });
  const sig = crypto.createHmac('sha256', 'super-secret-test').update(body).digest('hex');
  assert.equal(verifyWebhookHmac(body, sig), true);
});

test('webhook HMAC: firma incorrecta o ausente falla', () => {
  const body = JSON.stringify({ x: 1 });
  assert.equal(verifyWebhookHmac(body, 'deadbeef'), false);
  assert.equal(verifyWebhookHmac(body, undefined), false);
  // body manipulado con la firma del original
  const sig = crypto.createHmac('sha256', 'super-secret-test').update(body).digest('hex');
  assert.equal(verifyWebhookHmac(body + ' ', sig), false);
});

test('parsing de pedidos: gateway, cliente y estado de pago', async () => {
  const { extractGateway, extractCustomer, isPaid } = await import('./services/tiendanubeSync');

  assert.equal(extractGateway({ gateway: 'mercadopago' }), 'mercadopago');
  assert.equal(extractGateway({ payment_details: { method: 'transfer' } }), 'transfer');
  assert.equal(extractGateway({}), 'desconocido');

  const c = extractCustomer({ customer: { id: 7, name: 'Ana', email: 'ana@x.com', identification: '20-1' } });
  assert.equal(c?.id, '7');
  assert.equal(c?.email, 'ana@x.com');
  assert.equal(c?.taxId, '20-1');
  assert.equal(extractCustomer({}), null);

  assert.equal(isPaid({ payment_status: 'paid' }), true);
  assert.equal(isPaid({ paid_at: '2026-06-01T00:00:00Z' }), true);
  assert.equal(isPaid({ payment_status: 'pending' }), false);
});
