# E2E test plan — Repair orphan transfer flow

This document is the canonical end-to-end (Playwright) test plan for the
"reparar transferencia huérfana" UI in `client/src/pages/transactions.tsx`.

The integration test in `tests/repairTransferEndpoint.test.ts` covers the
HTTP handler. The HTTP-level e2e walk through the **same contract the
React UI uses** (login → GET orphan → POST repair → GET no longer orphan)
lives in `tests/repairTransferUI.e2e.test.ts` and runs automatically with:

```bash
npx tsx --test tests/repairTransferUI.e2e.test.ts
```

This Markdown plan is the **browser-level** counterpart: it exercises the
DOM (banner visibility, select dropdown, toast, dialog refetch). Re-run
it whenever the transaction-detail dialog or the orphan banner UI is
touched.

## How to run

The plan is executed with the Replit `runTest` callback (Playwright-based
testing subagent). From the agent shell:

```js
const result = await runTest({
  testPlan: <contents of TEST PLAN section below>,
  relevantTechnicalDocumentation: <contents of CONTEXT section below>,
});
```

The plan creates its own user/org/accounts via `[DB]` steps and uses a
unique email per run, so it does not interfere with existing data in the
shared development database.

## Scenarios covered

1. **Recrear contraparte** on a `transfer_out` orphan
   - Banner appears, opens the "Recrear contraparte" form, picks the
     counterpart account, and submits.
   - Verifies the success toast, banner disappearance, and that a
     `transfer_in` counterpart row was inserted with the same
     `transfer_pair_id`.

2. **Convertir en ingreso** on a `transfer_in` orphan
   - Banner appears with the amber "Convertir en ingreso" button.
   - Clicks confirm and verifies the transaction was flipped to
     `type='income'` with `transfer_pair_id=NULL`, and the banner is
     gone.

## CONTEXT (passed as `relevantTechnicalDocumentation`)

- Login form: `data-testid="input-login-email"`,
  `data-testid="input-login-password"`, submit button
  `data-testid="button-login"` at path `/login`.
- After successful login, the app lands on `/` (dashboard); the
  transactions screen is at `/transactions`.
- Each transaction row is rendered twice in the DOM with distinct
  testids: `data-testid="transaction-row-desktop-${id}"` for the
  desktop table layout and `data-testid="transaction-row-mobile-${id}"`
  for the mobile card layout. Clicking either opens the detail dialog
  (`Detalle del Movimiento`). Use the desktop selector in tests.
- The orphan banner is `data-testid="banner-orphan-transfer"`.
- Repair UI testids:
  - `button-orphan-recreate`, `button-orphan-convert`
  - `select-orphan-counterpart-account`, `input-orphan-counterpart-amount`
  - `button-orphan-confirm-recreate`, `button-orphan-cancel-recreate`
  - `button-orphan-confirm-convert`, `button-orphan-cancel-convert`
- API: `POST /api/transactions/:id/repair-transfer` with body
  `{ action: 'recreate-pair', counterpartAccountId, counterpartAmount? }`
  or `{ action: 'convert', newType: 'income'|'expense' }`.
- Success toast title is `Transferencia reparada`.
- DB schema (Drizzle / Postgres) — relevant tables/columns:
  - `users(id uuid pk, email text unique, name text, password text /* bcrypt */, account_type text, created_at)`
  - `organizations(id uuid pk, name text, type text, country text, default_currency text, created_at)`
  - `memberships(id uuid pk, user_id uuid, organization_id uuid, role text)`
  - `accounts(id uuid pk, name text, type text, currency text, balance numeric, account_category text, organization_id uuid)`
  - `transactions(id uuid pk, type text, amount numeric, currency text,
    description text, category text, date timestamp, imputation_date timestamp,
    account_id uuid, organization_id uuid, status text, transfer_pair_id uuid,
    created_at)`
- Bcrypt hash for the test password `Test1234!`:
  `$2b$10$ehaNDSkK0GDLEYp40V1H/eqDMmGf.xPiDTXIJYA4p0JYtbpKaZnv6`

## TEST PLAN (passed as `testPlan`)

```text
1. [New Context] Create a new browser context.
2. [DB] Generate a unique suffix (say ${suffix} = nanoid(8)) and use it for
   all the names below so this run does not collide with other data in the
   shared dev database.
3. [DB] Insert a user:
     INSERT INTO users (email, name, password, account_type)
     VALUES ('e2e-repair-${suffix}@test.local', 'E2E Repair Tester',
             '$2b$10$ehaNDSkK0GDLEYp40V1H/eqDMmGf.xPiDTXIJYA4p0JYtbpKaZnv6',
             'business')
     RETURNING id;
   Note the returned id as ${userId}.
4. [DB] Insert an organization:
     INSERT INTO organizations (name, type, country, default_currency)
     VALUES ('Repair E2E ${suffix}', 'business', 'AR', 'ARS')
     RETURNING id;
   Note the id as ${orgId}.
5. [DB] Insert a subscription so the auth middleware lets the user past the
   subscription gate (it is enforced in `server/routes/middleware.ts` and
   returns 402 `SUBSCRIPTION_REQUIRED` otherwise — without this the React
   app stays stuck on `/login` after a successful login response):
     INSERT INTO subscriptions (user_id, plan_type, status)
     VALUES ('${userId}', 'business', 'active');
6. [DB] Insert a membership making the user owner of the org:
     INSERT INTO memberships (user_id, organization_id, role)
     VALUES ('${userId}', '${orgId}', 'owner');
7. [DB] Insert two accounts in that org:
     INSERT INTO accounts (name, type, currency, balance, account_category, organization_id)
     VALUES ('Caja E2E ${suffix}', 'cash', 'ARS', 10000, 'operative', '${orgId}')
     RETURNING id;   -- note as ${cajaId}
     INSERT INTO accounts (name, type, currency, balance, account_category, organization_id)
     VALUES ('Banco E2E ${suffix}', 'bank', 'ARS', 0, 'operative', '${orgId}')
     RETURNING id;   -- note as ${bancoId}
8. [DB] Insert ORPHAN A — a `transfer_out` from Caja with NO transfer_pair_id:
     INSERT INTO transactions
       (type, amount, currency, description, category, date, imputation_date,
        account_id, organization_id, status)
     VALUES ('transfer_out', 750, 'ARS', 'E2E orphan OUT ${suffix}',
             'Transferencia Interna', NOW(), NOW(),
             '${cajaId}', '${orgId}', 'completed')
     RETURNING id;
   Note the id as ${orphanOutId}.
9. [Browser] Navigate to /login.
10. [Browser] Fill `input-login-email` with `e2e-repair-${suffix}@test.local`.
11. [Browser] Fill `input-login-password` with `Test1234!`.
12. [Browser] Click `button-login`.
13. [Verify] Wait for the URL to leave `/login` (we land on `/` or a
    dashboard). No "Email o contraseña incorrectos" error toast appeared.
14. [Browser] Navigate to /transactions.
15. [Browser] Wait for the row `transaction-row-desktop-${orphanOutId}`
    to be visible.
16. [Browser] Click on `transaction-row-desktop-${orphanOutId}`.
17. [Verify] The detail dialog opens and `banner-orphan-transfer` is
    visible. Inside the banner, both `button-orphan-recreate` and
    `button-orphan-convert` are visible. The convert button label
    contains the word "gasto" (because converting a transfer_out
    sign-preserves into expense).

    --- Recreate flow ---
18. [Browser] Click `button-orphan-recreate`.
19. [Browser] Open `select-orphan-counterpart-account` and choose the
    option whose label contains `Banco E2E ${suffix}`.
20. [Browser] Click `button-orphan-confirm-recreate`. Do NOT fill the
    optional amount field (defaults to the orphan amount).
21. [Verify] A toast titled "Transferencia reparada" appears.
22. [Verify] The `banner-orphan-transfer` disappears from the dialog
    (orphan was repaired and the dialog refetches the transaction).
23. [DB] Confirm a counterpart was inserted and the orphan was
    backfilled:
      SELECT t.id, t.type, t.account_id, t.amount, t.transfer_pair_id, t.status
      FROM transactions t
      WHERE t.organization_id = '${orgId}'
        AND t.transfer_pair_id IS NOT NULL;
    Assert exactly two rows with the SAME transfer_pair_id, both with
    status='completed': one is the orphan (id=${orphanOutId},
    type='transfer_out', account_id=${cajaId}) and the other is a NEW
    row with type='transfer_in', account_id=${bancoId}, amount=750.00.

    --- Convert flow ---
24. [DB] Insert ORPHAN B — a `transfer_in` to Banco with a stale
    transfer_pair_id pointing nowhere:
      INSERT INTO transactions
        (type, amount, currency, description, category, date, imputation_date,
         account_id, organization_id, status, transfer_pair_id)
      VALUES ('transfer_in', 300, 'ARS', 'E2E orphan IN ${suffix}',
              'Transferencia Interna', NOW(), NOW(),
              '${bancoId}', '${orgId}', 'completed',
              gen_random_uuid())
      RETURNING id;
    Note the id as ${orphanInId}.
25. [Browser] Close the open dialog if still open (press Escape) and
    reload /transactions so the new orphan appears in the list.
26. [Browser] Click `transaction-row-desktop-${orphanInId}`.
27. [Verify] `banner-orphan-transfer` is visible. The
    `button-orphan-convert` label contains the word "ingreso" (because
    converting a transfer_in sign-preserves into income).
28. [Browser] Click `button-orphan-convert`.
29. [Browser] Click `button-orphan-confirm-convert`.
30. [Verify] A toast titled "Transferencia reparada" appears and
    `banner-orphan-transfer` disappears.
31. [DB] Confirm the convert effects:
      SELECT type, transfer_pair_id, category, description
      FROM transactions WHERE id = '${orphanInId}';
    Assert type='income', transfer_pair_id IS NULL, and description
    contains "Convertida desde transferencia huérfana".

    --- Cleanup ---
32. [DB] Delete the test organization to cascade-clean accounts &
    transactions, then delete the user:
      DELETE FROM organizations WHERE id = '${orgId}';
      DELETE FROM users WHERE id = '${userId}';
```
