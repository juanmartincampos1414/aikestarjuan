import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Task #297 — El heartbeat del indicador "escribiendo..." debe re-enviarse
// cada ~20s mientras el handler procesa, y apagarse al llamar stop(). Esto
// evita que el indicador de WhatsApp se apague a los ~25s en flujos largos
// (foto de ticket con visión IA, audio, etc.) y el usuario piense que el
// bot dejó de responder.

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ('AC' + 'a'.repeat(32));
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-auth-token';
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886';

let typingCalls = 0;
const originalFetch = globalThis.fetch;
const stubFetch: typeof fetch = async (input, _init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input instanceof Request
      ? input.url
      : '';
  if (url.includes('messaging.twilio.com')) {
    typingCalls += 1;
    return new Response('{}', { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

const { startTypingHeartbeat } = await import('../server/routes/whatsapp');

describe('Task #297 — heartbeat del typing indicator', () => {
  beforeEach(() => {
    typingCalls = 0;
    // Aislamos el stub de fetch por test para no leakear globalmente
    // si el runner cambia a modo shared-process.
    globalThis.fetch = stubFetch;
    mock.timers.enable({ apis: ['setInterval'] });
  });
  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
  });

  it('manda el primer tick de inmediato y vuelve a mandar cada ~20s hasta stop()', async () => {
    const hb = startTypingHeartbeat('SM-test-heartbeat');
    // El primer fetch se dispara sincrónicamente cuando se llama
    // sendTypingIndicator (antes del primer await). Damos una vuelta del
    // event loop por las dudas.
    await new Promise((r) => setImmediate(r));
    assert.equal(typingCalls, 1, 'esperaba el indicador inicial');

    // Avanzamos 20s → un tick más.
    mock.timers.tick(20_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(typingCalls, 2, 'esperaba un tick a los 20s');

    // Avanzamos otros 20s → otro tick.
    mock.timers.tick(20_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(typingCalls, 3, 'esperaba otro tick a los 40s');

    // Apagamos: ya no debe dispararse más.
    hb.stop();
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(typingCalls, 3, 'no debe seguir disparando tras stop()');
  });

  it('stop() es idempotente: llamarlo varias veces no rompe nada', () => {
    const hb = startTypingHeartbeat('SM-test-idempotent');
    hb.stop();
    hb.stop();
    hb.stop();
    // Sin assert explícito: si stop() tirara error el test fallaría.
  });

  it('sin messageSid es no-op (no dispara fetch, devuelve stop seguro)', () => {
    const hb1 = startTypingHeartbeat(null);
    const hb2 = startTypingHeartbeat(undefined);
    const hb3 = startTypingHeartbeat('');
    assert.equal(typingCalls, 0, 'sin SID no debe haber requests al endpoint de typing');
    hb1.stop();
    hb2.stop();
    hb3.stop();
  });
});
