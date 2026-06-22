import { storage } from "../storage";

// `canonical` is the catalog-canonical name when the input matched a row in
// `transactionCategories` (callers should assign it back to overwrite casing
// drift). It's `null` when the input was null/empty/whitespace — meaning the
// caller should leave the existing value alone (the DB column itself is
// `NOT NULL`, so the caller decides what default to write).
export type CategoryValidationOk = { ok: true; canonical: string | null };
export type CategoryValidationFail = { ok: false; message: string };
export type CategoryValidationResult = CategoryValidationOk | CategoryValidationFail;

function normalize(s: string): string {
  return s.trim().toLocaleLowerCase("es-AR");
}

/**
 * Validates that `category` exists in the organization's `transactionCategories`
 * for the matching type (income/expense). Returns the canonical name as stored
 * in the DB (preserves the user's chosen casing). Null/undefined/empty are
 * passed through as `null` (movement without a category).
 *
 * Transfer types (`transfer_in`/`transfer_out`) skip the catalog check: those
 * are server-generated and never carry a user-facing category.
 *
 * `Ajuste Manual` is the canonical label used by the in-app current-account
 * reconcile flows (clients + suppliers, see `handleReconcile` in their pages),
 * which post through the regular `POST /api/transactions` route. Whitelist it
 * here so reconcile works on orgs that don't have it in the catalog. Casing is
 * normalized to the canonical form on match.
 */
const SYSTEM_CATEGORY_WHITELIST: Record<string, string> = {
  "ajuste manual": "Ajuste Manual",
};
export async function validateTransactionCategory(
  organizationId: string,
  type: string,
  category: string | null | undefined,
): Promise<CategoryValidationResult> {
  if (category === null || category === undefined) {
    return { ok: true, canonical: null };
  }
  const trimmed = typeof category === "string" ? category.trim() : "";
  if (trimmed.length === 0) {
    return { ok: true, canonical: null };
  }

  if (type === "transfer_in" || type === "transfer_out") {
    return { ok: true, canonical: trimmed };
  }

  const whitelistMatch = SYSTEM_CATEGORY_WHITELIST[normalize(trimmed)];
  if (whitelistMatch) {
    return { ok: true, canonical: whitelistMatch };
  }

  // income + receivable use income categories; expense + payable use expense.
  let catType: "income" | "expense";
  if (type === "income" || type === "receivable") {
    catType = "income";
  } else if (type === "expense" || type === "payable") {
    catType = "expense";
  } else {
    // Unknown type: skip rather than reject, so future tx types aren't blocked.
    return { ok: true, canonical: trimmed };
  }

  const rows = await storage.getTransactionCategoriesByOrganization(organizationId, catType);
  const needle = normalize(trimmed);
  const match = rows.find((r) => normalize(r.name) === needle);
  if (match) {
    return { ok: true, canonical: match.name };
  }
  return {
    ok: false,
    message: `La categoría "${trimmed}" no existe en la organización para movimientos de tipo ${catType === "income" ? "ingreso" : "egreso"}.`,
  };
}
