---
name: Consistencia de métricas del panel admin
description: Cómo mantener que el número de cada tarjeta del admin coincida con las filas que muestra su click-filter, y trampas del enum de estado de suscripción.
---

# Tarjetas del panel admin = sus click-filters

Cada tarjeta de métrica en `client/src/pages/admin.tsx` es además un filtro
clickeable sobre la lista de usuarios (`matchesMetricFilter`). Regla invariante:
**el conteo que computa el backend para una tarjeta debe usar exactamente el
mismo criterio que el filtro de la UI**, o el usuario hace click y ve una
cantidad de filas distinta al número de la tarjeta.

**Why:** las métricas (`computeAdminBusinessMetrics` en
`server/services/businessMetrics.ts`) y la lista (`/api/admin/users`) salen
ambas de `storage.getAllUsers()`, que **incluye usuarios soft-deleted**
(`deletedAt`). Los filtros de tarjeta de la UI excluyen con `!user.deletedAt`.
Si el backend cuenta los borrados y la UI no, los números no cuadran.

**How to apply:**
- En el loop de métricas saltear usuarios con `deletedAt` para todas las
  métricas de estado (activas/prueba/canceladas/pagos fallidos). El total de
  usuarios SÍ los incluye, igual que el filtro "total" de la UI.
- El estado canónico de baja en el enum es `'cancelled'` (dos L), NO `'canceled'`.
  Comparar con `'canceled'` siempre da false y es un bug silencioso.
- No confundir cancelación real (`status==='cancelled'`) con `cancelAtPeriodEnd`:
  estos últimos siguen activos hasta fin del período e incluyen trials con baja
  agendada; contarlos como "cancelaciones" infla el número con gente que aún usa
  la app.
- "Cancelará/baja agendada" es un cubo PROPIO (`cancelScheduledSubscriptions` /
  filtro `cancel_scheduled`), mutuamente excluyente de activas/prueba y de
  canceladas. Criterio idéntico en BE y FE: `cancelAtPeriodEnd && !paymentFailedAt
  && status!=='cancelled'`. `active`/`trial` excluyen `cancelAtPeriodEnd`. Se
  excluye `paymentFailedAt` para respetar la precedencia del badge (Pago fallido
  va antes que Cancelará en `getStatusBadge`), así filtro y badge coinciden.
- OJO: `activeSubscriptions` alimenta DOS cosas distintas. NO usar el conteo de
  la tarjeta "Activas" (que excluye `cancelAtPeriodEnd`) como denominador de
  revenue. MRR/ARPU/`activeCount` usan `activeRevenueCount`, que cuenta TODA sub
  `active` (incluidas las con baja agendada) porque siguen facturando hasta fin
  del período. Mezclarlos subestima el revenue (regresión real ya cometida una
  vez al separar el cubo "Cancelará").
- El conteo por tarjeta es a nivel usuario: usa la sub canónica deduplicada de
  `getSubscriptionByUserId`, así que puede leer 1 menos que un `count(*)` crudo
  sobre la tabla `subscriptions` (un usuario con filas duplicadas). Eso es
  correcto, no perseguir esa diferencia.
- Hay tests que blindan estos cubos: `server/admin-subscription-metrics.test.ts`.
  Inyectan storage a `computeAdminBusinessMetrics(storageDep?)` (param opcional
  con default `storage`, sin DB real) y comparan cada conteo del BE contra un
  espejo de `matchesMetricFilter` (admin.tsx) sobre la MISMA población. Si una de
  las dos copias cambia el criterio, el test de paridad falla. Si tocás el filtro
  del FE, replicá el cambio en el espejo del test.
- `usersWithoutSubscription` se cuenta DIRECTO (no borrados sin sub), NO como
  `totalUsers - (usuarios con sub)`: ese total incluye soft-deleted, que el filtro
  `no_subscription` excluye, rompiendo la paridad si un borrado conserva su sub.
- "Pago fallido" es ortogonal: PUEDE coexistir con "activa" (sub vigente con cobro
  rechazado) en BE y FE. La exclusión mutua aplica solo a los 4 cubos primarios
  (activa/prueba/cancelará/cancelada).
