/**
 * Facturitas API client.
 *
 * Docs: https://facturitas.mintlify.app/guias/introduccion
 *
 * - Two base URLs, one per environment:
 *     test → https://api-test.facturitas.app
 *     prod → https://api.facturitas.app
 *   Both are overridable via FACTURITA_BASE_URL_TEST / FACTURITA_BASE_URL_PROD.
 * - Auth: `X-API-KEY` header on every request.
 * - 5xx and network failures are retried with linear backoff.
 */
import {
  type InvoicingDocType,
  type InvoicingEmitterIvaCondition,
  type InvoicingEnvironment,
  type TaxIvaCondition,
} from '@shared/schema';

const DEFAULT_BASE_URL_TEST = 'https://api-test.facturitas.app';
const DEFAULT_BASE_URL_PROD = 'https://api.facturitas.app';

function getBaseUrl(env: InvoicingEnvironment | undefined): string {
  if (env === 'production') {
    return (process.env.FACTURITA_BASE_URL_PROD || DEFAULT_BASE_URL_PROD).replace(/\/+$/, '');
  }
  return (process.env.FACTURITA_BASE_URL_TEST || DEFAULT_BASE_URL_TEST).replace(/\/+$/, '');
}

export class FacturitaError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, opts: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'FacturitaError';
    this.status = opts.status ?? 500;
    this.code = opts.code;
    this.details = opts.details;
  }
}

/**
 * Returns a JSON-safe shallow clone of a provider response body suitable for
 * persisting in the audit log when an emission/NC call comes back with
 * BAD_RESPONSE (missing credit_note_uuid / cae / invoice_uuid). The goal is
 * to capture enough diagnostic info to later understand why the response was
 * incomplete (provider returned a status flag, an error string, a partial
 * uuid, etc.) without leaking secrets that may have been echoed back.
 *
 * - Drops obvious credential-like keys (api_key, apikey, x-api-key,
 *   authorization, token, secret, password, clave_fiscal) at the top level
 *   AND one level deep.
 * - Truncates very large values so a misbehaving provider can't blow up the
 *   audit_logs table with megabytes of HTML.
 * - Always returns a plain object so it can be JSON.stringify-ed without
 *   surprises (Date, Map, etc.).
 */
const SENSITIVE_KEY_RE = /^(?:api[_-]?key|x[_-]?api[_-]?key|authorization|token|secret|password|clave[_-]?fiscal)$/i;
const MAX_STR_LEN = 2000;
const MAX_DEPTH = 6;
const MAX_ARRAY_LEN = 50;

/**
 * Walks an unknown provider payload and returns a JSON-safe deep clone:
 * - Sensitive keys (api_key, token, etc.) are replaced with '[REDACTED]'
 *   at ANY depth.
 * - Strings are truncated to MAX_STR_LEN to keep audit_logs.new_data sane.
 * - Arrays preserve their elements (recursively scrubbed), capped at
 *   MAX_ARRAY_LEN entries.
 * - Recursion is capped at MAX_DEPTH to avoid pathological provider payloads
 *   blowing up logging; values past the cap are stringified via JSON.stringify
 *   so we still keep a readable representation (NOT `[object Object]`).
 *
 * Earlier versions of this function intentionally dropped nested arrays and
 * objects past one level deep, replacing them with the literal string
 * `'[object]'`. That made it impossible to diagnose 422 validation errors
 * from Facturitas (e.g. `{ errors: { json: [...detail...] } }`) because the
 * actual array of validation messages was discarded before being saved.
 */
export function scrubFacturitaResponseForLog(raw: unknown): Record<string, unknown> {
  const scrubbed = scrubValue(raw, 0);
  // Always return a plain object so callers can safely JSON.stringify it
  // and so the audit_logs JSON column receives a consistent shape.
  if (scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return { value: scrubbed };
}

function scrubValue(v: unknown, depth: number): unknown {
  if (v == null) return v;
  if (typeof v === 'string') {
    return v.length > MAX_STR_LEN ? `${v.slice(0, MAX_STR_LEN)}…[truncated]` : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;

  if (depth >= MAX_DEPTH) {
    // Past the recursion budget — keep a readable JSON snapshot rather than
    // dropping the data on the floor. We do a one-pass key-level redaction
    // before stringifying so credentials deeper than MAX_DEPTH never leak
    // into audit logs (e.g. a provider echoing back an api_key inside a
    // deeply nested error context).
    try {
      const s = JSON.stringify(v, (key, val) => SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : val);
      return s.length > MAX_STR_LEN ? `${s.slice(0, MAX_STR_LEN)}…[truncated]` : s;
    } catch {
      return '[unserializable]';
    }
  }

  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY_LEN).map((it) => scrubValue(it, depth + 1));
    if (v.length > MAX_ARRAY_LEN) {
      (out as unknown[]).push(`…[${v.length - MAX_ARRAY_LEN} more items truncated]`);
    }
    return out;
  }

  if (typeof v === 'object') {
    const inner: Record<string, unknown> = {};
    for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(ik)) { inner[ik] = '[REDACTED]'; continue; }
      inner[ik] = scrubValue(iv, depth + 1);
    }
    return inner;
  }

  return undefined;
}

export interface FacturitaContext {
  cuit: string;
  environment: InvoicingEnvironment;
  emitterIvaCondition: InvoicingEmitterIvaCondition;
}

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPriceNet: number; // net per unit (without IVA)
  ivaAliquot: number;   // % e.g. 21, 10.5, 0
}

export interface ReceiverInfo {
  taxId: string | null;          // CUIT/DNI/CF
  name: string;
  ivaCondition: TaxIvaCondition; // determines doc type validity
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

// ARCA "concepto" del comprobante. Facturitas lo expone como `item_type`:
//   product             → Productos (concepto 1)
//   service             → Servicios (concepto 2)
//   product_and_service → Productos y Servicios (concepto 3)
// Para servicios/ambos ARCA exige el período del servicio y el vencimiento de
// pago (service_from / service_to / payment_due_date).
export type FacturitaItemType = 'product' | 'service' | 'product_and_service';

export interface EmitInvoiceInput {
  ctx: FacturitaContext;
  sellingPoint: number;
  docType: InvoicingDocType;        // FA / FB / FC
  receiver: ReceiverInfo;
  date: Date;                       // emission date (informational)
  items: InvoiceLineItem[];
  currency: string;                 // ARS, USD, etc.
  exchangeRate?: number | null;
  externalReference?: string | null;
  observations?: string | null;
  itemType?: FacturitaItemType;     // default 'product' (concepto del comprobante)
  serviceFrom?: Date | null;        // obligatorio si itemType incluye servicio
  serviceTo?: Date | null;          // obligatorio si itemType incluye servicio
  paymentDueDate?: Date | null;     // obligatorio si itemType incluye servicio
}

export interface EmitCreditNoteInput {
  ctx: FacturitaContext;
  originalInvoiceUuid: string;
  originalDocType: InvoicingDocType;
  originalPrice?: number | null;    // if null → full cancellation
  date: Date;
  reason: string;
  externalReference?: string | null;
}

export interface EmittedInvoice {
  uuid: string;
  voucherNumber: string;
  cae: string;
  caeExpirationDate: Date;
  pdfUrl?: string;
  docType: InvoicingDocType;
  total: number;
  net: number;
  iva: number;
  emittedAt: Date;
  raw?: unknown;
}

interface RequestOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  environment?: InvoicingEnvironment;
}

function getApiKey(): string {
  const key = process.env.FACTURITA_API_KEY;
  if (!key) {
    throw new FacturitaError('FACTURITA_API_KEY no está configurada en el servidor', {
      status: 503, code: 'NO_API_KEY',
    });
  }
  return key;
}

const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson<T>(opts: RequestOpts): Promise<T> {
  const apiKey = getApiKey();
  const url = `${getBaseUrl(opts.environment)}${opts.path}`;
  let lastErr: FacturitaError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: opts.method,
        headers: {
          'X-API-KEY': apiKey,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      lastErr = new FacturitaError(
        `No se pudo conectar al servicio de facturación`,
        { status: 502, code: 'NETWORK', details: (err as Error)?.message },
      );
      if (attempt < MAX_ATTEMPTS) { await sleep(RETRY_DELAY_MS * attempt); continue; }
      throw lastErr;
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }

    if (response.ok) return parsed as T;

    const errBody = parsed as { error?: string; errors?: Record<string, unknown> } | null;
    // Facturitas usually returns either a flat `{ error: string }` or a
    // Rails-style `{ errors: { <field>: [string, string, ...] } }`, but in
    // practice we have also seen `errors[field]` come back as an array of
    // objects or a single object when the provider validates a nested JSON
    // body. We need to stringify those without falling into the JS default
    // `[object Object]` coercion or we lose the actual reason for the
    // rejection in our audit log.
    const formatErrItem = (it: unknown): string => {
      if (it == null) return '';
      if (typeof it === 'string') return it;
      if (typeof it === 'number' || typeof it === 'boolean') return String(it);
      try { return JSON.stringify(it); } catch { return '[unserializable]'; }
    };
    const validationMsg = errBody?.errors && typeof errBody.errors === 'object'
      ? Object.entries(errBody.errors)
          .map(([k, v]) => {
            const rendered = Array.isArray(v)
              ? v.map(formatErrItem).filter(Boolean).join(', ')
              : formatErrItem(v);
            return `${k}: ${rendered}`;
          })
          .join('; ')
      : undefined;
    lastErr = new FacturitaError(
      validationMsg || errBody?.error || `Error del servicio de facturación (HTTP ${response.status})`,
      { status: response.status, details: parsed },
    );
    if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }
    throw lastErr;
  }
  throw lastErr ?? new FacturitaError('Error desconocido en el servicio de facturación');
}

// ---------------------------------------------------------------------------
// Doc-type rules (Argentine AFIP simplification)
// ---------------------------------------------------------------------------

export function selectInvoiceDocType(
  emitterCondition: InvoicingEmitterIvaCondition,
  receiverCondition: TaxIvaCondition,
): InvoicingDocType {
  if (emitterCondition === 'responsable_inscripto') {
    return receiverCondition === 'responsable_inscripto' ? 'FA' : 'FB';
  }
  return 'FC';
}

export function selectCreditNoteDocType(originalDocType: InvoicingDocType): InvoicingDocType {
  switch (originalDocType) {
    case 'FA': return 'NCA';
    case 'FB': return 'NCB';
    case 'FC': return 'NCC';
    // INVOICING_DOC_TYPES currently only supports F[A|B|C] on the sale side,
    // so the default branch is unreachable today. If/when types M/T are
    // added to the schema, extend the switch BEFORE shipping them —
    // mapping any of them to NCC blindly would produce a fiscally
    // inconsistent NC and be rejected by ARCA.
    default: return 'NCC';
  }
}

// ---------------------------------------------------------------------------
// Mappers between our schema and Facturitas' wire format
// ---------------------------------------------------------------------------

function docTypeToApi(dt: InvoicingDocType): 'A' | 'B' | 'C' {
  if (dt === 'FA' || dt === 'NCA' || dt === 'NDA') return 'A';
  if (dt === 'FB' || dt === 'NCB' || dt === 'NDB') return 'B';
  return 'C';
}

/**
 * Letter (A/B/C) of a comprobante issued by the org against another party,
 * derived from emitter + receiver IVA condition. Useful to choose the right
 * letter for ND/NC issued to suppliers (devoluciones de compra).
 */
export function selectComprobanteLetter(
  emitterCondition: InvoicingEmitterIvaCondition,
  receiverCondition: TaxIvaCondition,
): 'A' | 'B' | 'C' {
  if (emitterCondition !== 'responsable_inscripto') return 'C';
  return receiverCondition === 'responsable_inscripto' ? 'A' : 'B';
}

export function buildDebitNoteDocType(letter: 'A' | 'B' | 'C'): InvoicingDocType {
  return (letter === 'A' ? 'NDA' : letter === 'B' ? 'NDB' : 'NDC');
}

export function buildCreditNoteDocType(letter: 'A' | 'B' | 'C'): InvoicingDocType {
  return (letter === 'A' ? 'NCA' : letter === 'B' ? 'NCB' : 'NCC');
}

export function isCreditNoteDocType(dt: InvoicingDocType): boolean {
  return dt === 'NCA' || dt === 'NCB' || dt === 'NCC';
}

export function isDebitNoteDocType(dt: InvoicingDocType): boolean {
  return dt === 'NDA' || dt === 'NDB' || dt === 'NDC';
}

export function isInvoiceDocType(dt: InvoicingDocType): boolean {
  return dt === 'FA' || dt === 'FB' || dt === 'FC';
}

/**
 * Type of operation that originates the emission. Movements of type
 * income/receivable produce an invoice (factura) to a client, whereas
 * expense/payable movements produce a NC/ND issued to a supplier (a
 * "comprobante propio" for compras).
 */
export type EmissionTxType = 'income' | 'receivable' | 'expense' | 'payable';

export type EmissionValidationResult =
  | { ok: true; docType: InvoicingDocType; letter: 'A' | 'B' | 'C' }
  | { ok: false; status: number; message: string };

/**
 * Pure validator for `/api/invoicing/transactions/:id/emit`. Centralises:
 *   - flow ↔ doc-type consistency (factura solo para clientes; NC/ND solo
 *     para proveedores)
 *   - default doc-type when the caller doesn't override it (factura para
 *     clientes; nota de crédito para proveedores)
 *   - letter selection from emitter + receiver IVA condition
 *   - emitter constraints (Monotributo/Exento solo C; RI solo A/B)
 *
 * Used by the HTTP route AND by the integration tests so both honour the
 * exact same rules.
 */
export function validateEmissionRequest(input: {
  txType: EmissionTxType;
  emitterCondition: InvoicingEmitterIvaCondition;
  receiverCondition: TaxIvaCondition;
  explicitDocType?: InvoicingDocType | null;
}): EmissionValidationResult {
  const isSupplierFlow = input.txType === 'expense' || input.txType === 'payable';
  const letter = selectComprobanteLetter(input.emitterCondition, input.receiverCondition);
  const defaultDocType: InvoicingDocType = isSupplierFlow
    ? buildCreditNoteDocType(letter)
    : selectInvoiceDocType(input.emitterCondition, input.receiverCondition);
  const docType: InvoicingDocType = input.explicitDocType ?? defaultDocType;

  const isFactura = isInvoiceDocType(docType);
  const isNote = isCreditNoteDocType(docType) || isDebitNoteDocType(docType);
  if (isSupplierFlow && !isNote) {
    return { ok: false, status: 400, message: 'Para comprobantes a proveedores se debe emitir Nota de Crédito o Nota de Débito.' };
  }
  if (!isSupplierFlow && !isFactura) {
    return { ok: false, status: 400, message: 'Para comprobantes a clientes se debe emitir Factura A, B o C.' };
  }

  const docLetter: 'A' | 'B' | 'C' =
    docType.endsWith('A') ? 'A' : docType.endsWith('B') ? 'B' : 'C';
  if (input.emitterCondition !== 'responsable_inscripto' && docLetter !== 'C') {
    return { ok: false, status: 400, message: 'Un emisor Monotributo/Exento solo puede emitir comprobantes clase C' };
  }
  if (input.emitterCondition === 'responsable_inscripto' && docLetter === 'C') {
    return { ok: false, status: 400, message: 'Un Responsable Inscripto debe emitir comprobantes clase A o B (no C)' };
  }

  return { ok: true, docType, letter: docLetter };
}

function buyerIvaToApi(c: TaxIvaCondition): 'responsableInscripto' | 'monotributo' | 'exento' | 'consumidorFinal' {
  switch (c) {
    case 'responsable_inscripto': return 'responsableInscripto';
    case 'monotributo':           return 'monotributo';
    case 'exento':                return 'exento';
    case 'consumidor_final':
    default:                      return 'consumidorFinal';
  }
}

function ivaAliquotToApi(n: number): string {
  // Facturitas expects strings: "0%", "2.5%", "5%", "10.5%", "21%", "27%"
  const allowed = [0, 2.5, 5, 10.5, 21, 27];
  const closest = allowed.reduce((p, v) => Math.abs(v - n) < Math.abs(p - n) ? v : p, allowed[0]);
  return `${closest}%`;
}

function formatDateDDMMYYYY(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${day}-${m}-${y}`;
}

function parseDate(s: string | null | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // Try DD-MM-YYYY
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) {
    const iso = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
    if (!isNaN(iso.getTime())) return iso;
  }
  return new Date();
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeTotals(items: InvoiceLineItem[]): { net: number; iva: number; total: number } {
  let net = 0;
  let iva = 0;
  for (const it of items) {
    const lineNet = it.quantity * it.unitPriceNet;
    net += lineNet;
    iva += lineNet * (it.ivaAliquot / 100);
  }
  net = round2(net);
  iva = round2(iva);
  return { net, iva, total: round2(net + iva) };
}

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

interface ValidateCuitResponse {
  valid: boolean;
  razonSocial?: string;
  ivaCondition?: InvoicingEmitterIvaCondition;
  message?: string;
}

export interface RegisterCuitInput {
  cuit: string;
  // For sociedades (CUIT 30/33) ARCA requires logging in as the personal
  // CUIT of the administrator (20/23/24/27). When `adminCuit` is provided,
  // the signup payload sends `cuit: <adminCuit>` and `cuit_entidad: <cuit>`.
  // For personas físicas this stays undefined and the payload is unchanged.
  adminCuit?: string | null;
  sellingPoint?: number;
  claveFiscal?: string | null;   // required by Facturitas only in production
  direccion?: string | null;
  nombreDeFantasia?: string | null;
  environment?: InvoicingEnvironment;
}

export interface RegisterCuitResponse {
  cuit: string;
  ivaCondition: InvoicingEmitterIvaCondition | null;
  razonSocial: string | null;
  sellingPoint: { number: number; businessName?: string; address?: string; status: string } | null;
}

function apiIvaConditionToOurs(s: string | undefined | null): InvoicingEmitterIvaCondition | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v === 'responsable_inscripto') return 'responsable_inscripto';
  if (v === 'monotributista' || v === 'monotributo') return 'monotributo';
  if (v === 'iva_exento' || v === 'exento') return 'exento';
  return null;
}

export async function registerCuit(input: RegisterCuitInput): Promise<RegisterCuitResponse> {
  if (!isValidCuitFormat(input.cuit)) {
    throw new FacturitaError('CUIT inválido (checksum módulo 11)', { status: 400, code: 'BAD_CUIT' });
  }
  if (input.adminCuit && !isValidCuitFormat(input.adminCuit)) {
    throw new FacturitaError('CUIT del administrador inválido (checksum módulo 11)', { status: 400, code: 'BAD_CUIT' });
  }
  // For sociedades, ARCA login uses the administrator's personal CUIT, while
  // the entity CUIT is sent as `cuit_entidad`. For personas físicas the
  // payload shape is unchanged (no `cuit_entidad`).
  const body: any = input.adminCuit
    ? { cuit: input.adminCuit, cuit_entidad: input.cuit }
    : { cuit: input.cuit };
  if (input.claveFiscal) body.clave_fiscal = input.claveFiscal;
  if (input.sellingPoint) body.selling_point = input.sellingPoint;
  if (input.direccion) body.direccion = input.direccion;
  if (input.nombreDeFantasia) body.nombre_de_fantasia = input.nombreDeFantasia;

  const data = await fetchJson<{
    cuit: string;
    iva_condition?: string;
    name?: string;
    selling_point?: { selling_point: number; address?: string; business_name?: string; status: string } | null;
  }>({ method: 'POST', path: '/signup/', body, environment: input.environment });

  return {
    cuit: data.cuit,
    ivaCondition: apiIvaConditionToOurs(data.iva_condition),
    razonSocial: data.name || null,
    sellingPoint: data.selling_point
      ? {
          number: data.selling_point.selling_point,
          businessName: data.selling_point.business_name,
          address: data.selling_point.address,
          status: data.selling_point.status,
        }
      : null,
  };
}

/**
 * The public Facturitas API does not expose a standalone CUIT-lookup endpoint;
 * registration happens via POST /signup/. We therefore validate the CUIT
 * format locally (checksum) and, if the CUIT is already registered by this
 * api_user, return its selling points as an implicit proof of registration.
 */
export async function validateCuit(
  cuit: string,
  environment: InvoicingEnvironment,
): Promise<ValidateCuitResponse> {
  if (!isValidCuitFormat(cuit)) {
    return { valid: false, message: 'El CUIT no tiene un formato válido' };
  }
  try {
    const data = await fetchJson<FacturitasSellingPoint[] | unknown>({
      method: 'GET',
      path: `/selling-points/cuit/${cuit}`,
      environment,
    });
    // The endpoint returning OK means the CUIT is registered with the
    // provider, but it doesn't mean the user can actually emit: ARCA
    // requires at least one ACTIVE selling point. Surface that distinction
    // so the user fixes it BEFORE clicking emitir and getting a generic
    // "No pudimos completar la operación con ARCA" toast.
    const list = Array.isArray(data) ? (data as FacturitasSellingPoint[]) : [];
    const hasActiveSp = list.some(
      (s) => (s?.status || '').toLowerCase() === 'active',
    );
    if (!hasActiveSp) {
      return {
        valid: true,
        message:
          'CUIT habilitado, pero no encontramos un punto de venta activo. Activá uno en ARCA antes de emitir.',
      };
    }
    return { valid: true, message: 'CUIT habilitado para facturación electrónica' };
  } catch (err) {
    if (err instanceof FacturitaError && err.status === 404) {
      return {
        valid: true,
        message: 'CUIT con formato válido. Activá la facturación electrónica para poder emitir.',
      };
    }
    if (err instanceof FacturitaError && err.code === 'NETWORK') {
      return { valid: true, message: 'CUIT con formato válido (no se pudo verificar con ARCA).' };
    }
    throw err;
  }
}

interface FacturitasSellingPoint {
  id: number;
  selling_point: number;
  business_name?: string;
  address?: string;
  status: string;
}

export async function listSellingPoints(
  ctx: FacturitaContext,
): Promise<Array<{ number: number; description?: string; active?: boolean }>> {
  try {
    const data = await fetchJson<FacturitasSellingPoint[]>({
      method: 'GET',
      path: `/selling-points/cuit/${ctx.cuit}`,
      environment: ctx.environment,
    });
    const list = Array.isArray(data) ? data : [];
    return list.map((s) => ({
      number: s.selling_point,
      description: s.business_name || s.address || `Punto de venta ${s.selling_point}`,
      active: (s.status || '').toLowerCase() === 'active',
    }));
  } catch (err) {
    if (err instanceof FacturitaError && err.status === 404) {
      return [];
    }
    throw err;
  }
}

/**
 * Returns the provider-supported correlation key (if any) read from
 * `FACTURITA_CORRELATION_KEY`. Default is unset → we don't send a
 * correlation field and the listing-based reconciliation degrades to
 * null. Set it (e.g. `api_user_reference`, `webhook_id`, `request_id`,
 * `external_reference`) once Facturitas confirms which field they accept.
 *
 * Only `[a-z0-9_]` is allowed to keep the key safe to interpolate into
 * both the JSON body and the `GET /invoices/?<key>=...` query string.
 */
function getCorrelationKey(): string | null {
  const raw = (process.env.FACTURITA_CORRELATION_KEY || '').trim();
  if (!raw) return null;
  if (!/^[a-z0-9_]+$/i.test(raw)) return null;
  return raw;
}

interface FacturitasInvoiceResponse {
  invoice_uuid: string;
  cuit: string;
  selling_point: number;
  invoice_type: string;
  status: string;
  invoice_date: string;
  price: number;
  cae: string;
  cae_expiration_date: string;
  voucher_id: number;
  pdf_url: string;
}

/**
 * Tolerant parsing of the POST /invoices/ response body.
 *
 * Facturitas normally returns a flat object with `invoice_uuid` + `cae`, but
 * we've observed responses that wrap the payload (`{ invoice: { ... } }`,
 * `{ data: { ... } }`, `{ result: { ... } }`) or use alternative key names
 * (`uuid`/`id` for the uuid, `cae_number` for the CAE). Previously any of
 * these shapes triggered BAD_RESPONSE even though the emission was valid on
 * ARCA, forcing the user into a manual workflow and risking duplicate
 * emission on retry.
 *
 * This helper performs a best-effort extraction without altering the strict
 * happy-path: if the top-level body already has both `invoice_uuid` and
 * `cae`, it is returned unchanged.
 *
 * Returns null when no plausible (uuid, cae) pair can be found at any of the
 * tolerated locations — the caller then throws BAD_RESPONSE as before.
 */
function extractInvoiceFromRaw(
  raw: unknown,
): FacturitasInvoiceResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidates: Array<Record<string, unknown>> = [];
  const root = raw as Record<string, unknown>;
  candidates.push(root);
  for (const k of ['invoice', 'data', 'result', 'response']) {
    const nested = root[k];
    if (nested && typeof nested === 'object') {
      candidates.push(nested as Record<string, unknown>);
    }
  }
  for (const obj of candidates) {
    const uuid = obj.invoice_uuid ?? obj.uuid ?? obj.id;
    const cae = obj.cae ?? obj.cae_number;
    if (typeof uuid === 'string' && uuid.length > 0
        && typeof cae === 'string' && cae.length > 0) {
      return {
        invoice_uuid: uuid,
        cuit: String(obj.cuit ?? root.cuit ?? ''),
        selling_point: Number(obj.selling_point ?? root.selling_point ?? 0),
        invoice_type: String(obj.invoice_type ?? root.invoice_type ?? ''),
        status: String(obj.status ?? root.status ?? ''),
        invoice_date: String(obj.invoice_date ?? root.invoice_date ?? ''),
        price: typeof obj.price === 'number'
          ? obj.price
          : typeof root.price === 'number' ? root.price : 0,
        cae,
        cae_expiration_date: String(
          obj.cae_expiration_date ?? root.cae_expiration_date ?? '',
        ),
        voucher_id: Number(obj.voucher_id ?? root.voucher_id ?? 0),
        pdf_url: String(obj.pdf_url ?? root.pdf_url ?? ''),
      };
    }
  }
  return null;
}

/**
 * Re-fetch a currently-valid PDF URL for an already-emitted comprobante.
 *
 * Facturitas serves PDFs from time-limited SAS-signed Azure Blob URLs
 * (`apifacturitas.blob.core.windows.net`). The link captured at emission time
 * eventually expires, so opening an OLD invoice/NC with the stored URL fails
 * with Azure's "AuthenticationFailed / Signed expiry time must be after signed
 * start time". This reads the comprobante from the provider by uuid and returns
 * a fresh `pdf_url`.
 *
 * - `primaryUuid` is read via `GET /invoices/{uuid}` and we take its `pdf_url`.
 * - For credit notes whose own uuid may not resolve a `pdf_url`, pass
 *   `creditNoteFallbackUuid` (the original invoice uuid); we then read the
 *   `credit_note_pdf_url` marker off the original invoice.
 *
 * Returns null when no fresh URL could be obtained (the caller surfaces a
 * clear message). Never throws.
 */
export async function fetchFreshPdfUrl(input: {
  environment: InvoicingEnvironment;
  primaryUuid?: string | null;
  creditNoteFallbackUuid?: string | null;
}): Promise<string | null> {
  const { environment, primaryUuid, creditNoteFallbackUuid } = input;

  const readUrl = (
    obj: unknown,
    key: 'pdf_url' | 'credit_note_pdf_url',
  ): string | null => {
    if (!obj || typeof obj !== 'object') return null;
    const root = obj as Record<string, unknown>;
    const candidates: Array<Record<string, unknown>> = [root];
    for (const k of ['invoice', 'data', 'result', 'response']) {
      const nested = root[k];
      if (nested && typeof nested === 'object') {
        candidates.push(nested as Record<string, unknown>);
      }
    }
    for (const c of candidates) {
      const v = c[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  };

  if (primaryUuid) {
    try {
      const data = await fetchJson<unknown>({
        method: 'GET',
        path: `/invoices/${encodeURIComponent(primaryUuid)}`,
        environment,
      });
      const url = readUrl(data, 'pdf_url') ?? readUrl(data, 'credit_note_pdf_url');
      if (url) return url;
    } catch {
      // fall through to the fallback lookup
    }
  }

  if (creditNoteFallbackUuid && creditNoteFallbackUuid !== primaryUuid) {
    try {
      const data = await fetchJson<unknown>({
        method: 'GET',
        path: `/invoices/${encodeURIComponent(creditNoteFallbackUuid)}`,
        environment,
      });
      const url = readUrl(data, 'credit_note_pdf_url') ?? readUrl(data, 'pdf_url');
      if (url) return url;
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Tolerant parsing of the PATCH /invoices/ (credit-note) response body. Same
 * rationale as `extractInvoiceFromRaw` — handles wrapper envelopes and the
 * `credit_note_uuid`/`uuid` alias.
 */
function extractCreditNoteFromRaw(
  raw: unknown,
): FacturitasCreditNoteResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidates: Array<Record<string, unknown>> = [];
  const root = raw as Record<string, unknown>;
  candidates.push(root);
  for (const k of ['credit_note', 'note', 'data', 'result', 'response']) {
    const nested = root[k];
    if (nested && typeof nested === 'object') {
      candidates.push(nested as Record<string, unknown>);
    }
  }
  for (const obj of candidates) {
    const uuid = obj.credit_note_uuid ?? obj.uuid ?? obj.id;
    const cae = obj.cae ?? obj.cae_number ?? obj.credit_note_cae;
    if (typeof uuid === 'string' && uuid.length > 0
        && typeof cae === 'string' && cae.length > 0) {
      return {
        credit_note_uuid: uuid,
        fk_invoice_id: Number(obj.fk_invoice_id ?? root.fk_invoice_id ?? 0),
        price: typeof obj.price === 'number'
          ? obj.price
          : typeof root.price === 'number' ? root.price : 0,
        status: String(obj.status ?? root.status ?? ''),
        cae,
        cae_expiration_date: String(
          obj.cae_expiration_date
            ?? root.cae_expiration_date
            ?? obj.credit_note_cae_expiration_date
            ?? root.credit_note_cae_expiration_date
            ?? '',
        ),
        voucher_id: Number(
          obj.voucher_id ?? root.voucher_id
            ?? obj.credit_note_voucher_id ?? root.credit_note_voucher_id ?? 0,
        ),
        pdf_url: String(
          obj.pdf_url
            ?? root.pdf_url
            ?? obj.credit_note_pdf_url
            ?? root.credit_note_pdf_url
            ?? '',
        ),
      };
    }
  }
  return null;
}

export async function emitInvoice(input: EmitInvoiceInput): Promise<EmittedInvoice> {
  const { ctx, sellingPoint, docType, receiver, observations } = input;
  let { items } = input;

  if (!items.length) {
    throw new FacturitaError('La factura debe tener al menos un ítem', { status: 400, code: 'NO_ITEMS' });
  }

  const apiInvoiceType = docTypeToApi(docType);
  // Defensive: Factura C does not discriminate IVA. If the caller mistakenly
  // passes a non-zero ivaAliquot for a C comprobante (e.g. legacy frontend
  // bug that defaulted to 21% for monotributo emitters and divided the total
  // by 1.21 — turning $5000 into $4132.23), force the aliquot to 0 here so
  // the unit_price we send is preserved as the final total.
  if (apiInvoiceType === 'C') {
    items = items.map(it => it.ivaAliquot === 0 ? it : { ...it, ivaAliquot: 0 });
  }
  const totals = computeTotals(items);

  // Split by name/surname when possible for individual receivers
  const [first, ...rest] = (receiver.name || '').trim().split(/\s+/);
  const buyer_name = first || 'Consumidor';
  const buyer_surname = rest.join(' ') || undefined;

  const itemType: FacturitaItemType = input.itemType ?? 'product';
  const includesService = itemType === 'service' || itemType === 'product_and_service';

  const body: any = {
    cuit: ctx.cuit,
    selling_point: sellingPoint,
    invoice_type: apiInvoiceType,
    item_type: itemType,
    items: items.map(it => {
      const base: any = {
        item: it.description,
        unit_price: round2(it.unitPriceNet),
        quantity: it.quantity,
        unit_measure: 'unidades',
      };
      if (apiInvoiceType !== 'C') {
        base.iva_aliquot = ivaAliquotToApi(it.ivaAliquot);
      }
      return base;
    }),
    buyer_name,
    buyer_iva: buyerIvaToApi(receiver.ivaCondition),
  };

  if (buyer_surname) body.buyer_surname = buyer_surname;
  if (receiver.address) body.buyer_address = receiver.address;
  if (receiver.email) body.buyer_email = receiver.email;

  // Correlation key: when `FACTURITA_CORRELATION_KEY` is configured, send
  // the local tx id under that key so `tryReconcileInvoice` can later
  // recover the comprobante on BAD_RESPONSE. The legacy `external_reference`
  // key was rejected by Facturitas (HTTP 422 "Unknown field") on
  // 2026-05-19, so by default we do NOT send any correlation field. Set
  // the env var to the provider-supported key (e.g. `api_user_reference`
  // / `webhook_id` / `request_id` / `external_reference`) once confirmed.
  if (input.externalReference) {
    const key = getCorrelationKey();
    if (key) {
      body[key] = input.externalReference;
    }
  }

  if (receiver.taxId) {
    // Factura A requires CUIT; B/C accept any of CUIT/CUIL/DNI
    const digits = receiver.taxId.replace(/\D/g, '');
    let idType: 'CUIT' | 'CUIL' | 'DNI' = 'DNI';
    if (digits.length === 11) idType = 'CUIT';
    else if (digits.length === 8 || digits.length === 7) idType = 'DNI';
    body.buyer_tax_id_type = idType;
    body.buyer_tax_id_value = digits;
  }

  if (observations) {
    // Facturitas exposes `payment_condition` as a free-text slot we can use.
    body.payment_condition = observations.slice(0, 200);
  }

  // Servicios / Productos y Servicios: ARCA exige el período del servicio y el
  // vencimiento de pago. Facturitas los espera en formato DD-MM-YYYY.
  if (includesService) {
    if (!input.serviceFrom || !input.serviceTo || !input.paymentDueDate) {
      throw new FacturitaError(
        'Para facturar servicios necesitás indicar el período del servicio (desde y hasta) y el vencimiento de pago.',
        { status: 400, code: 'MISSING_SERVICE_DATES' },
      );
    }
    body.service_from = formatDateDDMMYYYY(input.serviceFrom);
    body.service_to = formatDateDDMMYYYY(input.serviceTo);
    body.payment_due_date = formatDateDDMMYYYY(input.paymentDueDate);
  }

  const rawData = await fetchJson<unknown>({
    method: 'POST',
    path: '/invoices/',
    body,
    environment: ctx.environment,
  });

  // Tolerant parse: accept wrapped/aliased shapes before declaring
  // BAD_RESPONSE. See `extractInvoiceFromRaw` for the supported variants.
  const data = extractInvoiceFromRaw(rawData);
  if (!data) {
    throw new FacturitaError('Respuesta inválida del servicio de facturación', {
      status: 502, code: 'BAD_RESPONSE', details: rawData,
    });
  }

  return {
    uuid: data.invoice_uuid,
    voucherNumber: String(data.voucher_id ?? ''),
    cae: data.cae,
    caeExpirationDate: parseDate(data.cae_expiration_date),
    pdfUrl: data.pdf_url,
    docType,
    total: typeof data.price === 'number' && data.price > 0 ? data.price : totals.total,
    net: totals.net,
    iva: totals.iva,
    emittedAt: parseDate(data.invoice_date),
    raw: data,
  };
}

interface FacturitasCreditNoteResponse {
  credit_note_uuid: string;
  fk_invoice_id: number;
  price: number;
  status: string;
  cae: string;
  cae_expiration_date: string;
  voucher_id: number;
  pdf_url: string;
}

export async function emitCreditNote(input: EmitCreditNoteInput): Promise<EmittedInvoice> {
  const { originalInvoiceUuid, originalDocType, originalPrice, externalReference } = input;
  const docType = selectCreditNoteDocType(originalDocType);

  const body: Record<string, unknown> = {
    invoice_uuid: originalInvoiceUuid,
  };
  if (typeof originalPrice === 'number' && originalPrice > 0) {
    body.price = round2(originalPrice);
  }
  // Correlation key: see `emitInvoice` for the full rationale. When
  // `FACTURITA_CORRELATION_KEY` is configured we forward the local tx id
  // under that key so attempt 1 of `tryReconcileCreditNote` (listing by
  // the same key) can recover the NC on BAD_RESPONSE. Default (no env
  // var) keeps the post-2026-05-19 safe behavior of sending nothing.
  if (externalReference) {
    const key = getCorrelationKey();
    if (key) {
      body[key] = externalReference;
    }
  }

  const rawData = await fetchJson<unknown>({
    method: 'PATCH',
    path: '/invoices/',
    body,
    environment: input.ctx.environment,
  });

  // Tolerant parse: accept wrapped/aliased shapes before declaring
  // BAD_RESPONSE. See `extractCreditNoteFromRaw` for the supported variants.
  const data = extractCreditNoteFromRaw(rawData);
  if (!data) {
    throw new FacturitaError('Respuesta inválida del servicio de facturación al emitir la nota de crédito', {
      status: 502, code: 'BAD_RESPONSE', details: rawData,
    });
  }

  return {
    uuid: data.credit_note_uuid,
    voucherNumber: String(data.voucher_id ?? ''),
    cae: data.cae,
    caeExpirationDate: parseDate(data.cae_expiration_date),
    pdfUrl: data.pdf_url,
    docType,
    total: typeof data.price === 'number' ? data.price : 0,
    net: 0,
    iva: 0,
    emittedAt: new Date(),
    raw: data,
  };
}

export interface TryReconcileCreditNoteInput {
  ctx: FacturitaContext;
  originalInvoiceUuid: string;
  originalDocType: InvoicingDocType;
  externalReference: string;
}

/**
 * Best-effort reconciliation when emitCreditNote came back with BAD_RESPONSE
 * (missing credit_note_uuid / cae). We try to detect whether the provider
 * actually emitted the NC on ARCA's side despite the malformed response,
 * so we can avoid double emission and surface the real state to the user.
 *
 * Strategy (both attempts are best-effort and swallow ALL errors, returning
 * null on any failure — the caller will fall back to the normal error path):
 *  1. GET /invoices/?external_reference=<tx.id>  — list NCs filtered by the
 *     external reference we passed at emission time. Match by invoice_uuid.
 *  2. GET /invoices/<originalInvoiceUuid>  — read the original invoice and
 *     look for a `credit_note_uuid` / cancelled-status marker indicating
 *     the NC was applied.
 *
 * Production-only consideration: callers must already gate on the real
 * provider. We do not call this for simulated invoices (mock-only path).
 */
// Shape of items returned by GET /invoices/?external_reference=... when
// listing credit notes associated with a transaction. All fields are
// optional because the provider may include the NC details directly or
// reference the original invoice via one of several alternative keys.
interface FacturitasListCreditNoteItem {
  credit_note_uuid?: string;
  cae?: string;
  cae_expiration_date?: string;
  voucher_id?: number | string;
  pdf_url?: string;
  price?: number;
  status?: string;
  invoice_uuid?: string;
  fk_invoice_uuid?: string;
  original_uuid?: string;
}

type FacturitasListResponse =
  | FacturitasListCreditNoteItem[]
  | { items?: FacturitasListCreditNoteItem[] };

// Shape of GET /invoices/{uuid}: a superset of FacturitasInvoiceResponse
// that may also include credit-note-related fields once the invoice has
// been cancelled. All NC-related keys are optional.
interface FacturitasReadInvoiceResponse {
  invoice_uuid?: string;
  status?: string;
  price?: number;
  cae_expiration_date?: string;
  credit_note_uuid?: string;
  credit_note_cae?: string;
  cae_credit_note?: string;
  credit_note_voucher_id?: number | string;
  credit_note_cae_expiration_date?: string;
  credit_note_pdf_url?: string;
}

function pickListItems(list: FacturitasListResponse | null | undefined): FacturitasListCreditNoteItem[] {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  if (Array.isArray(list.items)) return list.items;
  return [];
}

/**
 * Best-effort reconciliation for a credit-note PATCH that came back as
 * BAD_RESPONSE.
 *
 * Attempt 1 (`?<correlation_key>=`) is gated on `FACTURITA_CORRELATION_KEY`
 * being set to a provider-supported field (`api_user_reference`,
 * `webhook_id`, `request_id`, or `external_reference` once Facturitas
 * re-opens it). When unset, attempt 1 is skipped entirely. Attempt 2
 * (`GET /invoices/{originalInvoiceUuid}`) always runs because it reads
 * the original invoice and inspects its `credit_note_uuid` marker —
 * that path catches the BAD_RESPONSE-with-NC-emitted-on-ARCA case even
 * without a correlation key. The PATCH body itself is also parsed
 * tolerantly by `extractCreditNoteFromRaw`, so most BAD_RESPONSE cases
 * are mitigated upstream before this function is ever called.
 */
export async function tryReconcileCreditNote(
  input: TryReconcileCreditNoteInput,
): Promise<EmittedInvoice | null> {
  const { ctx, originalInvoiceUuid, originalDocType, externalReference } = input;
  const docType = selectCreditNoteDocType(originalDocType);

  const toEmitted = (data: FacturitasListCreditNoteItem): EmittedInvoice | null => {
    if (!data.credit_note_uuid || !data.cae) return null;
    return {
      uuid: data.credit_note_uuid,
      voucherNumber: data.voucher_id != null ? String(data.voucher_id) : '',
      cae: data.cae,
      caeExpirationDate: parseDate(data.cae_expiration_date),
      pdfUrl: data.pdf_url,
      docType,
      total: typeof data.price === 'number' ? data.price : 0,
      net: 0,
      iva: 0,
      emittedAt: new Date(),
      raw: data,
    };
  };

  // Attempt 1: list NCs by the configured correlation key and match by
  // invoice_uuid. Skipped entirely when no key is configured (current
  // post-2026-05-19 default), so we fall straight through to attempt 2.
  const correlationKey = getCorrelationKey();
  try {
    if (!correlationKey) throw new Error('skip');
    const list = await fetchJson<FacturitasListResponse>({
      method: 'GET',
      path: `/invoices/?${correlationKey}=${encodeURIComponent(externalReference)}`,
      environment: ctx.environment,
    });
    const items = pickListItems(list);
    const match = items.find((it) => {
      if (!it.credit_note_uuid || !it.cae) return false;
      // Match by original invoice uuid in any of the plausible shapes
      // the provider may use (invoice_uuid, fk_invoice_uuid, original_uuid).
      const refUuid = it.invoice_uuid ?? it.fk_invoice_uuid ?? it.original_uuid;
      return typeof refUuid === 'string' && refUuid === originalInvoiceUuid;
    });
    if (match) {
      const emitted = toEmitted(match);
      if (emitted) return emitted;
    }
  } catch {
    // swallow — fall through to attempt 2
  }

  // Attempt 2: read original invoice and check for credit_note_uuid marker.
  try {
    const original = await fetchJson<FacturitasReadInvoiceResponse>({
      method: 'GET',
      path: `/invoices/${encodeURIComponent(originalInvoiceUuid)}`,
      environment: ctx.environment,
    });
    if (original && typeof original === 'object') {
      const ncUuid = original.credit_note_uuid;
      const ncCae = original.credit_note_cae ?? original.cae_credit_note;
      if (typeof ncUuid === 'string' && ncUuid.length > 0 && typeof ncCae === 'string' && ncCae.length > 0) {
        return {
          uuid: ncUuid,
          voucherNumber: original.credit_note_voucher_id != null ? String(original.credit_note_voucher_id) : '',
          cae: ncCae,
          caeExpirationDate: parseDate(original.credit_note_cae_expiration_date ?? original.cae_expiration_date),
          pdfUrl: typeof original.credit_note_pdf_url === 'string' ? original.credit_note_pdf_url : undefined,
          docType,
          total: typeof original.price === 'number' ? original.price : 0,
          net: 0,
          iva: 0,
          emittedAt: new Date(),
          raw: original,
        };
      }
    }
  } catch {
    // swallow — return null
  }

  return null;
}

export interface TryReconcileInvoiceInput {
  ctx: FacturitaContext;
  externalReference: string;
}

// Items returned by GET /invoices/?external_reference=... that look like
// regular facturas (not credit/debit notes). All fields are optional because
// the provider's list endpoint may include partial data.
interface FacturitasListInvoiceItem {
  invoice_uuid?: string;
  cae?: string;
  cae_expiration_date?: string;
  voucher_id?: number | string;
  pdf_url?: string;
  price?: number;
  invoice_date?: string;
  status?: string;
  invoice_type?: string;
  // NC-only markers — if present we skip this item because we're looking
  // for the original factura, not a credit/debit note linked to it.
  credit_note_uuid?: string;
  fk_invoice_uuid?: string;
  original_uuid?: string;
}

type FacturitasInvoiceListResponse =
  | FacturitasListInvoiceItem[]
  | { items?: FacturitasListInvoiceItem[] };

function pickInvoiceListItems(
  list: FacturitasInvoiceListResponse | null | undefined,
): FacturitasListInvoiceItem[] {
  if (!list) return [];
  if (Array.isArray(list)) return list;
  if (Array.isArray(list.items)) return list.items;
  return [];
}

/**
 * Best-effort reconciliation when `emitInvoice` returned BAD_RESPONSE
 * (provider responded 2xx but the body was missing `invoice_uuid` / `cae`).
 *
 * The factura may have actually been registered on ARCA's side. We try to
 * find it by listing invoices filtered by the `external_reference` we sent
 * at emission time (the local transaction id). If a match is found with a
 * valid CAE we adopt it, preventing a duplicate emission on retry.
 *
 * The correlation key used on both POST and the listing query is read
 * from `FACTURITA_CORRELATION_KEY` (e.g. `api_user_reference`,
 * `webhook_id`, `request_id`, or `external_reference` once Facturitas
 * re-opens it). When unset this function returns null immediately —
 * BAD_RESPONSE cases are still mitigated upstream by
 * `extractInvoiceFromRaw`, which accepts wrapped/aliased response shapes
 * before the caller ever needs to reach this function.
 *
 * All errors are swallowed — null means "couldn't confirm, fall through to
 * the regular error path".
 */
export async function tryReconcileInvoice(
  input: TryReconcileInvoiceInput,
): Promise<EmittedInvoice | null> {
  const { ctx, externalReference } = input;
  const correlationKey = getCorrelationKey();
  if (!correlationKey) return null;
  try {
    const list = await fetchJson<FacturitasInvoiceListResponse>({
      method: 'GET',
      path: `/invoices/?${correlationKey}=${encodeURIComponent(externalReference)}`,
      environment: ctx.environment,
    });
    const items = pickInvoiceListItems(list);
    // Pick the first item that looks like a factura (no NC linkage) AND
    // has both invoice_uuid and cae populated.
    const match = items.find((it) => {
      if (!it.invoice_uuid || !it.cae) return false;
      if (it.credit_note_uuid || it.fk_invoice_uuid || it.original_uuid) return false;
      return true;
    });
    if (!match || !match.invoice_uuid || !match.cae) return null;
    return {
      uuid: match.invoice_uuid,
      voucherNumber: match.voucher_id != null ? String(match.voucher_id) : '',
      cae: match.cae,
      caeExpirationDate: parseDate(match.cae_expiration_date),
      pdfUrl: match.pdf_url,
      // PLACEHOLDER docType: the list endpoint of Facturitas does not return
      // a value mappable to our InvoicingDocType reliably. The caller MUST
      // override this with the server-validated docType (see
      // `result = { ...reconciledResult, docType }` in routes/invoicing.ts).
      // Do not rely on this default — it exists only so the return type is
      // satisfied.
      docType: 'FC' as InvoicingDocType,
      total: typeof match.price === 'number' ? match.price : 0,
      net: 0,
      iva: 0,
      emittedAt: parseDate(match.invoice_date),
      raw: match,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Standalone NC/ND emission (for "comprobantes propios a proveedores")
// ---------------------------------------------------------------------------
//
// The Facturitas API does NOT expose endpoints for issuing standalone notes
// without a previous invoice: PATCH /invoices/ requires an `invoice_uuid`
// owned by the same api_user, and there is no debit-note endpoint at all.
//
// Behaviour of the two functions below:
//
//   * Nota de Crédito (`emitStandaloneCreditNote`) → emit a "shadow"
//     Factura first via POST /invoices/ and immediately PATCH a credit
//     note against it. The user-facing return value is the NC (real CAE,
//     voucher number and PDF backed by ARCA); the shadow factura is kept
//     only inside `raw.shadowInvoice` for audit. Note this means each NC
//     causes two real comprobantes in ARCA.
//
//   * Nota de Débito (`emitStandaloneDebitNote`) → not implemented
//     against the real provider. Throws a 501 with an ND-specific message
//     so the route can surface it to the user. We deliberately do NOT
//     fake an ND by emitting a Factura, because that would persist a
//     wrong fiscal document type.
//
export interface EmitStandaloneNoteInput {
  ctx: FacturitaContext;
  sellingPoint: number;
  docType: InvoicingDocType; // NCA/NCB/NCC for NC, NDA/NDB/NDC for ND
  receiver: ReceiverInfo;
  date: Date;
  items: InvoiceLineItem[];
  currency: string;
  exchangeRate?: number | null;
  externalReference?: string | null;
  observations?: string | null;
}

function shadowFacturaDocType(noteDocType: InvoicingDocType): InvoicingDocType {
  const letter: 'A' | 'B' | 'C' =
    noteDocType.endsWith('A') ? 'A' : noteDocType.endsWith('B') ? 'B' : 'C';
  return letter === 'A' ? 'FA' : letter === 'B' ? 'FB' : 'FC';
}

export async function emitStandaloneCreditNote(
  input: EmitStandaloneNoteInput,
): Promise<EmittedInvoice> {
  if (!isCreditNoteDocType(input.docType)) {
    throw new FacturitaError('docType inválido para emitir nota de crédito', {
      status: 400, code: 'BAD_DOC_TYPE',
    });
  }
  if (!input.items.length) {
    throw new FacturitaError('La nota de crédito debe tener al menos un ítem', {
      status: 400, code: 'NO_ITEMS',
    });
  }

  // Step 1 — emit the shadow factura that the NC will reference.
  const shadow = await emitInvoice({
    ctx: input.ctx,
    sellingPoint: input.sellingPoint,
    docType: shadowFacturaDocType(input.docType),
    receiver: input.receiver,
    date: input.date,
    items: input.items,
    currency: input.currency,
    exchangeRate: input.exchangeRate ?? null,
    externalReference: input.externalReference ?? null,
    observations: input.observations
      ? `[Origen NC] ${input.observations}`.slice(0, 200)
      : '[Origen NC]',
  });

  // Step 2 — PATCH a full-amount credit note against the shadow factura.
  const totals = computeTotals(input.items);
  const data = await fetchJson<FacturitasCreditNoteResponse>({
    method: 'PATCH',
    path: '/invoices/',
    body: { invoice_uuid: shadow.uuid, price: round2(totals.total) },
    environment: input.ctx.environment,
  });

  if (!data?.credit_note_uuid || !data?.cae) {
    throw new FacturitaError('Respuesta inválida del servicio de facturación al emitir la nota de crédito', {
      status: 502, code: 'BAD_RESPONSE', details: data,
    });
  }

  return {
    uuid: data.credit_note_uuid,
    voucherNumber: String(data.voucher_id ?? ''),
    cae: data.cae,
    caeExpirationDate: parseDate(data.cae_expiration_date),
    pdfUrl: data.pdf_url,
    docType: input.docType,
    total: typeof data.price === 'number' ? data.price : totals.total,
    net: totals.net,
    iva: totals.iva,
    emittedAt: new Date(),
    raw: {
      creditNote: data,
      shadowInvoice: shadow.raw,
      shadowInvoiceUuid: shadow.uuid,
      shadowVoucherNumber: shadow.voucherNumber,
    },
  };
}

/**
 * Standalone Debit Note emission.
 *
 * The upstream Facturitas/ARCA integration has no debit-note endpoint
 * (the public OpenAPI spec exposes only POST /invoices/ for facturas and
 * PATCH /invoices/ for credit notes referencing an existing invoice). We
 * intentionally do NOT silently relabel a Factura as a Nota de Débito —
 * that would persist a wrong fiscal document type. Instead we throw a
 * 501 here so the route can surface a clear, ND-specific message and the
 * user can issue the ND manually from ARCA until the provider exposes a
 * proper endpoint.
 */
export async function emitStandaloneDebitNote(
  input: EmitStandaloneNoteInput,
): Promise<EmittedInvoice> {
  if (!isDebitNoteDocType(input.docType)) {
    throw new FacturitaError('docType inválido para emitir nota de débito', {
      status: 400, code: 'BAD_DOC_TYPE',
    });
  }
  throw new FacturitaError(
    'La emisión de Notas de Débito a proveedores todavía no está disponible en producción porque ARCA, vía nuestro proveedor, no expone aún el endpoint correspondiente. Probá en modo Pruebas o emití la ND manualmente desde ARCA.',
    { status: 501, code: 'NOT_IMPLEMENTED' },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidCuitFormat(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit)) return false;
  const digits = cuit.split('').map(Number);
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0);
  const mod = 11 - (sum % 11);
  const expected = mod === 11 ? 0 : mod === 10 ? 9 : mod;
  return digits[10] === expected;
}
