import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Task #290 — `extractTicketFromImage` baja una imagen de Twilio (con
// Basic auth) y la manda a GPT-4o vision para sacar monto, descripción,
// categoría sugerida y proveedor del comprobante. Antes el bot quedaba
// mudo cuando recibía una foto suelta; el contrato nuevo es:
//   - vision devuelve JSON válido → ExtractedTicket
//   - vision dice "no es un comprobante" (isReceipt: false) → null
//   - JSON inválido / sin monto → null
//   - falla de descarga de Twilio → null
//
// Antes de cargar el módulo seteamos credenciales y reemplazamos el
// fetch global para interceptar las dos llamadas externas (Twilio y
// OpenAI). El SDK de OpenAI usa fetch global internamente.

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ('AC' + 'a'.repeat(32));
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-auth-token';
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || 'test-openai-key';

const TWILIO_MEDIA_URL = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest';

interface FetchCall {
  url: string;
  init: any;
}
const fetchCalls: FetchCall[] = [];
let nextTwilioStatus = 200;
let nextOpenAIContent: string | null = '';

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input?.url;
  fetchCalls.push({ url: String(url), init });

  if (typeof url === 'string' && url.includes('api.twilio.com')) {
    if (nextTwilioStatus !== 200) {
      return new Response('not found', { status: nextTwilioStatus });
    }
    // Devolvemos un buffer "lo suficientemente grande" (> 500 bytes) para
    // que el extractor lo considere imagen válida.
    const fakeImage = Buffer.alloc(2048, 0x41);
    return new Response(fakeImage, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }

  if (typeof url === 'string' && (url.includes('openai') || url.includes('chat/completions'))) {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ message: { content: nextOpenAIContent } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return originalFetch(input, init);
}) as typeof fetch;

const { extractTicketFromImage } = await import('../server/routes/whatsapp');

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fetchCalls.length = 0;
  nextTwilioStatus = 200;
  nextOpenAIContent = null;
});

describe('extractTicketFromImage — Task #290', () => {
  it('parsea un comprobante válido y devuelve datos normalizados', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 12345.67,
      currency: 'ARS',
      description: 'Compra en supermercado',
      supplierName: 'Coto S.A.',
      suggestedCategory: 'Supermercado',
      date: '2026-05-18',
    });

    const result = await extractTicketFromImage(TWILIO_MEDIA_URL, 'image/jpeg');

    assert.ok(result, 'esperaba un ExtractedTicket no nulo');
    assert.equal(result!.isReceipt, true);
    assert.equal(result!.type, 'expense');
    assert.equal(result!.amount, 12345.67);
    assert.equal(result!.currency, 'ARS');
    assert.equal(result!.description, 'Compra en supermercado');
    assert.equal(result!.supplierName, 'Coto S.A.');
    assert.equal(result!.suggestedCategory, 'Supermercado');
    assert.equal(result!.date, '2026-05-18');

    // Verificamos que pasó por Twilio con Basic auth.
    const twilioCall = fetchCalls.find(c => c.url.includes('api.twilio.com'));
    assert.ok(twilioCall, 'esperaba llamada a Twilio');
    const authHeader = twilioCall!.init?.headers?.Authorization || twilioCall!.init?.headers?.authorization;
    assert.ok(authHeader && String(authHeader).startsWith('Basic '), 'esperaba Basic auth en Twilio');
  });

  it('tolera respuesta envuelta en markdown ```json``` (defensa en profundidad)', async () => {
    nextOpenAIContent = '```json\n' + JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 5000,
      currency: 'ARS',
      description: 'Almuerzo',
      supplierName: null,
      suggestedCategory: 'Restaurante',
      date: null,
    }) + '\n```';

    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.amount, 5000);
    assert.equal(result!.suggestedCategory, 'Restaurante');
  });

  it('devuelve null cuando el modelo dice que no es un comprobante (isReceipt: false)', async () => {
    nextOpenAIContent = JSON.stringify({ isReceipt: false });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.equal(result, null);
  });

  it('devuelve null cuando el JSON es inválido', async () => {
    nextOpenAIContent = 'esto no es JSON válido';
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.equal(result, null);
  });

  it('devuelve null cuando el monto extraído no es positivo', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 0,
      currency: 'ARS',
      description: 'no-op',
      suggestedCategory: 'Otro',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.equal(result, null);
  });

  it('default currency = ARS si el modelo manda algo raro', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 100,
      currency: 'XYZ',
      description: 'algo',
      suggestedCategory: 'Varios',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.currency, 'ARS');
  });

  it('respeta USD y EUR cuando vienen del modelo', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 99.99,
      currency: 'usd',
      description: 'cena',
      suggestedCategory: 'Restaurante',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.currency, 'USD');
  });

  it('devuelve null si la descarga de Twilio falla', async () => {
    nextTwilioStatus = 404;
    nextOpenAIContent = JSON.stringify({ isReceipt: true, type: 'expense', amount: 100, currency: 'ARS' });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.equal(result, null);
    // No debería haber llegado a OpenAI.
    const openaiCall = fetchCalls.find(c => c.url.includes('openai') || c.url.includes('chat/completions'));
    assert.equal(openaiCall, undefined);
  });

  it('parsea monto en formato AR "12.345,67" sin perder los decimales', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: '12.345,67',
      currency: 'ARS',
      description: 'compra grande',
      suggestedCategory: 'Varios',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.amount, 12345.67);
  });

  it('parsea monto en formato US "12,345.67"', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: '12,345.67',
      currency: 'USD',
      description: 'x',
      suggestedCategory: 'Varios',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.amount, 12345.67);
  });

  it('parsea monto con símbolo de moneda al frente "$ 4.500"', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: '$ 4.500',
      currency: 'ARS',
      description: 'x',
      suggestedCategory: 'Varios',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.amount, 4500);
  });

  it('descarta fecha en formato inválido (no YYYY-MM-DD)', async () => {
    nextOpenAIContent = JSON.stringify({
      isReceipt: true,
      type: 'expense',
      amount: 100,
      currency: 'ARS',
      description: 'x',
      suggestedCategory: 'Varios',
      date: '18/05/2026',
    });
    const result = await extractTicketFromImage(TWILIO_MEDIA_URL);
    assert.ok(result);
    assert.equal(result!.date, null);
  });
});
