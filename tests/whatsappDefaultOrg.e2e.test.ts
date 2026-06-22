import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

// Task #207 — End-to-end del endpoint que controla la organización por
// defecto del bot de WhatsApp. Cubre:
//
//   1. GET /api/user/whatsapp-default-organization (vacío al inicio)
//   2. PUT con orgId válido → guarda y devuelve { valid: true }
//   3. GET refleja el cambio
//   4. PUT con orgId al que el usuario NO pertenece → 403
//   5. PUT con null → limpia la default
//   6. PUT /api/whatsapp-preferences cuando la default está vacía
//      auto-asigna esa org como default (mejora UX para usuarios actuales)
//      y devuelve `autoAssignedDefault: true`.
//
// Usa el mismo patrón de los e2e existentes: dev server en localhost:5000,
// usuario y orgs sembradas vía storage para ser hermético.

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run this e2e test');
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';

const { storage } = await import('../server/storage');

const SUFFIX = `${process.pid}_${Date.now()}`;
const EMAIL = `e2e-wa-default-${SUFFIX}@test.local`;
const PASSWORD = 'Test1234!';

let userId: string;
let orgAId: string;
let orgBId: string;
let orgForeignId: string;
let cookie = '';

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
  assert.ok(data.csrfToken, 'CSRF token endpoint must return a non-empty token');
  return data.csrfToken;
}

async function getDefault(): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/api/user/whatsapp-default-organization`, {
    headers: { Cookie: cookie },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function putDefault(organizationId: string | null): Promise<{ status: number; body: any }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch(`${BASE_URL}/api/user/whatsapp-default-organization`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({ organizationId }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function putPrefs(organizationId: string): Promise<{ status: number; body: any }> {
  const csrfToken = await fetchCsrfToken();
  const res = await fetch(`${BASE_URL}/api/whatsapp-preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify({
      organizationId,
      preferredAccountId: null,
      preferredExpenseCategory: null,
      preferredIncomeCategory: null,
      defaultHasInvoice: null,
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

before(async () => {
  const hashedPassword = await bcrypt.hash(PASSWORD, 10);
  const user = await storage.createUser({
    email: EMAIL,
    name: 'E2E WA Default Tester',
    password: hashedPassword,
    accountType: 'business',
  } as any);
  userId = user.id;

  await storage.createSubscription({
    userId,
    planType: 'business',
    status: 'active',
  } as any);

  const orgA = await storage.createOrganization({
    name: `Org A ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgAId = orgA.id;

  const orgB = await storage.createOrganization({
    name: `Org B ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgBId = orgB.id;

  // Org en la que el usuario NO es miembro — para validar el guard 403.
  const orgForeign = await storage.createOrganization({
    name: `Org Foreign ${SUFFIX}`,
    type: 'business',
    country: 'AR',
    defaultCurrency: 'ARS',
  });
  orgForeignId = orgForeign.id;

  await storage.createMembership({ userId, organizationId: orgAId, role: 'owner' } as any);
  await storage.createMembership({ userId, organizationId: orgBId, role: 'owner' } as any);

  cookie = await loginAndCaptureCookie();
});

after(async () => {
  // Limpieza best-effort. No falla si algo no se borra (FKs).
  try { await storage.deleteOrganization(orgAId); } catch {}
  try { await storage.deleteOrganization(orgBId); } catch {}
  try { await storage.deleteOrganization(orgForeignId); } catch {}
});

describe('WhatsApp default organization endpoint (Task #207)', () => {
  it('GET inicial devuelve organizationId=null (usuario nuevo)', async () => {
    const { status, body } = await getDefault();
    assert.equal(status, 200);
    assert.equal(body.organizationId, null);
    assert.equal(body.valid, false);
  });

  it('PUT con orgId válido (orgB) guarda y devuelve valid:true', async () => {
    const { status, body } = await putDefault(orgBId);
    assert.equal(status, 200, `PUT failed: ${JSON.stringify(body)}`);
    assert.equal(body.organizationId, orgBId);
    assert.equal(body.valid, true);
  });

  it('GET refleja la default que acabamos de guardar', async () => {
    const { status, body } = await getDefault();
    assert.equal(status, 200);
    assert.equal(body.organizationId, orgBId);
    assert.equal(body.valid, true);
  });

  it('PUT con orgId al que el usuario NO pertenece devuelve 403', async () => {
    const { status, body } = await putDefault(orgForeignId);
    assert.equal(status, 403, `Expected 403, got ${status}: ${JSON.stringify(body)}`);
  });

  it('Después del 403, la default anterior NO se modificó', async () => {
    const { body } = await getDefault();
    assert.equal(body.organizationId, orgBId, 'La default no debió cambiar tras un 403');
  });

  it('PUT con null limpia la default', async () => {
    const { status, body } = await putDefault(null);
    assert.equal(status, 200);
    assert.equal(body.organizationId, null);
    assert.equal(body.valid, false);
  });

  it('Después de un clear explícito, PUT prefs NO debe auto-asignar la default', async () => {
    // Pre-condición: el test anterior hizo PUT con null (clear explícito),
    // lo cual marca whatsappDefaultOrgInitialized=true. El auto-assign NO
    // debe correr aunque la default esté vacía: respetamos la decisión
    // explícita del usuario de no tener default.
    const pre = await getDefault();
    assert.equal(pre.body.organizationId, null);

    const { status, body } = await putPrefs(orgAId);
    assert.equal(status, 200, `PUT prefs failed: ${JSON.stringify(body)}`);
    assert.equal(
      body.autoAssignedDefault,
      false,
      'No debió auto-asignar tras un clear explícito previo'
    );

    const post = await getDefault();
    assert.equal(post.body.organizationId, null, 'La default debe seguir siendo null');
  });

  it('PUT /api/whatsapp-preferences auto-asigna la default en usuarios sin inicializar (legacy)', async () => {
    // Reset directo en DB del flag para simular un usuario legacy que
    // nunca tocó el endpoint de whatsapp-default-organization.
    await storage.updateUser(userId, {
      whatsappDefaultOrganizationId: null,
      whatsappDefaultOrgInitialized: false,
    } as any);

    const pre = await getDefault();
    assert.equal(pre.body.organizationId, null);

    const { status, body } = await putPrefs(orgAId);
    assert.equal(status, 200, `PUT prefs failed: ${JSON.stringify(body)}`);
    assert.equal(body.autoAssignedDefault, true, 'El server debió auto-asignar la default');

    const post = await getDefault();
    assert.equal(post.body.organizationId, orgAId);
    assert.equal(post.body.valid, true);
  });

  it('PUT prefs subsiguiente NO sobrescribe la default ya seteada', async () => {
    // Pre-condición: default ya es orgA (del test anterior).
    const { status, body } = await putPrefs(orgBId);
    assert.equal(status, 200);
    assert.equal(body.autoAssignedDefault, false, 'No debió auto-asignar otra vez');

    const post = await getDefault();
    assert.equal(post.body.organizationId, orgAId, 'La default debe seguir siendo orgA');
  });
});
