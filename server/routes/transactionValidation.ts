import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  insertTransactionBaseSchema,
  refineInvoiceNumberFormat,
  updateTransactionSchema,
  type InsertTransaction,
} from "@shared/schema";

// Schema used by `POST /api/transactions`. Re-uses the base insert schema
// (without `organizationId`, which the route fills from the session) and
// applies the strict ARCA invoice-number refinement.
//
// `invoiceVoucherId` is intentionally stripped from the payload: only the
// internal ARCA-emission code path (see `server/routes/invoicing.ts`) is
// allowed to write that field. Stripping it here prevents a malicious
// client from spoofing an ARCA-emitted invoice to bypass format checks.
//
// `invoiceCreditNotePdfUrl` is similarly internal: it must only be written
// by the credit-note emission flow with a URL returned by the provider,
// never by user input (otherwise a caller could inject an arbitrary URL
// that the UI would render as a "Descargar PDF de NC" link).
// Task #353: el cliente puede declarar `recurrenceTotalInstallments` (entero
// >= 1 o null = serie infinita), pero NO puede controlar el counter
// `recurrenceCurrentInstallment`: ese campo lo administra el servidor
// (arranca en 1 al crear, +1 en cada generación de próxima cuota). Lo
// omitimos del payload de inserción y de update, y validamos el total.
export const transactionInsertPayloadSchema = insertTransactionBaseSchema
  .omit({
    organizationId: true,
    invoiceVoucherId: true,
    invoiceCreditNotePdfUrl: true,
    recurrenceCurrentInstallment: true,
  })
  .extend({
    recurrenceTotalInstallments: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .nullable()
      .optional(),
  })
  .superRefine(refineInvoiceNumberFormat);

export type TransactionInsertPayload = z.infer<typeof transactionInsertPayloadSchema>;
export type TransactionUpdatePayload = z.infer<typeof updateTransactionSchema>;

export type ValidationFailure = {
  ok: false;
  status: number;
  body: { message: string; field?: string; errors?: z.ZodIssue[] };
};

export type ValidationSuccess<T> = { ok: true; data: T };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function buildInvoiceFailure(error: z.ZodError, fallbackMessage: string): ValidationFailure {
  const invoiceIssue = error.errors.find(e => e.path?.[0] === 'invoiceNumber');
  if (invoiceIssue) {
    return {
      ok: false,
      status: 400,
      body: { message: invoiceIssue.message, field: 'invoiceNumber', errors: error.errors },
    };
  }
  return { ok: false, status: 400, body: { message: fallbackMessage, errors: error.errors } };
}

export function parseTransactionInsertBody(body: unknown): ValidationResult<TransactionInsertPayload> {
  try {
    const data = transactionInsertPayloadSchema.parse(body);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return buildInvoiceFailure(error, 'Validation error');
    }
    throw error;
  }
}

export function parseTransactionUpdateBody(body: unknown): ValidationResult<TransactionUpdatePayload> {
  const parseResult = updateTransactionSchema.safeParse(body);
  if (parseResult.success) {
    return { ok: true, data: parseResult.data };
  }
  return buildInvoiceFailure(parseResult.error, 'Datos inválidos');
}

// Sends the validation failure response with the canonical shape used by
// `/api/transactions`. Returns true if the request was already handled.
export function respondIfInvalid<T>(res: Response, result: ValidationResult<T>): result is ValidationFailure {
  if (result.ok) return false;
  res.status(result.status).json(result.body);
  return true;
}

// Re-export so consumers don't need a second import.
export type { InsertTransaction };
