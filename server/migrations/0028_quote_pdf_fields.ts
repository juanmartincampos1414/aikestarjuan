import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #408: datos del PDF por presupuesto.
//
// Agrega:
// - quotes.pdf_logo_url / pdf_contact_email / pdf_contact_phone: override del
//   membrete del PDF SOLO para ese presupuesto.
// - organizations.quote_pdf_logo_url / quote_pdf_contact_email /
//   quote_pdf_contact_phone: preestablecido propio de presupuestos (separado de
//   la identidad de la organizacion usada en el resto de la app).
//
// Prioridad al generar el PDF (por dato): presupuesto -> preset de la org ->
// datos de la org -> datos del usuario que descarga.
//
// Idempotente: ADD COLUMN IF NOT EXISTS + registro en _migrations para no
// reintentar en futuros boots (prod no usa db:push).
export async function addQuotePdfFields() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0028_quote_pdf_fields' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add quote PDF override + organization preset columns...');

  await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_logo_url text`);
  await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_contact_email text`);
  await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_contact_phone text`);

  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS quote_pdf_logo_url text`);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS quote_pdf_contact_email text`);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS quote_pdf_contact_phone text`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0028_quote_pdf_fields') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: quote PDF fields ready.');
}
