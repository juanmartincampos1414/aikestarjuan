import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #484: agrega columnas terms_accepted_at (nullable timestamp) a las tablas
// users y pending_signups. Guarda la constancia de cuándo el usuario aceptó los
// Términos y Condiciones al registrarse. Se completa en el alta (pending_signup)
// y se propaga al usuario definitivo cuando se confirma el checkout de Stripe.
//
// Idempotente: ADD COLUMN IF NOT EXISTS. Nullable a propósito para no romper
// usuarios creados antes de esta política ni flujos que no la exigen (invitaciones).
export async function addTermsAcceptedAtColumns() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0037_terms_accepted_at' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add terms_accepted_at columns...');

  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp`);
  await db.execute(sql`ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS terms_accepted_at timestamp`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0037_terms_accepted_at') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: terms_accepted_at columns ready.');
}
