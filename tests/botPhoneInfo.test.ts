import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { getBotPhoneInfo, formatBotDisplay, PRODUCTION_BOT_NUMBER_E164 } =
  await import('../server/lib/botPhone');

// Task #218 — When the user-facing wa.me deeplink and the displayed
// number diverge, the linking wizard becomes a dead-end. Every case
// below must therefore assert all three contract fields (e164, waMe,
// display) so a regression in any of them surfaces immediately.

const PRODUCTION_WAME = '5491124894944';
const PRODUCTION_DISPLAY = '+54 11 2489-4944';

function assertProductionFallback(info: { e164: string; waMe: string; display: string }) {
  assert.equal(info.e164, PRODUCTION_BOT_NUMBER_E164);
  assert.equal(info.waMe, PRODUCTION_WAME);
  assert.equal(info.display, PRODUCTION_DISPLAY);
}

describe('getBotPhoneInfo', () => {
  it('falls back to the production constant when env is empty', () => {
    assertProductionFallback(getBotPhoneInfo(''));
  });

  it('falls back to production when env is whitespace only', () => {
    assertProductionFallback(getBotPhoneInfo('   '));
  });

  it('treats the Twilio sandbox number (with +) as "no real bot"', () => {
    assertProductionFallback(getBotPhoneInfo('+14155238886'));
  });

  it('treats the sandbox without "+" as "no real bot" (digits compare)', () => {
    assertProductionFallback(getBotPhoneInfo('14155238886'));
  });

  it('treats the sandbox with "whatsapp:" prefix as sandbox', () => {
    assertProductionFallback(getBotPhoneInfo('whatsapp:+14155238886'));
  });

  it('treats the sandbox with surrounding whitespace as sandbox', () => {
    assertProductionFallback(getBotPhoneInfo('  +14155238886  '));
  });

  it('uses a real env value as-is when it includes a leading +', () => {
    const info = getBotPhoneInfo('+5491155551234');
    assert.equal(info.e164, '+5491155551234');
    assert.equal(info.waMe, '5491155551234');
    assert.equal(info.display, '+54 11 5555-1234');
  });

  it('adds a leading + when the env value is digits-only', () => {
    const info = getBotPhoneInfo('5491155551234');
    assert.equal(info.e164, '+5491155551234');
    assert.equal(info.waMe, '5491155551234');
    assert.equal(info.display, '+54 11 5555-1234');
  });

  it('strips the "whatsapp:" prefix when present', () => {
    const info = getBotPhoneInfo('whatsapp:+5491155551234');
    assert.equal(info.e164, '+5491155551234');
    assert.equal(info.waMe, '5491155551234');
    assert.equal(info.display, '+54 11 5555-1234');
  });

  it('handles a real env value with embedded spaces and dashes', () => {
    const info = getBotPhoneInfo('+54 9 11 5555-1234');
    // The helper preserves the leading + and only strips non-digit chars
    // from waMe; e164 keeps the whitespace because we only look for "+".
    assert.match(info.waMe, /^\d+$/);
    assert.equal(info.waMe, '5491155551234');
    assert.equal(info.display, '+54 11 5555-1234');
  });

  it('returns a non-AR number unchanged in display (cleaned, no AR grouping)', () => {
    const info = getBotPhoneInfo('+12025551234');
    assert.equal(info.e164, '+12025551234');
    assert.equal(info.waMe, '12025551234');
    // No AR grouping rule matches → cleaned form returned.
    assert.equal(info.display, '+12025551234');
  });

  it('formatBotDisplay handles AR mobile with the optional "9" prefix', () => {
    assert.equal(formatBotDisplay('+5491124894944'), '+54 11 2489-4944');
  });

  it('e164 and waMe always represent the same digits', () => {
    for (const env of ['', '+14155238886', '14155238886', 'whatsapp:+14155238886',
                       '+5491155551234', '5491155551234', 'whatsapp:+5491155551234']) {
      const info = getBotPhoneInfo(env);
      const e164Digits = info.e164.replace(/[^\d]/g, '');
      assert.equal(info.waMe, e164Digits,
        `waMe must equal e164 digits for env="${env}"`);
    }
  });
});
