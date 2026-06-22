import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Task #286 — Integración del confirm path del webhook de WhatsApp.
//
// Prueba que cuando el usuario responde "sí" en el paso de confirmación con
// una categoría inventada por la IA que NO existe en el catálogo de la org:
//   (a) la transacción se persiste con una categoría real del catálogo
//       (jamás `null`, jamás `'General'` si "General" no está cargado), y
//   (b) el bot le manda un mensaje de confirmación al usuario.
//
// Pasa por el handler real del webhook con DB real (DATABASE_URL) y un
// Express local que registra `registerWhatsAppRoutes`. El fetch global se
// stubbea ANTES de cargar el módulo para capturar las llamadas a Twilio.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// Credenciales fake antes de cargar el módulo (`getTwilioCredentials` las lee).
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || ('AC' + 'a'.repeat(32));
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'test-auth-token';
process.env.TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886';

interface CapturedMessage {
  to: string;
  body: string;
}
const capturedMessages: CapturedMessage[] = [];

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url;
  if (typeof url === 'string' && url.includes('api.twilio.com')) {
    // Capturamos el body del POST a Twilio (form-urlencoded)
    try {
      const rawBody = init?.body;
      if (rawBody && typeof rawBody === 'object' && 'toString' in rawBody) {
        const params = new URLSearchParams(String(rawBody));
        capturedMessages.push({ to: params.get('To') || '', body: params.get('Body') || '' });
      }
    } catch {
      // ignore parse errors — assertion below will catch missing captures
    }
    return new Response(JSON.stringify({ sid: 'SMfake', status: 'queued' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (typeof url === 'string' && url.includes('messaging.twilio.com')) {
    // typing indicator — silencio
    return new Response('{}', { status: 200 });
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
const EMAIL = `e2e-task286-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';
function makePhone(seed: number): string {
  const tail = String(60_000_000 + ((seed * 31) % 30_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 13);
const DESCRIPTION_MARKER = `tx-task286-${SUFFIX}`;

let userId = '';
let orgId = '';
let accountId = '';
let server: Server;
let port = 0;

async function waitForTransaction(timeoutMs = 8_000): Promise<typeof schema.transactions.$inferSelect | null> {
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

async function waitForCapturedMessage(matcher: (m: CapturedMessage) => boolean, timeoutMs = 8_000): Promise<CapturedMessage | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = capturedMessages.find(matcher);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

before(async () => {
  // Usuario verificado con teléfono linkeado.
  const insertUser: InsertUser = {
    email: EMAIL,
    name: 'T286 confirm',
    password: await bcrypt.hash(PASSWORD, 10),
    accountType: 'business',
    phoneNumber: PHONE,
    phoneVerified: true,
  };
  const u = await storage.createUser(insertUser);
  userId = u.id;
  // Salteamos el welcome de primera vez y el banner de "qué org" para que el
  // mensaje "sí" entre derecho al branch del confirm.
  await storage.updateUser(userId, {
    whatsappWelcomed: true,
    lastWhatsappMessageAt: new Date(),
    whatsappDefaultOrganizationId: null,
  } as any);

  const insertSub: InsertSubscription = { userId, planType: 'business', status: 'active' };
  await storage.createSubscription(insertSub);

  const org = await storage.createOrganization({
    name: `T286 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;

  const insertMem: InsertMembership = { userId, organizationId: orgId, role: 'owner' };
  await storage.createMembership(insertMem);

  // Cuenta ARS.
  const acc = await storage.createAccount({
    name: 'Caja chica T286',
    type: 'cash',
    currency: 'ARS',
    balance: '100000',
    organizationId: orgId,
    accountCategory: 'operative',
  } as any);
  accountId = acc.id;

  // Sembramos UNA SOLA categoría de gasto que NO sea "General". Así
  // probamos que el resolver cae al catálogo real y no inserta `null`
  // ni la etiqueta inventada por la IA.
  await db.insert(schema.transactionCategories).values({
    organizationId: orgId,
    name: 'Otros gastos',
    type: 'expense',
    isDefault: true,
    createdBy: userId,
  });

  // Conversación en paso "confirm" con todos los slots completos y la
  // categoría inventada "General" (que no existe en la org).
  await db.insert(schema.whatsappConversations).values({
    organizationId: orgId,
    userId,
    currentStep: 'confirm',
    slots: {
      type: 'expense',
      amount: 1234,
      currency: 'ARS',
      accountId,
      accountName: 'Caja chica T286',
      description: `Café ${DESCRIPTION_MARKER}`,
      category: 'General',
      categorySource: 'auto',
      hasInvoice: false,
      invoiceSource: 'auto',
      invoiceType: null,
      invoiceNumber: null,
      invoiceTaxId: null,
      invoiceFileUrl: null,
      date: null,
      allowNegativeBalance: null,
      lastNegativeWarning: null,
      accountSource: 'explicit',
      clientId: null,
      clientName: null,
      supplierId: null,
      supplierName: null,
    } as any,
    messages: [],
    suggestedAccounts: null,
    availableCategories: null,
    pausedFlow: null,
    justCompletedTransaction: false,
    waitingForContinueDecision: false,
  });

  // Levantamos un Express local con sólo la ruta del webhook.
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

describe('Task #286 — confirm path del webhook con categoría inventada', () => {
  it('persiste la transacción con categoría del catálogo y le manda el mensaje al usuario', async () => {
    capturedMessages.length = 0;

    const body = new URLSearchParams({
      From: `whatsapp:${PHONE}`,
      Body: 'sí',
      MessageSid: `SM-test-${SUFFIX}`,
    });

    const res = await originalFetch(`http://127.0.0.1:${port}/api/whatsapp/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    // Twilio TwiML 200 inmediato; el procesamiento es async.
    assert.equal(res.status, 200);

    const tx = await waitForTransaction();
    assert.ok(tx, 'esperaba una transacción persistida en la org');
    assert.equal(tx!.organizationId, orgId);
    assert.equal(tx!.type, 'expense');
    assert.ok(tx!.category, `la categoría debe ser un string no vacío, fue: ${JSON.stringify(tx!.category)}`);
    // Como sólo sembramos "Otros gastos" en el catálogo y la IA propuso
    // "General" (inexistente), el resolver debe haber caído a ese fallback.
    assert.equal(tx!.category, 'Otros gastos');
    assert.equal(Number(tx!.amount), 1234);

    const confirmMsg = await waitForCapturedMessage(
      (m) => m.to === `whatsapp:${PHONE}` && m.body.includes('Registrado'),
    );
    assert.ok(confirmMsg, `esperaba un mensaje "✅ ¡Listo! Registrado..." al usuario, capturados: ${JSON.stringify(capturedMessages)}`);
    // El resumen debe mostrar la categoría real persistida, no la inventada.
    assert.ok(
      confirmMsg!.body.includes('Otros gastos') || !confirmMsg!.body.includes('General'),
      `el resumen no debe filtrar la etiqueta inventada "General"; body: ${confirmMsg!.body}`,
    );
  });
});
