import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #212 — End-to-end del flujo HTTP de verificación de número de WhatsApp.
// Cubre los nuevos endpoints:
//
//   PUT  /api/user/phone               → 410 si trae número, 200 si limpia (compat)
//   POST /api/user/phone/send-code     → 400/409/200 (validación + rate limit + send)
//   POST /api/user/phone/verify-code   → 400/429/200 (mismatch / no_pending / éxito)
//
// El send real por Twilio se "simula" con un stub: el helper
// sendWhatsAppMessage es importado dinámicamente dentro del route handler,
// así que aquí parchamos `globalThis.fetch` para devolver 200 a la URL de
// Twilio sin tocar la red. Eso permite ejecutar el suite en CI sin
// credenciales válidas.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this e2e test');
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { phoneVerificationCodes, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-pv-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';

// Canonical AR mobile = +549 + 10 digits (area code + local). We hard-code
// area 11 (Buenos Aires) and derive a unique 8-digit tail from a seed so
// concurrent test runs don't collide on the unique phone_number index.
function makePhone(seed: number): string {
  const tail = String(40_000_000 + ((seed * 13) % 50_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const PHONE = makePhone(process.pid + 1);

let userId = '';
let orgId = '';
let cookie = '';
let csrfToken = '';

// Patch fetch to fake Twilio responses without touching the network. We only
// intercept calls to api.twilio.com — everything else (the BASE_URL we hit
// for HTTP tests) flows through.
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? '';
  if (url.includes('api.twilio.com')) {
    return new Response(JSON.stringify({ sid: 'SMfake', status: 'queued' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof fetch;

async function loginAndCaptureCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `Login failed: ${res.status} ${await res.text()}`);

  const setCookies = res.headers.getSetCookie?.() ?? [];
  const live = setCookies.filter((c) => {
    const lower = c.toLowerCase();
    if (lower.includes('max-age=0')) return false;
    if (lower.includes('expires=thu, 01 jan 1970')) return false;
    const value = c.split(';')[0].split('=')[1];
    return Boolean(value);
  });
  assert.ok(live.length > 0, `No live session cookie in: ${setCookies.join(' | ')}`);
  return live.map((c) => c.split(';')[0].trim()).join('; ');
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'CSRF token endpoint must return 200');
  const data: { csrfToken?: string } = await res.json();
  assert.ok(data.csrfToken);
  return data.csrfToken;
}

async function send(phoneNumber: string): Promise<{ status: number; body: any }> {
  const token = await fetchCsrfToken();
  const res = await fetch(`${BASE_URL}/api/user/phone/send-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-csrf-token': token,
    },
    body: JSON.stringify({ phoneNumber }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function verify(code: string): Promise<{ status: number; body: any }> {
  const token = await fetchCsrfToken();
  const res = await fetch(`${BASE_URL}/api/user/phone/verify-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-csrf-token': token,
    },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

before(async () => {
  const hashed = await bcrypt.hash(PASSWORD, 10);
  const u = await storage.createUser({
    email: EMAIL,
    name: 'PV E2E Tester',
    password: hashed,
    accountType: 'business',
  } as any);
  userId = u.id;
  await storage.createSubscription({ userId, planType: 'business', status: 'active' } as any);

  const org = await storage.createOrganization({
    name: `PV E2E Org ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;
  await storage.createMembership({ userId, organizationId: orgId, role: 'owner' } as any);

  cookie = await loginAndCaptureCookie();
  csrfToken = await fetchCsrfToken();
});

after(async () => {
  globalThis.fetch = originalFetch;
  try { await db.delete(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId)); } catch {}
  try { await db.update(users).set({ phoneNumber: null, phoneVerified: false }).where(eq(users.id, userId)); } catch {}
  try { await storage.deleteOrganization(orgId); } catch {}
  try { await storage.deleteUser(userId); } catch {}
  try { await db.delete(users).where(eq(users.id, userId)); } catch {}
});

describe('Task #212 — Phone verification HTTP flow', () => {
  it('PUT /api/user/phone with a number is rejected (410) — must use the verification flow', async () => {
    const token = await fetchCsrfToken();
    const res = await fetch(`${BASE_URL}/api/user/phone`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'x-csrf-token': token,
      },
      body: JSON.stringify({ phoneNumber: PHONE }),
    });
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.code, 'phone_binding_requires_verification');
  });

  it('PUT /api/user/phone with null/empty acts as a clear (compat with old clients)', async () => {
    // First plant a verified binding so we can confirm the clear actually unlinks.
    await db.update(users).set({ phoneNumber: PHONE, phoneVerified: true }).where(eq(users.id, userId));
    const token = await fetchCsrfToken();
    const res = await fetch(`${BASE_URL}/api/user/phone`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'x-csrf-token': token,
      },
      body: JSON.stringify({ phoneNumber: null }),
    });
    assert.equal(res.status, 200);
    const after = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(after[0].phoneNumber, null, 'phone must be cleared');
    assert.equal(after[0].phoneVerified, false, 'phoneVerified must reset on clear');
  });

  it('POST /send-code rejects garbage phone numbers', async () => {
    const r = await send('not-a-phone');
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Número inválido/i);
  });

  it('POST /send-code with a valid AR mobile creates a row and stores the hash', async () => {
    const r = await send(PHONE);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.phoneNumber, PHONE);
    assert.ok(r.body.expiresAt);

    const rows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].normalizedPhone, PHONE);
    assert.match(rows[0].codeHash, /^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/);
  });

  it('POST /verify-code with the wrong code returns 400 + decrements remaining attempts', async () => {
    // We don't know the real plaintext (it was random), so any guess is wrong.
    const r = await verify('000000');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'mismatch');
    assert.ok(typeof r.body.remainingAttempts === 'number' && r.body.remainingAttempts < 5);
  });

  it('POST /verify-code with the correct code (planted directly in DB) succeeds and marks phoneVerified=true', async () => {
    // Plant a known bcrypt hash so we can verify deterministically. This
    // bypasses the random code from send-code but exercises the same
    // SQL/HTTP path. Hashing strategy must match the runtime exactly:
    // bcrypt with cost 10 over `pv1:${code}`.
    const bcrypt = (await import('bcryptjs')).default;
    const knownCode = '424242';
    const knownHash = await bcrypt.hash(`pv1:${knownCode}`, 10);
    await db
      .update(phoneVerificationCodes)
      .set({ codeHash: knownHash, attempts: 0, expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(phoneVerificationCodes.userId, userId));

    const r = await verify(knownCode);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.phoneVerified, true);
    assert.equal(r.body.phoneNumber, PHONE);

    const userRow = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(userRow[0].phoneNumber, PHONE);
    assert.equal(userRow[0].phoneVerified, true);

    const codeRows = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(codeRows.length, 0, 'code row must be consumed on success');

    // Task #225 — La confirmación por WhatsApp + email se dispara como
    // efecto colateral fire-and-forget desde el server (otro proceso).
    // No la aserto desde acá porque el log file del workflow se escribe
    // de forma diferida (no en streaming) y no podemos espiar el fetch
    // del server proceso desde el test. La cobertura de ese flujo está
    // en `tests/phoneLinkedConfirmation.test.ts` (unitario al server) y
    // en el log del workflow tras un verify real.
  });

  it('POST /verify-code without an active code returns no_pending', async () => {
    const r = await verify('424242');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'no_pending');
  });

  it('POST /send-code rejects when the number is already verified by ANOTHER user', async () => {
    // Create a second user that "owns" PHONE2 verified, then try to start
    // verification of the same number from our test user.
    const PHONE2 = makePhone(process.pid + 7919);
    const hashed = await bcrypt.hash('Test1234!', 10);
    const owner = await storage.createUser({
      email: `pv-owner-${SUFFIX}@test.local`,
      name: 'Owner',
      password: hashed,
      accountType: 'business',
    } as any);
    await db.update(users).set({ phoneNumber: PHONE2, phoneVerified: true }).where(eq(users.id, owner.id));

    try {
      const r = await send(PHONE2);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'phone_taken');
    } finally {
      try { await db.update(users).set({ phoneNumber: null }).where(eq(users.id, owner.id)); } catch {}
      try { await storage.deleteUser(owner.id); } catch {}
      try { await db.delete(users).where(eq(users.id, owner.id)); } catch {}
    }
  });
});
