import { db } from '../db';
import { sql } from 'drizzle-orm';

// Etapa 1 Presupuestos (#391): crea la tabla `quotes`, contraparte de la sección
// "Presupuestos" en Oficina. Permite cargar un presupuesto (con PDF opcional en
// object storage), seguir su estado (pending|won|lost) y, al ganarse, linkear el
// movimiento generado (linked_transaction_id).
//
// Producción NO corre `db:push`; aplica migraciones versionadas desde aquí. En
// desarrollo la tabla ya pudo crearse vía push: el CREATE TABLE IF NOT EXISTS y
// el marcador en _migrations hacen la migración idempotente.
export async function createQuotesTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0026_quotes' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create quotes table + indexes...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS quotes (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      title text NOT NULL,
      client_id varchar,
      client_name text,
      amount numeric(15,2) NOT NULL,
      currency text NOT NULL DEFAULT 'ARS',
      date timestamp NOT NULL DEFAULT now(),
      valid_until timestamp,
      notes text,
      pdf_url text,
      pdf_name text,
      status text NOT NULL DEFAULT 'pending',
      linked_transaction_id varchar,
      won_at timestamp,
      lost_at timestamp,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS quotes_org_status_date_idx
    ON quotes (organization_id, status, date)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0026_quotes') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: quotes table + indexes ready.');
}
