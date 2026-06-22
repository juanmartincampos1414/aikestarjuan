import { db } from '../db';
import { sql } from 'drizzle-orm';

// Task #282: persistir el estado de la conversación de WhatsApp en Postgres.
// Antes vivía en un Map in-memory en `server/conversation-state.ts`, lo que
// rompía cualquier deploy (se perdía el flujo en curso) y se rompía con
// Autoscale multi-réplica (cada réplica tenía su propio Map, así que un "1"
// caía en la réplica A y un "sí" en la B sin contexto).
//
// PK = (organization_id, user_id). El TTL de 30 minutos se aplica en queries
// (last_activity_at > now() - 30 min). El barrido periódico también usa
// last_activity_at. Idempotente: CREATE TABLE/INDEX IF NOT EXISTS.
export async function addWhatsappConversationsTable() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0020_whatsapp_conversations' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: create whatsapp_conversations table...');

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS whatsapp_conversations (
      organization_id varchar NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      current_step text NOT NULL DEFAULT 'type',
      slots jsonb NOT NULL,
      messages jsonb NOT NULL DEFAULT '[]'::jsonb,
      suggested_accounts jsonb,
      available_categories jsonb,
      paused_flow jsonb,
      just_completed_transaction boolean NOT NULL DEFAULT false,
      waiting_for_continue_decision boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL DEFAULT NOW(),
      last_activity_at timestamp NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, user_id)
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_user_activity
    ON whatsapp_conversations (user_id, last_activity_at)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_whatsapp_conv_activity
    ON whatsapp_conversations (last_activity_at)
  `);

  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0020_whatsapp_conversations') ON CONFLICT (name) DO NOTHING`
  );

  console.log('Migration complete: whatsapp_conversations ready.');
}
