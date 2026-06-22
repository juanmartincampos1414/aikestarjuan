---
name: CAC real (costo de adquisición)
description: Cómo se calcula el CAC real en el panel admin y de dónde sale el gasto de adquisición.
---

El CAC real del panel /admin sale de la tabla `acquisition_spend` (gasto de adquisición cargado a mano por mes 'YYYY-MM', en ARS) cruzado con las altas reales de `subscriptions`.

Reglas del cálculo (`server/lib/cac.ts`):
- CAC "blended": total de gasto / total de altas, considerando SOLO los meses que tienen gasto cargado. Un mes con gasto y sin altas suma al numerador (costo sin retorno); es intencional, no es un bug.
- Las altas se cuentan por `createdAt` cayendo en un mes con gasto, deduplicando por `stripeSubscriptionId` con `dedupeSubscriptionLifecycles` (el webhook de Stripe históricamente generaba filas duplicadas).
- El mes de un `createdAt` se calcula en UTC (`getUTC*`) para que sea determinista.
- `hasEnoughData=false` si no hay gasto cargado o si no hay altas en los meses con gasto → la UI cae a la estimación de `business_settings`.

**Why:** el CAC y el LTV/CAC antes eran una estimación fija porque no se registraba gasto de marketing; esto los vuelve datos reales sin depender de un deploy.

**How to apply:** la tarjeta CAC muestra "Real" cuando `cac.hasEnoughData`; la tarjeta LTV/CAC muestra "Real" solo cuando LTV (churn) y CAC son ambos reales. El gasto se administra desde el endpoint `/api/admin/acquisition-spend` (GET/PUT/DELETE).

## Derivación automática del gasto (además de la carga manual)
El gasto de adquisición también puede derivarse solo de gastos etiquetados, sin cargarlo a mano. La config vive en `business_settings` (columnas `acquisition_*`): org elegida + sets de cuentas / categorías (por NOMBRE, no id) / códigos de análisis. Lógica en `server/lib/acquisitionSpend.ts`.
- Una transacción cuenta si `type==='expense'`, `status!=='cancelled'` y matchea por OR (cuenta O categoría O código). Sin etiquetas → no deriva nada (evita sumar todo el gasto por error). USD/USD_CASH se convierten por `usdArsRate`; otras monedas se ignoran. Mes en hora Argentina (`getArgentinaMonth`).
- `mergeAcquisitionSpend`: el mes cargado MANUAL reemplaza al derivado de ese mes (manual gana). Así nunca se duplica.
- Se combina en `server/services/businessMetrics.ts` antes de `computeRealCac`, y hay vista previa admin con `source` 'manual'|'auto' en `GET /api/admin/acquisition-spend/derived`. Config: `GET/PUT /api/admin/acquisition-config`, opciones por org en `/api/admin/acquisition-config/options`.
**Why:** cargar el gasto a mano todos los meses era tedioso y propenso a olvidos; derivarlo de los propios libros lo mantiene actualizado solo.
