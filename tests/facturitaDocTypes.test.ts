import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectComprobanteLetter,
  buildCreditNoteDocType,
  buildDebitNoteDocType,
  validateEmissionRequest,
  isCreditNoteDocType,
  isDebitNoteDocType,
  isInvoiceDocType,
} from '../server/services/facturita';

// Pure-helper coverage for the doc-type rules behind nota de
// crédito/débito a proveedores. These functions are the source of
// truth for letter selection (A/B/C) and for the NCA/NDA/NCB/NDB/NCC/NDC
// mapping; the HTTP route delegates to them via validateEmissionRequest.

describe('selectComprobanteLetter', () => {
  it('emisor RI → A si receptor también es RI', () => {
    assert.equal(selectComprobanteLetter('responsable_inscripto', 'responsable_inscripto'), 'A');
  });

  it('emisor RI → B para receptores no RI (monotributo / exento / consumidor final)', () => {
    assert.equal(selectComprobanteLetter('responsable_inscripto', 'monotributo'), 'B');
    assert.equal(selectComprobanteLetter('responsable_inscripto', 'exento'), 'B');
    assert.equal(selectComprobanteLetter('responsable_inscripto', 'consumidor_final'), 'B');
  });

  it('emisor Monotributo / Exento → siempre C, sin importar el receptor', () => {
    for (const emitter of ['monotributo', 'exento'] as const) {
      assert.equal(selectComprobanteLetter(emitter, 'responsable_inscripto'), 'C');
      assert.equal(selectComprobanteLetter(emitter, 'monotributo'), 'C');
      assert.equal(selectComprobanteLetter(emitter, 'consumidor_final'), 'C');
      assert.equal(selectComprobanteLetter(emitter, 'exento'), 'C');
    }
  });
});

describe('buildCreditNoteDocType / buildDebitNoteDocType', () => {
  it('mapea letra → NC{A,B,C}', () => {
    assert.equal(buildCreditNoteDocType('A'), 'NCA');
    assert.equal(buildCreditNoteDocType('B'), 'NCB');
    assert.equal(buildCreditNoteDocType('C'), 'NCC');
  });

  it('mapea letra → ND{A,B,C}', () => {
    assert.equal(buildDebitNoteDocType('A'), 'NDA');
    assert.equal(buildDebitNoteDocType('B'), 'NDB');
    assert.equal(buildDebitNoteDocType('C'), 'NDC');
  });

  it('los resultados son reconocidos por isCreditNoteDocType / isDebitNoteDocType', () => {
    for (const l of ['A', 'B', 'C'] as const) {
      assert.equal(isCreditNoteDocType(buildCreditNoteDocType(l)), true);
      assert.equal(isDebitNoteDocType(buildDebitNoteDocType(l)), true);
      assert.equal(isInvoiceDocType(buildCreditNoteDocType(l)), false);
      assert.equal(isInvoiceDocType(buildDebitNoteDocType(l)), false);
    }
  });
});

describe('validateEmissionRequest — flujo proveedor (NC/ND a proveedor)', () => {
  it('default a NCA con emisor RI + receptor RI', () => {
    const r = validateEmissionRequest({
      txType: 'expense',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.docType, 'NCA');
      assert.equal(r.letter, 'A');
    }
  });

  it('acepta override explícito a NDA con emisor RI + receptor RI', () => {
    const r = validateEmissionRequest({
      txType: 'payable',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
      explicitDocType: 'NDA',
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.docType, 'NDA');
      assert.equal(r.letter, 'A');
    }
  });

  it('emisor monotributo solo puede emitir NCC/NDC, sin importar el receptor RI', () => {
    const ncc = validateEmissionRequest({
      txType: 'expense',
      emitterCondition: 'monotributo',
      receiverCondition: 'responsable_inscripto',
    });
    assert.equal(ncc.ok, true);
    if (ncc.ok) assert.equal(ncc.docType, 'NCC');

    const ndc = validateEmissionRequest({
      txType: 'payable',
      emitterCondition: 'monotributo',
      receiverCondition: 'consumidor_final',
      explicitDocType: 'NDC',
    });
    assert.equal(ndc.ok, true);
    if (ndc.ok) assert.equal(ndc.docType, 'NDC');
  });

  it('rechaza override a Factura (FA) en flujo proveedor', () => {
    const r = validateEmissionRequest({
      txType: 'expense',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
      explicitDocType: 'FA',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.message, /proveedores/i);
    }
  });

  it('rechaza emisor monotributo intentando emitir NCA (clase A)', () => {
    const r = validateEmissionRequest({
      txType: 'expense',
      emitterCondition: 'monotributo',
      receiverCondition: 'responsable_inscripto',
      explicitDocType: 'NCA',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.message, /Monotributo/);
    }
  });

  it('rechaza emisor RI intentando emitir NCC (clase C)', () => {
    const r = validateEmissionRequest({
      txType: 'expense',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'consumidor_final',
      explicitDocType: 'NCC',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.message, /Responsable Inscripto/);
    }
  });
});

describe('validateEmissionRequest — flujo cliente (Factura)', () => {
  it('default a FA con emisor RI + receptor RI', () => {
    const r = validateEmissionRequest({
      txType: 'income',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.docType, 'FA');
  });

  it('default a FB con emisor RI + receptor consumidor final', () => {
    const r = validateEmissionRequest({
      txType: 'receivable',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'consumidor_final',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.docType, 'FB');
  });

  it('default a FC con emisor monotributo', () => {
    const r = validateEmissionRequest({
      txType: 'income',
      emitterCondition: 'monotributo',
      receiverCondition: 'responsable_inscripto',
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.docType, 'FC');
  });

  it('rechaza override a NCA en flujo cliente', () => {
    const r = validateEmissionRequest({
      txType: 'income',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
      explicitDocType: 'NCA',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 400);
      assert.match(r.message, /clientes/i);
    }
  });

  it('rechaza override a NDA en flujo cliente', () => {
    const r = validateEmissionRequest({
      txType: 'receivable',
      emitterCondition: 'responsable_inscripto',
      receiverCondition: 'responsable_inscripto',
      explicitDocType: 'NDA',
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /clientes/i);
  });
});
