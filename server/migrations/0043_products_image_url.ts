import { db } from '../db';
import { sql } from 'drizzle-orm';

// Agrega products.image_url (URL de miniatura, ej. desde Tiendanube).
// Idempotente: ADD COLUMN IF NOT EXISTS + marcador en _migrations.
export async function addProductsImageUrlColumn() {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = await db.execute(sql`SELECT 1 FROM _migrations WHERE name = '0043_products_image_url' LIMIT 1`);
  if (done.rowCount && done.rowCount > 0) return;

  console.log('Running migration: add products.image_url column...');
  await db.execute(sql`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text`);
  await db.execute(sql`INSERT INTO _migrations (name) VALUES ('0043_products_image_url') ON CONFLICT (name) DO NOTHING`);
  console.log('Migration complete: products.image_url ready.');
}
