---
name: La tabla accounts no tiene isActive
description: Filtrar cuentas por a.isActive vacía la lista en silencio; accounts no tiene esa columna.
---

# La tabla `accounts` no tiene columna `isActive`

La tabla `accounts` en `shared/schema.ts` no define `isActive` (ni `is_active`,
ni `deletedAt`). Sus columnas relevantes son `id, name, type, currency, balance,
accountCategory, organizationId, createdAt`.

**Regla:** nunca filtrar cuentas por `a.isActive`. Como la propiedad es siempre
`undefined`, un `if (!a.isActive) return false` descarta TODAS las cuentas y deja
el desplegable/lista vacío sin error visible.

**Cómo filtrar bien:** seguí el patrón del asistente de transacciones
(`client/src/components/transaction-wizard.tsx`): filtrar solo por moneda,
normalizando con `(a.currency || 'ARS')` y `USD_CASH -> USD`.

**Why:** un diálogo de cobro de factura mostraba la lista de cuentas vacía
justamente por este filtro fantasma; otras pantallas/ wizard nunca usan isActive
sobre cuentas. Otras tablas (products, suppliers, assets, etc.) SÍ tienen
`is_active`, lo que hace fácil copiar el patrón equivocado a accounts.
