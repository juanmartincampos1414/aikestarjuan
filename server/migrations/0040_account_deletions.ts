import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #511: crea la tabla account_deletions, que registra las cuentas que el
// sistema elimina automáticamente (limpiezas de cancelados por falta de pago /
// cancelación voluntaria, e inactivos). Habilita el contador "Eliminadas por
// falta de pago" del panel admin y un historial de bajas.
//
// La tabla NO tiene FK a users a propósito: la limpieza de cancelados hace
// HARD-delete de la fila de users, así que el log tiene que sobrevivir a esa
// eliminación.
//
// Idempotente: CREATE TABLE IF NOT EXISTS + marcador en _migrations. En
// producción el esquema se aplica solo por estas migraciones versionadas (no se
// corre db:push), así que la tabla debe crearse acá.
export async function createAccountDeletionsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0040_account_deletions' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create account_deletions table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS account_deletions (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id varchar,
      email text NOT NULL,
      name text,
      reason text NOT NULL,
      subscription_status text,
      deleted_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS account_deletions_reason_idx ON account_deletions (reason)`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0040_account_deletions') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: account_deletions table ready.');
}
