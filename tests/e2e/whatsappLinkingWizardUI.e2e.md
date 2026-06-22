# WhatsApp Linking Wizard — runtime UI test (Task #217)

Runtime UI counterpart to `tests/whatsappLinkingFlow.e2e.test.ts` (HTTP).
Executed via the Replit `runTest()` Playwright tool — **last run: success**.

## Setup

Create a test user with an active business subscription before running:

```ts
await storage.createUser({
  email: `e2e-task217-ui-${Date.now()}@test.local`,
  name: 'T217 UI',
  password: await bcrypt.hash('TestTask217UI!2026', 10),
  accountType: 'business',
});
await storage.createSubscription({ userId, planType: 'business', status: 'active' });
await storage.createOrganization({ name: '...', type: 'business', country: 'AR', defaultCurrency: 'ARS' });
await storage.createMembership({ userId, organizationId, role: 'owner' });
```

## Test plan

```
1. [New Context] Create a new browser context.
2. [Browser] Navigate to /login. Submit email + password.
3. [Browser] Navigate to /settings, scroll to the WhatsApp section.
4. [Browser] Click data-testid="button-add-phone".

Step 1 (greet-bot):
5. [Verify]
   - data-testid="region-phone-wizard" visible.
   - data-testid="text-phone-step-indicator" shows step 1 active.
   - data-testid="checkbox-bot-greeted" exists, UNCHECKED.
   - data-testid="button-continue-to-phone" exists, DISABLED.
   - The bot number "+54 11 2489-4944" (from GET /api/whatsapp/bot-info)
     is shown and the wa.me link points to that number.
6. [Browser] Click checkbox-bot-greeted.
7. [Verify] button-continue-to-phone is now ENABLED.
8. [Browser] Click button-continue-to-phone.

Step 2 (enter-phone):
9. [Verify]
   - Step indicator shows step 2 active.
   - Phone input + country selector visible.
   - "Enviar código" button visible.
10. [Browser] Click button-cancel-verification.

Cancel reset:
11. [Verify]
    - Wizard closes back to "Vincular WhatsApp" entry, OR
    - Wizard re-opens at step 1 with the checkbox UNCHECKED and Continue
      DISABLED.
```

## What this test catches

- Continue gating: step 1 cannot be skipped without checking "Ya le escribí".
- Step indicator transitions correctly on Continue.
- The bot number rendered in the UI comes from the live API (not a stale literal).
- Cancel/back resets the greet-bot state (regression for the silent-drop bug).

## Pair with

- `tests/whatsappLinkingFlow.e2e.test.ts` — HTTP integration of the same
  3-step flow (bot-info → send-code → verify-code).
- `tests/whatsappWizardEntryPoints.test.ts` — structural source-level guards.
- `tests/botPhoneInfo.test.ts` — unit tests for the bot-phone helper.
