---
name: Renglones de presupuestos (quoteItems)
description: Cómo se relacionan los items de presupuesto con los items de transacción y reglas de precarga al ganar.
---

# Renglones de presupuestos

`quoteItems` es un espejo de `transactionItems` pero con `productId` NULLABLE
(un presupuesto puede tener renglones de servicio sin producto del catálogo).

- El total del presupuesto se deriva de la suma de los renglones cuando hay al
  menos uno; sin renglones vale el monto único (presupuesto legacy).
- PATCH de quotes con `items`: presente no-vacío reemplaza+recalcula; presente
  vacío limpia y usa el monto legacy del body; ausente no toca los items.

**Why:** el contrato de items de transacciones (`server/routes/transactions.ts`)
es más estricto que el de presupuestos: EXIGE `productId` en cada línea, >=2
líneas y solo ciertos tipos. Por eso al convertir un presupuesto ganado en
movimiento (handleWin en office.tsx) solo se precargan los items si TODAS las
líneas tienen `productId`, hay >=2 y NO hay conversión de moneda; si no, se cae
al monto único de siempre.

**How to apply:** cualquier flujo nuevo que pase items de presupuesto a una
transacción debe filtrar por esas condiciones, o el backend rechaza con 400.
