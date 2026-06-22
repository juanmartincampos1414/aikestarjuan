import { db } from '../db';
import { sql } from 'drizzle-orm';

// Agrega la columna mp_subscription_id (id de preapproval de MercadoPago) a las
// tablas users y subscriptions, para soportar pagos con MercadoPago.
//
// Idempotente: ADD COLUMN IF NOT EXISTS + marcador en _migrations. En producción
// el esquema se aplica por estas migraciones versionadas (no por db:push).
export async function addMpSubscriptionIdColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0041_mp_subscription_id' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add mp_subscription_id columns...');

  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_subscription_id text`);
  await db.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS mp_subscription_id text`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0041_mp_subscription_id') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: mp_subscription_id columns ready.');
}
