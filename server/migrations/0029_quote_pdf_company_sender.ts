import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #413: nombre de empresa y remitente en el PDF del presupuesto.
//
// Agrega:
// - quotes.pdf_company_name / pdf_contact_name: override del nombre de la
//   empresa y de quien envía el presupuesto SOLO para ese presupuesto.
// - organizations.quote_pdf_company_name / quote_pdf_contact_name:
//   preestablecido propio de presupuestos a nivel organización.
//
// Prioridad al generar el PDF: presupuesto -> preset de la org -> nombre de la
// organización (empresa) / nombre del usuario que descarga (remitente).
//
// Idempotente: ADD COLUMN IF NOT EXISTS + registro en _migrations para no
// reintentar en futuros boots (prod no usa db:push).
export async function addQuotePdfCompanySenderFields() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0029_quote_pdf_company_sender' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: add quote PDF company/sender name columns...');

  await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_company_name text`);
  await db.execute(sql`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_contact_name text`);

  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS quote_pdf_company_name text`);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS quote_pdf_contact_name text`);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0029_quote_pdf_company_sender') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: quote PDF company/sender fields ready.');
}
