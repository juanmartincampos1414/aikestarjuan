import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Structural guards: both entry points of the WhatsApp linking wizard
// must land on the greet-bot step. Regression for the bug where the
// pencil-edit button skipped step 1, re-introducing the silent-drop.

const FILE = path.join(process.cwd(), 'client/src/pages/settings.tsx');

describe('WhatsApp wizard entry points', () => {
  it('button-add-phone (initial linking) opens the wizard at the greet-bot step', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const idx = src.indexOf('data-testid="button-add-phone"');
    assert.ok(idx > -1, 'button-add-phone not found in settings.tsx');
    // Search backwards from the testid to the enclosing onClick handler.
    const before = src.slice(Math.max(0, idx - 800), idx);
    assert.match(
      before,
      /setPhoneStep\(['"]greet-bot['"]\)/,
      'button-add-phone onClick must initialize phoneStep to "greet-bot"',
    );
    // And must NOT directly jump to enter-phone or enter-code.
    assert.doesNotMatch(
      before,
      /setPhoneStep\(['"]enter-(phone|code)['"]\)/,
      'button-add-phone onClick must not skip the greet-bot step',
    );
  });

  it('button-edit-phone (re-linking an existing number) also opens at greet-bot', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const idx = src.indexOf('data-testid="button-edit-phone"');
    assert.ok(idx > -1, 'button-edit-phone not found in settings.tsx');
    const before = src.slice(Math.max(0, idx - 800), idx);
    assert.match(
      before,
      /setPhoneStep\(['"]greet-bot['"]\)/,
      'button-edit-phone onClick must initialize phoneStep to "greet-bot"',
    );
    assert.doesNotMatch(
      before,
      /setPhoneStep\(['"]enter-(phone|code)['"]\)/,
      'button-edit-phone onClick must not skip the greet-bot step (regression)',
    );
  });

  it('button-edit-phone clears prior wizard state before re-opening (botGreeted, code)', () => {
    // Task #218 regression: when a verified user clicks the pencil to
    // re-link, stale state (botGreeted=true, a previous verification
    // code, a pending phone) must NOT leak into the new wizard session,
    // otherwise the user could land on step 2/3 with the Continue button
    // already enabled.
    const src = fs.readFileSync(FILE, 'utf8');
    const idx = src.indexOf('data-testid="button-edit-phone"');
    assert.ok(idx > -1, 'button-edit-phone not found in settings.tsx');
    const before = src.slice(Math.max(0, idx - 800), idx);
    assert.match(
      before,
      /setBotGreeted\(false\)/,
      'button-edit-phone onClick must reset botGreeted=false',
    );
    assert.match(
      before,
      /setVerificationCode\(['"]['"]\)/,
      'button-edit-phone onClick must clear any leftover verification code',
    );
    assert.match(
      before,
      /setPendingPhone\(null\)/,
      'button-edit-phone onClick must clear any pending phone in flight',
    );
  });

  it('the bot-greeted checkbox state resets on cancel', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const cancelHandlerMatch = src.match(
      /const handleCancelVerification = \(\) => \{[\s\S]*?\};/,
    );
    assert.ok(cancelHandlerMatch, 'handleCancelVerification not found');
    assert.match(
      cancelHandlerMatch[0],
      /setBotGreeted\(false\)/,
      'cancel must clear the botGreeted flag so the next session re-asks',
    );
    assert.match(
      cancelHandlerMatch[0],
      /setPhoneStep\(['"]greet-bot['"]\)/,
      'cancel must reset back to step 1',
    );
  });

  it('"Continuar" button on step 1 is gated by the botGreeted state', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const idx = src.indexOf('data-testid="button-continue-to-phone"');
    assert.ok(idx > -1, 'button-continue-to-phone not found in settings.tsx');
    const around = src.slice(Math.max(0, idx - 400), idx + 400);
    assert.match(
      around,
      /disabled=\{!botGreeted\}/,
      '"Continuar" must be disabled while !botGreeted',
    );
  });

  it('the wa.me deeplink is built from the API-provided bot number', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    assert.match(
      src,
      /botWaLink\s*=\s*botInfo\s*\?\s*`https:\/\/wa\.me\/\$\{botInfo\.waMe\}/,
      'botWaLink must use botInfo.waMe when botInfo is loaded',
    );
    assert.match(
      src,
      /:\s*`https:\/\/wa\.me\/\$\{BOT_WAME_FALLBACK\}/,
      'botWaLink must fall back to BOT_WAME_FALLBACK (not a hardcoded number)',
    );
    // The greeting text must reference botInfo.defaultGreeting at least
    // once so backend changes propagate.
    assert.match(
      src,
      /botInfo\.defaultGreeting/,
      'greeting must come from botInfo.defaultGreeting',
    );
  });

  it('the FAQ rewrites the fallback bot number with the live backend value', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    assert.match(
      src,
      /faq\.answer\.split\(BOT_DISPLAY_FALLBACK\)\.join\(botInfo\.display\)/,
      'FAQ must rewrite BOT_DISPLAY_FALLBACK using the live botInfo.display',
    );
  });

  it('botInfo is hydrated on mount, not only when the wizard opens', () => {
    const src = fs.readFileSync(FILE, 'utf8');
    const effectMatch = src.match(
      /useEffect\(\(\) => \{\s*if \(botInfo\) return;\s*fetch\('\/api\/whatsapp\/bot-info'[\s\S]*?\}, \[botInfo\]\);/,
    );
    assert.ok(
      effectMatch,
      'bot-info fetch must run on mount (deps = [botInfo]), not gated by isEditingPhone',
    );
  });
});
