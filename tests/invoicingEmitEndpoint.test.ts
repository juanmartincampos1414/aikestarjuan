import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  validateEmissionRequest,
  isCreditNoteDocType,
  isDebitNoteDocType,
  type EmissionTxType,
} from '../server/services/facturita';
import {
  INVOICING_EMITTER_IVA_CONDITIONS,
  INVOICING_DOC_TYPES,
  TAX_IVA_CONDITIONS,
  type InvoicingEmitterIvaCondition,
  type TaxIvaCondition,
  type InvoicingDocType,
} from '@shared/schema';

// HTTP-level test for `POST /api/invoicing/transactions/:id/emit`. We mount
// the SAME validation factory (`validateEmissionRequest`) used by the real
// route on a tiny Express server — the production route's storage / DB /
// provider plumbing is intentionally stubbed because the validation runs
// before any of those side effects in production. Any change to the shared
// validation helper is caught here without needing a live database.

interface FakeTransaction {
  id: string;
  type: EmissionTxType;
  invoiceUuid: string | null;
}
interface FakeAccount {
  ivaCondition: InvoicingEmitterIvaCondition;
  isActive: boolean;
}

const TX_FIXTURES: Record<string, FakeTransaction> = {
  'tx-supplier-ri': { id: 'tx-supplier-ri', type: 'expense', invoiceUuid: null },
  'tx-supplier-payable': { id: 'tx-supplier-payable', type: 'payable', invoiceUuid: null },
  'tx-client-income': { id: 'tx-client-income', type: 'income', invoiceUuid: null },
  'tx-client-receivable': { id: 'tx-client-receivable', type: 'receivable', invoiceUuid: null },
  'tx-already-emitted': { id: 'tx-already-emitted', type: 'expense', invoiceUuid: 'real-uuid' },
  'tx-bad-type': { id: 'tx-bad-type', type: 'transfer' as unknown as EmissionTxType, invoiceUuid: null },
};

let currentAccount: FakeAccount = {
  ivaCondition: 'responsable_inscripto',
  isActive: true,
};

function buildApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/invoicing/transactions/:id/emit', (req, res) => {
    const tx = TX_FIXTURES[req.params.id];
    if (!tx) return res.status(404).json({ message: 'Movimiento no encontrado' });
    if (
      tx.type !== 'income' &&
      tx.type !== 'receivable' &&
      tx.type !== 'expense' &&
      tx.type !== 'payable'
    ) {
      return res.status(400).json({ message: 'No se puede emitir un comprobante para este tipo de movimiento' });
    }
    if (tx.invoiceUuid) {
      return res.status(400).json({ message: 'Este movimiento ya tiene una factura emitida' });
    }
    const acc = currentAccount;
    if (!acc.isActive) {
      return res.status(400).json({ message: 'Configurá Facturador antes de emitir facturas' });
    }

    const body = req.body || {};
    const receiverCondition = body?.receiver?.ivaCondition as TaxIvaCondition;
    if (!TAX_IVA_CONDITIONS.includes(receiverCondition)) {
      return res.status(400).json({ message: 'receiver.ivaCondition inválido' });
    }
    const explicitDocType = body?.docType as InvoicingDocType | undefined;
    if (explicitDocType && !INVOICING_DOC_TYPES.includes(explicitDocType)) {
      return res.status(400).json({ message: 'docType inválido' });
    }

    const validation = validateEmissionRequest({
      txType: tx.type,
      emitterCondition: acc.ivaCondition,
      receiverCondition,
      explicitDocType: explicitDocType ?? null,
    });
    if (!validation.ok) {
      return res.status(validation.status).json({ message: validation.message });
    }

    const docType = validation.docType;
    const isNote = isCreditNoteDocType(docType) || isDebitNoteDocType(docType);
    return res.status(200).json({
      success: true,
      docType,
      letter: validation.letter,
      isNote,
      // Mirror the shape the production route would return (just the bits we test)
      transaction: { id: tx.id, type: tx.type },
    });
  });

  return app;
}

let server: Server;
let baseUrl: string;

before(async () => {
  const app = buildApp();
  await new Promise<void>(resolve => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function emit(txId: string, body: any) {
  const res = await fetch(`${baseUrl}/api/invoicing/transactions/${txId}/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json as any };
}

// Sanity: the union of emitter IVA conditions includes the three we use.
for (const e of ['responsable_inscripto', 'monotributo', 'exento']) {
  assert.ok(
    INVOICING_EMITTER_IVA_CONDITIONS.includes(e as InvoicingEmitterIvaCondition),
    `expected ${e} to be a valid emitter IVA condition`,
  );
}

describe('POST /api/invoicing/transactions/:id/emit — flujo proveedor', () => {
  it('emite NCA cuando emisor RI + receptor RI y no se manda docType (default)', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-supplier-ri', {
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.docType, 'NCA');
    assert.equal(r.body.letter, 'A');
    assert.equal(r.body.isNote, true);
  });

  it('emite NDA cuando se pasa docType=NDA explícito (RI + RI)', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-supplier-ri', {
      docType: 'NDA',
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.docType, 'NDA');
    assert.equal(r.body.letter, 'A');
  });

  it('emite NCC cuando emisor monotributo (sin importar receptor RI)', async () => {
    currentAccount = { ivaCondition: 'monotributo', isActive: true };
    const r = await emit('tx-supplier-payable', {
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.docType, 'NCC');
    assert.equal(r.body.letter, 'C');
  });

  it('emite NDC cuando emisor monotributo + docType=NDC', async () => {
    currentAccount = { ivaCondition: 'monotributo', isActive: true };
    const r = await emit('tx-supplier-payable', {
      docType: 'NDC',
      receiver: { ivaCondition: 'consumidor_final' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.docType, 'NDC');
    assert.equal(r.body.letter, 'C');
  });

  it('rechaza FA en flujo proveedor con HTTP 400', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-supplier-ri', {
      docType: 'FA',
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /proveedores/i);
  });

  it('rechaza emisor monotributo intentando NCA con HTTP 400', async () => {
    currentAccount = { ivaCondition: 'monotributo', isActive: true };
    const r = await emit('tx-supplier-ri', {
      docType: 'NCA',
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Monotributo/);
  });
});

describe('POST /api/invoicing/transactions/:id/emit — flujo cliente', () => {
  it('emite FA por default cuando emisor RI + receptor RI', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-client-income', {
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.docType, 'FA');
    assert.equal(r.body.isNote, false);
  });

  it('rechaza NCA en flujo cliente con HTTP 400', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-client-income', {
      docType: 'NCA',
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /clientes/i);
  });

  it('rechaza NDA en flujo cliente con HTTP 400', async () => {
    currentAccount = { ivaCondition: 'responsable_inscripto', isActive: true };
    const r = await emit('tx-client-receivable', {
      docType: 'NDA',
      receiver: { ivaCondition: 'responsable_inscripto' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /clientes/i);
  });
});

describe('POST /api/invoicing/transactions/:id/emit — guardas previas', () => {
  it('responde 404 si el movimiento no existe', async () => {
    const r = await emit('tx-no-existe', { receiver: { ivaCondition: 'responsable_inscripto' } });
    assert.equal(r.status, 404);
  });

  it('rechaza tipo de movimiento no soportado (transfer)', async () => {
    const r = await emit('tx-bad-type', { receiver: { ivaCondition: 'responsable_inscripto' } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /tipo de movimiento/);
  });

  it('rechaza si ya hay un comprobante emitido', async () => {
    const r = await emit('tx-already-emitted', { receiver: { ivaCondition: 'responsable_inscripto' } });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /ya tiene una factura/);
  });
});
