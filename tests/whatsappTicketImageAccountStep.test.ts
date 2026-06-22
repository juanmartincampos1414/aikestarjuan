import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Task #294 — Integración del webhook cuando llega una foto suelta de ticket
// pero la org tiene MÁS de una cuenta en la moneda detectada → el bot manda
// al usuario al step `account`. Verificamos que tras elegir la cuenta el bot:
//   (a) NO vuelve a preguntar "¿Tenés factura?" ni pide adjunto,
//   (b) manda directo el resumen "¿Confirmo?" mostrando que la foto ya quedó
//       guardada (línea "Con factura (foto guardada)"),
//   (c) al responder "sí", la transacción queda persistida con
//       `hasInvoice=true` e `invoiceFileUrl` no nulo.
//
// Reproduce el bug reportado por Juan (captura del 18-may) donde el bot
// repreguntaba por factura, interpretaba "sí" como número de factura y
// pedía adjuntar la foto otra vez.

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
  amount: 4500,
  currency: 'ARS',
  description: 'Supermercado',
  supplierName: null,
  suggestedCategory: 'Supermercado',
  date: '2026-05-17',
});

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url;

  if (typeof url === 'string' && url.includes('api.twilio.com') && url.includes('/Media/')) {
    const fakeImage = Buffer.alloc(2048, 0x41);
    return new Response(fakeImage, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }

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
const { eq, and, ilike } = await import('drizzle-orm');

type InsertUser = typeof schema.users.$inferInsert;
type InsertSubscription = typeof schema.subscriptions.$inferInsert;
type InsertMembership = typeof schema.memberships.$inferInsert;

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-task294-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';
function makePhone(seed: number): string {
  const tail = String(60_000_000 + ((seed * 41) % 30_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 47);
const DESC_MARKER = `tx-task294-${SUFFIX}`;

let userId = '';
let orgId = '';
let accountMacroId = '';
let accountCajaId = '';
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

async function waitForTransaction(timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await db
      .select()
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.organizationId, orgId),
          ilike(schema.transactions.description, `%${DESC_MARKER}%`),
        ),
      )
      .limit(1);
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

before(async () => {
  const insertUser: InsertUser = {
    email: EMAIL,
    name: 'T294 multi-cuenta',
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
    name: `T294 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;
  await storage.updateUser(userId, { whatsappDefaultOrganizationId: orgId } as any);

  const insertMem: InsertMembership = { userId, organizationId: orgId, role: 'owner' };
  await storage.createMembership(insertMem);

  // DOS cuentas ARS → fuerzan el step `account` (bug original de Juan).
  const accMacro = await storage.createAccount({
    name: 'Banco Macro',
    type: 'bank',
    currency: 'ARS',
    balance: '500000',
    organizationId: orgId,
    accountCategory: 'operative',
  } as any);
  accountMacroId = accMacro.id;

  const accCaja = await storage.createAccount({
    name: 'Caja chica',
    type: 'cash',
    currency: 'ARS',
    balance: '50000',
    organizationId: orgId,
    accountCategory: 'operative',
  } as any);
  accountCajaId = accCaja.id;

  await db.insert(schema.transactionCategories).values({
    organizationId: orgId,
    name: 'Supermercado',
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
  try { await db.delete(schema.transactions).where(eq(schema.transactions.organizationId, orgId)); } catch {}
  try { await db.delete(schema.whatsappConversations).where(eq(schema.whatsappConversations.userId, userId)); } catch {}
  try { await db.delete(schema.transactionCategories).where(eq(schema.transactionCategories.organizationId, orgId)); } catch {}
  try { await db.delete(schema.accounts).where(eq(schema.accounts.organizationId, orgId)); } catch {}
  try { await storage.deleteOrganization(orgId); } catch {}
  try { await db.delete(schema.users).where(eq(schema.users.id, userId)); } catch {}
});

describe('Task #294 — foto de ticket + multi-cuenta NO repregunta por factura', () => {
  it('foto → elige Banco Macro → resumen pre-confirm (sin pedir factura) → sí → tx con foto guardada', async () => {
    capturedMessages.length = 0;

    // 1) Foto suelta del ticket. Multi-cuenta ARS → debería dejar la
    //    conversación en step `account`.
    const photoBody = new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: '',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEtest',
      MediaContentType0: 'image/jpeg',
      NumMedia: '1',
      MessageSid: `SM-test-photo-${SUFFIX}`,
    });
    let res = await originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: photoBody,
    });
    assert.equal(res.status, 200);

    const convAccount = await waitForConversationStep('account');
    assert.ok(convAccount, 'esperaba conversación en step account tras la foto multi-cuenta');
    const slotsAcc = convAccount!.slots as any;
    assert.equal(slotsAcc.hasInvoice, true);
    assert.ok(
      typeof slotsAcc.invoiceFileUrl === 'string' && slotsAcc.invoiceFileUrl.length > 0,
      `esperaba invoiceFileUrl persistido en slots desde la foto, fue: ${JSON.stringify(slotsAcc.invoiceFileUrl)}`,
    );

    const askAccountMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('¿De qué cuenta'),
    );
    assert.ok(askAccountMsg, `esperaba pregunta de cuenta; capturados: ${JSON.stringify(capturedMessages)}`);

    // Patcheamos el contenido a fingir que el usuario tipea el nombre.
    capturedMessages.length = 0;

    // 2) Elegimos "Banco Macro".
    const pickAccountBody = new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'Banco Macro',
      MessageSid: `SM-test-pick-${SUFFIX}`,
    });
    res = await originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: pickAccountBody,
    });
    assert.equal(res.status, 200);

    // El siguiente step debe ser `confirm` (NO `invoice` ni `invoice_number`).
    const convConfirm = await waitForConversationStep('confirm');
    assert.ok(convConfirm, 'esperaba step confirm tras elegir cuenta (no debe repreguntar por factura)');
    const slotsCfm = convConfirm!.slots as any;
    assert.equal(slotsCfm.accountId, accountMacroId);
    assert.equal(slotsCfm.hasInvoice, true);
    assert.ok(
      typeof slotsCfm.invoiceFileUrl === 'string' && slotsCfm.invoiceFileUrl.length > 0,
      'la foto debe seguir guardada en los slots tras elegir cuenta',
    );

    // El bot mandó el resumen, NO la pregunta de factura.
    const summaryMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('Resumen') && m.body.includes('¿Confirmo?'),
    );
    assert.ok(summaryMsg, `esperaba resumen ¿Confirmo?; capturados: ${JSON.stringify(capturedMessages)}`);
    assert.ok(
      !summaryMsg!.body.includes('¿Tenés factura'),
      `el resumen NO debe repreguntar por factura; body: ${summaryMsg!.body}`,
    );
    assert.ok(
      summaryMsg!.body.includes('Banco Macro'),
      `el resumen debe mencionar la cuenta elegida; body: ${summaryMsg!.body}`,
    );
    assert.ok(
      summaryMsg!.body.includes('Con factura'),
      `el resumen debe avisar que la foto quedó guardada; body: ${summaryMsg!.body}`,
    );

    // Sembramos el marker en la descripción para poder ubicar la tx después.
    await db
      .update(schema.whatsappConversations)
      .set({
        slots: { ...slotsCfm, description: `Supermercado ${DESC_MARKER}` } as any,
      })
      .where(eq(schema.whatsappConversations.userId, userId));

    capturedMessages.length = 0;

    // 3) Confirmamos con "sí". La tx debe registrarse con la foto.
    const confirmBody = new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'sí',
      MessageSid: `SM-test-confirm-${SUFFIX}`,
    });
    res = await originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: confirmBody,
    });
    assert.equal(res.status, 200);

    const tx = await waitForTransaction();
    assert.ok(tx, 'esperaba transacción persistida tras confirmar');
    assert.equal(tx!.type, 'expense');
    assert.equal(tx!.accountId, accountMacroId);
    assert.equal(tx!.hasInvoice, true);
    assert.ok(
      tx!.invoiceFileUrl && String(tx!.invoiceFileUrl).length > 0,
      `la tx debe quedar con la foto adjunta; fue: ${JSON.stringify(tx!.invoiceFileUrl)}`,
    );
  });
});
