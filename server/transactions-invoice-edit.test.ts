// Task #491 — Tests de regresión para editar movimientos con factura.
//
// El fix de Task #489 corrige un bug de producción: editar un movimiento que
// ya tenía un `invoiceNumber` NO canónico (movimientos viejos previos a la
// validación de formato, o facturas emitidas por ARCA que guardan el número
// "pelado") fallaba con 400, porque cualquier edición re-envía el número
// existente y el handler lo revalidaba a ciegas. La regla correcta es: validar
// el formato canónico (PPPP-NNNNNNNN) SÓLO cuando `invoiceNumber` cambia
// respecto del valor guardado.
//
// Estos tests ejercitan el endpoint real `PATCH /api/transactions/:id`
// (montado vía `registerTransactionRoutes`) cubriendo:
//   (a) número histórico no canónico SIN cambios + se edita otro campo => 200
//       (no se revalida el formato).
//   (b) se cambia el número a un valor inválido ("abc") => 400 con
//       field:'invoiceNumber'.
//   (c) se cambia el número a un canónico válido ("0001-00001234") => 200.
//   (d) limpiar la factura (hasInvoice=false / invoiceNumber=null) => 200.
//
// Corre en CI sin Postgres real: levantamos un Express con el router montado,
// inyectamos una sesión válida con un middleware y parcheamos los métodos del
// singleton `storage` que tocan los middlewares de auth/permiso y el happy
// path del handler. La ruta feliz elegida (un `expense` ya `completed` editado
// sólo en campos no monetarios) no toca la base ni `db`.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';

// db.ts abre un Pool al importarse (no conecta hasta una query). URL dummy para
// que el import no falle en CI; el happy path del test no ejecuta queries.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { storage } = await import('./storage');
const { registerTransactionRoutes } = await import('./routes/transactions');
const { INVOICE_NUMBER_FORMAT_MESSAGE } = await import('@shared/schema');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const TX_ID = 'tx-1';

// Movimiento de base: un gasto YA completado con una factura cuyo número es
// histórico/no canónico (el caso que rompía en producción).
function baseTransaction(): any {
  return {
    id: TX_ID,
    organizationId: ORG_ID,
    type: 'expense',
    amount: '100.00',
    currency: 'ARS',
    description: 'Compra original',
    category: 'Insumos',
    status: 'completed',
    accountId: null,
    hasInvoice: true,
    invoiceNumber: '12345', // no canónico (sin guion ni padding)
    date: new Date('2026-01-15'),
    createdAt: new Date('2026-01-15'),
  };
}

let currentTx: any;
let lastUpdateArgs: { id: string; updates: any } | null = null;

// Guardamos los métodos originales del singleton para restaurarlos al final.
const originals = {
  getUser: storage.getUser,
  getSubscriptionByUserId: storage.getSubscriptionByUserId,
  getMembershipByUserAndOrg: storage.getMembershipByUserAndOrg,
  getTransaction: storage.getTransaction,
  updateTransaction: storage.updateTransaction,
  createAuditLog: storage.createAuditLog,
};

let server: Server;
let baseUrl: string;

before(async () => {
  // Parcheo de storage para que auth + permiso pasen y el handler corra el
  // happy path sin tocar la base.
  (storage as any).getUser = async () => ({ id: USER_ID, deletedAt: null });
  (storage as any).getSubscriptionByUserId = async () => ({ status: 'active' });
  (storage as any).getMembershipByUserAndOrg = async () => ({ role: 'owner' });
  (storage as any).getTransaction = async (id: string) =>
    id === TX_ID ? currentTx : undefined;
  (storage as any).updateTransaction = async (id: string, updates: any) => {
    lastUpdateArgs = { id, updates };
    return { ...currentTx, ...updates };
  };
  (storage as any).createAuditLog = async () => ({});

  const app = express();
  app.use(express.json());
  // Sesión válida inyectada: requireAuth lee req.session.userId/organizationId.
  app.use((req: any, _res, next) => {
    req.session = {
      userId: USER_ID,
      organizationId: ORG_ID,
      destroy(cb?: () => void) {
        cb?.();
      },
    };
    next();
  });
  registerTransactionRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  Object.assign(storage, originals);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  currentTx = baseTransaction();
  lastUpdateArgs = null;
});

async function patchTransaction(body: unknown) {
  const res = await fetch(`${baseUrl}/api/transactions/${TX_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('(a) número histórico no canónico sin cambios + se edita otro campo => 200', async () => {
  // El cliente re-envía el invoiceNumber existente (no canónico) y cambia la
  // descripción. No debe revalidarse el formato.
  const { status, json } = await patchTransaction({
    invoiceNumber: '12345',
    description: 'Compra editada',
  });

  assert.equal(status, 200, 'editar otro campo no debe revalidar el número histórico');
  assert.equal(json.description, 'Compra editada');
  assert.equal(json.invoiceNumber, '12345', 'el número histórico se preserva tal cual');
  assert.ok(lastUpdateArgs, 'debe haber llamado a updateTransaction');
});

test('(b) cambiar el número a un valor inválido ("abc") => 400 field:invoiceNumber', async () => {
  const { status, json } = await patchTransaction({
    invoiceNumber: 'abc',
    description: 'Compra editada',
  });

  assert.equal(status, 400, 'un número nuevo con formato inválido debe rechazarse');
  assert.equal(json.field, 'invoiceNumber');
  assert.equal(json.message, INVOICE_NUMBER_FORMAT_MESSAGE);
  assert.equal(lastUpdateArgs, null, 'no debe persistir nada cuando el formato es inválido');
});

test('(c) cambiar el número a un canónico válido ("0001-00001234") => 200', async () => {
  const { status, json } = await patchTransaction({
    invoiceNumber: '0001-00001234',
  });

  assert.equal(status, 200, 'un número nuevo en formato canónico debe aceptarse');
  assert.equal(json.invoiceNumber, '0001-00001234');
  assert.ok(lastUpdateArgs, 'debe haber persistido el nuevo número');
});

test('(d) limpiar la factura (hasInvoice=false / invoiceNumber=null) => 200', async () => {
  const { status, json } = await patchTransaction({
    hasInvoice: false,
    invoiceNumber: null,
  });

  assert.equal(status, 200, 'limpiar la factura no debe disparar la validación de formato');
  assert.equal(json.hasInvoice, false);
  assert.equal(json.invoiceNumber, null);
  assert.ok(lastUpdateArgs, 'debe haber persistido la limpieza');
});
