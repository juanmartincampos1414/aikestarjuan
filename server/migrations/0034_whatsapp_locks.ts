import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #464: candado por (org, user) con expiración automática (TTL) para el bot
// de WhatsApp. Reemplaza al advisory lock de sesión de Postgres (Task #284/#458),
// que en producción (Neon, endpoint pooled) NO se liberaba de forma confiable:
// destruir la conexión del cliente no terminaba la sesión backend que retenía el
// lock, así que el candado quedaba tomado por minutos y el bot se "tildaba".
//
// Este candado vive en una fila por (organization_id, user_id) con un vencimiento
// (`locked_until`) y un token de propietario. Se auto-libera por tiempo sin
// depender de que ninguna conexión siga viva: si el handler muere o se cuelga, la
// fila vence y el próximo mensaje la reclama.
//
// Idempotente: CREATE TABLE/INDEX IF NOT EXISTS + marcador en _migrations.
export async function createWhatsappLocksTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0034_whatsapp_locks' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create whatsapp_locks table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS whatsapp_locks (
      organization_id varchar NOT NULL,
      user_id varchar NOT NULL,
      locked_until timestamptz NOT NULL,
      lock_token varchar NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    )
  `);

  // Índice para que el barrido de filas vencidas (y el predicado de reclamo) no
  // tengan que escanear toda la tabla.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_locks_locked_until
    ON whatsapp_locks (locked_until)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0034_whatsapp_locks') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: whatsapp_locks table ready.');
}
