import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Boot-time env vars required by transitive imports (`server/db.ts` requires
// DATABASE_URL even though we never query the real DB; `invoicingCrypto`
// requires INVOICING_ENCRYPTION_KEY for `requireInvoicingEnv` to pass).
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.INVOICING_ENCRYPTION_KEY ||= Buffer.alloc(32).toString('base64');
// Force sandbox mock: no API key + no force flag -> shouldUseSandboxMock(sandbox)=true.
delete process.env.FACTURITA_API_KEY;
delete process.env.INVOICING_SANDBOX_MOCK;

// Dynamic imports so the env above is in place before module side-effects run.
const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { registerInvoicingRoutes } = await import('../server/routes/invoicing');
const { parseMockVoucher } = await import('../server/services/mockFacturita');

const ORG_ID = 'org-test';
const USER_ID = 'user-test';

// In-memory transaction row + invoice ledger.
type TxRow = Record<string, any>;
let txRow: TxRow;
let invoiceLedger: TxRow[];
let auditLogs: any[];

// Restore originals at teardown so we don't pollute other test files.
const ORIG_STORAGE: Record<string, any> = {};
const ORIG_DB_UPDATE = (db as any).update;

function stubStorage(account: { ivaCondition: string; environment?: string; defaultSellingPoint?: number }) {
  const methods: Record<string, any> = {
    // Auth middleware needs these.
    getUser: async (_id: string) => ({ id: USER_ID, deletedAt: null }),
    getSubscriptionByUserId: async (_id: string) => ({ status: 'active' }),
    getOrganizationOwner: async (_org: string) => ({ id: USER_ID }),
    getMembershipByUserAndOrg: async (_u: string, _o: string) => ({ role: 'owner', userId: USER_ID, organizationId: ORG_ID }),
    // Endpoint needs these.
    getTransaction: async (_id: string) => txRow,
    getInvoicingAccount: async (_org: string) => ({
      id: 'acc-1',
      cuit: '20111111112',
      razonSocial: 'EMISOR',
      ivaCondition: account.ivaCondition,
      environment: account.environment ?? 'sandbox',
      defaultSellingPoint: account.defaultSellingPoint ?? 1,
      isActive: true,
      isSimulated: true,
    }),
    getSellingPointsByOrganization: async (_org: string) => ([{ number: 1, description: 'PV 1', isActive: true }]),
    getEmittedInvoicesByOrganization: async (_org: string, _opts: any) => invoiceLedger,
    createAuditLog: async (entry: any) => { auditLogs.push(entry); return entry; },
  };
  for (const [k, v] of Object.entries(methods)) {
    if (!(k in ORIG_STORAGE)) ORIG_STORAGE[k] = (storage as any)[k];
    (storage as any)[k] = v;
  }
}

// Minimal stand-in for the drizzle update chain used by the emit handler.
// Two patterns are exercised:
//   1) update().set().where().returning()  ← the idempotency lock claim
//   2) update().set().where()                ← persist invoice fields / release
// We treat any chain that ends in `.returning()` as the lock-claim (only
// applies the patch if invoiceUuid is currently null) and any `await`-on-where
// chain as an unconditional patch on the single tracked row.
function installDbStub() {
  (db as any).update = (_table: any) => ({
    set: (patch: Record<string, any>) => {
      let returningCalled = false;
      const apply = async () => {
        if (returningCalled) {
          if (txRow && txRow.invoiceUuid == null) {
            Object.assign(txRow, patch);
            return [{ id: txRow.id }];
          }
          return [];
        }
        if (txRow) Object.assign(txRow, patch);
        return undefined;
      };
      const where = (_cond: any) => {
        const builder: any = {
          then: (resolve: any, reject: any) => apply().then(resolve, reject),
          catch: (reject: any) => apply().catch(reject),
          finally: (cb: any) => apply().finally(cb),
          returning: (_cols: any) => { returningCalled = true; return apply(); },
        };
        return builder;
      };
      return { where };
    },
  });
}

function freshTx(type: 'expense' | 'income' = 'expense'): TxRow {
  return {
    id: 'tx-1',
    organizationId: ORG_ID,
    type,
    date: new Date('2026-04-01'),
    currency: 'ARS',
    invoiceUuid: null,
    invoiceVoucherId: null,
    invoiceCae: null,
    invoiceCaeExpirationDate: null,
    invoicePdfUrl: null,
    invoiceEnvironment: null,
    invoiceEmissionStatus: null,
    invoiceEmittedAt: null,
    invoiceDocType: null,
    invoiceEmitterCuit: null,
    hasInvoice: false,
    invoiceType: null,
    invoiceNumber: null,
    invoiceFileUrl: null,
    invoiceNetAmount: null,
    invoiceIvaAmount: null,
    invoiceTaxId: null,
    invoiceAddress: null,
    invoicePhone: null,
    invoiceSimulated: null,
  };
}

let server: Server;
let baseUrl: string;

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject a session BEFORE invoicing routes register their requireAuth.
  app.use((req: any, _res, next) => {
    req.session = {
      userId: USER_ID,
      organizationId: ORG_ID,
      destroy: (cb: any) => cb && cb(),
    };
    next();
  });
  registerInvoicingRoutes(app);
  return app;
}

before(async () => {
  installDbStub();
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  // Restore everything we monkey-patched.
  for (const [k, v] of Object.entries(ORIG_STORAGE)) (storage as any)[k] = v;
  (db as any).update = ORIG_DB_UPDATE;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  txRow = freshTx('expense');
  invoiceLedger = [];
  auditLogs = [];
});

async function emit(body: any) {
  const res = await fetch(`${baseUrl}/api/invoicing/transactions/${txRow.id}/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: any = {};
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

const baseReceiverRI = {
  taxId: '20222222223',
  name: 'Proveedor SA',
  ivaCondition: 'responsable_inscripto' as const,
};

const baseReceiverConsumidor = {
  taxId: null,
  name: 'Proveedor Final',
  ivaCondition: 'consumidor_final' as const,
};

const baseItems = [{ description: 'Devolución', quantity: 1, unitPriceNet: 100, ivaAliquot: 21 }];

function assertPersistedNote(docType: string) {
  assert.equal(txRow.invoiceDocType, docType, 'invoiceDocType must be persisted');
  assert.equal(txRow.invoiceType, docType, 'legacy invoiceType mirror must match');
  assert.equal(txRow.invoiceSimulated, true, 'invoiceSimulated must be true for mock-emitted notes');
  assert.equal(txRow.invoiceEmissionStatus, 'emitted', 'invoiceEmissionStatus must be "emitted"');
  assert.equal(txRow.hasInvoice, true, 'hasInvoice must flip to true');
  assert.equal(txRow.invoiceEnvironment, 'sandbox');
  assert.ok(txRow.invoiceUuid && !String(txRow.invoiceUuid).startsWith('pending-'),
    'invoiceUuid must be replaced by the real (mock) uuid, not the pending lock');
  assert.match(String(txRow.invoiceUuid), /^mock-/, 'mock emitter must use mock- prefix');
  // PPPP-NNNNNNNN format check via the canonical parser.
  const parsed = parseMockVoucher(txRow.invoiceVoucherId);
  assert.ok(parsed, `invoiceVoucherId "${txRow.invoiceVoucherId}" must match PPPP-NNNNNNNN`);
  assert.equal(txRow.invoiceNumber, txRow.invoiceVoucherId, 'invoiceNumber must mirror invoiceVoucherId');
  assert.ok(txRow.invoiceCae, 'CAE must be persisted');
}

describe('POST /api/invoicing/transactions/:id/emit — persistence of NCA/NDA/NCC/NDC (mock)', () => {
  it('persists a simulated NCA with all expected fields', async () => {
    stubStorage({ ivaCondition: 'responsable_inscripto' });
    const { status, body } = await emit({
      docType: 'NCA',
      receiver: baseReceiverRI,
      items: baseItems,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assertPersistedNote('NCA');
    assert.ok(auditLogs.some(l => l.action === 'invoice_emitted'),
      'must write an invoice_emitted audit log');
  });

  it('persists a simulated NDA with all expected fields', async () => {
    stubStorage({ ivaCondition: 'responsable_inscripto' });
    const { status, body } = await emit({
      docType: 'NDA',
      receiver: baseReceiverRI,
      items: baseItems,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assertPersistedNote('NDA');
  });

  it('persists a simulated NCC with all expected fields', async () => {
    stubStorage({ ivaCondition: 'monotributo' });
    const { status, body } = await emit({
      docType: 'NCC',
      receiver: baseReceiverConsumidor,
      items: baseItems,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assertPersistedNote('NCC');
  });

  it('persists a simulated NDC with all expected fields', async () => {
    stubStorage({ ivaCondition: 'monotributo' });
    const { status, body } = await emit({
      docType: 'NDC',
      receiver: baseReceiverConsumidor,
      items: baseItems,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assertPersistedNote('NDC');
  });

  it('returns 409 when the idempotency lock was already claimed (TOCTOU race)', async () => {
    stubStorage({ ivaCondition: 'responsable_inscripto' });
    const first = await emit({ docType: 'NCA', receiver: baseReceiverRI, items: baseItems });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assertPersistedNote('NCA');

    // Simulate the race: a second client read the tx BEFORE the first one
    // claimed the lock (so it sees invoiceUuid=null) but by the time it
    // tries to claim the lock, the row has already been updated. Returning a
    // stale snapshot from `storage.getTransaction` lets the early "ya tiene
    // factura" check pass and forces execution into the conditional UPDATE,
    // which is exactly the path the 409 is meant to guard.
    const snapshot = { ...txRow };
    (storage as any).getTransaction = async (_id: string) => ({
      ...txRow,
      invoiceUuid: null,
      invoiceVoucherId: null,
      invoiceDocType: null,
      invoiceEmissionStatus: null,
      hasInvoice: false,
      invoiceSimulated: null,
    });
    const second = await emit({ docType: 'NCA', receiver: baseReceiverRI, items: baseItems });
    assert.equal(second.status, 409, 'second emission must be rejected by the lock');
    // Persisted invoice data must remain untouched.
    assert.equal(txRow.invoiceUuid, snapshot.invoiceUuid);
    assert.equal(txRow.invoiceVoucherId, snapshot.invoiceVoucherId);
    assert.equal(txRow.invoiceCae, snapshot.invoiceCae);
    assert.equal(txRow.invoiceEmissionStatus, snapshot.invoiceEmissionStatus);
  });
});
