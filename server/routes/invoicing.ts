import type { Express } from "express";
import { createHash } from "crypto";
import { z } from "zod";
import * as XLSX from "xlsx";
import archiver from "archiver";
import { Readable } from "stream";
import PDFDocument from "pdfkit";
import type { Transaction, InsertTransaction } from "@shared/schema";
import { storage } from "../storage";
import { db } from "../db";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { requireAuth, requirePermission, sanitizeError } from "./middleware";
import {
  upsertInvoicingAccountSchema,
  INVOICING_ENVIRONMENTS,
  INVOICING_DOC_TYPES,
  INVOICING_EMITTER_IVA_CONDITIONS,
  TAX_IVA_CONDITIONS,
  type InvoicingDocType,
  type InvoicingEnvironment,
  type InvoicingEmitterIvaCondition,
  type TaxIvaCondition,
  transactions,
  clients,
} from "@shared/schema";
import {
  validateCuit,
  listSellingPoints,
  emitInvoice,
  emitCreditNote,
  emitStandaloneCreditNote,
  emitStandaloneDebitNote,
  registerCuit,
  selectCreditNoteDocType,
  isCreditNoteDocType,
  isDebitNoteDocType,
  validateEmissionRequest,
  isValidCuitFormat,
  FacturitaError,
  scrubFacturitaResponseForLog,
  tryReconcileCreditNote,
  tryReconcileInvoice,
  fetchFreshPdfUrl,
  type FacturitaContext,
  type InvoiceLineItem,
  type ReceiverInfo,
} from "../services/facturita";
import { isInvoicingCryptoConfigured } from "../services/invoicingCrypto";
import { attemptInvoiceEmailSend } from "../services/invoiceEmailService";
import { sendCreditNoteBadResponseAlertEmail, sendInvoiceBadResponseAlertEmail } from "../services/email";
import {
  mockRegisterCuit,
  mockListSellingPoints,
  mockEmitInvoice,
  mockEmitCreditNote,
  MOCK_PDF_PATH_PREFIX,
  parseMockVoucher,
} from "../services/mockFacturita";
import {
  isProviderConfigured,
  isSandboxMockForced,
  shouldUseSandboxMock,
  isMockFallbackEligible,
  checkCreditNoteProductionGuard,
  shouldUseMockForCreditNote,
  buildCreditNoteUpdatePatch,
  authorizeMockPdfAccess,
} from "../services/invoicingFallback";
import {
  resolveMockInvoiceContext,
  pipeMockInvoicePdf,
} from "../services/mockInvoicePdf";

function requireInvoicingEnv(): { ok: boolean; reason?: string; internalReason?: string } {
  // Crypto is required to (eventually) store certificate material; required even in mock mode.
  if (!isInvoicingCryptoConfigured()) {
    return {
      ok: false,
      reason: 'El servicio de facturación electrónica no está disponible en este momento. Probá de nuevo más tarde.',
      internalReason: 'Falta INVOICING_ENCRYPTION_KEY en el servidor',
    };
  }
  return { ok: true };
}

// Server-side feature flag mirroring the client's `VITE_INVOICING_ENABLED`.
// Default OFF. When OFF, every endpoint that mutates invoicing data or talks
// to the provider returns 403 — even with a valid auth token — so a hand-
// crafted HTTP call cannot bypass the hidden UI to emit/cancel/email
// vouchers. Read-only endpoints (GET /account, GET /invoices, exports,
// mock-pdf viewer) deliberately remain usable so any historical data the
// org might already have stays accessible. Re-enabling requires both
// `INVOICING_ENABLED=true` on the server AND `VITE_INVOICING_ENABLED=true`
// on the client (+ redeploy).
export function isInvoicingServerEnabled(): boolean {
  return process.env.INVOICING_ENABLED === 'true';
}

export function requireInvoicingEnabled(_req: any, res: any, next: any) {
  if (!isInvoicingServerEnabled()) {
    return res.status(403).json({ message: 'Facturación electrónica deshabilitada' });
  }
  next();
}

// Fail-closed for production-only paths (still requires API key + crypto).
function requireProductionProvider(): { ok: boolean; reason?: string } {
  if (!isInvoicingCryptoConfigured()) {
    return { ok: false, reason: 'El servicio de facturación electrónica no está disponible en este momento. Probá de nuevo más tarde.' };
  }
  if (!isProviderConfigured()) {
    return { ok: false, reason: 'La facturación electrónica en producción no está disponible en este momento. Probá de nuevo más tarde.' };
  }
  return { ok: true };
}

type InvoicingErrorContext = 'activate' | 'emit' | 'sync' | 'generic';

// Internal classification of a Facturita error, used both to map to a
// user-facing Spanish message AND to persist a stable `code` on the
// transaction so we can detect patterns later (e.g. "5 users hit
// BAD_CREDENTIALS this week").
export type InvoicingErrorCode =
  | 'NETWORK'
  | 'NOT_ACTIVE'        // 412 / "CUIT not active. Complete signup first."
  | 'BAD_CREDENTIALS'   // clave fiscal sin permisos sobre el CUIT en AFIP
  | 'BAD_CUIT'
  | 'NOT_IMPLEMENTED'
  | 'UNAUTHORIZED'      // 401/403 service-side
  | 'NOT_FOUND'         // 404
  | 'CONFLICT'          // 409
  | 'VALIDATION'        // 400 with provider field-level message
  | 'SERVER_ERROR'      // 5xx
  | 'GENERIC';

// Scrubs any brand/provider mention from a raw error message so we can safely
// surface the underlying fiscal/business reason (e.g. "unit_price supera el
// máximo permitido para monotributistas") to the end user. The brand name is
// never shown — copy speaks only of "ARCA" / "facturación electrónica".
function scrubBrandFromMessage(raw: string): string {
  return raw
    .replace(/facturit[ao]s?/gi, 'ARCA')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Returns BOTH the user-safe Spanish message and the internal classification
// code. The code is what we persist on the transaction for analytics; the
// message is what we show in the UI and persist for the user to read.
export function classifyInvoicingError(
  err: unknown,
  context: InvoicingErrorContext = 'generic',
): { code: InvoicingErrorCode; message: string } {
  if (err instanceof FacturitaError) {
    const code = err.code;
    const status = err.status;
    const raw = err.message || '';

    // Provider replied but the body didn't contain the expected fields
    // (e.g. credit_note_uuid + cae missing on a NC emission). The operation
    // may have actually been processed upstream — we just couldn't confirm it
    // synchronously. Distinguish from genuine network failures so the user
    // knows to refresh and check before retrying (avoids double-emission).
    if (code === 'BAD_RESPONSE') {
      if (context === 'emit') {
        // Neutral wording — this branch is hit for BOTH factura and nota de
        // crédito emissions. The previous copy mencionaba "la nota de
        // crédito ya se procesó" lo cual confundía a quien estaba emitiendo
        // una factura común. Texto genérico que sirve para ambos casos: el
        // server ya intentó reconciliar contra el proveedor antes de llegar
        // acá, así que si vemos este mensaje es porque ni siquiera la
        // reconciliación pudo confirmar el resultado. Recomendamos refresh +
        // revisar antes de reintentar para no duplicar.
        return {
          code: 'NETWORK',
          message: 'El proveedor de facturación electrónica respondió de forma incompleta y no pudimos confirmar si el comprobante quedó registrado en ARCA. Cerrá esta ventana, refrescá la lista y revisá el estado antes de reintentar para no duplicar la emisión. Te avisamos por mail al admin de la organización.',
        };
      }
      return {
        code: 'NETWORK',
        message: 'El servicio de ARCA respondió de forma inesperada. Refrescá y revisá el estado antes de reintentar.',
      };
    }

    if (code === 'NETWORK' || status === 502 || status === 503 || status === 504) {
      return {
        code: 'NETWORK',
        message: 'No pudimos conectar con ARCA en este momento. Probá de nuevo en unos minutos.',
      };
    }

    // Provider-side activation pending (e.g. 412 "CUIT XXX is not active.
    // Complete signup first."). Per Facturitas, when we register a CUIT
    // emisor with CUIT + clave fiscal, they run an automatic process that
    // generates the ARCA certificate and authorizes electronic invoicing.
    // If we get here, that automatic process didn't complete (transient
    // backend issue or signup was missed). The user does NOT need to do
    // anything in AFIP — soporte/Facturitas resuelve.
    if (
      status === 412 ||
      /is not active|not active.*signup|complete signup/i.test(raw)
    ) {
      return {
        code: 'NOT_ACTIVE',
        message: 'El proveedor de facturación electrónica todavía no terminó de activar tu CUIT en ARCA. Esperá unos minutos y volvé a probar. Si persiste, escribinos a soporte para que lo destrabemos (no necesitás hacer nada en AFIP).',
      };
    }

    // Bad credentials: the clave fiscal we have for this CUIT does not
    // grant permissions over it (or it changed in AFIP). Typical case:
    // a person enters AFIP with their personal CUIT but tries to invoice
    // with a sociedad's CUIT — they need to be designated administrador
    // of that sociedad, or have the WSFE service delegated.
    if (
      code === 'BAD_CREDENTIALS' ||
      /bad[_ ]credentials|invalid[_ ]credentials|credenciales? (inv|inválid|invalid)/i.test(raw) ||
      /no autori[zs]ad|not authorized|sin permiso/i.test(raw)
    ) {
      return {
        code: 'BAD_CREDENTIALS',
        message: 'Tu clave fiscal no tiene permisos sobre este CUIT en AFIP. Entrá a AFIP con tu clave fiscal, andá a "Administrador de Relaciones de Clave Fiscal" y verificá que figurás como administrador de este CUIT. Si no figurás, el administrador real tiene que darte de alta o delegarte el servicio "Facturación Electrónica (WSFE)". Después volvé acá y reintentá.',
      };
    }

    if (code === 'BAD_CUIT' || (status === 400 && /cuit/i.test(raw))) {
      return {
        code: 'BAD_CUIT',
        message: 'El CUIT no es válido. Verificá los 11 dígitos y la condición frente al IVA.',
      };
    }
    if (status === 501 || code === 'NOT_IMPLEMENTED') {
      return {
        code: 'NOT_IMPLEMENTED',
        message: scrubBrandFromMessage(raw || 'Esta operación todavía no está disponible. Probá en modo Pruebas.'),
      };
    }
    if (status === 401 || status === 403) {
      return {
        code: 'UNAUTHORIZED',
        message: 'El servicio de facturación electrónica no está disponible en este momento. Contactá a soporte.',
      };
    }
    // For 400/422 emit errors, the provider returns highly actionable Spanish
    // messages ("Ítem N: unit_price ... supera el máximo permitido para
    // monotributistas (613492)", "buyer_iva inválido", etc.). Surface them
    // verbatim (after scrubbing brand mentions) instead of a generic message
    // so the user knows exactly what to fix.
    //
    // 422 (Unprocessable Entity) is what Facturita actually returns for
    // payload validation failures — including the NC case that originally
    // exposed the audit-log bug. Treating it like 400 here was missing,
    // which made us fall through to the generic "revisá los datos" message
    // below even when the provider had told us exactly which field was
    // wrong. Now we surface the real reason whenever the provider gave us
    // one, regardless of whether the status is 400 or 422.
    if ((status === 400 || status === 422) && context === 'emit' && raw) {
      // Distinguish two flavors of 4xx provider errors:
      //
      // 1. Actionable Spanish validation messages ("unit_price supera el
      //    máximo permitido para monotributistas", "buyer_iva inválido",
      //    etc.) — surface verbatim so the user knows exactly what to fix.
      //
      // 2. Schema-shape / contract errors ("Unknown field", "Missing
      //    required field", or a raw JSON-shaped string like
      //    `json: {"external_reference":["Unknown field."]}`) — these
      //    indicate a bug in our payload mapping or that the provider
      //    silently tightened its schema. The user can't act on them, and
      //    leaking the JSON into the UI looks broken. Map to a friendly
      //    fallback and rely on the audit log + email alerts for the
      //    diagnostic detail.
      const looksLikeSchemaError =
        /Unknown field|missing (?:required )?field|unexpected (?:field|property)|not allowed/i.test(raw) ||
        // Pure JSON-shaped strings: `key: {...}` or starts with `{`/`[`.
        /^\s*[\{\[]/.test(raw) ||
        /:\s*[\{\[]/.test(raw);
      if (looksLikeSchemaError) {
        return {
          code: 'VALIDATION',
          message: 'No se pudo emitir la factura electrónica en este momento. Reintentá en unos minutos. Si el problema sigue, escribinos por WhatsApp así lo revisamos.',
        };
      }
      return { code: 'VALIDATION', message: scrubBrandFromMessage(raw) };
    }
    if (status === 404) {
      // A 404 has different meanings depending on what we were trying to do.
      // For emit/sync the CUIT is already activated locally — surfacing
      // "Activá la facturación" would be misleading and tell users to re-do
      // a step they already completed. Most real-world 404s here are upstream
      // routing/availability issues, so use a neutral retry message.
      if (context === 'emit') {
        return { code: 'NOT_FOUND', message: 'No pudimos emitir la factura. El servicio de ARCA no respondió correctamente. Probá de nuevo en unos minutos.' };
      }
      if (context === 'sync') {
        return { code: 'NOT_FOUND', message: 'No pudimos sincronizar con ARCA en este momento. Probá de nuevo en unos minutos.' };
      }
      if (context === 'activate') {
        return { code: 'NOT_FOUND', message: 'No pudimos activar la facturación electrónica con ARCA en este momento. Probá de nuevo en unos minutos.' };
      }
      return { code: 'NOT_FOUND', message: 'El servicio de ARCA no respondió correctamente. Probá de nuevo en unos minutos.' };
    }
    if (status === 409) {
      return { code: 'CONFLICT', message: 'Este CUIT ya está asociado a otra cuenta. Contactá a soporte si creés que es un error.' };
    }
    if (status >= 500) {
      return { code: 'SERVER_ERROR', message: 'El servicio de ARCA no respondió correctamente. Probá de nuevo en unos minutos.' };
    }
    // Generic 4xx — prefer a neutral message that does NOT presume the user
    // entered something wrong. We only get here when the provider returned a
    // 4xx we couldn't classify AND didn't give us an actionable validation
    // message; in that case the cause could equally be a bug on our payload
    // mapping or a provider-side issue, so blaming the user with "revisá los
    // datos ingresados" is misleading. Direct them to support so we can look
    // at the real audit-log detail and resolve it.
    return { code: 'GENERIC', message: 'No pudimos completar la operación con ARCA en este momento. Probá de nuevo en unos minutos; si el problema persiste, contactá a soporte.' };
  }
  return { code: 'GENERIC', message: 'Ocurrió un error procesando la facturación electrónica. Probá de nuevo en unos minutos.' };
}

function userSafeInvoicingMessage(
  err: unknown,
  context: InvoicingErrorContext = 'generic',
): string {
  return classifyInvoicingError(err, context).message;
}

function handleFacturitaError(res: any, err: unknown, context: InvoicingErrorContext = 'generic') {
  if (err instanceof FacturitaError) {
    const { code, message } = classifyInvoicingError(err, context);
    // Log the real reason server-side for ops; never return `details` or raw provider text.
    // eslint-disable-next-line no-console
    console.warn('[invoicing] provider error', {
      status: err.status,
      providerCode: err.code,
      classifiedCode: code,
      message: err.message,
      context,
      // Raw provider payload (when present) is critical for diagnosing
      // BAD_RESPONSE cases where the upstream API replied with an unexpected
      // shape. Truncate to keep logs bounded.
      details: (() => {
        try {
          const d = err.details;
          if (d == null) return undefined;
          const s = typeof d === 'string' ? d : JSON.stringify(d);
          return s.length > 1000 ? `${s.slice(0, 1000)}…` : s;
        } catch { return undefined; }
      })(),
    });
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 500)
      .json({ message, code });
  }
  // eslint-disable-next-line no-console
  console.warn('[invoicing] unexpected error', err);
  return res.status(500).json({
    message: 'Ocurrió un error procesando la facturación electrónica. Probá de nuevo en unos minutos.',
    code: 'GENERIC',
  });
}

const emitInvoiceSchema = z.object({
  sellingPoint: z.number().int().positive().optional(),
  docType: z.enum(INVOICING_DOC_TYPES).optional(), // override; default computed from emitter+receiver
  receiver: z.object({
    taxId: z.string().nullable().optional(),
    name: z.string().min(1).max(200),
    ivaCondition: z.enum(TAX_IVA_CONDITIONS),
    address: z.string().max(300).nullable().optional(),
    phone: z.string().max(30).nullable().optional(),
    email: z.string().email().nullable().optional(),
  }),
  items: z.array(z.object({
    description: z.string().min(1).max(300),
    quantity: z.number().positive(),
    unitPriceNet: z.number().nonnegative(),
    ivaAliquot: z.number().min(0).max(100),
  })).min(1),
  observations: z.string().max(500).nullable().optional(),
  exchangeRate: z.number().positive().nullable().optional(),
  // Concepto del comprobante (producto/servicio/ambos). Para servicios/ambos
  // ARCA exige el período del servicio y el vencimiento de pago, en YYYY-MM-DD.
  itemType: z.enum(['product', 'service', 'product_and_service']).optional(),
  serviceFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').optional(),
  serviceTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').optional(),
  paymentDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').optional(),
}).superRefine((data, ctx) => {
  const includesService = data.itemType === 'service' || data.itemType === 'product_and_service';
  if (!includesService) return;
  for (const field of ['serviceFrom', 'serviceTo', 'paymentDueDate'] as const) {
    if (!data[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: 'Obligatorio cuando facturás servicios',
      });
    }
  }
  if (data.serviceFrom && data.serviceTo && data.serviceTo < data.serviceFrom) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['serviceTo'],
      message: 'La fecha "hasta" no puede ser anterior a "desde"',
    });
  }
});

// "YYYY-MM-DD" → Date en horario local (mediodía) para evitar corrimientos de
// día por zona horaria al formatear luego a DD-MM-YYYY para Facturitas.
function ymdToLocalDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

const emitCreditNoteSchema = z.object({
  reason: z.string().min(1).max(500),
});

export function registerInvoicingRoutes(app: Express): void {
  // ------------------------------------------------------------------------
  // GET /api/invoicing/account → status + (sanitized) facturita account
  // ------------------------------------------------------------------------
  app.get('/api/invoicing/account', requireAuth, async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      const acc = await storage.getInvoicingAccount(req.organizationId);
      const sellingPoints = await storage.getSellingPointsByOrganization(req.organizationId);
      // Compute mock-mode hint: ONLY runtime state. We deliberately do NOT
      // include `acc.isSimulated` (which is historical) so that as soon as
      // the real provider is available again, the UI stops warning about
      // simulated mode and lets the user emit real invoices.
      const sandboxMockActive = acc
        ? shouldUseSandboxMock(acc.environment as InvoicingEnvironment)
        : (isSandboxMockForced() || !isProviderConfigured());
      res.json({
        configured: !!acc,
        envReady: env.ok,
        envReason: env.reason,
        sandboxMockActive,
        account: acc ? {
          id: acc.id,
          cuit: acc.cuit,
          adminCuit: acc.adminCuit,
          razonSocial: acc.razonSocial,
          ivaCondition: acc.ivaCondition,
          environment: acc.environment,
          defaultSellingPoint: acc.defaultSellingPoint,
          address: acc.address,
          phone: acc.phone,
          isActive: acc.isActive,
          isSimulated: !!acc.isSimulated,
          lastValidatedAt: acc.lastValidatedAt,
          lastSyncedAt: acc.lastSyncedAt,
          notes: acc.notes,
          // Never expose encrypted material
          hasCert: !!acc.encryptedCert,
        } : null,
        sellingPoints,
      });
    } catch (err) {
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  // ------------------------------------------------------------------------
  // PUT /api/invoicing/account → upsert config (CUIT + IVA + env)
  // ------------------------------------------------------------------------
  app.put('/api/invoicing/account', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) {
        return res.status(503).json({ message: env.reason });
      }
      const data = upsertInvoicingAccountSchema.parse(req.body);
      const existingAcc = await storage.getInvoicingAccount(req.organizationId);

      if (!isValidCuitFormat(data.cuit)) {
        return res.status(400).json({ message: 'El CUIT no es válido (verificación de checksum falló)' });
      }

      // Try to validate against Facturita (non-fatal if upstream is unreachable)
      let lastValidatedAt: Date | null = null;
      let razonSocial: string | null = data.razonSocial ?? null;
      try {
        const v = await validateCuit(data.cuit, data.environment);
        if (!v.valid) {
          return res.status(400).json({ message: v.message || 'El CUIT no fue validado por AFIP' });
        }
        lastValidatedAt = new Date();
        if (!razonSocial && v.razonSocial) razonSocial = v.razonSocial;
      } catch (e) {
        if (e instanceof FacturitaError && e.code !== 'NETWORK') {
          return handleFacturitaError(res, e, 'sync');
        }
        // network → continue without remote validation
      }

      const acc = await storage.upsertInvoicingAccount(req.organizationId, {
        cuit: data.cuit,
        razonSocial,
        ivaCondition: data.ivaCondition,
        environment: data.environment,
        defaultSellingPoint: data.defaultSellingPoint ?? null,
        address: data.address !== undefined ? data.address : (existingAcc?.address ?? null),
        phone: data.phone !== undefined ? data.phone : (existingAcc?.phone ?? null),
        notes: data.notes ?? null,
        isActive: true,
        lastValidatedAt,
        createdBy: req.userId,
      });
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: acc.id,
        action: 'upsert',
        previousData: null,
        newData: JSON.stringify({ cuit: acc.cuit, environment: acc.environment, ivaCondition: acc.ivaCondition }),
      });
      res.json({
        id: acc.id,
        cuit: acc.cuit,
        razonSocial: acc.razonSocial,
        ivaCondition: acc.ivaCondition,
        environment: acc.environment,
        defaultSellingPoint: acc.defaultSellingPoint,
        address: acc.address,
        phone: acc.phone,
        isActive: acc.isActive,
        lastValidatedAt: acc.lastValidatedAt,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  // ------------------------------------------------------------------------
  // PATCH /api/invoicing/account → partial update (currently only allows
  // changing `defaultSellingPoint`). Lets the user switch the default PV from
  // the Facturador screen without re-doing the full signup flow.
  // ------------------------------------------------------------------------
  app.patch('/api/invoicing/account', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const schema = z.object({
        defaultSellingPoint: z.number().int().positive().nullable(),
      });
      const data = schema.parse(req.body);
      const existingAcc = await storage.getInvoicingAccount(req.organizationId);
      if (!existingAcc) {
        return res.status(404).json({ message: 'No hay una cuenta de facturación activa.' });
      }
      if (data.defaultSellingPoint != null) {
        const sps = await storage.getSellingPointsByOrganization(req.organizationId);
        const match = sps.find((sp) => sp.number === data.defaultSellingPoint);
        if (!match || !match.isActive) {
          return res.status(400).json({ message: 'El punto de venta seleccionado no está activo o no existe.' });
        }
      }
      const previous = existingAcc.defaultSellingPoint;
      const acc = await storage.upsertInvoicingAccount(req.organizationId, {
        defaultSellingPoint: data.defaultSellingPoint ?? null,
      });
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: acc.id,
        action: 'update_default_selling_point',
        previousData: JSON.stringify({ defaultSellingPoint: previous }),
        newData: JSON.stringify({ defaultSellingPoint: acc.defaultSellingPoint }),
      });
      res.json({
        id: acc.id,
        defaultSellingPoint: acc.defaultSellingPoint,
      });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/validate-cuit → standalone CUIT validation
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/validate-cuit', requireInvoicingEnabled, requireAuth, async (req: any, res) => {
    try {
      const schema = z.object({
        cuit: z.string().regex(/^\d{11}$/),
        environment: z.enum(INVOICING_ENVIRONMENTS).default('sandbox'),
      });
      const { cuit, environment } = schema.parse(req.body);
      if (!isValidCuitFormat(cuit)) {
        return res.json({ valid: false, message: 'CUIT inválido (checksum)' });
      }
      const result = await validateCuit(cuit, environment);
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'CUIT inválido', errors: err.errors });
      handleFacturitaError(res, err, 'generic');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/signup → register CUIT in Facturitas
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/signup', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const schema = z.object({
        cuit: z.string().regex(/^\d{11}$/).optional(),
        // Personal CUIT of the administrator for sociedades (CUIT 30/33).
        // Required when the entity CUIT starts with 30 or 33; ignored otherwise.
        adminCuit: z.string().regex(/^\d{11}$/).nullable().optional(),
        ivaCondition: z.enum(INVOICING_EMITTER_IVA_CONDITIONS).optional(),
        environment: z.enum(INVOICING_ENVIRONMENTS).optional(),
        sellingPoint: z.number().int().positive().optional(),
        claveFiscal: z.string().min(1).max(100).nullable().optional(),
        direccion: z.string().min(1).max(200).nullable().optional(),
        nombreDeFantasia: z.string().min(1).max(200).nullable().optional(),
        address: z.string().max(200).nullable().optional(),
        phone: z.string().max(30).nullable().optional(),
        // When true, never fall back to the internal sandbox mock. Used by the
        // "Conectar con ARCA real" promotion flow so the user gets a clear
        // error instead of silently staying in simulated mode.
        forceReal: z.boolean().optional(),
      });
      const data = schema.parse(req.body || {});

      // Prefer existing account CUIT if not sent; otherwise require it in body.
      const acc = await storage.getInvoicingAccount(req.organizationId);
      const cuit = data.cuit || acc?.cuit;
      if (!cuit) {
        return res.status(400).json({ message: 'Ingresá tu CUIT para activar la facturación electrónica' });
      }
      if (!isValidCuitFormat(cuit)) {
        return res.status(400).json({ message: 'El CUIT no es válido (verificá los 11 dígitos)' });
      }

      // Sociedad detection: ARCA needs the administrator's personal CUIT to
      // authenticate the signup of CUITs that start with 30 or 33 (SA, SRL,
      // etc.). For 20/23/24/27 (persona física) the admin CUIT is ignored.
      const isSociedad = /^(30|33)/.test(cuit);
      const adminCuitRaw = data.adminCuit ?? acc?.adminCuit ?? null;
      const adminCuit = isSociedad ? (adminCuitRaw || null) : null;
      if (isSociedad) {
        if (!adminCuit) {
          return res.status(400).json({
            message: 'Ingresá el CUIT del administrador (persona física habilitada en ARCA para facturar a nombre de la sociedad).',
          });
        }
        if (!/^(20|23|24|27)\d{9}$/.test(adminCuit) || !isValidCuitFormat(adminCuit)) {
          return res.status(400).json({
            message: 'El CUIT del administrador no es válido. Debe empezar con 20, 23, 24 o 27 y tener 11 dígitos.',
          });
        }
      }

      // Task #300 / Task #313 — No defaultear punto de venta a 1 en el alta
      // y tampoco reutilizar ciegamente el `defaultSellingPoint` cacheado
      // localmente en una re-configuración. Si el usuario no eligió un PV
      // específico en este intento, dejamos esto `undefined` para que el
      // payload del `POST /signup/` a Facturitas NO incluya `selling_point`
      // y ARCA elija el correcto (típicamente el primer activo). El caso
      // reportado por Juan (mayo 2026, agency de redes) tenía la cuenta
      // local con `defaultSellingPoint = 1` cacheado de un alta vieja: cada
      // reintento volvía a empujar "1" hacia ARCA y reproducía el error,
      // aunque el usuario quisiera empezar limpio. El post-signup sync
      // (más abajo) se encarga igualmente de re-derivar el default a partir
      // de lo que ARCA realmente tiene activo.
      const sellingPoint = data.sellingPoint ?? undefined;
      const nombreDeFantasia = data.nombreDeFantasia ?? acc?.razonSocial ?? null;
      const targetEnv = (data.environment ?? acc?.environment ?? 'sandbox') as InvoicingEnvironment;

      // Production must always go through the real provider.
      if (targetEnv === 'production') {
        const prod = requireProductionProvider();
        if (!prod.ok) return res.status(503).json({ message: prod.reason });
      }

      let result;
      let usedMock = false;
      const tryMock = () => {
        usedMock = true;
        return mockRegisterCuit({
          cuit,
          sellingPoint,
          claveFiscal: data.claveFiscal ?? null,
          direccion: data.direccion ?? null,
          nombreDeFantasia,
        });
      };

      if (shouldUseSandboxMock(targetEnv) && !data.forceReal) {
        result = tryMock();
      } else {
        if (data.forceReal && !isProviderConfigured()) {
          return res.status(503).json({
            message: 'No pudimos conectar con ARCA en este momento. Probá de nuevo en unos minutos.',
          });
        }
        try {
          result = await registerCuit({
            cuit,
            adminCuit,
            sellingPoint,
            claveFiscal: data.claveFiscal ?? null,
            direccion: data.direccion ?? null,
            nombreDeFantasia,
            environment: targetEnv,
          });
        } catch (err) {
          if (!data.forceReal && isMockFallbackEligible(targetEnv, err)) {
            console.warn('[invoicing] signup falling back to internal sandbox mock:', (err as FacturitaError).message);
            result = tryMock();
          } else if (
            err instanceof FacturitaError &&
            isSociedad &&
            (err.code === 'BAD_CREDENTIALS' ||
              /bad[_ ]credentials|invalid[_ ]credentials/i.test(err.message || ''))
          ) {
            // Sociedad-specific BAD_CREDENTIALS message: makes it explicit
            // that the administrator's credentials are what ARCA validated.
            console.warn('[invoicing] signup BAD_CREDENTIALS for sociedad', { cuit, adminCuit });
            return res.status(400).json({
              message: 'Verificá que el CUIT del administrador y su clave fiscal sean correctos y que tenga relación habilitada en ARCA para facturar a nombre de la sociedad.',
              code: 'BAD_CREDENTIALS',
            });
          } else {
            throw err;
          }
        }
      }

      // Reflect resolved data on the local account + seed selling points.
      await storage.upsertInvoicingAccount(req.organizationId, {
        cuit: result.cuit,
        razonSocial: result.razonSocial ?? acc?.razonSocial ?? null,
        ivaCondition: (result.ivaCondition ?? data.ivaCondition ?? acc?.ivaCondition ?? 'responsable_inscripto') as InvoicingEmitterIvaCondition,
        environment: targetEnv,
        defaultSellingPoint: result.sellingPoint?.number ?? acc?.defaultSellingPoint ?? sellingPoint,
        lastValidatedAt: new Date(),
        lastSyncedAt: result.sellingPoint ? new Date() : acc?.lastSyncedAt ?? null,
        isActive: true,
        isSimulated: usedMock,
        // Persist admin CUIT only for sociedades; clear it if we're back on a
        // persona física (e.g. user changed CUIT to a 20/23/24/27).
        adminCuit: isSociedad ? adminCuit : null,
        ...(data.address !== undefined ? { address: data.address?.trim() || null } : {}),
        ...(data.phone !== undefined ? { phone: data.phone?.trim() || null } : {}),
        createdBy: acc ? undefined : req.userId,
      });

      if (result.sellingPoint) {
        await storage.replaceSellingPoints(req.organizationId, [{
          number: result.sellingPoint.number,
          description: result.sellingPoint.businessName ?? result.sellingPoint.address ?? null,
          isActive: (result.sellingPoint.status || '').toLowerCase() === 'active',
        }]);
      }

      // After a real (non-mock) signup, pull the full list of selling points
      // from the provider so the local cache reflects ARCA exactly. This is
      // especially important for the "Conectar con ARCA real" promotion flow:
      // the user might have multiple PVs registered with ARCA that aren't
      // returned by registerCuit alone.
      if (!usedMock) {
        try {
          const remote = await listSellingPoints({
            cuit: result.cuit,
            environment: targetEnv,
            emitterIvaCondition: (result.ivaCondition ?? data.ivaCondition ?? acc?.ivaCondition ?? 'responsable_inscripto') as InvoicingEmitterIvaCondition,
          });
          if (Array.isArray(remote) && remote.length > 0) {
            const replaced = await storage.replaceSellingPoints(
              req.organizationId,
              remote.map(r => ({
                number: r.number,
                description: r.description ?? null,
                isActive: r.active !== false,
              })),
            );
            // Re-derive defaultSellingPoint if the value we just saved during
            // signup isn't actually present/active in what the provider has.
            // This is the Juan case: signup said PV 1, but ARCA only has PV 4.
            const activeRemote = replaced.filter(sp => sp.isActive);
            const currentDefault = result.sellingPoint?.number ?? acc?.defaultSellingPoint ?? sellingPoint;
            const defaultIsValid = activeRemote.some(sp => sp.number === currentDefault);
            const correctedDefault = defaultIsValid
              ? currentDefault
              : (activeRemote[0]?.number ?? replaced[0]?.number ?? currentDefault);
            await storage.upsertInvoicingAccount(req.organizationId, {
              lastSyncedAt: new Date(),
              ...(correctedDefault !== currentDefault ? { defaultSellingPoint: correctedDefault } : {}),
            });
          }
        } catch (syncErr) {
          // Don't fail the signup if PV sync errors out — the account is
          // already promoted; the user can hit the manual sync button.
          // eslint-disable-next-line no-console
          console.warn('[invoicing] post-signup selling-points sync failed', syncErr);
        }
      }

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: cuit,
        action: 'invoicing_signup',
        previousData: null,
        newData: JSON.stringify({
          cuit: result.cuit,
          ivaCondition: result.ivaCondition,
          sellingPoint: result.sellingPoint?.number,
        }),
      });

      res.json({
        success: true,
        cuit: result.cuit,
        ivaCondition: result.ivaCondition,
        razonSocial: result.razonSocial,
        sellingPoint: result.sellingPoint,
      });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      handleFacturitaError(res, err, 'activate');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/deactivate → disable emission (keeps data)
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/deactivate', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc) return res.json({ success: true });
      await storage.upsertInvoicingAccount(req.organizationId, { isActive: false });
      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: acc.id,
        action: 'deactivate',
        previousData: null,
        newData: null,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  // ------------------------------------------------------------------------
  // In-memory dedupe cache for /api/invoicing/credentials/validate.
  //
  // The validation endpoint authenticates the clave fiscal against ARCA via
  // `registerCuit` (POST /signup/ on the provider). Because the client
  // debounces and re-fires the validation on every relevant input change,
  // a short TTL cache here is essential to avoid hammering the provider
  // with effectively identical signup calls while the user is still
  // editing the form. The cache key combines (org, cuit, adminCuit,
  // claveFiscal, environment); the value is the same response shape we
  // return to the client. Successful and BAD_CREDENTIALS results are
  // cached for 60 s; "skipped" results (network/5xx/other) are NOT cached
  // so a transient failure doesn't pin the UI into the "skipped" state.
  // ------------------------------------------------------------------------
  type CredValidateResult =
    | { ok: true }
    | { ok: true; skipped: true; reason: string }
    | { ok: false; code: 'BAD_CREDENTIALS'; message: string };
  const credValidateCache = new Map<string, { expires: number; result: CredValidateResult }>();
  const CRED_VALIDATE_TTL_MS = 60_000;
  // Build a cache key that does NOT retain the raw clave fiscal in
  // memory. We hash the secret with SHA-256 (alongside the other
  // identifiers, which are not secrets) so an attacker reading process
  // memory cannot recover the clave from the dedupe map. The non-secret
  // parts are still included as plain text to keep keys unambiguous and
  // collision-resistant beyond the hash alone.
  function credValidateCacheKey(parts: {
    organizationId: string | number | null | undefined;
    cuit: string;
    adminCuit: string;
    claveFiscal: string;
    environment: string;
  }): string {
    const secretHash = createHash('sha256')
      .update(`${parts.organizationId ?? ''}|${parts.cuit}|${parts.adminCuit}|${parts.environment}|`)
      .update(parts.claveFiscal)
      .digest('hex');
    return `${parts.organizationId ?? ''}|${parts.cuit}|${parts.adminCuit}|${parts.environment}|${secretHash}`;
  }
  // Lightweight eviction: walk the map and drop expired entries to bound
  // memory growth and the retention window of any (hashed) secret-derived
  // keys. Cheap because the map only sees one entry per unique input set
  // per minute.
  function evictExpiredCredValidateCache(now: number): void {
    for (const [k, v] of credValidateCache) {
      if (v.expires <= now) credValidateCache.delete(k);
    }
  }

  // ------------------------------------------------------------------------
  // POST /api/invoicing/credentials/validate → early validation of the
  // administrator's clave fiscal against ARCA, BEFORE the user clicks
  // "Activar". Anticipates the BAD_CREDENTIALS error so we can surface the
  // same actionable message that `classifyInvoicingError` would show post-
  // signup (link to "Administrador de Relaciones de Clave Fiscal").
  //
  // Behaviour:
  //   - Only meaningful in production with a real provider configured. In
  //     sandbox or when the internal mock is forced, we skip silently.
  //   - Calls `registerCuit` against the provider to authenticate the
  //     clave_fiscal. This is the same authentication path used by the
  //     real signup, so a successful validation here implies the next
  //     "Activar" click will succeed. The endpoint does NOT persist
  //     anything locally; the real signup endpoint still has to be called.
  //   - On BAD_CREDENTIALS → returns `{ ok:false, code:'BAD_CREDENTIALS',
  //     message }` so the wizard can block "Activar" with an inline error.
  //   - On NETWORK / 5xx → returns `{ ok:true, skipped:true, reason:... }`
  //     to NOT block activation (matches the existing "don't block on
  //     5xx/Network" policy of the selling-points preview).
  //   - Any other provider error is treated as `skipped:'other'` so we
  //     never block on classifications we can't act on early.
  // ------------------------------------------------------------------------
  app.post(
    '/api/invoicing/credentials/validate',
    requireInvoicingEnabled,
    requireAuth,
    requirePermission('organization:settings'),
    async (req: any, res) => {
      try {
        const env = requireInvoicingEnv();
        if (!env.ok) return res.status(503).json({ message: env.reason });

        const schema = z.object({
          cuit: z.string().regex(/^\d{11}$/),
          adminCuit: z.string().regex(/^\d{11}$/).nullable().optional(),
          claveFiscal: z.string().min(1).max(100),
          environment: z.enum(INVOICING_ENVIRONMENTS),
          ivaCondition: z.enum(INVOICING_EMITTER_IVA_CONDITIONS).optional(),
        });
        const data = schema.parse(req.body || {});

        if (data.environment !== 'production') {
          return res.json({ ok: true, skipped: true, reason: 'not_production' });
        }
        if (!isValidCuitFormat(data.cuit)) {
          return res.status(400).json({ message: 'El CUIT no es válido (verificá los 11 dígitos)' });
        }

        const isSociedad = /^(30|33)/.test(data.cuit);
        const adminCuit = isSociedad ? (data.adminCuit ?? null) : null;
        if (isSociedad) {
          if (!adminCuit) {
            return res.status(400).json({
              message: 'Ingresá el CUIT del administrador (persona física habilitada en ARCA para facturar a nombre de la sociedad).',
            });
          }
          if (!/^(20|23|24|27)\d{9}$/.test(adminCuit) || !isValidCuitFormat(adminCuit)) {
            return res.status(400).json({
              message: 'El CUIT del administrador no es válido. Debe empezar con 20, 23, 24 o 27 y tener 11 dígitos.',
            });
          }
        }

        // If the internal sandbox mock is active or the real provider isn't
        // configured, we cannot meaningfully validate against ARCA. Skip
        // silently so the wizard still lets the user proceed (same policy
        // as 5xx/Network).
        if (shouldUseSandboxMock('production') || !isProviderConfigured()) {
          return res.json({ ok: true, skipped: true, reason: 'unavailable' });
        }

        // Cache lookup — dedupe successive identical validations triggered
        // by the client's debounced re-fires so we don't repeatedly POST
        // /signup/ to the provider while the user is still editing.
        const now = Date.now();
        evictExpiredCredValidateCache(now);
        const cacheKey = credValidateCacheKey({
          organizationId: req.organizationId,
          cuit: data.cuit,
          adminCuit: adminCuit ?? '',
          claveFiscal: data.claveFiscal,
          environment: 'production',
        });
        const cached = credValidateCache.get(cacheKey);
        if (cached && cached.expires > now) {
          return res.json(cached.result);
        }

        try {
          await registerCuit({
            cuit: data.cuit,
            adminCuit,
            claveFiscal: data.claveFiscal,
            environment: 'production',
          });
          const okResult: CredValidateResult = { ok: true };
          credValidateCache.set(cacheKey, {
            expires: Date.now() + CRED_VALIDATE_TTL_MS,
            result: okResult,
          });
          return res.json(okResult);
        } catch (err) {
          if (err instanceof FacturitaError) {
            if (err.code === 'NETWORK' || err.status === 502 || err.status === 503 || err.status === 504) {
              return res.json({ ok: true, skipped: true, reason: 'network' });
            }
            if (err.status >= 500) {
              return res.json({ ok: true, skipped: true, reason: 'server_error' });
            }
            const { code, message } = classifyInvoicingError(err, 'activate');
            if (code === 'BAD_CREDENTIALS') {
              // Use the classified message verbatim so we preserve the
              // actionable AFIP guidance (Administrador de Relaciones de
              // Clave Fiscal + delegación del servicio "Facturación
              // Electrónica (WSFE)"). Do NOT override per-emitter type
              // here — the wording from classifyInvoicingError is the
              // contract referenced by the task.
              // eslint-disable-next-line no-console
              console.warn('[invoicing] credentials/validate BAD_CREDENTIALS', { cuit: data.cuit, isSociedad });
              const badResult: CredValidateResult = {
                ok: false,
                code: 'BAD_CREDENTIALS',
                message,
              };
              credValidateCache.set(cacheKey, {
                expires: Date.now() + CRED_VALIDATE_TTL_MS,
                result: badResult,
              });
              return res.json(badResult);
            }
            // Any other provider classification (NOT_ACTIVE, BAD_CUIT,
            // CONFLICT, VALIDATION, etc.) is NOT actionable as an early
            // credential check; let the real signup surface it instead.
            // Not cached so a transient classification doesn't pin the UI.
            return res.json({ ok: true, skipped: true, reason: 'other' });
          }
          // Unexpected non-FacturitaError — never block on it.
          // eslint-disable-next-line no-console
          console.warn('[invoicing] credentials/validate unexpected error', err);
          return res.json({ ok: true, skipped: true, reason: 'other' });
        }
      } catch (err) {
        if (err instanceof z.ZodError) {
          return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
        }
        return res.status(500).json({
          message: 'Ocurrió un error procesando la facturación electrónica. Probá de nuevo en unos minutos.',
        });
      }
    },
  );

  // ------------------------------------------------------------------------
  // GET /api/invoicing/selling-points/preview → pre-fetch active selling
  // points from ARCA (via Facturitas) BEFORE the signup so the wizard can
  // let the user pick one consciously instead of relying on ARCA to choose.
  //
  // Returns `{ sellingPoints, available, reason? }` shape:
  //   - available=true: provider responded; sellingPoints reflects ARCA.
  //   - available=false + reason: provider was not asked or failed (sandbox
  //     mock active, CUIT not yet registered with Facturitas, network, etc).
  // In every failure case we still return 200 with an empty list so the
  // wizard can silently fall back to the current "let ARCA choose" path.
  // ------------------------------------------------------------------------
  app.get('/api/invoicing/selling-points/preview', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const schema = z.object({
        cuit: z.string().regex(/^\d{11}$/),
        environment: z.enum(INVOICING_ENVIRONMENTS).default('sandbox'),
        ivaCondition: z.enum(INVOICING_EMITTER_IVA_CONDITIONS).default('responsable_inscripto'),
      });
      const parsed = schema.safeParse({
        cuit: typeof req.query.cuit === 'string' ? req.query.cuit : undefined,
        environment: typeof req.query.environment === 'string' ? req.query.environment : undefined,
        ivaCondition: typeof req.query.ivaCondition === 'string' ? req.query.ivaCondition : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: 'Parámetros inválidos', errors: parsed.error.errors });
      }
      const { cuit, environment, ivaCondition } = parsed.data;
      if (!isValidCuitFormat(cuit)) {
        return res.status(400).json({ message: 'El CUIT no es válido (verificación de checksum falló)' });
      }

      // When the internal sandbox mock is active there's no real ARCA call to
      // make — don't pretend to have queried ARCA.
      if (shouldUseSandboxMock(environment as InvoicingEnvironment)) {
        return res.json({ sellingPoints: [], available: false, reason: 'sandbox_mock' });
      }

      try {
        const remote = await listSellingPoints({
          cuit,
          environment: environment as InvoicingEnvironment,
          emitterIvaCondition: ivaCondition as InvoicingEmitterIvaCondition,
        });
        // Only active PVs are surfaced — inactive ones can't be used for
        // emission and would just confuse the wizard selector.
        const activeOnly = remote
          .filter(r => r.active !== false)
          .map(r => ({
            number: r.number,
            description: r.description ?? null,
            active: true,
          }));
        return res.json({ sellingPoints: activeOnly, available: true });
      } catch (err) {
        if (err instanceof FacturitaError) {
          if (err.code === 'NETWORK' || err.status === 502 || err.status === 503 || err.status === 504) {
            return res.json({ sellingPoints: [], available: false, reason: 'network' });
          }
          if (err.status === 404) {
            return res.json({ sellingPoints: [], available: false, reason: 'not_registered' });
          }
          // eslint-disable-next-line no-console
          console.warn('[invoicing] selling-points preview failed', { status: err.status, code: err.code });
          return res.json({ sellingPoints: [], available: false, reason: 'unavailable' });
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Parámetros inválidos', errors: err.errors });
      handleFacturitaError(res, err, 'sync');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/selling-points/sync → fetch from provider
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/selling-points/sync', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc) return res.status(400).json({ message: 'Primero configurá tu CUIT en Facturador' });
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const ctx: FacturitaContext = {
        cuit: acc.cuit,
        environment: acc.environment as InvoicingEnvironment,
        emitterIvaCondition: acc.ivaCondition as InvoicingEmitterIvaCondition,
      };

      const existing = await storage.getSellingPointsByOrganization(req.organizationId);
      const knownNumbers = existing.map(s => s.number);
      const useMock = shouldUseSandboxMock(ctx.environment);

      let remote;
      if (useMock) {
        remote = mockListSellingPoints(ctx, knownNumbers);
      } else {
        try {
          remote = await listSellingPoints(ctx);
        } catch (err) {
          if (isMockFallbackEligible(ctx.environment, err)) {
            console.warn('[invoicing] selling-points sync falling back to mock:', (err as FacturitaError).message);
            remote = mockListSellingPoints(ctx, knownNumbers);
          } else {
            throw err;
          }
        }
      }

      const replaced = await storage.replaceSellingPoints(
        req.organizationId,
        remote.map(r => ({ number: r.number, description: r.description ?? null, isActive: r.active !== false })),
      );
      // Same self-heal as post-signup: if acc.defaultSellingPoint isn't in
      // the active list anymore (e.g. user removed PV 1 in ARCA, only PV 4
      // exists), correct it so the next emit doesn't fail.
      const activeRemote = replaced.filter(sp => sp.isActive);
      const defaultIsValid = acc.defaultSellingPoint != null
        && activeRemote.some(sp => sp.number === acc.defaultSellingPoint);
      const correctedDefault = defaultIsValid
        ? acc.defaultSellingPoint
        : (activeRemote[0]?.number ?? replaced[0]?.number ?? acc.defaultSellingPoint);
      await storage.upsertInvoicingAccount(req.organizationId, {
        lastSyncedAt: new Date(),
        ...(correctedDefault !== acc.defaultSellingPoint ? { defaultSellingPoint: correctedDefault } : {}),
      });
      res.json({ sellingPoints: replaced });
    } catch (err) {
      handleFacturitaError(res, err, 'sync');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/selling-points/reset → reinicia el punto de venta
  // por defecto y re-consulta a ARCA (Task #313).
  //
  // Borra `defaultSellingPoint` de la cuenta local (lo deja `null`) y
  // ejecuta el mismo flujo que `/selling-points/sync` para refrescar el
  // listado contra ARCA. La diferencia con el sync común es que NO intenta
  // preservar el default cacheado: lo limpia de entrada, así el siguiente
  // emit elige el primer PV activo del listado real (o el que el usuario
  // pinche explícitamente desde la UI) en vez de seguir colgado del PV
  // viejo. Caso de uso: el cliente del agency cuyo cache decía PV 1 pero
  // ARCA ya tenía PV 4 — al reiniciar acá, el default queda `null` y el
  // selector vivo muestra el PV correcto.
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/selling-points/reset', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc) return res.status(400).json({ message: 'Primero configurá tu CUIT en Facturador' });
      if (!acc.isActive) return res.status(400).json({ message: 'Tu facturación electrónica está desactivada. Activala antes de reiniciar el punto de venta.' });
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const previousDefault = acc.defaultSellingPoint;
      // Limpiar el default cacheado primero, así nada lo reutiliza si el
      // sync falla a mitad de camino. El emit se autoprotege chequeando
      // que el default sea un PV activo conocido (ver `acc.defaultSellingPoint`
      // self-heal lines arriba); con `null` el siguiente emit cae al
      // primer PV activo del cache local, que recién vamos a refrescar.
      await storage.upsertInvoicingAccount(req.organizationId, { defaultSellingPoint: null });

      const ctx: FacturitaContext = {
        cuit: acc.cuit,
        environment: acc.environment as InvoicingEnvironment,
        emitterIvaCondition: acc.ivaCondition as InvoicingEmitterIvaCondition,
      };
      const existing = await storage.getSellingPointsByOrganization(req.organizationId);
      const knownNumbers = existing.map(s => s.number);
      const useMock = shouldUseSandboxMock(ctx.environment);

      let remote;
      if (useMock) {
        remote = mockListSellingPoints(ctx, knownNumbers);
      } else {
        try {
          remote = await listSellingPoints(ctx);
        } catch (err) {
          if (isMockFallbackEligible(ctx.environment, err)) {
            const errMessage = err instanceof FacturitaError ? err.message : err instanceof Error ? err.message : String(err);
            console.warn('[invoicing] selling-points reset falling back to mock:', errMessage);
            remote = mockListSellingPoints(ctx, knownNumbers);
          } else {
            throw err;
          }
        }
      }

      const replaced = await storage.replaceSellingPoints(
        req.organizationId,
        remote.map(r => ({ number: r.number, description: r.description ?? null, isActive: r.active !== false })),
      );
      await storage.upsertInvoicingAccount(req.organizationId, { lastSyncedAt: new Date() });

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: acc.id,
        action: 'invoicing_reset_selling_point',
        previousData: JSON.stringify({ defaultSellingPoint: previousDefault }),
        newData: JSON.stringify({ defaultSellingPoint: null, sellingPointsCount: replaced.length }),
      });

      res.json({
        sellingPoints: replaced,
        activeCount: replaced.filter(sp => sp.isActive).length,
      });
    } catch (err) {
      handleFacturitaError(res, err, 'sync');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/signup/retry → re-disparar el alta en Facturitas
  // SIN mandar `selling_point`, para que el provider cree el PV "RECE / Web
  // Services" en ARCA por nosotros.
  //
  // Caso de uso: cuentas dadas de alta ANTES del fix Task #300 / Task #313
  // (mayo 2026), cuando el backend defaulteaba el `selling_point` a 1 en el
  // body del POST /signup/. Facturitas confirmó que cuando reciben el
  // signup con `cuit + clave_fiscal` y SIN `selling_point`, se encargan de
  // crear un PV nuevo en ARCA con sistema RECE. Estas cuentas viejas
  // quedaron con el PV 1 de tipo "Factura en Línea" cacheado (que no sirve
  // para emisión por web service), porque Facturitas vio el `selling_point`
  // viejo y no creó nada nuevo. Este endpoint permite re-disparar ese alta
  // limpia sin que el usuario tenga que crear el PV manualmente en el
  // portal de ARCA.
  //
  // Requiere clave fiscal en el body (no la persistimos). Aplica solo a
  // cuentas activas en producción con provider real configurado.
  //
  // Respuesta:
  //   { success: true, sellingPoint, sellingPoints, recreated }
  //   `recreated` es true si Facturitas devolvió un PV distinto del que
  //   estaba cacheado antes (señal de que se creó uno nuevo en ARCA).
  //   Si es false, el usuario debe crear el PV manualmente (fallback).
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/signup/retry', requireInvoicingEnabled, requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const schema = z.object({
        claveFiscal: z.string().min(1).max(100),
      });
      const data = schema.parse(req.body || {});

      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc) {
        return res.status(400).json({ message: 'Primero configurá tu CUIT en Facturador' });
      }
      if (!acc.isActive) {
        return res.status(400).json({ message: 'Tu facturación electrónica está desactivada. Activala antes de reintentar el alta.' });
      }
      if (acc.environment !== 'production') {
        return res.status(400).json({ message: 'El reintento solo aplica en producción.' });
      }
      if (acc.isSimulated || shouldUseSandboxMock(acc.environment as InvoicingEnvironment)) {
        return res.status(400).json({ message: 'Tu cuenta está en modo simulado. Conectala con ARCA real primero.' });
      }
      const prod = requireProductionProvider();
      if (!prod.ok) return res.status(503).json({ message: prod.reason });

      const previousDefault = acc.defaultSellingPoint;
      const isSociedad = /^(30|33)/.test(acc.cuit);
      const adminCuit = isSociedad ? acc.adminCuit ?? null : null;
      if (isSociedad && !adminCuit) {
        return res.status(400).json({
          message: 'Falta el CUIT del administrador. Editá la configuración del facturador antes de reintentar.',
        });
      }

      // Limpiar el default cacheado ANTES de llamar al provider, así si el
      // provider nos devuelve `selling_point: null` no nos quedamos con el
      // valor viejo (PV 1) re-pegado al cache.
      await storage.upsertInvoicingAccount(req.organizationId, { defaultSellingPoint: null });

      let result;
      try {
        result = await registerCuit({
          cuit: acc.cuit,
          adminCuit,
          claveFiscal: data.claveFiscal,
          environment: 'production',
          // No mandamos `sellingPoint` a propósito: queremos que Facturitas
          // cree uno nuevo en ARCA.
        });
      } catch (err) {
        // Si falla, restauramos el default previo para no dejar la cuenta
        // peor que como estaba.
        if (previousDefault != null) {
          try {
            await storage.upsertInvoicingAccount(req.organizationId, { defaultSellingPoint: previousDefault });
          } catch {
            // best effort
          }
        }
        if (err instanceof FacturitaError) {
          if (
            isSociedad &&
            (err.code === 'BAD_CREDENTIALS' ||
              /bad[_ ]credentials|invalid[_ ]credentials/i.test(err.message || ''))
          ) {
            return res.status(400).json({
              message: 'Verificá que el CUIT del administrador y su clave fiscal sean correctos y que tenga relación habilitada en ARCA para facturar a nombre de la sociedad.',
              code: 'BAD_CREDENTIALS',
            });
          }
        }
        throw err;
      }

      // Reflejar el resultado del retry en la cuenta local. NO usamos el
      // operador `??` para `defaultSellingPoint` porque si `result.sellingPoint`
      // es null, queremos quedarnos con `null` (no re-cachear el viejo).
      const newDefault = result.sellingPoint?.number ?? null;
      await storage.upsertInvoicingAccount(req.organizationId, {
        razonSocial: result.razonSocial ?? acc.razonSocial ?? null,
        ivaCondition: (result.ivaCondition ?? acc.ivaCondition) as InvoicingEmitterIvaCondition,
        defaultSellingPoint: newDefault,
        lastValidatedAt: new Date(),
        lastSyncedAt: result.sellingPoint ? new Date() : acc.lastSyncedAt,
      });

      if (result.sellingPoint) {
        await storage.replaceSellingPoints(req.organizationId, [{
          number: result.sellingPoint.number,
          description: result.sellingPoint.businessName ?? result.sellingPoint.address ?? null,
          isActive: (result.sellingPoint.status || '').toLowerCase() === 'active',
        }]);
      }

      // Post-retry sync — refrescar el listado completo de PVs de ARCA.
      let replaced: { number: number; isActive: boolean }[] = [];
      try {
        const remote = await listSellingPoints({
          cuit: acc.cuit,
          environment: 'production',
          emitterIvaCondition: (result.ivaCondition ?? acc.ivaCondition) as InvoicingEmitterIvaCondition,
        });
        if (Array.isArray(remote) && remote.length > 0) {
          const replacedRows = await storage.replaceSellingPoints(
            req.organizationId,
            remote.map(r => ({
              number: r.number,
              description: r.description ?? null,
              isActive: r.active !== false,
            })),
          );
          replaced = replacedRows.map(sp => ({ number: sp.number, isActive: sp.isActive }));
          const activeRemote = replacedRows.filter(sp => sp.isActive);
          // Re-derivar default si el que volvió del signup no aparece activo.
          const currentDefault = result.sellingPoint?.number ?? newDefault;
          const defaultIsValid = currentDefault != null && activeRemote.some(sp => sp.number === currentDefault);
          const correctedDefault = defaultIsValid
            ? currentDefault
            : (activeRemote[0]?.number ?? null);
          await storage.upsertInvoicingAccount(req.organizationId, {
            lastSyncedAt: new Date(),
            ...(correctedDefault !== currentDefault ? { defaultSellingPoint: correctedDefault } : {}),
          });
        }
      } catch (syncErr) {
        // No fallar el retry si el sync de PVs falla — el alta ya se
        // re-disparó; el usuario puede hacer "Reiniciar PV" después.
        console.warn('[invoicing] post-retry selling-points sync failed', syncErr);
      }

      const finalAccount = await storage.getInvoicingAccount(req.organizationId);
      const finalDefault = finalAccount?.defaultSellingPoint ?? null;
      // "recreated" = el provider creó (o asignó) un PV distinto del que
      // teníamos cacheado antes. Si quedó en el mismo número (típicamente
      // 1 para monotributistas viejos), la creación en ARCA no prosperó y
      // el usuario tiene que ir por la guía manual.
      const recreated = finalDefault != null && finalDefault !== previousDefault;

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'invoicing_account',
        entityId: acc.id,
        action: 'invoicing_signup_retry',
        previousData: JSON.stringify({ defaultSellingPoint: previousDefault }),
        newData: JSON.stringify({ defaultSellingPoint: finalDefault, recreated }),
      });

      res.json({
        success: true,
        sellingPoint: result.sellingPoint,
        sellingPoints: replaced,
        previousDefault,
        newDefault: finalDefault,
        recreated,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      }
      handleFacturitaError(res, err, 'activate');
    }
  });

  // ------------------------------------------------------------------------
  // GET /api/invoicing/mock-pdf/:uuid → generate a "SIMULADO" PDF for sandbox
  // emissions. Requires auth and that the invoice belongs to the user's org.
  // ------------------------------------------------------------------------
  app.get('/api/invoicing/mock-pdf/:uuid', requireAuth, async (req: any, res) => {
    try {
      const { uuid } = req.params;
      // Validate uuid format before touching the DB
      if (!uuid || !/^[A-Za-z0-9_-]+$/.test(uuid)) {
        return res.status(400).json({ message: 'UUID inválido' });
      }
      // Lookup by uuid OR credit-note uuid, scoped to org
      const [tx] = await db.select().from(transactions)
        .where(and(
          eq(transactions.organizationId, req.organizationId),
          sql`(${transactions.invoiceUuid} = ${uuid} OR ${transactions.invoiceCreditNoteUuid} = ${uuid})`,
        ));
      const auth = authorizeMockPdfAccess(uuid, tx ?? null, req.organizationId);
      if (!auth.ok) {
        return res.status(auth.status ?? 404).json({ message: auth.message });
      }
      const isCreditNote = tx.invoiceCreditNoteUuid === uuid;
      const ctx = await resolveMockInvoiceContext(tx, req.organizationId, isCreditNote);
      pipeMockInvoicePdf(res as any, ctx, tx.invoiceVoucherId || uuid);
    } catch (err) {
      try { res.status(500).json({ message: sanitizeError(err) }); } catch {}
    }
  });

  // ------------------------------------------------------------------------
  // GET /api/invoicing/invoices → list emitted invoices for current org
  // ------------------------------------------------------------------------
  app.get('/api/invoicing/invoices', requireAuth, async (req: any, res) => {
    try {
      const filters = {
        startDate: req.query.startDate as string | undefined,
        endDate: req.query.endDate as string | undefined,
        environment: req.query.environment as string | undefined,
        status: req.query.status as string | undefined,
        clientId: req.query.clientId as string | undefined,
        docType: req.query.docType as string | undefined,
        emitterCuit: req.query.emitterCuit as string | undefined,
      };
      const items = await storage.getEmittedInvoicesByOrganization(req.organizationId, filters);
      // Distinct emitter CUITs (across all emitted invoices, ignoring filters) so the UI
      // can decide whether to show the emitter-CUIT filter.
      const allEmitters = await storage.getEmittedInvoicesByOrganization(req.organizationId, {});
      const emitterCuits = Array.from(new Set(allEmitters.map(t => t.invoiceEmitterCuit).filter((v): v is string => !!v))).sort();

      // Aggregate summary
      const summary = items.reduce((acc, t) => {
        const total = parseFloat(t.amount || '0');
        const net = parseFloat(t.invoiceNetAmount || '0');
        const iva = parseFloat(t.invoiceIvaAmount || '0');
        acc.count += 1;
        acc.total += total;
        acc.net += net;
        acc.iva += iva;
        return acc;
      }, { count: 0, total: 0, net: 0, iva: 0 });

      res.json({ items, summary, emitterCuits });
    } catch (err) {
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  // ------------------------------------------------------------------------
  // EXPORTS: xlsx, pdf consolidado, zip de PDFs
  // ------------------------------------------------------------------------
  type ExportItem = Transaction & { _clientName: string; _clientTaxId: string };

  async function loadExportItems(req: any): Promise<ExportItem[]> {
    const filters = {
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      environment: req.query.environment as string | undefined,
      status: req.query.status as string | undefined,
      clientId: req.query.clientId as string | undefined,
      docType: req.query.docType as string | undefined,
      emitterCuit: req.query.emitterCuit as string | undefined,
    };
    let items = await storage.getEmittedInvoicesByOrganization(req.organizationId, filters);
    const idsParam = (req.query.ids as string | undefined) || '';
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      const set = new Set(ids);
      items = items.filter(it => set.has(it.id));
    }
    const clientIds = Array.from(new Set(items.map(t => t.clientId).filter((v): v is string => !!v)));
    const cls = clientIds.length
      ? await db.select().from(clients).where(and(inArray(clients.id, clientIds), eq(clients.organizationId, req.organizationId)))
      : [];
    const clientMap = new Map(cls.map(c => [c.id, c]));
    return items.map<ExportItem>(t => {
      const c = t.clientId ? clientMap.get(t.clientId) : null;
      return {
        ...t,
        _clientName: c?.name || '',
        _clientTaxId: c?.taxId || t.invoiceTaxId || '',
      };
    });
  }

  function fmtDate(d: Date | string | null | undefined): string {
    if (!d) return '';
    const dt = d instanceof Date ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  }

  function nrm(v: any): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
    return Number.isFinite(n) ? n : 0;
  }

  app.get('/api/invoicing/invoices.xlsx', requireAuth, async (req: any, res) => {
    try {
      const items = await loadExportItems(req);

      // Group net by aliquot per row to discriminate IVA columns
      const aliquotSet = new Set<number>();
      for (const it of items) {
        const a = nrm(it.invoiceIvaAliquot);
        if (a > 0) aliquotSet.add(a);
      }
      const aliquots = Array.from(aliquotSet).sort((a, b) => a - b);

      type XlsxRow = Record<string, string | number>;
      const data: XlsxRow[] = items.map(it => {
        const total = nrm(it.amount);
        const net = nrm(it.invoiceNetAmount);
        const iva = nrm(it.invoiceIvaAmount);
        const aliq = nrm(it.invoiceIvaAliquot);
        const row: XlsxRow = {
          Fecha: fmtDate(it.invoiceEmittedAt || it.date),
          Tipo: it.invoiceDocType || '',
          'N° Comprobante': it.invoiceVoucherId || '',
          'CUIT Emisor': it.invoiceEmitterCuit || '',
          CAE: it.invoiceCae || '',
          'Vto CAE': fmtDate(it.invoiceCaeExpirationDate),
          Cliente: it._clientName,
          CUIT: it._clientTaxId,
          Descripción: it.description || '',
          Moneda: it.currency || 'ARS',
          Neto: Number(net.toFixed(2)),
          'Alícuota %': aliq ? Number(aliq.toFixed(2)) : 0,
          IVA: Number(iva.toFixed(2)),
          Total: Number(total.toFixed(2)),
          Ambiente: it.invoiceEnvironment || '',
          Estado: it.invoiceCreditNoteUuid ? 'Anulada' : (it.invoiceEmissionStatus || ''),
        };
        for (const a of aliquots) {
          row[`Neto ${a.toFixed(2)}%`] = Math.abs(aliq - a) < 0.01 ? Number(net.toFixed(2)) : 0;
          row[`IVA ${a.toFixed(2)}%`] = Math.abs(aliq - a) < 0.01 ? Number(iva.toFixed(2)) : 0;
        }
        return row;
      });

      const totals: XlsxRow = {
        Fecha: '', Tipo: '', 'N° Comprobante': 'TOTAL', 'CUIT Emisor': '', CAE: '', 'Vto CAE': '',
        Cliente: '', CUIT: '', Descripción: '', Moneda: '',
        Neto: Number(items.reduce((s, it) => s + nrm(it.invoiceNetAmount), 0).toFixed(2)),
        'Alícuota %': '',
        IVA: Number(items.reduce((s, it) => s + nrm(it.invoiceIvaAmount), 0).toFixed(2)),
        Total: Number(items.reduce((s, it) => s + nrm(it.amount), 0).toFixed(2)),
        Ambiente: '', Estado: '',
      };
      for (const a of aliquots) {
        totals[`Neto ${a.toFixed(2)}%`] = Number(items.filter(it => Math.abs(nrm(it.invoiceIvaAliquot) - a) < 0.01)
          .reduce((s, it) => s + nrm(it.invoiceNetAmount), 0).toFixed(2));
        totals[`IVA ${a.toFixed(2)}%`] = Number(items.filter(it => Math.abs(nrm(it.invoiceIvaAliquot) - a) < 0.01)
          .reduce((s, it) => s + nrm(it.invoiceIvaAmount), 0).toFixed(2));
      }
      data.push(totals);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, 'Facturas');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="facturas_${fmtDate(new Date())}.xlsx"`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ message: sanitizeError(err) });
    }
  });

  app.get('/api/invoicing/invoices.pdf', requireAuth, async (req: any, res) => {
    try {
      const items = await loadExportItems(req);
      const acc = await storage.getInvoicingAccount(req.organizationId);

      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="libro_iva_ventas_${fmtDate(new Date())}.pdf"`);
      doc.pipe(res);

      // Header
      doc.fontSize(14).font('Helvetica-Bold').text('Libro de IVA Ventas', { align: 'left' });
      doc.fontSize(9).font('Helvetica');
      if (acc) {
        doc.text(`Emisor: ${acc.razonSocial || ''}  CUIT: ${acc.cuit}  Cond. IVA: ${acc.ivaCondition}`);
      }
      const period = `${(req.query.startDate as string) || '—'} a ${(req.query.endDate as string) || '—'}`;
      doc.text(`Período: ${period}`);
      doc.text(`Generado: ${new Date().toLocaleString('es-AR')}`);
      doc.moveDown(0.5);

      // Table
      const cols = [
        { key: 'fecha', label: 'Fecha', width: 55 },
        { key: 'tipo', label: 'Tipo', width: 38 },
        { key: 'comp', label: 'Comprobante', width: 80 },
        { key: 'emisor', label: 'CUIT Emisor', width: 75 },
        { key: 'cliente', label: 'Cliente', width: 130 },
        { key: 'cuit', label: 'CUIT', width: 70 },
        { key: 'neto', label: 'Neto', width: 60 },
        { key: 'aliq', label: 'Alic %', width: 38 },
        { key: 'iva', label: 'IVA', width: 60 },
        { key: 'total', label: 'Total', width: 70 },
        { key: 'cae', label: 'CAE', width: 80 },
        { key: 'env', label: 'Amb', width: 38 },
      ];
      const startX = doc.page.margins.left;
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const totalW = cols.reduce((s, c) => s + c.width, 0);
      const scale = usableWidth / totalW;
      for (const c of cols) c.width = c.width * scale;

      const drawRow = (y: number, values: string[], opts: { bold?: boolean; bg?: string; aligns?: ('left' | 'right')[] } = {}): number => {
        const h = 16;
        if (opts.bg) {
          doc.save();
          doc.rect(startX, y, usableWidth, h).fill(opts.bg);
          doc.restore();
        }
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor('#000');
        let x = startX;
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          const align = opts.aligns?.[i] || 'left';
          doc.text(values[i] || '', x + 2, y + 4, { width: c.width - 4, height: h - 4, align, lineBreak: false, ellipsis: true });
          x += c.width;
        }
        // bottom border
        doc.moveTo(startX, y + h).lineTo(startX + usableWidth, y + h).strokeColor('#cccccc').lineWidth(0.5).stroke();
        return y + h;
      }

      let y = doc.y;
      const aligns: ('left' | 'right')[] = ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'left', 'left'];
      y = drawRow(y, cols.map(c => c.label), { bold: true, bg: '#eeeeee', aligns });

      let totalNet = 0, totalIva = 0, totalAmt = 0;
      const fmt = (n: number) => n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      for (const it of items) {
        if (y + 18 > doc.page.height - doc.page.margins.bottom) {
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 28 });
          y = doc.page.margins.top;
          y = drawRow(y, cols.map(c => c.label), { bold: true, bg: '#eeeeee', aligns });
        }
        const net = nrm(it.invoiceNetAmount);
        const iva = nrm(it.invoiceIvaAmount);
        const total = nrm(it.amount);
        const aliq = nrm(it.invoiceIvaAliquot);
        totalNet += net; totalIva += iva; totalAmt += total;
        y = drawRow(y, [
          fmtDate(it.invoiceEmittedAt || it.date),
          it.invoiceDocType || '',
          it.invoiceVoucherId || '',
          it.invoiceEmitterCuit || '',
          it._clientName,
          it._clientTaxId,
          fmt(net),
          aliq ? aliq.toFixed(2) : '',
          fmt(iva),
          `${it.currency || 'ARS'} ${fmt(total)}`,
          it.invoiceCae || '',
          it.invoiceEnvironment === 'production' ? 'Prod' : 'Pruebas',
        ], { aligns });
      }

      if (y + 22 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A4', layout: 'landscape', margin: 28 });
        y = doc.page.margins.top;
      }
      y = drawRow(y, [
        '', '', '', '', `TOTAL (${items.length})`, '',
        fmt(totalNet), '', fmt(totalIva), fmt(totalAmt), '', '',
      ], { bold: true, bg: '#f5f5f5', aligns });

      doc.end();
    } catch (err) {
      try { res.status(500).json({ message: sanitizeError(err) }); } catch {}
    }
  });

  // Allowlist: only HTTPS Facturita hosts (and their CDN/storage subdomains).
  // Mitigates SSRF since invoicePdfUrl comes from a remote provider but is
  // stored in our DB and could be tampered with.
  // NOTE: Facturitas serves the actual PDF bytes from a time-limited SAS-signed
  // Azure Blob URL on `apifacturitas.blob.core.windows.net` (NOT *.facturita.com).
  // That exact host must be allow-listed or every real provider PDF (zip export
  // and the per-tx redirect below) gets rejected as "URL no permitida". We pin
  // the specific blob host instead of the wildcard `.blob.core.windows.net`
  // suffix to avoid opening an SSRF hole to arbitrary Azure tenants.
  const ALLOWED_PDF_HOST_SUFFIXES = [
    '.facturita.com',
    'facturita.com',
    'apifacturitas.blob.core.windows.net',
  ];
  function isAllowedPdfUrl(raw: string | null | undefined): URL | null {
    if (!raw) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const ok = ALLOWED_PDF_HOST_SUFFIXES.some(suf => host === suf.replace(/^\./, '') || host.endsWith(suf));
    return ok ? u : null;
  }

  app.get('/api/invoicing/invoices.zip', requireAuth, async (req: any, res) => {
    try {
      const items = await loadExportItems(req);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="facturas_pdf_${fmtDate(new Date())}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('warning', (err) => { if (err.code !== 'ENOENT') console.warn('[zip] warn', err); });
      archive.on('error', (err) => {
        console.error('[zip] error', err);
        try { res.destroy(err); } catch {}
      });
      archive.pipe(res);

      const errors: string[] = [];
      let included = 0, skipped = 0;
      // Build absolute base URL for internal mock PDFs so they can be fetched
      // from this same process (zip exports run server-side).
      const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol || 'http';
      const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
      const internalBase = host ? `${proto}://${host}` : null;
      const authHeader = req.headers.authorization;
      for (const it of items) {
        // Allow internal mock PDFs (simulated invoices) without going through
        // the external host allowlist.
        const isMockPdf = !!it.invoiceSimulated
          && typeof it.invoicePdfUrl === 'string'
          && it.invoicePdfUrl.startsWith(MOCK_PDF_PATH_PREFIX);
        const safeUrl = isMockPdf
          ? (internalBase ? new URL(`${internalBase}${it.invoicePdfUrl}`) : null)
          : isAllowedPdfUrl(it.invoicePdfUrl);
        if (!safeUrl) {
          if (it.invoicePdfUrl) {
            errors.push(`${it.invoiceVoucherId || it.id}: URL de PDF no permitida`);
            skipped += 1;
          }
          continue;
        }
        try {
          const resp = await fetch(safeUrl.toString(), {
            headers: isMockPdf && authHeader ? { Authorization: authHeader } : undefined,
          });
          if (!resp.ok || !resp.body) {
            errors.push(`${it.invoiceVoucherId || it.id}: HTTP ${resp.status}`);
            continue;
          }
          const safeName = `${it.invoiceDocType || 'FAC'}_${(it.invoiceVoucherId || it.id).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`;
          // Stream body straight into the archive (no full buffering)
          const nodeStream = Readable.fromWeb(resp.body as any);
          archive.append(nodeStream, { name: safeName });
          // Wait for this entry to finish before appending the next, so back-pressure works
          await new Promise<void>((resolve, reject) => {
            archive.once('entry', () => resolve());
            nodeStream.once('error', reject);
          });
          included += 1;
        } catch (e: any) {
          errors.push(`${it.invoiceVoucherId || it.id}: ${e?.message || 'error'}`);
        }
      }
      if (errors.length > 0) {
        archive.append(`No se pudieron incluir ${errors.length} PDFs:\n\n${errors.join('\n')}\n`, { name: '_errores.txt' });
      }
      if (included === 0 && errors.length === 0 && skipped === 0) {
        archive.append('Ninguna factura del filtro tiene PDF disponible.\n', { name: '_vacio.txt' });
      }
      await archive.finalize();
    } catch (err) {
      try {
        if (!res.headersSent) res.status(500).json({ message: sanitizeError(err) });
        else res.destroy(err as Error);
      } catch {}
    }
  });

  // ------------------------------------------------------------------------
  // GET /api/invoicing/transactions/:id/pdf?type=invoice|creditNote
  // Redirects to a FRESH PDF URL for an already-emitted comprobante.
  //
  // Facturitas serves PDFs from time-limited SAS-signed Azure Blob links; the
  // URL captured at emission expires, so opening an OLD invoice/NC with the
  // stored link fails ("AuthenticationFailed"). We re-fetch a valid link from
  // the provider by uuid and 302-redirect to it. Simulated (mock) invoices
  // redirect to the internal mock PDF route. requireAuth here authenticates via
  // the session cookie, so plain <a>/window.open navigations work without a
  // Bearer header. No requireInvoicingEnabled: viewing already-emitted PDFs
  // must keep working even if the feature flag is later toggled off (mirrors
  // the invoices.zip export).
  // ------------------------------------------------------------------------
  app.get('/api/invoicing/transactions/:id/pdf', requireAuth, async (req: any, res) => {
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const pdfErrorPage = (status: number, message: string) => {
      try {
        res.status(status).type('html').send(
          `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<title>No se pudo abrir el comprobante</title>` +
          `<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;` +
          `background:#0b0f1a;color:#e6edf3;display:flex;min-height:100vh;margin:0;` +
          `align-items:center;justify-content:center;padding:24px}` +
          `.card{max-width:440px;text-align:center;background:#121826;border:1px solid #1f2937;` +
          `border-radius:16px;padding:28px}h1{font-size:18px;margin:0 0 10px}` +
          `p{font-size:14px;color:#9aa4b2;margin:0;line-height:1.5}</style></head><body>` +
          `<div class="card"><h1>No se pudo abrir el comprobante</h1>` +
          `<p>${esc(message)}</p></div></body></html>`,
        );
      } catch {}
    };
    try {
      const { id } = req.params;
      const wantsCreditNote =
        String(req.query.type || '').toLowerCase() === 'creditnote';

      const tx = await storage.getTransaction(id);
      if (!tx || tx.organizationId !== req.organizationId) {
        return pdfErrorPage(404, 'No encontramos este comprobante en tu organización.');
      }

      const storedUrl = wantsCreditNote
        ? tx.invoiceCreditNotePdfUrl
        : tx.invoicePdfUrl;
      const primaryUuid = wantsCreditNote
        ? tx.invoiceCreditNoteUuid
        : tx.invoiceUuid;
      // For credit notes, the original invoice uuid lets us recover the
      // `credit_note_pdf_url` even when the NC-specific columns are missing
      // (historical/incomplete rows).
      const ncFallbackUuid = wantsCreditNote ? tx.invoiceUuid : null;

      if (!primaryUuid && !storedUrl && !ncFallbackUuid) {
        return pdfErrorPage(404, 'Este movimiento todavía no tiene un comprobante emitido.');
      }

      // Simulated (mock) invoices: the PDF is generated by this same server.
      // Redirect to the internal mock route (also cookie-authenticated).
      const isMockUrl =
        typeof storedUrl === 'string' && storedUrl.startsWith(MOCK_PDF_PATH_PREFIX);
      if (tx.invoiceSimulated || isMockUrl) {
        if (isMockUrl) return res.redirect(302, storedUrl as string);
        if (primaryUuid) {
          return res.redirect(
            302,
            `${MOCK_PDF_PATH_PREFIX}${encodeURIComponent(primaryUuid)}`,
          );
        }
        return pdfErrorPage(404, 'No encontramos el comprobante simulado.');
      }

      // Real provider: re-fetch a fresh, non-expired PDF URL by uuid.
      const environment =
        (tx.invoiceEnvironment as InvoicingEnvironment) || 'production';
      let freshUrl: string | null = null;
      try {
        freshUrl = await fetchFreshPdfUrl({
          environment,
          primaryUuid,
          creditNoteFallbackUuid: ncFallbackUuid,
        });
      } catch {
        freshUrl = null;
      }

      // Fall back to the stored URL only if the provider didn't return a fresh
      // one (e.g. provider unreachable) — it may still be inside its window.
      const candidate = freshUrl || storedUrl || null;
      const safeUrl = isAllowedPdfUrl(candidate);
      if (!safeUrl) {
        return pdfErrorPage(
          502,
          'No pudimos obtener el PDF desde el facturador en este momento. Probá de nuevo en unos minutos.',
        );
      }

      // Best-effort: persist the refreshed URL so other features (export ZIP,
      // email) start from a fresher link. Never block the redirect on this.
      if (freshUrl && freshUrl !== storedUrl) {
        try {
          await db.update(transactions)
            .set(
              wantsCreditNote
                ? { invoiceCreditNotePdfUrl: freshUrl }
                : { invoicePdfUrl: freshUrl },
            )
            .where(eq(transactions.id, tx.id));
        } catch {
          // ignore — refreshing the redirect target is the priority
        }
      }

      return res.redirect(302, safeUrl.toString());
    } catch (err) {
      return pdfErrorPage(500, 'Ocurrió un error inesperado al abrir el comprobante.');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/transactions/:id/emit → emit invoice for a tx
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/transactions/:id/emit', requireInvoicingEnabled, requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const { id } = req.params;
      const tx = await storage.getTransaction(id);
      if (!tx || tx.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Movimiento no encontrado' });
      }
      // We support emission for both client-directed comprobantes
      // (ingresos / cuentas a cobrar) and supplier-directed comprobantes
      // propios — p. ej. notas de débito/crédito de devoluciones de compra
      // emitidas por la organización al proveedor (egreso / a pagar).
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

      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc || !acc.isActive) {
        return res.status(400).json({ message: 'Configurá Facturador antes de emitir facturas (Configuración → Facturador)' });
      }

      // Resolve the selling point to use for this emission. Order:
      //   1) Explicit number passed in the request body (user picked one).
      //   2) acc.defaultSellingPoint, but only if it actually exists & is
      //      active in the synced list (otherwise we'd repeat the bug where
      //      we kept asking ARCA for PV 1 when only PV 4 existed for the CUIT).
      //   3) First ACTIVE synced selling point — and self-heal the default
      //      so future emits don't re-derive.
      //   4) First synced selling point regardless of active flag.
      //   5) Last-resort fallback to 1 (legacy behavior).
      const sellingPoints = await storage.getSellingPointsByOrganization(req.organizationId);
      const activeSellingPoints = sellingPoints.filter(sp => sp.isActive);
      const requestedSellingPoint = req.body?.sellingPoint as number | undefined;
      let sellingPoint: number;
      if (requestedSellingPoint != null) {
        sellingPoint = requestedSellingPoint;
      } else if (
        acc.defaultSellingPoint != null
        && activeSellingPoints.some(sp => sp.number === acc.defaultSellingPoint)
      ) {
        sellingPoint = acc.defaultSellingPoint;
      } else if (activeSellingPoints.length > 0) {
        sellingPoint = activeSellingPoints[0].number;
        // Self-heal: the saved default doesn't match what the provider has;
        // persist the first active PV so future emissions skip this branch.
        try {
          await storage.upsertInvoicingAccount(req.organizationId, { defaultSellingPoint: sellingPoint });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('[invoicing] failed to self-heal defaultSellingPoint', e);
        }
      } else if (sellingPoints.length > 0) {
        sellingPoint = sellingPoints[0].number;
      } else {
        sellingPoint = 1;
      }

      const parsed = emitInvoiceSchema.parse(req.body || {});

      const emitterCondition = acc.ivaCondition as InvoicingEmitterIvaCondition;
      const validation = validateEmissionRequest({
        txType: tx.type as 'income' | 'receivable' | 'expense' | 'payable',
        emitterCondition,
        receiverCondition: parsed.receiver.ivaCondition,
        explicitDocType: parsed.docType ?? null,
      });
      if (!validation.ok) {
        return res.status(validation.status).json({ message: validation.message });
      }
      const docType: InvoicingDocType = validation.docType;
      const isNote = isCreditNoteDocType(docType) || isDebitNoteDocType(docType);

      // Idempotency lock: claim the emission slot before calling Facturita
      const lockUuid = `pending-${tx.id}-${Date.now()}`;
      const locked = await db.update(transactions)
        .set({ invoiceUuid: lockUuid, invoiceEmissionStatus: 'pending', invoiceEnvironment: acc.environment })
        .where(and(eq(transactions.id, tx.id), isNull(transactions.invoiceUuid)))
        .returning({ id: transactions.id });
      if (locked.length === 0) {
        return res.status(409).json({ message: 'Ya hay una emisión en curso o realizada para este movimiento' });
      }

      const ctx: FacturitaContext = {
        cuit: acc.cuit,
        environment: acc.environment as InvoicingEnvironment,
        emitterIvaCondition: emitterCondition,
      };

      const items: InvoiceLineItem[] = parsed.items;
      const receiver: ReceiverInfo = {
        taxId: parsed.receiver.taxId ?? null,
        name: parsed.receiver.name,
        ivaCondition: parsed.receiver.ivaCondition,
        address: parsed.receiver.address ?? null,
        phone: parsed.receiver.phone ?? null,
        email: parsed.receiver.email ?? null,
      };

      // Production must use the real provider — fail closed if not configured.
      if (ctx.environment === 'production') {
        const prod = requireProductionProvider();
        if (!prod.ok) {
          await db.update(transactions)
            .set({
              invoiceUuid: null,
              invoiceEmissionStatus: 'failed',
              invoiceEmissionErrorMessage: prod.reason || 'La facturación electrónica no está disponible en este momento.',
              invoiceEmissionErrorCode: 'NETWORK',
              invoiceEmissionErrorAt: new Date(),
            })
            .where(eq(transactions.id, tx.id));
          return res.status(503).json({ message: prod.reason, code: 'NETWORK' });
        }
      }

      let result;
      let usedMock = false;
      const tryMockEmit = async () => {
        usedMock = true;
        // Mock voucher numbering: incremental per (selling point + docType),
        // matching ARCA's PPPP-NNNNNNNN convention.
        const allInvoices = await storage.getEmittedInvoicesByOrganization(req.organizationId, {});
        const maxN = allInvoices.reduce((m, i) => {
          if (i.invoiceDocType !== docType) return m;
          const parsed2 = parseMockVoucher(i.invoiceVoucherId);
          if (!parsed2 || parsed2.pv !== sellingPoint) return m;
          return Math.max(m, parsed2.n);
        }, 0);
        return mockEmitInvoice({
          ctx,
          sellingPoint,
          docType,
          receiver,
          items,
          date: tx.date,
          currency: tx.currency || 'ARS',
          exchangeRate: parsed.exchangeRate ?? null,
          externalReference: tx.id,
          observations: parsed.observations ?? null,
          nextVoucherNumber: maxN + 1,
          sellingPointNumber: sellingPoint,
        });
      };

      try {
        if (shouldUseSandboxMock(ctx.environment)) {
          result = await tryMockEmit();
        } else if (isNote) {
          // NC/ND a proveedores: the upstream API has no standalone-note
          // endpoint. For Notas de Crédito the Facturita client uses a
          // shadow-factura + PATCH NC technique (real CAE/voucher/PDF
          // backed by ARCA, see emitStandaloneCreditNote). For Notas de
          // Débito there is no provider endpoint at all, so
          // emitStandaloneDebitNote throws 501 and the user is asked to
          // emit the ND manually from ARCA — we deliberately do NOT fake
          // an ND by emitting a Factura.
          try {
            const noteInput = {
              ctx,
              sellingPoint,
              docType,
              receiver,
              items,
              date: tx.date,
              currency: tx.currency || 'ARS',
              exchangeRate: parsed.exchangeRate ?? null,
              externalReference: tx.id,
              observations: parsed.observations ?? null,
            };
            result = isCreditNoteDocType(docType)
              ? await emitStandaloneCreditNote(noteInput)
              : await emitStandaloneDebitNote(noteInput);
          } catch (err) {
            if (isMockFallbackEligible(ctx.environment, err)) {
              console.warn('[invoicing] note emit falling back to internal sandbox mock:', (err as FacturitaError).message);
              result = await tryMockEmit();
            } else {
              throw err;
            }
          }
        } else {
          try {
            result = await emitInvoice({
              ctx,
              sellingPoint,
              docType,
              receiver,
              items,
              date: tx.date,
              currency: tx.currency || 'ARS',
              exchangeRate: parsed.exchangeRate ?? null,
              externalReference: tx.id,
              observations: parsed.observations ?? null,
              itemType: parsed.itemType ?? 'product',
              serviceFrom: parsed.serviceFrom ? ymdToLocalDate(parsed.serviceFrom) : null,
              serviceTo: parsed.serviceTo ? ymdToLocalDate(parsed.serviceTo) : null,
              paymentDueDate: parsed.paymentDueDate ? ymdToLocalDate(parsed.paymentDueDate) : null,
            });
          } catch (err) {
            // BAD_RESPONSE: el proveedor respondió 2xx pero el body llegó sin
            // `invoice_uuid` / `cae`. La factura puede haber quedado emitida
            // en ARCA igual. Espejo de la lógica de credit-note (líneas
            // ~2148-2222): (a) audit log con rawResponse, (b) email-alerta al
            // admin, (c) intento de reconciliación contra el proveedor por
            // external_reference. Solo aplica en producción — sandbox sigue
            // cayendo al mock fallback.
            if (err instanceof FacturitaError && err.code === 'BAD_RESPONSE') {
              try {
                await storage.createAuditLog({
                  organizationId: req.organizationId,
                  userId: req.userId,
                  entityType: 'transaction',
                  entityId: tx.id,
                  action: 'invoice_bad_response',
                  previousData: JSON.stringify({
                    docType,
                    sellingPoint,
                    environment: ctx.environment,
                  }),
                  newData: JSON.stringify({
                    externalReference: tx.id,
                    message: err.message,
                    status: err.status,
                    rawResponse: scrubFacturitaResponseForLog(err.details),
                  }),
                });
              } catch (logErr) {
                console.warn('[invoicing] failed to persist invoice BAD_RESPONSE audit log:', (logErr as Error)?.message);
              }

              const alertsEnabled = process.env.INVOICING_BAD_RESPONSE_ALERTS !== 'false';
              if (alertsEnabled) {
                (async () => {
                  try {
                    const owner = await storage.getOrganizationOwner(req.organizationId);
                    if (!owner?.email) return;
                    const org = await storage.getOrganization(req.organizationId).catch(() => null);
                    const totalGuess = items.reduce(
                      (sum, it) => sum + Number(it.unitPriceNet || 0) * Number(it.quantity || 0),
                      0,
                    );
                    await sendInvoiceBadResponseAlertEmail({
                      to: owner.email,
                      recipientName: owner.name || 'equipo',
                      organizationName: org?.name || 'tu organización',
                      receiverName: receiver.name || '—',
                      totalLabel: `${tx.currency || 'ARS'} ${totalGuess.toFixed(2)}`,
                      errorMessage: err.message || 'Respuesta incompleta del proveedor',
                      transactionId: tx.id,
                      environment: ctx.environment,
                    });
                  } catch (mailErr) {
                    console.warn(
                      '[invoicing] failed to send invoice BAD_RESPONSE alert email:',
                      (mailErr as Error)?.message,
                    );
                  }
                })();
              }

              // Reconciliación: solo en producción. En sandbox dejamos que
              // caiga al mock fallback porque no es autoritativo en ARCA.
              if (ctx.environment === 'production') {
                const reconciledResult = await tryReconcileInvoice({
                  ctx,
                  externalReference: tx.id,
                });
                if (reconciledResult) {
                  console.warn('[invoicing] invoice reconciled after BAD_RESPONSE:', reconciledResult.uuid);
                  // Mantener el docType validado por el server — el listado
                  // de Facturitas no siempre devuelve el tipo correcto.
                  result = { ...reconciledResult, docType };
                }
              }
            }

            if (!result) {
              if (isMockFallbackEligible(ctx.environment, err)) {
                console.warn('[invoicing] emit falling back to internal sandbox mock:', (err as FacturitaError).message);
                result = await tryMockEmit();
              } else {
                throw err;
              }
            }
          }
        }
      } catch (err) {
        // Classify the error so we can persist a user-facing Spanish message
        // AND a stable internal code for analytics. Both are saved on the
        // transaction so the user (or anyone reopening the detail) can see
        // exactly why it failed without rerunning the emission.
        const { code: classifiedCode, message: userMessage } = classifyInvoicingError(err, 'emit');
        // Release the idempotency lock so the user can retry, and persist
        // the failure reason on the transaction itself.
        await db.update(transactions)
          .set({
            invoiceUuid: null,
            invoiceEmissionStatus: 'failed',
            invoiceEmissionErrorMessage: userMessage,
            invoiceEmissionErrorCode: classifiedCode,
            invoiceEmissionErrorAt: new Date(),
          })
          .where(eq(transactions.id, tx.id));
        if (err instanceof FacturitaError) {
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'transaction',
            entityId: tx.id,
            action: 'invoice_emit_failed',
            previousData: null,
            newData: JSON.stringify({
              message: err.message,
              providerCode: err.code,
              classifiedCode,
              status: err.status,
              // Include the scrubbed provider response so ops can see the
              // exact validation detail without re-running the request.
              // Mirrors the credit_note_emit_failed audit log (~line 1840).
              rawResponse: scrubFacturitaResponseForLog(err.details),
            }),
          });
        }
        return handleFacturitaError(res, err, 'emit');
      }

      // Sync the transaction amount with the invoice TOTAL when they diverge.
      // Use case (Juan, 08/05/2026): user opens the emit modal on a $5000
      // movement, edits the "Neto" field to 4500, emits FC. Without this,
      // the PDF says $4500 but transaction.amount stays at $5000 — books
      // and invoice disagree forever. We only sync for non-note doctypes
      // (FA/FB/FC/MA/MB/MC); credit/debit notes have inverse semantics
      // against the original movement and must not overwrite its amount.
      const invoiceTotal = Math.round(Number(result.total ?? (Number(result.net) + Number(result.iva))) * 100) / 100;
      const txAmountNum = Number(tx.amount);
      const shouldSyncAmount = !isNote
        && Number.isFinite(invoiceTotal)
        && invoiceTotal > 0
        && Math.abs(invoiceTotal - txAmountNum) > 0.005;

      // Persist invoice info on the transaction
      await db.update(transactions).set({
        invoiceUuid: result.uuid,
        invoiceVoucherId: result.voucherNumber,
        invoiceCae: result.cae,
        invoiceCaeExpirationDate: result.caeExpirationDate,
        invoicePdfUrl: result.pdfUrl,
        invoiceEnvironment: ctx.environment,
        invoiceEmissionStatus: 'emitted',
        // Clear any prior failure reason now that this emission succeeded.
        invoiceEmissionErrorMessage: null,
        invoiceEmissionErrorCode: null,
        invoiceEmissionErrorAt: null,
        invoiceEmittedAt: result.emittedAt,
        invoiceDocType: docType,
        invoiceEmitterCuit: acc.cuit,
        hasInvoice: true,
        invoiceType: docType,
        invoiceNumber: result.voucherNumber,
        invoiceFileUrl: result.pdfUrl,
        invoiceNetAmount: String(result.net),
        invoiceIvaAmount: String(result.iva),
        invoiceTaxId: receiver.taxId ?? null,
        invoiceAddress: receiver.address ?? null,
        invoicePhone: receiver.phone ?? null,
        invoiceSimulated: usedMock,
        ...(shouldSyncAmount ? { amount: String(invoiceTotal) } : {}),
      }).where(eq(transactions.id, tx.id));

      if (shouldSyncAmount) {
        await storage.createAuditLog({
          organizationId: req.organizationId,
          userId: req.userId,
          entityType: 'transaction',
          entityId: tx.id,
          action: 'amount_synced_to_invoice',
          previousData: JSON.stringify({ amount: String(txAmountNum) }),
          newData: JSON.stringify({
            amount: String(invoiceTotal),
            reason: 'invoice_emit_total_diverged',
            invoiceUuid: result.uuid,
            invoiceVoucherId: result.voucherNumber,
          }),
        });
      }

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: tx.id,
        action: 'invoice_emitted',
        previousData: null,
        newData: JSON.stringify({
          uuid: result.uuid, voucherNumber: result.voucherNumber, docType, environment: ctx.environment,
        }),
      });

      const updated = await storage.getTransaction(tx.id);
      res.json({ transaction: updated, invoice: result });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      handleFacturitaError(res, err, 'emit');
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/transactions/:id/send-pdf → email the emitted invoice
  // PDF (real or simulated) to the receiver, with optional CCs / sender copy.
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/transactions/:id/send-pdf', requireInvoicingEnabled, requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const schema = z.object({
        to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(10)]),
        cc: z.array(z.string().email()).max(10).optional(),
        bcc: z.array(z.string().email()).max(10).optional(),
        message: z.string().max(2000).nullable().optional(),
      });
      const body = schema.parse(req.body || {});
      const primaryRecipients = Array.isArray(body.to) ? body.to : [body.to];

      const tx = await storage.getTransaction(id);
      if (!tx || tx.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Movimiento no encontrado' });
      }
      if (!tx.invoiceUuid || !tx.invoicePdfUrl) {
        return res.status(400).json({ message: 'Este movimiento todavía no tiene una factura emitida' });
      }

      const result = await attemptInvoiceEmailSend(tx, {
        to: primaryRecipients,
        cc: body.cc,
        bcc: body.bcc,
        message: body.message ?? null,
      });
      const { sent, failed } = result;
      if (result.pdfError) {
        // PDF resolution problem (URL invalid or download error). Bail early
        // — nothing was sent and SendGrid was never contacted, so there's no
        // point persisting per-recipient failure status here.
        console.warn('[invoicing] could not resolve PDF for email', result.errorMessage);
        return res.status(502).json({ message: result.errorMessage || 'No pudimos descargar el PDF de la factura para enviarlo por email. Probá de nuevo en unos minutos.' });
      }

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: tx.id,
        action: 'invoice_emailed',
        previousData: null,
        newData: JSON.stringify({ sent, failed, cc: body.cc || [], bcc: body.bcc || [] }),
      });

      // Persist email delivery status on the transaction so the user keeps a
      // visible record (badge in invoices list + retry button) instead of
      // relying only on the toast.
      const emailStatus = failed.length === 0 ? 'sent' : 'failed';
      const recipientsSnapshot = {
        to: primaryRecipients,
        cc: body.cc || [],
        bcc: body.bcc || [],
        message: body.message ?? null,
      };
      try {
        const emailUpdate: Partial<InsertTransaction> = {
          invoiceEmailStatus: emailStatus,
          invoiceEmailLastAttemptAt: new Date(),
          invoiceEmailLastError: failed.length > 0
            ? `No se pudo enviar a: ${failed.join(', ')}`
            : null,
          invoiceEmailLastRecipients: JSON.stringify(recipientsSnapshot),
          // Manual sends reset the retry counter: a successful manual send
          // should clear it, and a failed one should give the cron a fresh
          // budget of automatic retries instead of inheriting an exhausted one.
          invoiceEmailRetryCount: 0,
        };
        await storage.updateTransaction(tx.id, emailUpdate);
      } catch (e) {
        console.warn('[invoicing] could not persist email status', e);
      }

      // If the manual send succeeded, close any pending failure notification
      // for this transaction so the user doesn't keep seeing a stale alert.
      if (emailStatus === 'sent') {
        try {
          await storage.markInvoiceEmailFailureNotificationsRead(tx.id);
        } catch (e) {
          console.warn('[invoicing] could not clear prior failure notifications', e);
        }
      }

      // Notify (bell) if any recipient failed so the user finds out without
      // having to keep the toast on screen.
      if (failed.length > 0) {
        try {
          const docLabel = `${tx.invoiceDocType || 'Factura'} ${tx.invoiceVoucherId || tx.invoiceNumber || ''}`.trim();
          await storage.createNotification({
            userId: req.userId,
            organizationId: req.organizationId,
            type: 'invoice_email_failed',
            priority: 'warning',
            title: 'No pudimos enviar la factura por email',
            message: `${docLabel} — falló el envío a: ${failed.join(', ')}. Reintentá desde Oficina → Facturas.`,
            transactionId: tx.id,
            source: 'auto',
          });
        } catch (e) {
          console.warn('[invoicing] could not create email failure notification', e);
        }
      }

      const status = sent.length > 0 ? 200 : 502;
      res.status(status).json({ sent, failed });
    } catch (err: any) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      console.warn('[invoicing] send-pdf error', err);
      res.status(500).json({ message: 'No pudimos enviar el email. Probá de nuevo en unos minutos.' });
    }
  });

  // ------------------------------------------------------------------------
  // POST /api/invoicing/transactions/:id/credit-note → emit NC for a tx
  // ------------------------------------------------------------------------
  app.post('/api/invoicing/transactions/:id/credit-note', requireInvoicingEnabled, requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const env = requireInvoicingEnv();
      if (!env.ok) return res.status(503).json({ message: env.reason });

      const { id } = req.params;
      const tx = await storage.getTransaction(id);
      if (!tx || tx.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Movimiento no encontrado' });
      }
      if (!tx.invoiceUuid || !tx.invoiceDocType) {
        return res.status(400).json({ message: 'Este movimiento no tiene una factura para anular' });
      }
      if (tx.invoiceCreditNoteUuid) {
        return res.status(409).json({
          message: 'Esta factura ya tiene una Nota de Crédito emitida.',
          code: 'ALREADY_EMITTED',
        });
      }

      const acc = await storage.getInvoicingAccount(req.organizationId);
      if (!acc) return res.status(400).json({ message: 'Configurá Facturador antes de continuar' });

      const { reason } = emitCreditNoteSchema.parse(req.body || {});

      const ctx: FacturitaContext = {
        cuit: acc.cuit,
        environment: acc.environment as InvoicingEnvironment,
        emitterIvaCondition: acc.ivaCondition as InvoicingEmitterIvaCondition,
      };

      // Production must use the real provider — fail closed if not configured.
      if (ctx.environment === 'production') {
        const prod = requireProductionProvider();
        if (!prod.ok) return res.status(503).json({ message: prod.reason });
      }

      const wasSimulatedInvoice = !!tx.invoiceSimulated;

      // Production may NEVER use the mock — even for invoices that were
      // originally simulated. Those should not exist in prod, but if they do,
      // refuse and surface a clear message.
      const guard = checkCreditNoteProductionGuard(ctx.environment, wasSimulatedInvoice);
      if (!guard.ok) {
        return res.status(guard.status ?? 409).json({ message: guard.message });
      }

      let result;
      let usedMockNc = false;
      let reconciled = false;
      const tryMockNc = async () => {
        usedMockNc = true;
        const ncDocType = selectCreditNoteDocType(tx.invoiceDocType as InvoicingDocType);
        // Reuse the original invoice's selling point if encoded in voucher,
        // otherwise fall back to the account default (or 1).
        const origPv = parseMockVoucher(tx.invoiceVoucherId)?.pv
          ?? acc.defaultSellingPoint
          ?? 1;
        const allInvoices = await storage.getEmittedInvoicesByOrganization(req.organizationId, {});
        const maxN = allInvoices.reduce((m, i) => {
          if (i.invoiceDocType !== ncDocType) return m;
          const parsed2 = parseMockVoucher(i.invoiceVoucherId);
          if (!parsed2 || parsed2.pv !== origPv) return m;
          return Math.max(m, parsed2.n);
        }, 0);
        return mockEmitCreditNote({
          ctx,
          originalInvoiceUuid: tx.invoiceUuid!,
          originalDocType: tx.invoiceDocType as InvoicingDocType,
          date: new Date(),
          reason,
          externalReference: tx.id,
          nextVoucherNumber: maxN + 1,
          sellingPointNumber: origPv,
        });
      };

      // If the original invoice was simulated, only the mock can cancel it.
      if (shouldUseMockForCreditNote(ctx.environment, wasSimulatedInvoice)) {
        result = await tryMockNc();
      } else {
        try {
          result = await emitCreditNote({
            ctx,
            originalInvoiceUuid: tx.invoiceUuid,
            originalDocType: tx.invoiceDocType as InvoicingDocType,
            date: new Date(),
            reason,
            externalReference: tx.id,
          });
        } catch (err) {
          // BAD_RESPONSE: provider returned an incomplete body (missing
          // credit_note_uuid / cae). The NC may have actually been emitted
          // on ARCA's side, so we (a) persist a diagnostic audit log with
          // the scrubbed raw body and the consulted invoiceUuid, and
          // (b) try a best-effort reconciliation against the provider to
          // detect & adopt an already-emitted NC, avoiding double emission.
          if (err instanceof FacturitaError && err.code === 'BAD_RESPONSE') {
            try {
              await storage.createAuditLog({
                organizationId: req.organizationId,
                userId: req.userId,
                entityType: 'transaction',
                entityId: tx.id,
                action: 'credit_note_bad_response',
                previousData: JSON.stringify({
                  invoiceUuid: tx.invoiceUuid,
                  invoiceDocType: tx.invoiceDocType,
                  environment: ctx.environment,
                }),
                newData: JSON.stringify({
                  invoiceUuid: tx.invoiceUuid,
                  externalReference: tx.id,
                  message: err.message,
                  status: err.status,
                  rawResponse: scrubFacturitaResponseForLog(err.details),
                }),
              });
            } catch (logErr) {
              console.warn('[invoicing] failed to persist BAD_RESPONSE audit log:', (logErr as Error)?.message);
            }

            // Best-effort alert email to the org owner so the case doesn't
            // sit silently in the audit log. Gated by INVOICING_BAD_RESPONSE_ALERTS
            // (defaults to enabled) so we can mute it if the provider has a
            // mass outage and we don't want to spam everyone.
            const alertsEnabled = process.env.INVOICING_BAD_RESPONSE_ALERTS !== 'false';
            if (alertsEnabled) {
              (async () => {
                try {
                  const owner = await storage.getOrganizationOwner(req.organizationId);
                  if (!owner?.email) return;
                  const org = await storage.getOrganization(req.organizationId).catch(() => null);
                  await sendCreditNoteBadResponseAlertEmail({
                    to: owner.email,
                    recipientName: owner.name || 'equipo',
                    organizationName: org?.name || 'tu organización',
                    invoiceDocType: tx.invoiceDocType || 'Factura',
                    invoiceVoucher: tx.invoiceVoucherId || tx.invoiceNumber || '',
                    reason,
                    errorMessage: err.message || 'Respuesta incompleta del proveedor',
                    transactionId: tx.id,
                    environment: ctx.environment,
                  });
                } catch (mailErr) {
                  console.warn(
                    '[invoicing] failed to send BAD_RESPONSE alert email:',
                    (mailErr as Error)?.message,
                  );
                }
              })();
            }

            // Reconciliation: gated to production-only per scope. Sandbox
            // BAD_RESPONSE keeps falling through to mock-fallback / re-throw
            // because sandbox NCs are not authoritative on ARCA's side.
            // The helper itself swallows all errors and returns null when
            // the NC cannot be confirmed.
            if (ctx.environment === 'production') {
              const reconciledResult = await tryReconcileCreditNote({
                ctx,
                originalInvoiceUuid: tx.invoiceUuid,
                originalDocType: tx.invoiceDocType as InvoicingDocType,
                externalReference: tx.id,
              });
              if (reconciledResult) {
                console.warn('[invoicing] credit-note reconciled after BAD_RESPONSE:', reconciledResult.uuid);
                result = reconciledResult;
                reconciled = true;
              }
            }
          }

          if (!result) {
            if (isMockFallbackEligible(ctx.environment, err)) {
              console.warn('[invoicing] credit-note falling back to internal sandbox mock:', (err as FacturitaError).message);
              result = await tryMockNc();
            } else {
              throw err;
            }
          }
        }
      }

      await db.update(transactions)
        .set(buildCreditNoteUpdatePatch(result.uuid, usedMockNc, result.pdfUrl))
        .where(eq(transactions.id, tx.id));

      await storage.createAuditLog({
        organizationId: req.organizationId,
        userId: req.userId,
        entityType: 'transaction',
        entityId: tx.id,
        action: 'credit_note_emitted',
        previousData: JSON.stringify({ invoiceUuid: tx.invoiceUuid }),
        newData: JSON.stringify({
          creditNoteUuid: result.uuid,
          voucherNumber: result.voucherNumber,
          ...(reconciled ? { reconciled: true } : {}),
        }),
      });

      const updated = await storage.getTransaction(tx.id);
      res.json({ transaction: updated, creditNote: result });
    } catch (err) {
      if (err instanceof z.ZodError) return res.status(400).json({ message: 'Datos inválidos', errors: err.errors });
      // Persist a structured audit log for NC failures so we have the same
      // forensic trail we already keep for invoice emission (see line ~1397).
      // This is what lets ops answer "was it our payload or the provider?"
      // without depending on ephemeral console logs.
      if (err instanceof FacturitaError) {
        try {
          const { code: classifiedCode } = classifyInvoicingError(err, 'emit');
          await storage.createAuditLog({
            organizationId: req.organizationId,
            userId: req.userId,
            entityType: 'transaction',
            entityId: req.params.id,
            action: 'credit_note_emit_failed',
            previousData: null,
            newData: JSON.stringify({
              message: err.message,
              providerCode: err.code,
              classifiedCode,
              status: err.status,
              rawResponse: scrubFacturitaResponseForLog(err.details),
            }),
          });
        } catch (logErr) {
          console.warn('[invoicing] failed to persist credit_note_emit_failed audit log:', (logErr as Error)?.message);
        }
      }
      handleFacturitaError(res, err, 'emit');
    }
  });
}
