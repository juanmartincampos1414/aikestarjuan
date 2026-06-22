---
name: Registro vía pending_signups
description: El alta de usuarios se concreta DESPUÉS del checkout de Stripe, no en /api/auth/register.
---

El registro self-service NO crea el usuario en `/api/auth/register`. Ese endpoint
solo crea un `pending_signups` y devuelve la URL de checkout de Stripe. El `users`
real se crea recién al confirmar el pago (validate-checkout en `server/routes/auth.ts`),
copiando los campos desde el `pendingSignup`.

**Why:** Hay que cobrar/validar tarjeta antes de dar de alta. Por eso cualquier dato
nuevo del formulario de registro debe persistirse primero en `pending_signups` y
luego propagarse al `createUser`, o se pierde entre el form y el alta definitiva.

**How to apply:** Para agregar un campo nuevo al registro: (1) columna en `users` y en
`pending_signups`, (2) guardarlo en `createPendingSignup`, (3) copiarlo en el
`createUser` del validate-checkout. El flujo de invitaciones de equipo (mismo archivo,
crea user directo con `mustChangePassword`) es independiente y no pasa por pending.
