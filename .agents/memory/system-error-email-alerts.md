---
name: Alertas de errores del sistema por email
description: Criterios durables sobre qué incluir/redactar y cómo capturar todos los 500 en las alertas de error por email.
---

# Alertas de errores del sistema por email

**Qué se incluye vs. qué se redacta (decisión de alcance):** el email de alerta SÍ incluye email del usuario e IP — se interpretó "sin secretos/PII" como "sin credenciales", no como "sin datos del usuario", porque email/IP son parte del valor diagnóstico de la alerta. NUNCA deben filtrarse credenciales: contraseñas, tokens Bearer/JWT, api keys, cookies, códigos. Hay una capa de redacción que las enmascara en mensaje, stack y URL antes de enviar.
**Why:** el pedido decía "sin secretos/PII" pero también pedía explícitamente usuario e IP como contexto.

**Cubrir TODOS los 500, no solo los del middleware:** un error que se devuelve directo con `res.status(500)` (p. ej. el webhook de Stripe) no pasa por el error handler central de Express. Para no perder esos casos hay que capturar también vía un hook `res.on('finish')` global registrado temprano (antes de las rutas), y evitar doble alerta marcando el request cuando el handler central ya reportó.
**Why:** una revisión rechazó la primera versión justo por esta brecha.

**Operativa:** solo dispara en producción (override forzar/apagar por env). Anti-spam por dedupe temporal con ruta normalizada (sin query ni ids dinámicos). El dedupe es in-memory por instancia → en deploy multi-instancia puede duplicar entre nodos (ver tarea de follow-up para store compartido).

## Panel de errores persistido (tabla system_errors)

**Persistencia separada del throttle del email:** la persistencia en DB y el throttle anti-spam del email son dos cosas distintas. Persistir SIEMPRE (cuando alertsEnabled), aunque el email esté en cooldown, o el contador de ocurrencias del panel queda corto. La huella (fingerprint) usada para agrupar es la misma que la del dedupe del email: origen + ruta normalizada + mensaje.

**Dedupe atómico = índice único PARCIAL + ON CONFLICT.** Para "una sola fila open por huella con contador confiable", usar `UNIQUE(fingerprint) WHERE status='open'` + `INSERT ... ON CONFLICT (fingerprint) WHERE status='open' DO UPDATE SET occurrence_count = occurrence_count + 1, ...COALESCE(excluded.x, tabla.x)`. El patrón read-then-write NO sirve: ante ráfagas concurrentes de errores idénticos crea filas open duplicadas o pierde incrementos (lo rechazó una revisión).
**Why:** los errores llegan en ráfagas concurrentes (un endpoint roto golpeado N veces); sin atomicidad el agrupado se rompe.

**Reabrir choca con el índice parcial.** Si un error se resolvió y reapareció, ya hay otra fila open con esa huella; reabrir la histórica viola el único parcial. `updateSystemErrorStatus` hace pre-check (otra open con misma huella y distinto id → throw code 'OPEN_EXISTS') y además normaliza el `23505` del UPDATE (TOCTOU) al mismo código; la ruta lo mapea a HTTP 409, no 500.

**Migraciones del proyecto:** además de `db:push`, hay migraciones versionadas hechas a mano en `server/migrations/NNNN_*.ts` que corren en boot encadenadas en `server/index.ts` y se marcan en la tabla `_migrations` (idempotentes, IF NOT EXISTS). Toda tabla/índice nuevo necesita su archivo acá o no existirá en prod (que NO corre db:push). `db:push` es interactivo: no acepta pipe/stdin en scripts.
