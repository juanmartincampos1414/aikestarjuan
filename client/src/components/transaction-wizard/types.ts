import { z } from 'zod';
import { type AssetType, type AssetCategory, ARCA_INVOICE_NUMBER_REGEX, normalizeArcaInvoiceNumber } from '@shared/schema';

export type Step = 'type' | 'account' | 'amount' | 'emit' | 'confirm' | 'transfer';

export const transactionBaseSchema = z.object({
  type: z.enum(['income', 'expense', 'payable', 'receivable', 'transfer']),
  destinationAccountId: z.string().optional(), // For transfers: the destination account
  amount: z.string().min(1, 'El monto es requerido'),
  description: z.string().min(3, 'La descripción es requerida'),
  category: z.string().min(1, 'El concepto es requerido'),
  imputationDate: z.string(),
  hasInvoice: z.boolean(),
  invoiceType: z.string().optional(),
  invoiceNumber: z.string().optional(),
  invoiceNetAmount: z.string().optional(),
  invoiceIvaAliquot: z.string().optional(),
  invoiceIvaAmount: z.string().optional(),
  invoiceOtherTaxes: z.string().optional(),
  accountId: z.string().optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  supplierId: z.string().optional(),
  productId: z.string().optional(),
  productQuantity: z.string().optional(),
  profitabilityCodeId: z.string().optional(),
  paymentMethodId: z.string().optional(),
  linkedTransactionId: z.string().optional(),
  isRecurring: z.boolean().optional(),
  recurrenceFrequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).optional(),
  // Task #353: optional closed-series limit. Empty = infinite (legacy).
  // Integer >= 1 = serie cerrada: al confirmar la cuota N no se genera la próxima.
  recurrenceTotalInstallments: z.number().int().min(1).optional().nullable(),
});

// Cross-field validation: when there is an invoice and the user typed a number
// (i.e. ARCA isn't filling it for them), it must match PPPP-NNNNNNNN once
// normalized. We don't have access to the React `emitWithArca` flag here, so
// we only enforce the regex when a value is present — the wizard clears the
// field whenever ARCA is turned on.
export const transactionSchema = transactionBaseSchema.superRefine((data, ctx) => {
  if (!data.hasInvoice) return;
  const raw = (data.invoiceNumber ?? '').trim();
  if (!raw) return;
  const normalized = normalizeArcaInvoiceNumber(raw);
  if (!ARCA_INVOICE_NUMBER_REGEX.test(normalized)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invoiceNumber'],
      message: 'Formato inválido. Usá PPPP-NNNNNNNN (ej: 0001-00001234).',
    });
  }
});

export type TransactionFormValues = z.infer<typeof transactionBaseSchema>;

export interface ClassificationResult {
  assetType: AssetType;
  assetTypeLabel: string;
  confidence: number;
  assetCategory?: AssetCategory;
  assetCategoryLabel?: string;
  suggestedUsefulLifeMonths?: number;
  reasoning: string;
  isCapitalExpenditure: boolean;
}

export interface NegativeBalanceInfo {
  accountName: string;
  newBalance: number;
  currentBalance?: number;
  isPayable?: boolean;
}
