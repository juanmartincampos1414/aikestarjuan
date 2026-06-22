---
name: Resumen semanal en Autoscale (trigger al despertar)
description: Por qué el cron in-process del weekly digest no dispara en Autoscale y cómo se reemplazó por un trigger al despertar la app.
---

# Resumen semanal: cron in-process NO sirve en Autoscale

El deployment principal es **Autoscale** (escala a cero). Un `node-cron` in-process
(`0 6 * * 1`) **nunca se dispara** confiablemente para tareas agendadas: el lunes
6 AM el contenedor está dormido y no hay request que lo despierte. Síntoma en logs
de prod: solo aparece "cron started", nunca "triggered/completed".

**Regla vigente: tareas agendadas se disparan "al despertar", no a hora fija.** Un
proyecto Replit admite UN solo deployment, así que NO se puede agregar un Scheduled
Deployment sin romper el web (aikestar.net). En vez de un reloj, la app aprovecha
cada vez que se despierta (boot tras dormir, o tráfico mientras está viva): chequea
si ya pasó el momento agendado y todavía no se hizo el trabajo; si corresponde, lo
dispara ahí.

**Why:** Autoscale no mantiene proceso vivo entre requests; los timers in-process
mueren con el contenedor. Pero sí hay tráfico real (usuarios pagos entran), así que
"al despertar" es un disparador confiable que el cron a hora fija no tiene.

**How to apply (caso weekly digest, `server/services/weeklyDigest.ts`):**
- El trigger arranca en el listen callback de `server/index.ts`: una corrida al
  bootear + un `setInterval` con `.unref()` mientras la app siga viva. Gateado a
  prod salvo `ENABLE_INPROCESS_DIGEST_CRON=true` (para no blastear mails reales en
  cada arranque local).
- El núcleo se auto-gatea (idempotente, seguro de llamar seguido): clave de semana
  + chequeo horario, flag "corriendo ahora" (no solapar) y un cooldown/throttle
  entre lotes. El estado in-memory es solo optimización, NO la garantía.
- **Zona horaria: la clave de semana Y el chequeo de hora tienen que calcularse en
  la MISMA zona (ART, UTC-3 sin DST), nunca mezclar con UTC.** Si la clave usa
  `startOfWeek` en UTC y el horario se chequea en ART, en la ventana de borde
  (domingo 21:00–23:59 ART = ya lunes UTC) la clave salta a la semana siguiente
  mientras el reloj ART todavía marca domingo → se manda hasta 9 h antes. Calcular
  el lunes de la semana a partir de los componentes de fecha ART, no de UTC.
- **Auto-reparación: solo marcar la semana como "completada" en memoria si el lote
  no tuvo errores.** Y contar como error cualquier envío fallido (no solo las
  excepciones): si un `sendEmail` devuelve false sin ser "ya enviado", es un fallo
  operativo. Si se sella la semana con fallas adentro, esos usuarios quedan sin su
  resumen hasta que reinicie el proceso (se pierde el envío de la semana).
- Idempotencia REAL (única fuente de verdad, sobrevive reinicios y multi-instancia):
  tabla `weekly_digest_sends` (PK user_id, week_start), claim-first con
  `onConflictDoNothing` antes de enviar; si el envío falla se borra el claim. El
  trigger NO escribe filas de send; eso lo hace el envío por usuario con la guarda
  `enforceOnce` (el path admin de "probar" pasa sin la opción para no bloquearse).
- El cron in-process queda deshabilitado en prod salvo `ENABLE_INPROCESS_DIGEST_CRON`
  =true; coexiste sin riesgo con el wake trigger porque comparten la idempotencia.
- NO tocar `.replit`: tiene una sola sección `[deployment]` (= Autoscale principal).

**Confirmado en prod:** el trigger "al despertar" es un CATCH-UP, no un reloj. Al
publicar/bootear cualquier día que ya pasó el lunes 6 AM ART de la semana en curso
(no solo el lunes), si esa semana todavía no se envió, dispara el lote completo ahí
mismo (`trigger=boot`). O sea: un deploy a mitad de semana manda el resumen de esa
semana a todos los elegibles al instante. Verificado: el envío salió bien (0 errores,
0 duplicados (user, week)), la tabla `weekly_digest_sends` se crea al bootear la
migración, y la cantidad de filas de la semana = "emails sent" del log de "Completed".

**Histórico:** se evaluó un Scheduled Deployment one-shot (entrypoint propio + build
liviano esbuild) pero se descartó porque un repo Replit no admite un 2º deployment
sin romper el web; esos artefactos fueron eliminados.
