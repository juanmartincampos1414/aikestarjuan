import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// End-to-end test for the orphan-transfer repair UI flow (Task #178).
//
// This test treats the running dev server (http://localhost:5000) as a black
// box and walks through the SAME HTTP contract the React UI in
// `client/src/pages/transactions.tsx` uses when the user clicks the
// "Reparar transferencia" button on the orphan banner:
//
//   1. POST /api/auth/login                              (login → session cookie)
//   2. GET  /api/transactions/:id                        (returns isOrphanTransfer:true → renders banner)
//   3. POST /api/transactions/:id/repair-transfer        (recreate-pair OR convert)
//   4. GET  /api/transactions/:id                        (returns isOrphanTransfer:false → banner disappears)
//
// Two cases are covered, mirroring the two buttons on the banner:
//   - "Recrear contraparte"        → action: 'recreate-pair'
//   - "Convertir en ingreso/gasto" → action: 'convert'
//
// Visual / DOM coverage of the same flow is documented in
// `tests/e2e/repairTransferUI.e2e.md` for execution via the Replit `runTest`
// (Playwright) tool. This file is the executable, repeatable counterpart.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run the orphan-transfer UI e2e test');
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

const { storage } = await import('../server/storage');

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-repair-ui-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';

let userId: string;
let organizationId: string;
let cajaId: string;
let bancoId: string;
let cookie = '';

async function loginAndCaptureCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `Login failed: ${res.status} ${await res.text()}`);

  // The login handler emits MANY Set-Cookie headers: it clears every variation
  // of `aikestarsid` and `connect.sid` cookies before regenerating the
  // session, then sets the new `aikestarsid`. We need to skip the clearing
  // entries (Max-Age=0 / Expires in the past) and keep the live session
  // cookie(s).
  const setCookies = res.headers.getSetCookie?.() ?? [];
  assert.ok(setCookies.length > 0, 'Login response must set at least one cookie');

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

async function getTransaction(id: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/transactions/${id}`, {
    headers: { Cookie: cookie },
  });
  const raw = await res.text();
  assert.equal(res.status, 200, `GET /api/transactions/${id} failed: ${res.status} ${raw}`);
  return JSON.parse(raw);
}

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/csrf-token`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'CSRF token endpoint must return 200');
  const data: { csrfToken?: string } = await res.json();
  assert.ok(data.csrfToken, 'CSRF token endpoint must return a non-empty token');
  return data.csrfToken;
}

async function postRepair(id: string, body: unknown): Promise<{ status: number; body: any }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch(`${BASE_URL}/api/transactions/${id}/repair-transfer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

before(async () => {
  // Seed a self-contained user/org graph so the test is hermetic.
  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  const user = await storage.createUser({
    email: EMAIL,
    name: 'E2E Repair UI Tester',
    password: hashedPassword,
    accountType: 'business',
  } as any);
  userId = user.id;

  // The auth middleware (server/routes/middleware.ts) rejects requests with
  // 402 SUBSCRIPTION_REQUIRED unless the user has a row in `subscriptions`
  // with status in ('active','trialing'). Without this the React UI would
  // never get past /login, so this is part of the "user can use the app" e2e.
  await storage.createSubscription({
    userId,
    planType: 'business',
    status: 'active',
  } as any);

  const org = await storage.createOrganization({
    name: `Repair UI E2E ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  organizationId = org.id;

  await storage.createMembership({
    userId,
    organizationId,
    role: 'owner',
  } as any);

  const caja = await storage.createAccount({
    name: `Caja E2E ${SUFFIX}`,
    type: 'cash',
    currency: 'ARS',
    balance: '10000',
    organizationId,
  });
  cajaId = caja.id;

  const banco = await storage.createAccount({
    name: `Banco E2E ${SUFFIX}`,
    type: 'bank',
    currency: 'ARS',
    balance: '0',
    organizationId,
  });
  bancoId = banco.id;

  cookie = await loginAndCaptureCookie();
});

after(async () => {
  if (organizationId) await storage.deleteOrganization(organizationId);
  if (userId) await storage.deleteUser(userId);
});

describe('Orphan-transfer repair UI — end-to-end via HTTP API', () => {
  it('"Recrear contraparte": GET shows orphan banner → POST repair → GET no longer shows banner; counterpart row exists in DB with same transfer_pair_id', async () => {
    // Create ORPHAN A: a transfer_out from Caja with NO transfer_pair_id.
    // This is exactly the shape that makes `isOrphanTransfer=true` on the
    // detail endpoint and therefore renders `data-testid="banner-orphan-transfer"`
    // in the React detail dialog.
    const orphan = await storage.createTransaction({
      type: 'transfer_out',
      amount: '750',
      currency: 'ARS',
      description: `E2E orphan OUT ${SUFFIX}`,
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: cajaId,
      organizationId,
      status: 'completed',
    });

    // Step A: the UI fetches the detail. Banner renders iff isOrphanTransfer.
    const before = await getTransaction(orphan.id);
    assert.equal(before.isOrphanTransfer, true, 'Detail endpoint must report orphan so the UI banner renders');
    assert.equal(before.orphanReason, 'no_pair_id');
    assert.equal(before.type, 'transfer_out');

    // Step B: user clicks "Recrear contraparte" → "Confirmar".
    const { status, body } = await postRepair(orphan.id, {
      action: 'recreate-pair',
      counterpartAccountId: bancoId,
    });
    assert.equal(status, 200, `Repair failed: ${JSON.stringify(body)}`);
    assert.ok(body.success ?? body.transaction ?? body.pairId, 'Repair response should signal success');

    // Step C: the UI invalidates the detail query and re-fetches. Banner must disappear.
    const after = await getTransaction(orphan.id);
    assert.equal(after.isOrphanTransfer, false, 'After repair, detail endpoint must no longer report the transaction as orphan (banner disappears)');
    assert.ok(after.transferPairId, 'Original orphan should now have a transfer_pair_id');
    assert.ok(after.transferPair, 'Detail endpoint should expose the linked counterpart');
    assert.equal(after.transferPair.type, 'transfer_in');
    assert.equal(after.transferPair.accountId, bancoId);
    assert.equal(Number(after.transferPair.amount), 750);
    assert.equal(after.transferPair.status, 'completed');
  });

  it('"Convertir en ingreso/gasto": GET shows orphan banner → POST convert → GET no longer shows banner; row was flipped to income with cleared transfer_pair_id', async () => {
    // Create ORPHAN B: a transfer_in to Banco with a stale transfer_pair_id
    // pointing at no row at all. This is the second orphan flavour
    // (orphanReason: 'missing_counterpart').
    const stalePairId = crypto.randomUUID();
    const orphan = await storage.createTransaction({
      type: 'transfer_in',
      amount: '300',
      currency: 'ARS',
      description: `E2E orphan IN ${SUFFIX}`,
      category: 'Transferencia Interna',
      date: new Date(),
      imputationDate: new Date(),
      accountId: bancoId,
      organizationId,
      status: 'completed',
      transferPairId: stalePairId,
    });

    const before = await getTransaction(orphan.id);
    assert.equal(before.isOrphanTransfer, true, 'Detail endpoint must report orphan so the UI banner renders');
    assert.equal(before.orphanReason, 'missing_counterpart');
    assert.equal(before.type, 'transfer_in');

    // The convert button label in the UI says "ingreso" because converting a
    // transfer_in sign-preserves into income; we send that newType here.
    const { status, body } = await postRepair(orphan.id, {
      action: 'convert',
      newType: 'income',
    });
    assert.equal(status, 200, `Convert failed: ${JSON.stringify(body)}`);

    const after = await getTransaction(orphan.id);
    assert.equal(after.isOrphanTransfer, false, 'After convert, detail endpoint must no longer report the transaction as orphan (banner disappears)');
    assert.equal(after.type, 'income', 'Row should have been flipped to income');
    assert.equal(after.transferPairId, null, 'Stale transfer_pair_id should be cleared');
    assert.match(
      String(after.description ?? ''),
      /Convertida desde transferencia huérfana/i,
      'Description should be annotated to indicate the conversion',
    );
  });
});
