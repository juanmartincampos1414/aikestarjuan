import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

describe('GET /api/whatsapp/bot-info', () => {
  it('responds 200 without any auth headers or cookies', async () => {
    const res = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /json/);
  });

  it('returns the four contract fields with non-empty values', async () => {
    const res = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    const body = await res.json();
    assert.ok(typeof body.e164 === 'string' && body.e164.startsWith('+'),
      `e164 must be E.164 string, got: ${JSON.stringify(body.e164)}`);
    assert.ok(typeof body.waMe === 'string' && /^\d+$/.test(body.waMe),
      `waMe must be digits-only, got: ${JSON.stringify(body.waMe)}`);
    assert.ok(typeof body.display === 'string' && body.display.length > 0,
      `display must be non-empty, got: ${JSON.stringify(body.display)}`);
    assert.ok(typeof body.defaultGreeting === 'string' && body.defaultGreeting.length > 0,
      `defaultGreeting must be non-empty, got: ${JSON.stringify(body.defaultGreeting)}`);
  });

  it('e164 and waMe represent the same number (digits-only equivalence)', async () => {
    const res = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    const body = await res.json();
    const e164Digits = String(body.e164).replace(/[^\d]/g, '');
    assert.equal(body.waMe, e164Digits,
      `waMe (${body.waMe}) must equal e164 digits (${e164Digits})`);
  });

  it('never surfaces the Twilio sandbox number to clients', async () => {
    const res = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    const body = await res.json();
    assert.notEqual(body.waMe, '14155238886', 'sandbox leaked to client');
  });
});
