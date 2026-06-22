import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #218 — End-to-end coverage for the "Editar teléfono" entry point.
//
// Setup mirrors `tests/phoneVerification.e2e.test.ts` but plants a user
// whose phone is ALREADY verified, then exercises the HTTP contract that
// the pencil-edit button relies on:
//
//   1. GET /api/auth/me reports phoneVerified=true and a real phoneNumber.
//   2. GET /api/whatsapp/bot-info still works (the wizard's step-1 hydrate).
//   3. POST /api/user/phone/send-code accepts a new code request even
//      though the user is already verified — i.e. the backend supports
//      re-linking and the wizard is free to restart from step 1.
//   4. The re-link send-code response stores a fresh row in
//      phone_verification_codes scoped to the current user, proving the
//      pencil-edit click leads to a clean step-1 session and not to a
//      stale step-2/3 state.
//
// Twilio is stubbed so the suite runs in CI without credentials.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this e2e test');
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { phoneVerificationCodes, users } = await import('../shared/schema');
const { eq } = await import('drizzle-orm');

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-task218-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';

function makePhone(seed: number): string {
  const tail = String(40_000_000 + ((seed * 23) % 50_000_000)).padStart(8, '0');
  return `+54911${tail}`;
}
const VERIFIED_PHONE = makePhone(process.pid + 11);
const NEW_PHONE = makePhone(process.pid + 13);

let userId = '';
let orgId = '';
let cookie = '';

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

async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `Login failed: ${res.status}`);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const live = setCookies.filter((c) => {
    const lower = c.toLowerCase();
    if (lower.includes('max-age=0')) return false;
    if (lower.includes('expires=thu, 01 jan 1970')) return false;
    return Boolean(c.split(';')[0].split('=')[1]);
  });
  assert.ok(live.length > 0, 'No live session cookie');
  return live.map((c) => c.split(';')[0].trim()).join('; ');
}

async function csrf(): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/csrf-token`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const d: { csrfToken?: string } = await r.json();
  return d.csrfToken!;
}

before(async () => {
  const u = await storage.createUser({
    email: EMAIL,
    name: 'T218 E2E',
    password: await bcrypt.hash(PASSWORD, 10),
    accountType: 'business',
  } as any);
  userId = u.id;
  await storage.createSubscription({
    userId,
    planType: 'business',
    status: 'active',
  } as any);
  const org = await storage.createOrganization({
    name: `T218 ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgId = org.id;
  await storage.createMembership({
    userId,
    organizationId: orgId,
    role: 'owner',
  } as any);
  // Plant a verified binding so the UI shows the pencil-edit button.
  await db.update(users)
    .set({ phoneNumber: VERIFIED_PHONE, phoneVerified: true })
    .where(eq(users.id, userId));
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

describe('Task #218 — "Editar teléfono" wizard restart (HTTP contract)', () => {
  it('the user starts as already-verified — the pencil-edit button is the relevant entry point', async () => {
    const r = await fetch(`${BASE_URL}/api/user`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const me = await r.json();
    assert.equal(me.phoneNumber, VERIFIED_PHONE, 'planted phone must be returned');
    assert.equal(me.phoneVerified, true, 'planted user must be already verified');
  });

  it('GET /api/whatsapp/bot-info is reachable (step-1 hydration on wizard re-open)', async () => {
    // Importantly: cookie-less. The wizard fetches this endpoint on mount
    // and on re-entry; it must not require auth or it would break the
    // re-link flow.
    const r = await fetch(`${BASE_URL}/api/whatsapp/bot-info`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.e164?.startsWith('+'), 'e164 missing or malformed');
    assert.ok(/^\d+$/.test(body.waMe), 'waMe must be digits-only');
    assert.ok(typeof body.display === 'string' && body.display.length > 0, 'display required');
    assert.ok(typeof body.defaultGreeting === 'string' && body.defaultGreeting.length > 0,
      'defaultGreeting required');
  });

  it('an already-verified user can POST /send-code with a NEW number (wizard restart)', async () => {
    // No prior verification row should exist for this user yet.
    const before = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(before.length, 0, 'no in-flight verification expected at start');

    const t = await csrf();
    const r = await fetch(`${BASE_URL}/api/user/phone/send-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'x-csrf-token': t,
      },
      body: JSON.stringify({ phoneNumber: NEW_PHONE }),
    });
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 200, `send-code on re-link must succeed; got ${r.status} ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(body.phoneNumber, NEW_PHONE,
      'send-code must echo the new normalized phone the user wants to switch to');

    // A row was planted scoped to THIS user — the wizard now has a clean
    // step-1 session it can advance from. This is the backend evidence
    // that "Editar teléfono" landed on step 1, not on a stale step 2/3.
    const after = await db.select().from(phoneVerificationCodes).where(eq(phoneVerificationCodes.userId, userId));
    assert.equal(after.length, 1, 'a fresh verification row must exist after re-link send-code');
    assert.equal(after[0].normalizedPhone, NEW_PHONE);
    assert.match(after[0].codeHash, /^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/);

    // The original verified phone is still in place — re-linking does
    // NOT clear the user's existing binding until verify-code succeeds.
    const userRow = await db.select().from(users).where(eq(users.id, userId));
    assert.equal(userRow[0].phoneNumber, VERIFIED_PHONE,
      'existing verified phone must remain until the new code is confirmed');
    assert.equal(userRow[0].phoneVerified, true);
  });
});
