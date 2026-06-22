---
name: Validación de número de comprobante al editar
description: Por qué el formato ARCA del invoiceNumber debe validarse "solo si cambia" y dónde están las capas que bloquean.
---

# Validación de número de comprobante (invoiceNumber) al editar movimientos

**Regla:** al EDITAR un movimiento, el formato canónico ARCA (`/^\d{4}-\d{8}$/`,
`ARCA_INVOICE_NUMBER_REGEX`) debe validarse **solo cuando el `invoiceNumber` cambia
respecto del valor guardado**, nunca a ciegas.

**Why:** muchos movimientos guardan números NO canónicos: los emitidos por ARCA
guardan el voucher pelado ("1", "2") y los manuales viejos cosas como "000123456",
"0225584-287". Al editar cualquier otro campo, el front reenvía el `invoiceNumber`
existente. Si se valida el formato a ciegas, esos movimientos quedan ineditables
(bug de prod reportado: usuaria no podía editar movimientos facturados).

**How to apply:** el chequeo de formato vive en TRES capas que hay que mantener en
sincronía, todas con la lógica "saltear si no cambió":
1. Server PATCH `/api/transactions/:id` (`server/routes/transactions.ts`): valida solo
   si `updates.invoiceNumber` viene, es no vacío y `!== currentTx.invoiceNumber`.
2. Client form `transactionSchema.superRefine` (`client/src/pages/transactions.tsx`):
   usa el campo de form `originalInvoiceNumber` (seteado al abrir edición) y saltea si
   `invoiceNumber === originalInvoiceNumber`.
3. Client error inline del input de comprobante: saltea si el valor == el guardado
   (`editingTransaction.invoiceNumber`).

`normalizeArcaInvoiceNumber` es idempotente sobre valores ya guardados que no matchean
`/^(\d{1,4})-(\d{1,8})$/` (los devuelve sin cambios), por eso `incoming === stored` se
cumple para los datos históricos y el chequeo se saltea bien.

**Cuarta capa (cerrada):** `PATCH /api/taxes/transactions/:id` (`server/routes/taxes.ts`,
edición fiscal en línea de compras/ventas) AHORA valida el formato del `invoiceNumber`
con el helper compartido `invoiceNumberChangeError(nuevo, guardado)` de `shared/schema.ts`
(mismo criterio "saltear si no cambió"). Si querés cambiar la regla de formato, hacelo
en ese helper para mantener las capas en sincronía.
