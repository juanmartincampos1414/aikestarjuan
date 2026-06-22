import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Integración HTTP del wizard de 3 pasos:
// bot-info (paso 1) → send-code (paso 2) → verify-code (paso 3).
// Stub Twilio para no tocar la red.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { phoneVerificationCodes, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');
const schema = await import('../shared/schema');
type InsertUser = typeof schema.users.$inferInsert;
type InsertSubscription = typeof schema.subscriptions.$inferInsert;
type InsertMembership = typeof schema.memberships.$inferInsert;

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-task217-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';
function makePhone(seed: number): string {
  const tail = String(40_000_000 + ((seed * 17) % 50_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 7);

let userId = '';
let orgId = '';
let cookie = '';

const originalFetch = globalThis.fetch;
const stubbedFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes('api.twilio.com')) {
    return new Response(JSON.stringify({ sid: 'SMfake', status: 'queued' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
};
globalThis.fetch = stubbedFetch;

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const live = (res.headers.getSetCookie?.() ?? []).filter((c) => {
    const lower = c.toLowerCase();
    if (lower.includes('max-age=0')) return false;
    if (lower.includes('expires=thu, 01 jan 1970')) return false;
    return Boolean(c.split(';')[0].split('=')[1]);
  });
  return live.map((c) => c.split(';')[0].trim()).join('; ');
}

async function csrf(): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/csrf-token`, { headers: { Cookie: cookie } });
  const d: { csrfToken?: string } = await r.json();
  return d.csrfToken!;
}

async function sendCode(): Promise<Response> {
  const t = await csrf();
  return fetch(`${BASE_URL}/api/user/phone/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': t },
    body: JSON.stringify({ phoneNumber: PHONE }),
  });
}

interface VerifyResponse {
  ok?: boolean;
  code?: string;
  phoneVerified?: boolean;
  phoneNumber?: string | null;
  remainingAttempts?: number;
}
async function verifyCode(code: string): Promise<{ status: number; body: VerifyResponse }> {
  const t = await csrf();
  const r = await fetch(`${BASE_URL}/api/user/phone/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': t },
    body: JSON.stringify({ code }),
  });
  const body = (await r.json().catch(() => ({}))) as VerifyResponse;
  return { status: r.status, body };
}

before(async () => {
  const insertUser: InsertUser = {
    email: EMAIL,
    name: 'T217 E2E',
    password: await bcrypt.hash(PASSWORD, 10),
    accountType: 'business',
  };
  const u = await storage.createUser(insertUser);
  userId = u.id;
  const insertSub: InsertSubscription = {
    userId,
    planType: 'business',
    status: 'active',
  };
  await storage.createSubscription(insertSub);
  const org = await storage.createOrganization({
    name: `T217 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;
  const insertMem: InsertMembership = {
    userId,
    organizationId: orgId,
    role: 'owner',
  };
  await storage.createMembership(insertMem);
  cookie = await login();
});

after(async () => {
  globalThis.fetch = originalFetch;
  try { await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId)); } catch {}
  try { await db.update(users).set({ phoneNumber: null, phoneVerified: false }).where(eq(users.id, userId)); } catch {}
  try { await storage.deleteOrganization(orgId); } catch {}
  try { await storage.deleteUser(userId); } catch {}
  try { await db.delete(users).where(eq(users.id, userId)); } catch {}
});

describe('Task #217 — wizard 3-step integration', () => {
  it('paso 1 (bot-info): expone número público sin auth y devuelve los 4 campos del contrato', async () => {
    const r = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    assert.equal(r.status, 200);
    const info = await r.json();
    assert.ok(info.e164?.startsWith('+'), 'e164 debe ser E.164');
    assert.ok(/^\d+$/.test(info.waMe), 'waMe debe ser solo dígitos para wa.me/<num>');
    assert.ok(info.display?.length > 0, 'display debe ser legible');
    assert.ok(info.defaultGreeting?.length > 0, 'defaultGreeting debe estar definido');
  });

  it('happy path: send-code (paso 2) → verify-code con código correcto (paso 3) vincula el número', async () => {
    const send = await sendCode();
    assert.equal(send.status, 200, await send.text());

    const knownCode = '424242';
    await db
      .update(phoneVerificationCodes)
      .set({
        codeHash: await bcrypt.hash(`pv1:${knownCode}`, 10),
        attempts: 0,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(phoneVerificationCodes.userId, userId));

    const v = await verifyCode(knownCode);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.equal(v.body.ok, true);
    assert.equal(v.body.phoneVerified, true);

    const row = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(row[0].phoneVerified, true);
    assert.ok(row[0].phoneNumber);
  });

  it('código incorrecto en el paso 3 devuelve mismatch (400) y NO vincula', async () => {
    await db.update(users).set({ phoneNumber: null, phoneVerified: false }).where(eq(users.id, userId));
    await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));

    const send = await sendCode();
    assert.equal(send.status, 200);

    const v = await verifyCode('000000');
    assert.equal(v.status, 400);
    assert.equal(v.body.code, 'mismatch');

    const row = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(row[0].phoneVerified, false);
  });
});
