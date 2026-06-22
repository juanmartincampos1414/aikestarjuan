import { pool } from "../db";

const CLEANUP_VERSION = "2026-03-07-orphaned-cancellations-generic";

export async function runOneTimeCleanup() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS _cleanup_flags (version TEXT PRIMARY KEY, ran_at TIMESTAMPTZ DEFAULT NOW())`);

    const flagCheck = await client.query(
      `SELECT 1 FROM _cleanup_flags WHERE version = $1`,
      [CLEANUP_VERSION]
    );
    if (flagCheck.rows.length > 0) {
      return;
    }

    const orphans = await client.query(`
      SELECT c.id, c.description, c.organization_id, c.account_id,
             (c.original_transaction_data::json->>'id') as original_id
      FROM transactions c
      WHERE c.description LIKE '[CANCELACIÓN]%'
        AND c.original_transaction_data IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM transactions orig
          WHERE orig.id = (c.original_transaction_data::json->>'id')::text
        )
    `);

    await client.query('BEGIN');
    try {
      if (orphans.rows.length > 0) {
        console.log(`[Cleanup] Found ${orphans.rows.length} orphaned cancellation records across all organizations:`);
        for (const row of orphans.rows) {
          console.log(`[Cleanup]   - "${row.description}" (org: ${row.organization_id}, account: ${row.account_id})`);
        }

        const idsToDelete = orphans.rows.map((r: any) => r.id);
        const placeholders = idsToDelete.map((_: any, i: number) => `$${i + 1}`).join(',');
        await client.query(
          `DELETE FROM transactions WHERE id IN (${placeholders})`,
          idsToDelete
        );
        console.log(`[Cleanup] Deleted ${idsToDelete.length} orphaned cancellation records. Balances not adjusted (none had updated balances due to ::text bug).`);
      } else {
        console.log('[Cleanup] No orphaned cancellation records found.');
      }

      await client.query(
        `INSERT INTO _cleanup_flags (version) VALUES ($1)`,
        [CLEANUP_VERSION]
      );
      await client.query('COMMIT');
      console.log(`[Cleanup] ${CLEANUP_VERSION} completed and flagged.`);
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }
  } catch (err: any) {
    console.error('[Cleanup] Error:', err.message);
  } finally {
    client.release();
  }
}
