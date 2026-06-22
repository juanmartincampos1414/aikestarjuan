---
name: transactions.category es NOT NULL en la DB
description: Crear cualquier movimiento via POST /api/transactions exige category, aunque el schema Drizzle lo declare nullable.
---

La columna `category` de la tabla `transactions` es **NOT NULL en la base de datos**, pero la
columna en el schema Drizzle (`shared/schema.ts`) está declarada como `text("category")` sin
`.notNull()`, así que TypeScript no lo detecta.

**Why:** Cualquier flujo nuevo que cree movimientos llamando a `transactionAPI.create` /
`POST /api/transactions` sin pasar `category` revienta en runtime con
`null value in column "category" of relation "transactions" violates not-null constraint`.
El wizard normal de transacciones siempre manda un concepto, por eso no se nota hasta que un
flujo alternativo (ej: confirmar venta de un presupuesto) omite el campo.

**How to apply:** Al crear un movimiento desde un flujo nuevo, siempre incluir `category` con
el nombre de un concepto válido. Los conceptos se obtienen de
`GET /api/organization/categories?type=income|expense` (tabla `transaction_categories`,
campo `name`). El curl/typecheck NO atrapa este error; sólo aparece end-to-end (usar el skill
de testing para verificar flujos que crean transacciones).
