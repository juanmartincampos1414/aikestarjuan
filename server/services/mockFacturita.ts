/**
 * Internal sandbox mock for facturación electrónica (ARCA).
 *
 * Activated when the external provider is unavailable or the server is
 * configured without API key while the org's environment is "sandbox".
 *
 * NEVER used in production (`environment === 'production'`).
 *
 * Generated comprobantes are clearly marked as `invoiceSimulated=true` and
 * the PDF carries a "SIMULADO - SIN VALIDEZ FISCAL" watermark.
 */
import {
  type InvoicingDocType,
  type InvoicingEmitterIvaCondition,
  type InvoicingEnvironment,
} from '@shared/schema';
import {
  selectCreditNoteDocType,
  type EmitInvoiceInput,
  type EmitCreditNoteInput,
  type EmittedInvoice,
  type RegisterCuitInput,
  type RegisterCuitResponse,
} from './facturita';

export const MOCK_PDF_PATH_PREFIX = '/api/invoicing/mock-pdf/';

function genUuid(prefix: string): string {
  // RFC4122-ish; we don't need cryptographic uniqueness.
  const rnd = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${prefix}-${Date.now().toString(16)}-${rnd()}${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`;
}

function genCae(): string {
  // 14 digits, like AFIP CAE
  let s = '';
  for (let i = 0; i < 14; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

function caeExpiration(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + 10);
  return d;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface MockEmitInvoiceInput extends EmitInvoiceInput {
  nextVoucherNumber: number;
  sellingPointNumber: number;
}

function formatVoucher(pv: number, n: number): string {
  return `${String(pv).padStart(4, '0')}-${String(n).padStart(8, '0')}`;
}

/** Parse a voucher number formatted as "PPPP-NNNNNNNN" → { pv, n } or null. */
export function parseMockVoucher(v: string | null | undefined): { pv: number; n: number } | null {
  if (!v) return null;
  const m = /^(\d{1,4})-(\d{1,8})$/.exec(v);
  if (!m) return null;
  return { pv: parseInt(m[1], 10), n: parseInt(m[2], 10) };
}

export function mockRegisterCuit(input: RegisterCuitInput): RegisterCuitResponse {
  return {
    cuit: input.cuit,
    ivaCondition: 'responsable_inscripto',
    razonSocial: input.nombreDeFantasia || `EMISOR SIMULADO ${input.cuit}`,
    sellingPoint: {
      number: input.sellingPoint || 1,
      businessName: input.nombreDeFantasia || 'Punto de venta simulado',
      address: input.direccion || 'Sin dirección registrada',
      status: 'active',
    },
  };
}

export function mockListSellingPoints(
  _ctx: { cuit: string; environment: InvoicingEnvironment; emitterIvaCondition: InvoicingEmitterIvaCondition },
  knownNumbers: number[],
): Array<{ number: number; description: string; active: boolean }> {
  const set = new Set<number>(knownNumbers);
  if (set.size === 0) set.add(1);
  return Array.from(set)
    .sort((a, b) => a - b)
    .map((n) => ({
      number: n,
      description: `Punto de venta ${String(n).padStart(4, '0')} (simulado)`,
      active: true,
    }));
}

export function mockEmitInvoice(input: MockEmitInvoiceInput): EmittedInvoice {
  const { items, docType, nextVoucherNumber, sellingPointNumber } = input;
  let net = 0;
  let iva = 0;
  for (const it of items) {
    const lineNet = it.quantity * it.unitPriceNet;
    net += lineNet;
    iva += lineNet * (it.ivaAliquot / 100);
  }
  net = round2(net);
  iva = round2(iva);
  const total = round2(net + iva);
  const uuid = genUuid('mock');
  const now = new Date();
  return {
    uuid,
    voucherNumber: formatVoucher(sellingPointNumber, nextVoucherNumber),
    cae: genCae(),
    caeExpirationDate: caeExpiration(now),
    pdfUrl: `${MOCK_PDF_PATH_PREFIX}${uuid}`,
    docType,
    total,
    net,
    iva,
    emittedAt: now,
    raw: { simulated: true },
  };
}

export interface MockEmitCreditNoteInput extends EmitCreditNoteInput {
  nextVoucherNumber: number;
  sellingPointNumber: number;
}

export function mockEmitCreditNote(input: MockEmitCreditNoteInput): EmittedInvoice {
  const docType = selectCreditNoteDocType(input.originalDocType);
  const uuid = genUuid('mock-nc');
  const now = new Date();
  return {
    uuid,
    voucherNumber: formatVoucher(input.sellingPointNumber, input.nextVoucherNumber),
    cae: genCae(),
    caeExpirationDate: caeExpiration(now),
    pdfUrl: `${MOCK_PDF_PATH_PREFIX}${uuid}`,
    docType,
    total: input.originalPrice ?? 0,
    net: 0,
    iva: 0,
    emittedAt: now,
    raw: { simulated: true, reason: input.reason },
  };
}
