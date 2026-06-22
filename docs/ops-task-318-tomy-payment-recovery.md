# Ops note — Task #318 — Caso Tomy: suscripción duplicada + loop de login

**Fecha:** 2026-05-19
**Entorno:** producción (`NEON_OHIO_URL`)
**Usuario reportante:** Juan
**Usuario afectado (caso testigo):** `tomydelavega39@gmail.com` (`id=118460c8-eb8b-4cf5-bb83-9a445344fece`)
**Stripe subscription:** `sub_1SuviRHgfA42eDHyl6iOtLEM`
**Operado por:** Replit Agent (Task #318)

## Síntomas

1. Pago rechazado → email de Stripe → el usuario intenta loguearse para
   actualizar la tarjeta.
2. Login OK → pantalla de bienvenida → pantalla blanca → sesión caída.
3. A pesar del fix de Task #309, el usuario seguía recibiendo el resumen
   semanal los lunes.

## Causa raíz

Dos filas en `subscriptions` para el mismo `stripe_subscription_id`:

| created_at | status | payment_failed_at | updated_at |
|---|---|---|---|
| 2026-01-15 | trialing | null | 2026-01-15 |
| 2026-03-01 | cancelled | 2026-03-01 | 2026-03-22 |

`getSubscriptionByUserId` ordenaba primero por prioridad funcional
(`active > trialing > … > cancelled`) — devolvía la fila trialing vieja.
El middleware le daba paso, pero el resto del flujo (Stripe portal, account
checks, etc.) pegaba contra un `stripe_subscription_id` que del lado Stripe
estaba muerto. Los 4xx terminaban en `/api/user` con 402 y, como ese query
usa `skipAuthRedirect=true`, el handler de 402 se salteaba → `throw` →
`isError=true` en App.tsx → pantalla blanca + caída a `/login`.

El cron del digest hacía la misma resolución y daba elegible.

## Mitigación runtime (código — esta task)

- `server/storage.ts` — `getSubscriptionByUserId` deduplica por
  `stripe_subscription_id` no nulo quedándose con `updatedAt` más reciente,
  *luego* aplica prioridad funcional. Self-heals todos los usuarios con
  duplicados históricos.
- `server/routes/middleware.ts` — `cancelled + paymentFailedAt` se mapea
  igual que `past_due` (grace 7 días, 402 `PAYMENT_BLOCKED` con
  `daysUntilDeletion`). Usuario ve "Acceso Bloqueado / Pagar Ahora".
- `server/services/weeklyDigest.ts` — `isEligibleForWeeklyDigest` busca
  filas hermanas del `stripe_subscription_id` ganador y bloquea el envío
  si alguna está `cancelled`/`unpaid` (Stripe es la verdad).
- `server/routes/stripe.ts` — `create-portal-session-blocked` ahora tiene
  doble fallback: portal → checkout con priceId resuelto desde Stripe →
  checkout con priceId resuelto desde `planType` local + producto activo
  matching → `/pricing?recover=1`.
- `client/src/lib/api.ts` — el branch de 402 ya no está gated por
  `skipAuthRedirect`; siempre redirige a `/subscription-required`
  preservando sesión, con anti-loop si ya estamos en esa ruta.

## Consolidación de datos en prod

El índice único parcial sobre `subscriptions.stripe_subscription_id` ya
está vivo en prod desde Task #311 (ver `docs/ops-task-311-subscriptions-unique-index.md`),
por lo que **no se pueden crear nuevos duplicados**. Los duplicados
remanentes son legacy de antes del índice (incluido el caso Tomy).

Para limpiarlos se corre el script idempotente
`scripts/dedupe-subscriptions.ts` (creado en Task #310 + ampliado en esta
task con modo `--verify`):

```bash
# 1. Dry-run — lista qué borraría
tsx scripts/dedupe-subscriptions.ts

# 2. Commit — backup + delete en transacción única
tsx scripts/dedupe-subscriptions.ts --commit

# 3. Verificación posterior — exit 0 si invariante "1 fila por
#    (user, stripe_subscription_id)" se cumple; exit 1 si hay duplicados.
tsx scripts/dedupe-subscriptions.ts --verify
```

El script:
- Apunta a `NEON_OHIO_URL || DATABASE_URL` (igual que `server/db.ts`).
- Hace backup en `subscriptions_dedupe_backup_t310` antes de cualquier
  delete (rollback con `INSERT INTO subscriptions SELECT * FROM
  subscriptions_dedupe_backup_t310`).
- Detecta y reporta (no borra) usuarios con múltiples
  `stripe_subscription_id` distintos para revisión manual.
- Tiene una verificación post-delete interna que aborta si quedó algún
  duplicado.

La ejecución de `--commit` en producción queda como follow-up #319 (no
bloquea este fix porque el código runtime ya self-healea la selección de
la fila correcta).

## Acción manual sobre Tomy

Post-deploy, el operador humano debería:

1. Correr `--verify` y, si hay duplicados, `--commit`.
2. Confirmar que `tomydelavega39@gmail.com` puede loguearse y ve la
   pantalla "Acceso Bloqueado / Pagar Ahora".
3. Mandarle un mail explicando el incidente y el flujo para actualizar
   la tarjeta (portal → si falla, checkout automático).

## Invariante objetivo (post-fix)

```sql
SELECT user_id, stripe_subscription_id, COUNT(*)
FROM subscriptions
WHERE stripe_subscription_id IS NOT NULL
GROUP BY 1, 2
HAVING COUNT(*) > 1;
-- Esperado: 0 filas.
```

Equivalente a `scripts/dedupe-subscriptions.ts --verify`.
