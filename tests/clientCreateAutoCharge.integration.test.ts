import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Task #315 — Integración de POST/PATCH /api/clients con el disparo automático
// de cobro mensual para clientes suscriptores.
//
// Lo que se valida acá (a pedido del code review):
//
//   1) POST con plan + cantidad genera una transacción de tipo `receivable`
//      Y un audit log con acción `client_create_auto_charge`.
//   2) POST sin cantidad NO genera la transacción pero NO rompe el alta
//      (la respuesta sigue siendo 200 con el cliente recién creado).
//   3) PATCH que reactiva un cliente (isActive false -> true con datos
//      suficientes) genera la transacción y un audit log
//      `client_update_auto_charge`.
//   4) PATCH repetido en el mismo mes NO duplica la transacción: el claim
//      atómico de `subscriberLastBilledMonth` colapsa la segunda llamada.
//   5) `subscriberStartMonth` futuro NO genera transacción (caso del
//      cliente cargado por adelantado).
//
// Estrategia de stubbing: imitamos el patrón de
// `tests/facturitaResetSellingPoint.integration.test.ts` reemplazando
// métodos del singleton `storage` y del singleton `db` (sólo `transaction`,
// que es el único método que el servicio toca). Eso nos permite levantar
// un Express real con las rutas reales pero sin pegarle a Postgres.

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { storage } = await import('../server/storage');
const { db } = await import('../server/db');
const { registerOperationRoutes } = await import('../server/routes/operations');

interface ClientRow {
  id: string;
  organizationId: string;
  name: string;
  clientType: string | null;
  isActive: boolean;
  status: string;
  subscriberPlanId: string | null;
  subscriberQuantity: number | null;
  subscriberUnitPriceOverride: string | null;
  subscriberCurrencyOverride: string | null;
  subscriberBillingDay: number | null;
  subscriberStartMonth: string | null;
  subscriberLastBilledMonth: string | null;
}

interface AuditLogEntry {
  action: string;
  entityType: string;
  entityId: string;
  newData: string | null;
}

interface InsertedTxRow {
  id: string;
  organizationId: string;
  type: string;
  amount: string;
  currency: string;
  clientId: string;
}

const ORG_ID = 'org-test-315';
const USER_ID = 'user-test-315';
const PLAN_ID = '11111111-1111-4111-8111-111111111111';

const ORIG_STORAGE: Record<string, unknown> = {};
const ORIG_DB_TRANSACTION = db.transaction.bind(db);

let clientStore: Map<string, ClientRow>;
let auditLogs: AuditLogEntry[];
let insertedTransactions: InsertedTxRow[];
let nextClientIdSeq: number;
let nextTxIdSeq: number;

function stubStorage(): void {
  const methods: Record<string, (...args: any[]) => any> = {
    // requireAuth chain
    getUser: async () => ({ id: USER_ID, deletedAt: null }),
    getSubscriptionByUserId: async () => ({ status: 'active' }),
    getOrganizationOwner: async () => ({ id: USER_ID }),
    getMembershipByUserAndOrg: async () => ({ role: 'owner', userId: USER_ID, organizationId: ORG_ID }),
    // route storage calls
    getSubscriptionPlan: async (id: string) => (id === PLAN_ID
      ? { id: PLAN_ID, organizationId: ORG_ID, name: 'Plan Test', currency: 'ARS', monthlyPrice: '5000.00', isActive: true }
      : undefined),
    createClient: async (data: Partial<ClientRow>) => {
      const id = `cli-${++nextClientIdSeq}`;
      const row: ClientRow = {
        id,
        organizationId: data.organizationId || ORG_ID,
        name: data.name || 'Cliente',
        clientType: data.clientType ?? null,
        isActive: data.isActive ?? true,
        status: data.status ?? 'active',
        subscriberPlanId: data.subscriberPlanId ?? null,
        subscriberQuantity: data.subscriberQuantity ?? null,
        subscriberUnitPriceOverride: data.subscriberUnitPriceOverride ?? null,
        subscriberCurrencyOverride: data.subscriberCurrencyOverride ?? null,
        subscriberBillingDay: data.subscriberBillingDay ?? null,
        subscriberStartMonth: data.subscriberStartMonth ?? null,
        subscriberLastBilledMonth: null,
      };
      clientStore.set(id, row);
      return row;
    },
    getClient: async (id: string) => clientStore.get(id),
    updateClient: async (id: string, updates: Partial<ClientRow>) => {
      const current = clientStore.get(id);
      if (!current) return undefined;
      const merged: ClientRow = { ...current, ...updates };
      clientStore.set(id, merged);
      return merged;
    },
    createAuditLog: async (entry: AuditLogEntry) => {
      auditLogs.push(entry);
      return entry;
    },
  };
  for (const [k, v] of Object.entries(methods)) {
    if (!(k in ORIG_STORAGE)) ORIG_STORAGE[k] = (storage as unknown as Record<string, unknown>)[k];
    (storage as unknown as Record<string, unknown>)[k] = v;
  }
}

// Stub minimalista de `db.transaction`. Sólo simulamos lo que
// `generateChargeForClient` necesita: el callback recibe un `tx` que sabe
// hacer (1) update(clientsTable).set().where().returning() — donde la
// semántica del claim es "si el subscriberLastBilledMonth todavía no
// alcanzó el mes actual, lo avanzo y devuelvo [{id}]; si no, devuelvo []",
// y (2) insert(transactionsTable).values(v).returning() — guardo la row y
// la devuelvo. El claim se hace contra `clientStore` (estado real del
// test) para que la idempotencia entre llamadas funcione naturalmente.
function stubDbTransaction(): void {
  (db as unknown as { transaction: typeof db.transaction }).transaction = (async (callback: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      update: (_table: unknown) => {
        let setValues: Record<string, unknown> = {};
        let targetClientId: string | null = null;
        let requireLastBilledLessThanMonth: string | null = null;
        const chain = {
          set: (vals: Record<string, unknown>) => { setValues = vals; return chain; },
          where: (_cond: unknown) => chain,
          returning: async (_sel?: unknown) => {
            // No podemos parsear las condiciones de Drizzle sin reimplementarlas.
            // En su lugar interpretamos los `setValues`: si trae
            // subscriberLastBilledMonth, es el claim; chequeamos contra
            // todos los clientes para encontrar el matching y aplicamos el
            // guard "<" manualmente.
            const newMonth = setValues.subscriberLastBilledMonth as string | undefined;
            for (const row of clientStore.values()) {
              if (typeof newMonth === 'string') {
                const cur = row.subscriberLastBilledMonth;
                if (cur === null || cur < newMonth) {
                  row.subscriberLastBilledMonth = newMonth;
                  targetClientId = row.id;
                  return [{ id: row.id }];
                }
              }
            }
            void requireLastBilledLessThanMonth;
            void targetClientId;
            return [];
          },
        };
        return chain;
      },
      insert: (_table: unknown) => {
        let txValues: Record<string, unknown> = {};
        const chain = {
          values: (v: Record<string, unknown>) => { txValues = v; return chain; },
          returning: async () => {
            const id = `tx-${++nextTxIdSeq}`;
            const row: InsertedTxRow = {
              id,
              organizationId: String(txValues.organizationId),
              type: String(txValues.type),
              amount: String(txValues.amount),
              currency: String(txValues.currency),
              clientId: String(txValues.clientId),
            };
            insertedTransactions.push(row);
            return [row];
          },
        };
        return chain;
      },
    };
    return callback(tx);
  }) as unknown as typeof db.transaction;
}

let server: Server;
let baseUrl = '';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as unknown as { session: unknown }).session = {
      userId: USER_ID,
      organizationId: ORG_ID,
      destroy: (cb: () => void) => cb && cb(),
    };
    next();
  });
  registerOperationRoutes(app);
  return app;
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

after(async () => {
  for (const [k, v] of Object.entries(ORIG_STORAGE)) {
    (storage as unknown as Record<string, unknown>)[k] = v;
  }
  (db as unknown as { transaction: typeof db.transaction }).transaction = ORIG_DB_TRANSACTION;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  clientStore = new Map();
  auditLogs = [];
  insertedTransactions = [];
  nextClientIdSeq = 0;
  nextTxIdSeq = 0;
  stubStorage();
  stubDbTransaction();
});

async function postClient(body: Record<string, unknown>): Promise<{ status: number; body: { id?: string; [k: string]: unknown } }> {
  const res = await fetch(`${baseUrl}/api/clients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: { id?: string; [k: string]: unknown } = {};
  try { json = await res.json() as typeof json; } catch { /* respuesta vacía */ }
  return { status: res.status, body: json };
}

async function patchClient(id: string, body: Record<string, unknown>): Promise<{ status: number; body: { id?: string; [k: string]: unknown } }> {
  const res = await fetch(`${baseUrl}/api/clients/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json: { id?: string; [k: string]: unknown } = {};
  try { json = await res.json() as typeof json; } catch { /* respuesta vacía */ }
  return { status: res.status, body: json };
}

const FAR_PAST_MONTH = '2020-01';
const FAR_FUTURE_MONTH = '2099-12';

describe('POST /api/clients — auto-charge side-effect (Task #315)', () => {
  it('alta de suscriptor con plan y cantidad genera receivable y audit log', async () => {
    const { status, body } = await postClient({
      name: 'Suscriptor Feliz',
      clientType: 'suscriptores',
      subscriberPlanId: PLAN_ID,
      subscriberQuantity: 3,
      subscriberStartMonth: FAR_PAST_MONTH,
      subscriberBillingDay: 5,
      status: 'active',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.id, 'esperaba id del cliente creado');

    // Se persistió una receivable por 3 * 5000 = 15000 ARS.
    assert.equal(insertedTransactions.length, 1, `esperaba 1 transacción, obtuve ${insertedTransactions.length}`);
    const tx = insertedTransactions[0];
    assert.equal(tx.type, 'receivable');
    assert.equal(tx.amount, '15000.00');
    assert.equal(tx.currency, 'ARS');
    assert.equal(tx.clientId, body.id);

    // Audit logs: uno por el create (action='create') y otro por el
    // side-effect (action='client_create_auto_charge').
    const autoChargeAudit = auditLogs.find(a => a.action === 'client_create_auto_charge');
    assert.ok(autoChargeAudit, `esperaba audit log client_create_auto_charge; obtuve ${auditLogs.map(a => a.action).join(', ')}`);
    assert.equal(autoChargeAudit.entityType, 'client');
    assert.equal(autoChargeAudit.entityId, body.id);
    const parsed = JSON.parse(autoChargeAudit.newData!) as { transactionId: string; amount: string; currency: string };
    assert.equal(parsed.transactionId, tx.id);
    assert.equal(parsed.amount, '15000.00');
    assert.equal(parsed.currency, 'ARS');
  });

  it('alta de suscriptor SIN cantidad NO genera receivable pero el alta sigue exitosa', async () => {
    const { status, body } = await postClient({
      name: 'Suscriptor Incompleto',
      clientType: 'suscriptores',
      subscriberPlanId: PLAN_ID,
      // sin subscriberQuantity — gate `no_quantity` debe activarse
      status: 'active',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.id);
    assert.equal(insertedTransactions.length, 0);
    const autoChargeAudit = auditLogs.find(a => a.action === 'client_create_auto_charge');
    assert.equal(autoChargeAudit, undefined, 'no debería existir el audit de cobro automático');
  });

  it('alta con subscriberStartMonth futuro NO genera receivable (cliente cargado por adelantado)', async () => {
    const { status, body } = await postClient({
      name: 'Suscriptor del Futuro',
      clientType: 'suscriptores',
      subscriberPlanId: PLAN_ID,
      subscriberQuantity: 2,
      subscriberStartMonth: FAR_FUTURE_MONTH,
      status: 'active',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.id);
    assert.equal(insertedTransactions.length, 0);
    const autoChargeAudit = auditLogs.find(a => a.action === 'client_create_auto_charge');
    assert.equal(autoChargeAudit, undefined);
  });

  it('alta de suscriptor CON cantidad pero SIN plan ni override NO genera receivable', async () => {
    // Caso explícito del texto del task: el usuario pone "tipo
    // suscriptores" + cantidad pero todavía no eligió plan ni puso un
    // precio override. Gate `no_price` debe activarse.
    const { status, body } = await postClient({
      name: 'Suscriptor sin Plan',
      clientType: 'suscriptores',
      subscriberQuantity: 2,
      subscriberStartMonth: FAR_PAST_MONTH,
      status: 'active',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(body.id);
    assert.equal(insertedTransactions.length, 0);
    assert.equal(auditLogs.find(a => a.action === 'client_create_auto_charge'), undefined);
  });

  it('alta de cliente NO suscriptor no dispara la generación', async () => {
    const { status, body } = await postClient({
      name: 'Cliente Común',
      clientType: 'clientes',
      status: 'active',
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(insertedTransactions.length, 0);
    assert.equal(auditLogs.find(a => a.action === 'client_create_auto_charge'), undefined);
  });
});

describe('PATCH /api/clients/:id — auto-charge side-effect (Task #315)', () => {
  it('reactivar un suscriptor completo genera receivable y audit log de update', async () => {
    // Pre-condición: cliente suscriptor con datos completos pero inactivo
    // (status='inactive' lo bloqueó del cron). Cuando lo reactivamos,
    // queremos que el cobro del mes se genere en el acto.
    const created = await postClient({
      name: 'Suscriptor a Reactivar',
      clientType: 'suscriptores',
      subscriberPlanId: PLAN_ID,
      subscriberQuantity: 1,
      subscriberStartMonth: FAR_PAST_MONTH,
      status: 'inactive',
      isActive: false,
    });
    assert.equal(created.status, 200);
    assert.equal(insertedTransactions.length, 0, 'el alta inactiva no debería haber generado nada');
    auditLogs.length = 0; // reset para aislar el assert del PATCH

    const { status, body } = await patchClient(created.body.id!, {
      status: 'active',
      isActive: true,
    });

    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(insertedTransactions.length, 1, 'esperaba que el PATCH generara la receivable');
    const updateAudit = auditLogs.find(a => a.action === 'client_update_auto_charge');
    assert.ok(updateAudit, `esperaba audit client_update_auto_charge; obtuve ${auditLogs.map(a => a.action).join(', ')}`);
  });

  it('PATCH repetido en el mismo mes NO duplica la receivable (idempotencia)', async () => {
    // Creamos un suscriptor que ya generó su cobro en el alta.
    const created = await postClient({
      name: 'Suscriptor Idempotente',
      clientType: 'suscriptores',
      subscriberPlanId: PLAN_ID,
      subscriberQuantity: 1,
      subscriberStartMonth: FAR_PAST_MONTH,
      status: 'active',
    });
    assert.equal(insertedTransactions.length, 1, 'el alta debió generar 1 receivable');

    // Cualquier edición posterior (por ejemplo cambiar el nombre) NO debe
    // generar una segunda receivable: el claim atómico en
    // `subscriberLastBilledMonth` rechaza el segundo intento.
    const { status } = await patchClient(created.body.id!, { name: 'Suscriptor Idempotente v2' });
    assert.equal(status, 200);
    assert.equal(insertedTransactions.length, 1, 'no debería haberse generado una segunda receivable');
    // Y por lo tanto tampoco hay audit log de auto-charge del update.
    const updateAudit = auditLogs.find(a => a.action === 'client_update_auto_charge');
    assert.equal(updateAudit, undefined);
  });
});
