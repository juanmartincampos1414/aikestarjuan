---
name: WhatsApp bot "se tilda" — candado de conversación
description: Por qué el bot de WhatsApp quedaba tildado por minutos y por qué el candado de conversación usa expiración por TTL en la base y no un advisory lock.
---
# Bot WhatsApp "se tilda" — candado de conversación

**Síntoma:** tras "¿Confirmo? sí/no", el bot respondía en loop "Todavía estoy procesando
tu mensaje anterior…" y no destrababa por minutos, hasta reiniciar el proceso. El
movimiento SÍ se cargaba bien (saldo OK); lo único trabado era el candado.

## Por qué NO usar advisory locks de sesión (lección que costó varios intentos)
Un `pg_try_advisory_lock` **session-level** SOLO se suelta con `pg_advisory_unlock` en la
MISMA conexión o cerrando esa conexión. Sobre el endpoint **pooled** de Neon esto es una
trampa: la conexión del lado del cliente es un proxy, y destruirla (`client.release(Error)`)
NO garantiza terminar la sesión backend que retiene el lock. Resultado: el candado quedaba
tomado 6+ min pese a watchdog/timeout/keepalive. **Conclusión:** no atar el candado a la
vida de una conexión. Watchdog + destruir-conexión NO alcanza sobre pooled.

## Diseño correcto: candado con expiración automática (TTL) en la base
Fila por `(organization_id, user_id)` en `whatsapp_locks` con `locked_until` y `lock_token`.
Se auto-libera por tiempo sin depender de ninguna conexión viva:
- **Acquire** = upsert atómico que gana solo si no hay candado vigente:
  `INSERT ... ON CONFLICT DO UPDATE ... WHERE locked_until < NOW() RETURNING (xmax<>0)`.
  RETURNING vacío = ocupado; `xmax<>0` = reclamó un candado vencido (handler previo no liberó).
- **Heartbeat** (setInterval) extiende `locked_until` mientras el handler vive, pero DEJA de
  renovar pasado `maxHoldMs` para que un handler colgado igual venza por TTL.
- **Release** = `DELETE ... AND lock_token = $token` (token-scoped → un handler viejo no borra
  el candado de otro que ya lo reclamó; idempotente con guard `released`).
- Corre sobre el pool principal `db` (queries triviales, sin pool dedicado). `withTimeout`
  envuelve acquire/release para no colgar al handler ante conexión muerta; si el release
  falla, el TTL lo limpia igual.

**Why:** la garantía de liveness ("nunca tildado") viene del TTL, no de cerrar conexiones.
**Trade-off:** pasado `maxHoldMs` el candado puede vencer mientras un handler legítimo aún
corre → dos mensajes podrían intercalarse (race original). Es raro y mucho menos grave que
un freeze permanente; se prioriza liveness sobre serialización estricta.

## Observabilidad
El reclamo de un candado vencido (`xmax<>0`) se reporta vía `reportWhatsappLockForceRelease`
(kind `ttl_reclaim`, source `whatsappLock`): persiste en el panel `system_errors` agrupado
por tipo y manda email solo si supera umbral en ventana deslizante (env `WHATSAPP_LOCK_ALERT_*`).
Una racha de reclamos = handlers que mueren/cuelgan seguido (inestabilidad), no un caso aislado.

## Cómo testear sin Postgres real
Test seam `__setWhatsappLockStoreForTesting(store)` inyecta un `WhatsappLockStore` en memoria
que modela la semántica de TTL (acquire gana si vencido/inexistente; extend/release solo si
el token coincide). Runner `node:test` vía `tsx --test`, validation step `test`. El SQL de
producción (xmax, interval math, ON CONFLICT...WHERE) se valida aparte contra la base de dev.

## "No impacta el saldo" era síntoma del freeze, no un bug aparte
Cuando el bot se tildaba tras "¿Confirmo?", el "sí" nunca se procesaba → la transacción nunca
se creaba → no había impacto en saldo. Arreglado el candado, el saldo impacta normal. El único
`accountId: null` legítimo es receivable/payable (status 'scheduled', no toca saldo); no agregar
cuenta ahí.
