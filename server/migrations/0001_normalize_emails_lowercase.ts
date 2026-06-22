import { db } from '../db';
import { sql } from 'drizzle-orm';

export async function normalizeEmailsToLowercase() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);

  const done = await db.execute(
    sql`SELECT 1 FROM _migrations WHERE name = '0001_normalize_emails_lowercase' LIMIT 1`
  );
  if (done.rowCount && done.rowCount > 0) {
    return;
  }

  console.log('Running migration: normalize emails to lowercase...');
  
  const r1 = await db.execute(
    sql`UPDATE users SET email = LOWER(TRIM(email)) WHERE email != LOWER(TRIM(email))`
  );
  console.log(`  users updated: ${r1.rowCount}`);
  
  const r2 = await db.execute(
    sql`UPDATE pending_signups SET email = LOWER(TRIM(email)) WHERE email != LOWER(TRIM(email))`
  );
  console.log(`  pending_signups updated: ${r2.rowCount}`);
  
  const r3 = await db.execute(
    sql`UPDATE team_invitations SET email = LOWER(TRIM(email)) WHERE email != LOWER(TRIM(email))`
  );
  console.log(`  team_invitations updated: ${r3.rowCount}`);
  
  const r4 = await db.execute(
    sql`UPDATE access_denied_events SET user_email = LOWER(TRIM(user_email)) WHERE user_email != LOWER(TRIM(user_email))`
  );
  console.log(`  access_denied_events updated: ${r4.rowCount}`);
  
  await db.execute(
    sql`INSERT INTO _migrations (name) VALUES ('0001_normalize_emails_lowercase')`
  );
  
  console.log('Migration complete: all emails normalized to lowercase.');
}
