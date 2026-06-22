#!/usr/bin/env tsx
/**
 * Task #310 — Script one-off para limpiar duplicados de `subscriptions`.
 *
 * Contexto: en producción hay ~32 pares de filas en `subscriptions` que
 * comparten el mismo `stripe_subscription_id`. El patrón es siempre el
 * mismo: una fila vieja con `status='trialing'` insertada al momento del
 * signup, y una fila nueva insertada milisegundos después por otro
 * webhook con `current_period_end` y demás datos completos. El bug del
 * webhook ya se arregló en la misma tarea (upsert keyed por
 * stripe_subscription_id), pero todavía hay que limpiar el legado.
 *
 * Estrategia: para cada `(user_id, stripe_subscription_id)` con más de
 * una fila, mantenemos la más reciente por `updated_at` y borramos las
 * otras. Caso especial conocido: usuarios con dos `stripe_subscription_id`
 * DISTINTOS (ej. juantetamanti@hotmail.com) no son duplicados estrictos
 * y se loguean como excepción para revisión manual.
 *
 * Uso:
 *   tsx scripts/dedupe-subscriptions.ts             # dry-run
 *   tsx scripts/dedupe-subscriptions.ts --commit    # ejecuta los deletes
 *
 * IMPORTANTE: se conecta a la base por `NEON_OHIO_URL || DATABASE_URL`,
 * igual que server/db.ts, así que en producción apunta a la Neon Ohio.
 */

import { sql, eq, and, desc, inArray } from 'drizzle-orm';
import { db } from '../server/db';
import { subscriptions, users } from '../shared/schema';

interface DuplicateGroup {
  userId: string;
  email: string | null;
  stripeSubscriptionId: string;
  rows: Array<{
    id: string;
    status: string;
    currentPeriodEnd: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

async function findDuplicates(): Promise<DuplicateGroup[]> {
  // Pares (user_id, stripe_subscription_id) con más de una fila.
  const dupPairs = await db.execute(sql`
    SELECT user_id, stripe_subscription_id, COUNT(*) AS dup_count
    FROM subscriptions
    WHERE stripe_subscription_id IS NOT NULL
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
    ORDER BY user_id
  `);

  const groups: DuplicateGroup[] = [];
  for (const row of dupPairs.rows as any[]) {
    const userId = row.user_id as string;
    const stripeSubscriptionId = row.stripe_subscription_id as string;

    const rows = await db.select({
      id: subscriptions.id,
      status: subscriptions.status,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      createdAt: subscriptions.createdAt,
      updatedAt: subscriptions.updatedAt,
    }).from(subscriptions)
      .where(and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId),
      ))
      .orderBy(desc(subscriptions.updatedAt));

    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    groups.push({ userId, email: user?.email ?? null, stripeSubscriptionId, rows });
  }
  return groups;
}

interface MultiStripeIdCase {
  userId: string;
  email: string | null;
  stripeSubscriptionIds: string[];
}

async function findUsersWithMultipleStripeIds(): Promise<MultiStripeIdCase[]> {
  // Usuarios con MÁS de un stripe_subscription_id distinto — caso especial
  // (ej. juantetamanti). No los borramos automáticamente.
  const multi = await db.execute(sql`
    SELECT user_id, ARRAY_AGG(DISTINCT stripe_subscription_id) AS ids
    FROM subscriptions
    WHERE stripe_subscription_id IS NOT NULL
    GROUP BY user_id
    HAVING COUNT(DISTINCT stripe_subscription_id) > 1
    ORDER BY user_id
  `);
  const cases: MultiStripeIdCase[] = [];
  for (const row of multi.rows as any[]) {
    const userId = row.user_id as string;
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    cases.push({ userId, email: user?.email ?? null, stripeSubscriptionIds: row.ids as string[] });
  }
  return cases;
}

// Task #318 — modo verificación-only. Útil para incluir en runbooks /
// post-deploy checks: imprime el invariante "0 duplicados por
// stripe_subscription_id" y termina con exit 0/1 sin tocar la base.
async function verifyInvariant(): Promise<number> {
  const groups = await findDuplicates();
  const multi = await findUsersWithMultipleStripeIds();
  console.log(`\n[dedupe-subscriptions --verify] DB: ${(process.env.NEON_OHIO_URL || process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`[dedupe-subscriptions --verify] Pares (user_id, stripe_subscription_id) duplicados: ${groups.length}`);
  console.log(`[dedupe-subscriptions --verify] Usuarios con múltiples stripe_subscription_id distintos: ${multi.length}`);
  if (groups.length === 0) {
    console.log('[dedupe-subscriptions --verify] OK — invariante mantenida: 1 fila por (user, stripe_subscription_id).');
    return 0;
  }
  console.error('[dedupe-subscriptions --verify] FAIL — hay duplicados, correr el script con --commit.');
  for (const g of groups) {
    console.error(`  - ${g.email || g.userId} / ${g.stripeSubscriptionId} (${g.rows.length} filas)`);
  }
  return 1;
}

async function main() {
  if (process.argv.includes('--verify')) {
    const code = await verifyInvariant();
    process.exit(code);
  }
  const commit = process.argv.includes('--commit');
  const mode = commit ? 'COMMIT' : 'DRY-RUN';

  console.log(`\n[dedupe-subscriptions] Mode: ${mode}`);
  console.log(`[dedupe-subscriptions] DB: ${(process.env.NEON_OHIO_URL || process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@')}\n`);

  const multiCases = await findUsersWithMultipleStripeIds();
  if (multiCases.length > 0) {
    console.log(`[dedupe-subscriptions] Casos especiales (múltiples stripe_subscription_id distintos) — NO se tocan, revisión manual:`);
    for (const c of multiCases) {
      console.log(`  - ${c.email || c.userId}: ${c.stripeSubscriptionIds.join(', ')}`);
    }
    console.log('');
  }

  const groups = await findDuplicates();
  if (groups.length === 0) {
    console.log('[dedupe-subscriptions] No se encontraron duplicados. Nada que hacer.');
    process.exit(0);
  }

  console.log(`[dedupe-subscriptions] Encontrados ${groups.length} pares (user_id, stripe_subscription_id) con duplicados:\n`);

  const idsToDelete: string[] = [];
  for (const g of groups) {
    const [keep, ...drop] = g.rows; // ya viene ordenado por updated_at desc
    console.log(`  ${g.email || g.userId} / ${g.stripeSubscriptionId} (${g.rows.length} filas)`);
    console.log(`    KEEP: ${keep.id} status=${keep.status} updated_at=${keep.updatedAt.toISOString()}`);
    for (const d of drop) {
      console.log(`    DROP: ${d.id} status=${d.status} updated_at=${d.updatedAt.toISOString()}`);
      idsToDelete.push(d.id);
    }
  }

  console.log(`\n[dedupe-subscriptions] Total a borrar: ${idsToDelete.length} filas`);

  if (!commit) {
    console.log('[dedupe-subscriptions] DRY-RUN: no se ejecuta ningún DELETE. Volvé a correr con --commit para aplicar.');
    process.exit(0);
  }

  // Backup + DELETE en una transacción única.
  // El backup se queda en la base como `subscriptions_dedupe_backup_t310`
  // por al menos 14 días para permitir rollback con INSERT...SELECT.
  console.log('[dedupe-subscriptions] Creando backup y ejecutando DELETE en transacción...');
  await db.transaction(async (tx) => {
    if (idsToDelete.length === 0) return;

    // Backup vía CREATE TABLE AS SELECT — copia exactamente las columnas
    // de la fila original. Sin INSERT explícito ni cast de array.
    // DROP IF EXISTS hace al script re-ejecutable si una corrida anterior
    // tuvo que reintentarse.
    await tx.execute(sql`DROP TABLE IF EXISTS subscriptions_dedupe_backup_t310`);
    const backedUp = await tx.execute(sql`
      CREATE TABLE subscriptions_dedupe_backup_t310 AS
      WITH ranked AS (
        SELECT s.*,
          ROW_NUMBER() OVER (PARTITION BY s.user_id, s.stripe_subscription_id ORDER BY s.updated_at DESC) AS rn
        FROM subscriptions s
        WHERE s.stripe_subscription_id IS NOT NULL
          AND (s.user_id, s.stripe_subscription_id) IN (
            SELECT user_id, stripe_subscription_id FROM subscriptions
            WHERE stripe_subscription_id IS NOT NULL
            GROUP BY 1, 2 HAVING COUNT(*) > 1
          )
      )
      SELECT *, NOW() AS backed_up_at FROM ranked WHERE rn > 1
    `);
    console.log(`[dedupe-subscriptions] Backed up ${backedUp.rowCount ?? '?'} filas en subscriptions_dedupe_backup_t310.`);

    const deleted = await tx.delete(subscriptions).where(inArray(subscriptions.id, idsToDelete)).returning({ id: subscriptions.id });
    console.log(`[dedupe-subscriptions] Borradas ${deleted.length} filas de subscriptions.`);
  });

  // Verificación post-delete.
  const remaining = await findDuplicates();
  if (remaining.length > 0) {
    console.error(`[dedupe-subscriptions] ERROR: quedaron ${remaining.length} duplicados después del cleanup. Revisar manualmente.`);
    process.exit(1);
  }

  console.log('[dedupe-subscriptions] Verificación OK: 0 duplicados restantes.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[dedupe-subscriptions] Fatal error:', err);
  process.exit(1);
});
