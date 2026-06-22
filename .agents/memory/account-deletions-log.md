---
name: Registro de bajas de cuentas (account_deletions)
description: Cómo y por qué se registran las cuentas eliminadas, para métricas del panel admin.
---

# Registro de bajas de cuentas

La tabla `account_deletions` registra cada baja (email, nombre, reason, deletedAt)
para que el panel admin pueda contar bajas aún después de un hard-delete del user.

**Por qué sin FK a users:** el flujo de cancelación hace hard-delete de la fila
`users`; una FK haría que la baja desaparezca junto con el user. Por eso es una
tabla independiente (ver "Orden importa" abajo para cuándo se escribe el log).

**Reasons (`ACCOUNT_DELETION_REASONS`):**
- `non_payment` — calculado en cancelledAccountCleanup cuando `paymentFailedAt` o
  `subscriptionStatus === 'past_due'`.
- `cancellation` — resto de las bajas por cancelación.
- `inactivity` — soft-delete en inactiveAccountCleanup.

**Cómo aplicar:** todo flujo nuevo que elimine cuentas debe llamar
`storage.recordAccountDeletion(...)` en try/catch NO bloqueante (no debe frenar el
cleanup si el insert falla). El conteo de métricas usa `countAccountDeletions(reason)`
con SQL `COUNT(*)`. Métrica expuesta: `deletedForNonPayment` en businessMetrics.

**Orden importa:** el insert del log va DESPUÉS de confirmar el borrado real del
user (hard-delete en cancelledAccountCleanup, soft-delete `deletedAt` en
inactiveAccountCleanup), no antes. Así la métrica no cuenta una baja que falló a
mitad de camino. Como la tabla no tiene FK a users, registrar tras el hard-delete
funciona igual. El try/catch del log sigue siendo NO bloqueante (la baja ya está
aplicada cuando se loguea).
