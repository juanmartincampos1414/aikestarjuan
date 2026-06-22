---
name: Producción usa Neon Ohio, no la base administrada por Replit
description: Por qué el paso "Database migrations" del Publish de Replit NO actualiza la base productiva real, y cómo llegan los cambios de esquema a prod.
---

En runtime de producción la app se conecta a una Neon propia del cliente (host `ep-...us-east-2.aws.neon.tech`) vía el secret `NEON_OHIO_URL`. `server/db.ts` hace `(NODE_ENV==='production' ? NEON_OHIO_URL : undefined) || DATABASE_URL`. La base que Replit muestra como "Production database connected" (la que administra Replit) NO es la que usa la app.

**Consecuencia clave:** el paso "Database migrations" del flujo de Publish de Replit aplica el diff de esquema a la base administrada por Replit (la que la app ignora). Aprobarlo es inofensivo pero NO actualiza la base productiva real.

**Cómo llegan los cambios de esquema a prod (patrón establecido):** migraciones versionadas en `server/migrations/NNNN_*.ts`, cableadas en `server/index.ts`, que corren al bootear contra `db` (= Neon Ohio en prod). Son idempotentes: tabla `_migrations` con marcador por nombre + `CREATE TABLE/INDEX IF NOT EXISTS`. Prod NO corre `db:push` (eso es solo dev, que usa DATABASE_URL=helium).

**Por qué una tabla nueva puede "faltar" en prod aunque exista la migración:** el deploy productivo vigente corre el código anterior (sin esa migración). La tabla recién se crea cuando se publica el código nuevo y bootea (ahí corre la migración). No hace falta crearla a mano si el deploy nuevo incluye la migración cableada.

**Si hay que tocar prod a mano** (urgencia): conectar directo con `NEON_OHIO_URL` (`pg.Pool`), nunca imprimir el connection string. Replicar EXACTO el estado final de la migración (tabla + índices + insertar el marcador en `_migrations`) para que el boot la saltee.

**Rollback de la base productiva:** borrar el secret `NEON_OHIO_URL` hace que prod vuelva a la base inyectada por Replit (DATABASE_URL).
