import { db } from '../db';
import { sql } from 'drizzle-orm';

// Crea las tablas del CRM comercial (oportunidades + actividades).
// Idempotente: CREATE TABLE/INDEX IF NOT EXISTS + marcador en _migrations.
export async function createCrmTables() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0044_crm' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: CRM tables (opportunities + activities)...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS crm_opportunities (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      client_id varchar REFERENCES clients(id) ON DELETE SET NULL,
      contact_name text,
      phone text,
      email text,
      title text NOT NULL,
      description text,
      estimated_value numeric(15,2) DEFAULT '0',
      currency text NOT NULL DEFAULT 'ARS',
      probability integer DEFAULT 50,
      stage text NOT NULL DEFAULT 'consulta',
      status text NOT NULL DEFAULT 'open',
      owner_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      quote_id varchar REFERENCES quotes(id) ON DELETE SET NULL,
      expected_close_date timestamp,
      next_followup_at timestamp,
      lost_reason text,
      created_by varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS crm_opp_org_stage_idx ON crm_opportunities (organization_id, stage)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS crm_opp_org_status_idx ON crm_opportunities (organization_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS crm_opp_quote_idx ON crm_opportunities (quote_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS crm_activities (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      opportunity_id varchar NOT NULL REFERENCES crm_opportunities(id) ON DELETE CASCADE,
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      type text NOT NULL,
      content text,
      scheduled_at timestamp,
      completed_at timestamp,
      created_by_user_id varchar REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS crm_act_opp_idx ON crm_activities (opportunity_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS crm_act_sched_idx ON crm_activities (organization_id, scheduled_at)`);

  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0044_crm') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: CRM tables ready.');
}
