import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Task #290 — Integración del webhook de WhatsApp cuando llega una foto
// suelta de ticket (sin estar en el step `invoice_image`).
//
// Verifica que el handler:
//   (a) llama a GPT-4o vision para extraer los datos del comprobante,
//   (b) deja la conversación en step `confirm` con los slots cargados
//       (incluyendo `date` extraída),
//   (c) le manda al usuario el resumen pre-confirm,
//   (d) NO interfiere con el paso `invoice_image` (no se prueba acá pero
//       el guard `currentStep !== 'invoice_image'` está en el handler).
//
// El fetch global se stubbea ANTES de cargar el módulo para interceptar:
//   - GET api.twilio.com/.../Media/... → devuelve buffer JPEG fake
//   - POST openai (chat/completions) → devuelve JSON del ticket
//   - POST api.twilio.com/.../Messages → captura el body para asserts

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ('AC' + 'a'.repeat(32));
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-auth-token';
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886';
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || 'test-openai-key';

interface CapturedMessage {
  to: string;
  body: string;
}
const capturedMessages: CapturedMessage[] = [];

const TICKET_JSON = JSON.stringify({
  isReceipt: true,
  type: 'expense',
  amount: 7890.5,
  currency: 'ARS',
  description: 'Café y medialunas',
  supplierName: null,
  suggestedCategory: 'Restaurante',
  date: '2026-05-16',
});

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url;

  // Descarga de media de Twilio (GET con Basic auth).
  if (typeof url === 'string' && url.includes('api.twilio.com') && url.includes('/Media/')) {
    const fakeImage = Buffer.alloc(2048, 0x41);
    return new Response(fakeImage, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }

  // POST a Twilio messages.
  if (typeof url === 'string' && url.includes('api.twilio.com')) {
    try {
      const rawBody = init?.body;
      if (rawBody && typeof rawBody === 'object' && 'toString' in rawBody) {
        const params = new URLSearchParams(String(rawBody));
        capturedMessages.push({ to: params.get('To') || '', body: params.get('Body') || '' });
      }
    } catch {}
    return new Response(JSON.stringify({ sid: 'SMfake', status: 'queued' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (typeof url === 'string' && url.includes('messaging.twilio.com')) {
    return new Response('{}', { status: 200 });
  }

  // OpenAI vision (chat completions).
  if (typeof url === 'string' && (url.includes('openai.com') || url.includes('/chat/completions'))) {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ message: { content: TICKET_JSON } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return originalFetch(input, init);
}) as typeof fetch;

const { registerWhatsAppRoutes } = await import('../server/routes/whatsapp');
const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const schema = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

type InsertUser = typeof schema.users.$inferInsert;
type InsertSubscription = typeof schema.subscriptions.$inferInsert;
type InsertMembership = typeof schema.memberships.$inferInsert;

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-task290-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';
function makePhone(seed: number): string {
  const tail = String(60_000_000 + ((seed * 37) % 30_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 29);

let userId = '';
let orgId = '';
let accountId = '';
let server: Server;
let port = 0;

async function waitForConversationStep(step: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(schema.whatsappConversations)
      .where(eq(schema.whatsappConversations.userId, userId))
      .limit(1);
    if (rows.length > 0 && rows[0].currentStep === step) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function waitForCapturedMessage(matcher: (m: CapturedMessage) => boolean, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = capturedMessages.find(matcher);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

before(async () => {
  const insertUser: InsertUser = {
    email: EMAIL,
    name: 'T290 ticket img',
    password: await bcrypt.hash(PASSWORD, 10),
    accountType: 'business',
    phoneNumber: PHONE,
    phoneVerified: true,
  };
  const u = await storage.createUser(insertUser);
  userId = u.id;
  await storage.updateUser(userId, {
    whatsappWelcomed: true,
    lastWhatsappMessageAt: new Date(),
    whatsappDefaultOrganizationId: null,
  } as any);

  const insertSub: InsertSubscription = { userId, planType: 'business', status: 'active' };
  await storage.createSubscription(insertSub);

  const org = await storage.createOrganization({
    name: `T290 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;
  // El bot mira `whatsappDefaultOrganizationId` para resolver org sin
  // preguntar. Lo seteamos después de tener el id.
  await storage.updateUser(userId, { whatsappDefaultOrganizationId: orgId } as any);

  const insertMem: InsertMembership = { userId, organizationId: orgId, role: 'owner' };
  await storage.createMembership(insertMem);

  // ÚNICA cuenta → el branch elige `confirm` directo (no `account`).
  const acc = await storage.createAccount({
    name: 'Caja chica T290',
    type: 'cash',
    currency: 'ARS',
    balance: '100000',
    organizationId: orgId,
    accountCategory: 'operative',
  } as any);
  accountId = acc.id;

  // Categoría del catálogo (para que el resolver no inserte nada inventado).
  await db.insert(schema.transactionCategories).values({
    organizationId: orgId,
    name: 'Restaurante',
    type: 'expense',
    isDefault: true,
    createdBy: userId,
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  registerWhatsAppRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  try { await db.delete(schema.whatsappConversations).where(eq(schema.whatsappConversations.userId, userId)); } catch {}
  try { await db.delete(schema.transactionCategories).where(eq(schema.transactionCategories.organizationId, orgId)); } catch {}
  try { await db.delete(schema.accounts).where(eq(schema.accounts.organizationId, orgId)); } catch {}
  try { await storage.deleteOrganization(orgId); } catch {}
  try { await db.delete(schema.users).where(eq(schema.users.id, userId)); } catch {}
});

describe('Task #290 — foto suelta de ticket dispara pre-confirm', () => {
  it('extrae el ticket, deja la conversación en confirm con los slots y manda el resumen', async () => {
    capturedMessages.length = 0;

    const body = new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: '',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest',
      MediaContentType0: 'image/jpeg',
      NumMedia: '1',
      MessageSid: `SM-test-${SUFFIX}`,
    });

    const res = await originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 200);

    const conv = await waitForConversationStep('confirm');
    assert.ok(conv, 'esperaba conversación en step confirm tras la foto');
    const slots = conv!.slots as any;
    assert.equal(slots.type, 'expense');
    assert.equal(Number(slots.amount), 7890.5);
    assert.equal(slots.currency, 'ARS');
    assert.equal(slots.accountId, accountId);
    assert.equal(slots.hasInvoice, true);
    assert.equal(slots.date, '2026-05-16');
    // La foto del ticket queda guardada como adjunto (slots.invoiceFileUrl).
    assert.ok(
      typeof slots.invoiceFileUrl === 'string' && slots.invoiceFileUrl.length > 0,
      `esperaba invoiceFileUrl persistido en slots, fue: ${JSON.stringify(slots.invoiceFileUrl)}`,
    );
    assert.ok(slots.description && String(slots.description).toLowerCase().includes('café'));

    const preConfirm = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('Leí el comprobante') && m.body.includes('¿Confirmo?'),
    );
    assert.ok(preConfirm, `esperaba pre-confirm; capturados: ${JSON.stringify(capturedMessages)}`);
    // El resumen muestra la fecha extraída.
    assert.ok(preConfirm!.body.includes('2026-05-16'), `esperaba fecha en pre-confirm; body: ${preConfirm!.body}`);
  });
});
