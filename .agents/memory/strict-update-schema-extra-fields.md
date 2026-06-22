---
name: Campos extra y updateTransactionSchema .strict()
description: Por qué un PATCH /api/transactions con campos fuera del schema da 400 y cómo agregar extensiones a nivel de ruta.
---

`updateTransactionSchema` (shared/schema.ts) es `.strict()`: rechaza cualquier
clave que no esté declarada. El handler PATCH parsea el body con
`parseTransactionUpdateBody(...)`, así que cualquier campo "extra" a nivel de
ruta (p.ej. `items[]` de multi-producto) hace fallar la validación con 400
ANTES de llegar a tu lógica.

**Regla:** para aceptar un campo que no pertenece al schema estricto, sacalo del
body con destructuring (`const { items, ...rest } = req.body`) y pasá `rest` al
parser; validá el campo extra por separado con su propio zod.

**Why:** un primer intento de soportar `items[]` en la edición pasó toda la
validación de stock/reconciliación pero el endpoint seguía respondiendo 400
porque el `.strict()` cortaba el payload antes. Costó una ronda de code review
detectarlo.

**How to apply:** cualquier extensión nueva del PATCH/POST de transacciones que
no quieras agregar al schema canónico debe stripearse antes del parse estricto.
