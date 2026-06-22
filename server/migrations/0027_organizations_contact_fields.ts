import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #406: agrega columnas contact_email y contact_phone (nullable text) a la
// tabla organizations. Sirven para personalizar los datos de contacto que salen
// en el membrete del PDF de presupuestos (Oficina), con fallback a los datos del
// usuario que emite cuando estan vacios.
//
// Idempotente: ADD COLUMN IF NOT EXISTS. Compatible con ambientes donde el ALTER
// ya se aplico manualmente: el INSERT en _migrations marca como aplicada para no
// reintentar en futuros boots.
export async function addOrganizationsContactFields() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0027_organizations_contact_fields' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add organizations contact_email/contact_phone columns...');

  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email text`);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_phone text`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0027_organizations_contact_fields') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: organizations contact fields ready.');
}
