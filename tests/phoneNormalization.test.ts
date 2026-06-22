import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePhoneInput,
  formatArgentineMobilePretty,
  isArgentineMobileMissing9,
  arPhoneCandidates,
  maskPhoneForDisplay,
} from '../shared/phone';

// Task #187 — Argentine mobile numbers must be canonicalized to +549<10 digits>
// no matter how the user types them, while non-AR numbers stay as-is in E.164.

describe('normalizePhoneInput — Argentine variants', () => {
  const expected = '+5491168247426';

  const cases: Array<[string, string]> = [
    ['1168247426', expected],            // bare 10-digit local (CABA)
    ['01168247426', expected],           // with trunk 0
    ['+541168247426', expected],         // E.164 missing the 9 (most common bug)
    ['+5401168247426', expected],        // E.164 with trunk 0 mistakenly
    ['+5491168247426', expected],        // already canonical
    ['11 6824-7426', expected],          // pretty AR format
    ['11 15 6824-7426', expected],       // with 15 mobile prefix
    ['011 15 6824-7426', expected],      // with 0 + 15
    ['+54 11 15-6824-7426', expected],   // E.164 + 15
    ['9 11 6824 7426', expected],        // domestic with 9 already
    ['+54 9 11 6824 7426', expected],    // E.164 spaced
  ];

  for (const [input, want] of cases) {
    it(`normalizes "${input}" -> ${want}`, () => {
      const r = normalizePhoneInput(input);
      assert.equal(r.ok, true, `expected ok=true for ${input}, got ${JSON.stringify(r)}`);
      if (r.ok) {
        assert.equal(r.phone, want);
        assert.equal(r.isArMobile, true);
      }
    });
  }

  it('marks the result as changed when normalization rewrites the input', () => {
    const r = normalizePhoneInput('011 15 6824-7426');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.changed, true);
  });

  it('marks the result as not changed when input is already canonical', () => {
    const r = normalizePhoneInput('+5491168247426');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.changed, false);
  });
});

describe('normalizePhoneInput — non-Argentine numbers stay as E.164', () => {
  it('keeps a US number untouched', () => {
    const r = normalizePhoneInput('+12025550123');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.phone, '+12025550123');
      assert.equal(r.isArMobile, false);
    }
  });

  it('keeps a Uruguayan number untouched', () => {
    const r = normalizePhoneInput('+59899123456');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.phone, '+59899123456');
      assert.equal(r.isArMobile, false);
    }
  });

  it('rejects empty input', () => {
    const r = normalizePhoneInput('');
    assert.equal(r.ok, false);
  });

  it('rejects garbage input', () => {
    const r = normalizePhoneInput('abc');
    assert.equal(r.ok, false);
  });

  it('rejects malformed +54 numbers instead of falling back to E.164', () => {
    // Too short — 5 digits after +54. Previously the generic E.164 path could
    // accept this; the AR guard now surfaces it as invalid so the friendly
    // "ingresá tu número local" copy fires.
    const tooShort = normalizePhoneInput('+54123');
    assert.equal(tooShort.ok, false);

    // Valid E.164 length but starts with 54 and has no plausible AR mobile
    // pattern (e.g., area code 0 or all zeros).
    const wrongShape = normalizePhoneInput('+540000000000');
    assert.equal(wrongShape.ok, false);
  });
});

describe('formatArgentineMobilePretty', () => {
  it('formats canonical AR mobile', () => {
    assert.equal(formatArgentineMobilePretty('+5491168247426'), '+54 9 11 6824-7426');
  });

  it('returns null for non-AR or invalid input', () => {
    assert.equal(formatArgentineMobilePretty('+12025550123'), null);
    assert.equal(formatArgentineMobilePretty('+541168247426'), null); // missing 9
    assert.equal(formatArgentineMobilePretty(''), null);
  });
});

describe('isArgentineMobileMissing9', () => {
  it('detects legacy AR numbers stored without the 9', () => {
    assert.equal(isArgentineMobileMissing9('+541168247426'), true);
  });

  it('returns false for canonical AR mobile', () => {
    assert.equal(isArgentineMobileMissing9('+5491168247426'), false);
  });

  it('returns false for non-AR numbers', () => {
    assert.equal(isArgentineMobileMissing9('+12025550123'), false);
  });
});

describe('arPhoneCandidates — fallback lookup variants', () => {
  it('produces both with-9 and without-9 variants for canonical AR input', () => {
    const candidates = arPhoneCandidates('+5491168247426');
    assert.ok(candidates.includes('+5491168247426'));
    assert.ok(candidates.includes('5491168247426'));
    assert.ok(candidates.includes('+541168247426'));
    assert.ok(candidates.includes('541168247426'));
  });

  it('produces both variants for legacy AR input (no 9)', () => {
    const candidates = arPhoneCandidates('+541168247426');
    assert.ok(candidates.includes('+541168247426'));
    assert.ok(candidates.includes('+5491168247426'));
  });

  it('returns just the input variants for non-AR numbers', () => {
    const candidates = arPhoneCandidates('+12025550123');
    assert.ok(candidates.includes('+12025550123'));
    assert.ok(candidates.includes('12025550123'));
    // Should NOT have 549 variants
    assert.equal(candidates.some((c) => c.includes('549')), false);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(arPhoneCandidates(''), []);
  });
});

// Task #225 — Para los emails/WhatsApp de confirmación de vinculación
// queremos mostrar el número con los últimos 4 dígitos visibles y el resto
// enmascarado. Esto evita leakear el número entero en logs/inboxes y
// además le da al usuario una pista clara de qué número fue vinculado.
describe('maskPhoneForDisplay — Task #225', () => {
  it('enmascara móvil AR canónico mostrando últimos 4 dígitos', () => {
    assert.equal(maskPhoneForDisplay('+5491168247426'), '+54 9 11 ••••-7426');
  });

  it('enmascara móvil AR de otra área (Córdoba 351)', () => {
    assert.equal(maskPhoneForDisplay('+5493514812345'), '+54 9 35 ••••-2345');
  });

  it('enmascara número internacional no-AR conservando últimos 4', () => {
    const masked = maskPhoneForDisplay('+12025550123');
    assert.match(masked, /0123$/, 'debe terminar con los últimos 4');
    assert.ok(masked.includes('••••'), 'debe contener máscara');
    assert.ok(!masked.includes('5550'), 'no debe leakear el medio del número');
  });

  it('devuelve placeholder para null/undefined/vacío', () => {
    assert.equal(maskPhoneForDisplay(null), '•••• ••••');
    assert.equal(maskPhoneForDisplay(undefined), '•••• ••••');
    assert.equal(maskPhoneForDisplay(''), '•••• ••••');
  });

  it('devuelve placeholder para input demasiado corto', () => {
    assert.equal(maskPhoneForDisplay('123'), '•••• ••••');
  });

  it('soporta números no-canónicos (ignora caracteres no dígitos)', () => {
    // No es AR canónico (le falta el 9) — cae en la rama internacional.
    const masked = maskPhoneForDisplay('+54 11 6824-7426');
    assert.match(masked, /7426$/);
    assert.ok(masked.includes('••••'));
  });
});
