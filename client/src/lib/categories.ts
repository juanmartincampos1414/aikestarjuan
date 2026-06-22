import type { QueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api';

export type ExistingCategory = {
  id: string;
  name: string;
  type: string;
  expenseSubtype?: string | null;
};

function normalize(s: string): string {
  return s.trim().toLocaleLowerCase('es-AR');
}

// Mirror de `SYSTEM_CATEGORY_WHITELIST` en
// `server/services/categoryValidation.ts`: el server acepta estas categorías
// aunque no estén en `transactionCategories`, así que el cliente tampoco
// debe intentar crearlas (si lo hace, un operador sin `organization:settings`
// recibiría 403 y abortaría el guardado de un movimiento que el server
// habría aceptado).
const SYSTEM_CATEGORY_WHITELIST: Record<string, string> = {
  'ajuste manual': 'Ajuste Manual',
};

/**
 * Garantiza que la categoría que eligió el usuario exista en el catálogo de
 * la organización. Si ya existe (match case-insensitive con normalización
 * es-AR contra `existing`), devuelve el nombre canónico tal cual está en la
 * base. Si no existe, crea la categoría vía `POST /api/organization/categories`
 * con el `type` derivado del tipo de movimiento (income/receivable → income,
 * expense/payable → expense), invalida la query de categorías y devuelve el
 * nombre canónico que respondió el servidor.
 *
 * Devuelve `null` cuando la entrada es null/vacía (movimiento sin concepto).
 * Para tipos que no van por catálogo (transferencias) devuelve el texto tal
 * cual para que el servidor lo procese como hoy.
 *
 * Lanza si el POST falla — el caller debe abortar el submit del movimiento.
 */
export async function ensureCategoryExists(
  rawName: string | null | undefined,
  txType: string,
  existing: ExistingCategory[],
  queryClient: QueryClient,
): Promise<string | null> {
  if (rawName === null || rawName === undefined) return null;
  const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
  if (trimmed.length === 0) return null;
  if (txType === 'transfer_in' || txType === 'transfer_out' || txType === 'transfer') {
    return trimmed;
  }
  const whitelistMatch = SYSTEM_CATEGORY_WHITELIST[normalize(trimmed)];
  if (whitelistMatch) return whitelistMatch;
  let catType: 'income' | 'expense';
  if (txType === 'income' || txType === 'receivable') catType = 'income';
  else if (txType === 'expense' || txType === 'payable') catType = 'expense';
  else return trimmed;

  const needle = normalize(trimmed);
  const match = existing.find((c) => c.type === catType && normalize(c.name) === needle);
  if (match) return match.name;

  const created = (await fetchWithAuth('/organization/categories', {
    method: 'POST',
    body: JSON.stringify({ name: trimmed, type: catType }),
  })) as { name?: string } | null;
  queryClient.invalidateQueries({ queryKey: ['/organization/categories'] });
  return created && typeof created.name === 'string' ? created.name : trimmed;
}
