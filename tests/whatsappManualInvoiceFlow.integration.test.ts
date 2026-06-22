import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Task #295 — Red de seguridad para el flujo MANUAL de factura por WhatsApp.
//
// El fix de Task #294 saltea los pasos de número/adjunto cuando la foto del
// ticket viajó como adjunto (caso "foto suelta de ticket"). Este test cubre
// el camino opuesto — el normal — para evitar regresiones:
//
//   user: "gasté 2500 en nafta"  →  bot procesa el intent
//   bot: "¿Tenés factura?"       (step: invoice)
//   user: "sí"                    →  step: invoice_number
//   user: "0001-00012345"         →  step: invoice_image
//   user: <foto>                  →  step: confirm
//   user: "sí"                    →  transacción persistida con
//                                    invoiceNumber + invoiceFileUrl no nulos
//
// Nota sobre el bridge a step `invoice`: el path actual de "arranque por
// texto" pasa por `resolveSmartDefaults`, que SIEMPRE resuelve
// `sources.hasInvoice` (a 'auto' como fallback) y por eso el bot salta
// directo a `confirm`. La única manera de que el bot pregunte
// "¿Tenés factura?" hoy es que la conversación esté en step `invoice` con
// `hasInvoice=null` e `invoiceSource=null`. Para que el test arranque con
// un mensaje de texto REAL del usuario (Task #295 dice "arranca con un
// mensaje de texto") pero igual ejercite la rama manual, hacemos:
//   1) Mandamos el webhook con "gasté 2500 en nafta" (extracción real
//      mockeada por OpenAI), el bot procesa y deja la conversación con
//      todos los slots cargados (cuenta, descripción, etc.).
//   2) Bridge: forzamos `currentStep='invoice'` y limpiamos hasInvoice/
//      invoiceSource para simular el estado en el que el bot pregunta
//      "¿Tenés factura?".
//   3) A partir de ahí, ejercitamos la rama manual real del handler
//      (`server/routes/whatsapp.ts:3526-3793`) end-to-end, incluyendo el
//      confirm final y la fila persistida en `transactions`.

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

const EXTRACTED_SLOTS_JSON = JSON.stringify({
  type: 'expense',
  amount: 2500,
  currency: 'ARS',
  currencyExplicit: false,
  description: 'nafta',
  hasInvoice: null,
  autoConfirm: false,
  clientName: null,
  supplierName: null,
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

  // OpenAI chat completions — devolvemos los slots extraídos.
  if (typeof url === 'string' && (url.includes('openai.com') || url.includes('/chat/completions'))) {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ message: { content: EXTRACTED_SLOTS_JSON } }],
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
const EMAIL = `e2e-task295-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';
function makePhone(seed: number): string {
  const tail = String(60_000_000 + ((seed * 41) % 30_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 47);
const INVOICE_NUMBER = `0001-${Date.now() % 100_000_000}`;
const DESCRIPTION_MARKER = `tx-task295-${SUFFIX}`;

let userId = '';
let orgId = '';
let accountId = '';
let server: Server;
let port = 0;

async function getConversation() {
  const rows = await db
    .select()
    .from(schema.whatsappConversations)
    .where(eq(schema.whatsappConversations.userId, userId))
    .limit(1);
  return rows[0] || null;
}

async function waitForConversationStep(step: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const conv = await getConversation();
    if (conv && conv.currentStep === step) return conv;
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
          ilike(schema.transactions.description, `%${DESCRIPTION_MARKER}%`),
        ),
      )
      .limit(1);
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function postWebhook(body: URLSearchParams) {
  return originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

before(async () => {
  const insertUser: InsertUser = {
    email: EMAIL,
    name: 'T295 manual invoice',
    password: await bcrypt.hash(PASSWORD, 10),
    accountType: 'business',
    phoneNumber: PHONE,
    phoneVerified: true,
  };
  const u = await storage.createUser(insertUser);
  userId = u.id;

  const insertSub: InsertSubscription = { userId, planType: 'business', status: 'active' };
  await storage.createSubscription(insertSub);

  const org = await storage.createOrganization({
    name: `T295 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;

  await storage.updateUser(userId, {
    whatsappWelcomed: true,
    lastWhatsappMessageAt: new Date(),
    whatsappDefaultOrganizationId: orgId,
  } as any);

  const insertMem: InsertMembership = { userId, organizationId: orgId, role: 'owner' };
  await storage.createMembership(insertMem);

  const acc = await storage.createAccount({
    name: 'Caja chica T295',
    type: 'cash',
    currency: 'ARS',
    balance: '100000',
    organizationId: orgId,
    accountCategory: 'operative',
  } as any);
  accountId = acc.id;

  await db.insert(schema.transactionCategories).values({
    organizationId: orgId,
    name: 'Combustible',
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

describe('Task #295 — flujo manual de factura por WhatsApp', () => {
  it('arranca con texto, pasa por invoice → invoice_number → invoice_image → confirm y persiste la transacción con invoice no nulos', async () => {
    capturedMessages.length = 0;

    // STEP 0 — Mensaje real del usuario: "gasté 2500 en nafta".
    // El extractor real (mockeado a nivel de fetch a OpenAI) devuelve los
    // slots; el bot los procesa, elige la cuenta única y deja la
    // conversación con todos los datos cargados.
    const res0 = await postWebhook(new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'gasté 2500 en nafta',
      MessageSid: `SM-t295-0-${SUFFIX}`,
    }));
    assert.equal(res0.status, 200);

    // Esperamos a que el bot procese el intent (slots type/amount/account
    // cargados). El path moderno con cuenta única y descripción no genérica
    // deja la conversación en `confirm` con hasInvoice/invoiceSource ya
    // resueltos por smart defaults — por eso necesitamos el bridge a
    // `invoice` debajo (ver comentario al tope del archivo).
    let conv: typeof schema.whatsappConversations.$inferSelect | null = null;
    for (let i = 0; i < 80; i++) {
      conv = await getConversation();
      if (conv && conv.slots && (conv.slots as any).amount === 2500 && (conv.slots as any).accountId === accountId) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(conv, 'esperaba conversación con los slots cargados tras el extractor');
    const initialSlots = conv!.slots as any;
    assert.equal(initialSlots.type, 'expense');
    assert.equal(Number(initialSlots.amount), 2500);
    assert.equal(initialSlots.accountId, accountId);
    assert.ok(initialSlots.description && String(initialSlots.description).toLowerCase().includes('nafta'));

    // Bridge: forzamos el step `invoice` con hasInvoice/invoiceSource en
    // null, simulando un estado donde el bot pregunta "¿Tenés factura?".
    // Aprovechamos para marcar la descripción con un sufijo único para
    // poder encontrar la transacción persistida sin colisiones entre tests.
    const bridgedDescription = `${initialSlots.description} ${DESCRIPTION_MARKER}`;
    await db
      .update(schema.whatsappConversations)
      .set({
        currentStep: 'invoice' as any,
        slots: {
          ...initialSlots,
          description: bridgedDescription,
          hasInvoice: null,
          invoiceSource: null,
          invoiceNumber: null,
          invoiceFileUrl: null,
        },
      })
      .where(eq(schema.whatsappConversations.userId, userId));

    // Aserción explícita post-bridge: la conversación queda exactamente en
    // step `invoice`, dejando la intención del orden de pasos clara en el
    // propio test.
    const convBridged = await getConversation();
    assert.ok(convBridged, 'esperaba conversación tras el bridge');
    assert.equal(convBridged!.currentStep, 'invoice');
    assert.equal((convBridged!.slots as any).hasInvoice, null);
    assert.equal((convBridged!.slots as any).invoiceSource, null);

    // STEP 1 — usuario dice "sí" a "¿Tenés factura?"
    capturedMessages.length = 0;
    const res1 = await postWebhook(new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'sí',
      MessageSid: `SM-t295-1-${SUFFIX}`,
    }));
    assert.equal(res1.status, 200);

    const convAfterYes = await waitForConversationStep('invoice_number');
    assert.ok(convAfterYes, 'esperaba transición a invoice_number tras "sí"');
    assert.equal((convAfterYes!.slots as any).hasInvoice, true);

    const askNumberMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('número de factura'),
    );
    assert.ok(askNumberMsg, `esperaba pregunta de número de factura; capturados: ${JSON.stringify(capturedMessages)}`);

    // STEP 2 — usuario manda el número de factura.
    capturedMessages.length = 0;
    const res2 = await postWebhook(new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: INVOICE_NUMBER,
      MessageSid: `SM-t295-2-${SUFFIX}`,
    }));
    assert.equal(res2.status, 200);

    const convAfterNumber = await waitForConversationStep('invoice_image');
    assert.ok(convAfterNumber, 'esperaba transición a invoice_image tras el número');
    const slotsAfterNumber = convAfterNumber!.slots as any;
    assert.equal(slotsAfterNumber.invoiceNumber, INVOICE_NUMBER);
    assert.equal(slotsAfterNumber.hasInvoice, true);

    const askImageMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('foto o archivo'),
    );
    assert.ok(askImageMsg, `esperaba pedido de foto/archivo; capturados: ${JSON.stringify(capturedMessages)}`);
    assert.ok(
      askImageMsg!.body.includes(INVOICE_NUMBER),
      `el ack del número debería mostrarlo; body: ${askImageMsg!.body}`,
    );

    // STEP 3 — usuario adjunta la foto de la factura.
    capturedMessages.length = 0;
    const res3 = await postWebhook(new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: '',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MMtest/Media/MEt295',
      MediaContentType0: 'image/jpeg',
      NumMedia: '1',
      MessageSid: `SM-t295-3-${SUFFIX}`,
    }));
    assert.equal(res3.status, 200);

    const convAfterImage = await waitForConversationStep('confirm');
    assert.ok(convAfterImage, 'esperaba transición a confirm tras la foto');
    const slotsAfterImage = convAfterImage!.slots as any;
    assert.equal(slotsAfterImage.invoiceNumber, INVOICE_NUMBER);
    assert.ok(
      typeof slotsAfterImage.invoiceFileUrl === 'string' && slotsAfterImage.invoiceFileUrl.length > 0,
      `esperaba invoiceFileUrl persistido en slots, fue: ${JSON.stringify(slotsAfterImage.invoiceFileUrl)}`,
    );
    assert.notEqual(slotsAfterImage.invoiceFileUrl, 'skipped');
    assert.notEqual(slotsAfterImage.invoiceFileUrl, '');
    assert.equal(slotsAfterImage.hasInvoice, true);

    const summaryMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('¿Confirmo?'),
    );
    assert.ok(summaryMsg, `esperaba resumen con "¿Confirmo?"; capturados: ${JSON.stringify(capturedMessages)}`);
    assert.ok(summaryMsg!.body.includes(INVOICE_NUMBER), `el resumen debería mostrar el número; body: ${summaryMsg!.body}`);
    assert.ok(summaryMsg!.body.includes('Con factura'), `el resumen debería marcar "Con factura"; body: ${summaryMsg!.body}`);

    // STEP 4 — usuario confirma con "sí" → la transacción se persiste.
    capturedMessages.length = 0;
    const res4 = await postWebhook(new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'sí',
      MessageSid: `SM-t295-4-${SUFFIX}`,
    }));
    assert.equal(res4.status, 200);

    const tx = await waitForTransaction();
    assert.ok(tx, 'esperaba una transacción persistida tras el confirm final');
    assert.equal(tx!.organizationId, orgId);
    assert.equal(tx!.type, 'expense');
    assert.equal(Number(tx!.amount), 2500);
    assert.equal(tx!.hasInvoice, true);
    // Asserts clave de Task #295: ambos campos quedan no nulos en la fila.
    assert.equal(tx!.invoiceNumber, INVOICE_NUMBER);
    assert.ok(
      typeof tx!.invoiceFileUrl === 'string' && tx!.invoiceFileUrl!.length > 0,
      `la transacción persistida debe tener invoiceFileUrl no nulo, fue: ${JSON.stringify(tx!.invoiceFileUrl)}`,
    );

    const okMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('Registrado'),
    );
    assert.ok(okMsg, `esperaba "¡Listo! Registrado..."; capturados: ${JSON.stringify(capturedMessages)}`);
  });
});
