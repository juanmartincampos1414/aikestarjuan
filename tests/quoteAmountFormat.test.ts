import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAmountLive,
  normalizeAmountInput,
  prepareQuoteAmount,
} from '../client/src/lib/currency';

// `prepareQuoteAmount` is the exact pure helper that office.tsx
// QuotesSection.handleSave (~line 4291) uses to validate the raw amount and decide
// the string sent in the payload (`amount: preparedAmount.amountValue`). Testing it
// directly exercises the real save path rather than a local copy, so regressions in
// the validation/payload logic are caught.

describe('formatAmountLive - manual entry (es-AR)', () => {
  it('keeps display (thousands) and internal (raw) in sync for "1.234,56"', () => {
    const { displayValue, internalValue } = formatAmountLive('1.234,56');
    assert.equal(displayValue, '1.234,56');
    assert.equal(internalValue, '1234.56');
  });

  it('formats a plain integer with thousand separators', () => {
    const { displayValue, internalValue } = formatAmountLive('1234');
    assert.equal(displayValue, '1.234');
    assert.equal(internalValue, '1234');
  });

  it('formats large integers (millions) correctly', () => {
    const { displayValue, internalValue } = formatAmountLive('1234567');
    assert.equal(displayValue, '1.234.567');
    assert.equal(internalValue, '1234567');
  });

  it('handles a trailing comma (user about to type decimals)', () => {
    const { displayValue, internalValue } = formatAmountLive('1234,');
    assert.equal(displayValue, '1.234,');
    // No decimal digits yet -> internal stays the integer part.
    assert.equal(internalValue, '1234');
  });

  it('limits decimals to two digits', () => {
    const { displayValue, internalValue } = formatAmountLive('1.234,567');
    assert.equal(displayValue, '1.234,56');
    assert.equal(internalValue, '1234.56');
  });

  it('returns empty for empty input', () => {
    const { displayValue, internalValue } = formatAmountLive('');
    assert.equal(displayValue, '');
    assert.equal(internalValue, '');
  });

  it('builds up "1.234,56" incrementally without desync', () => {
    // Simulate the controlled-input loop: each step feeds the previous internal value.
    let internal = '';
    const steps: Array<[string, string, string]> = [
      // input, expectedDisplay, expectedInternal
      ['1', '1', '1'],
      ['12', '12', '12'],
      ['123', '123', '123'],
      ['1234', '1.234', '1234'],
    ];
    for (const [input, expDisplay, expInternal] of steps) {
      const r = formatAmountLive(input, internal);
      assert.equal(r.displayValue, expDisplay, `display for "${input}"`);
      assert.equal(r.internalValue, expInternal, `internal for "${input}"`);
      internal = r.internalValue;
    }
  });
});

describe('formatAmountLive - edit flow (openEdit re-formats q.amount)', () => {
  // openEdit calls formatAmountLive(q.amount?.toString() || '') where q.amount comes
  // from the DB as a decimal string like "156662.00" or as a number.
  it('re-formats a stored decimal string "156662.00"', () => {
    const { displayValue, internalValue } = formatAmountLive('156662.00');
    assert.equal(displayValue, '156.662,00');
    assert.equal(internalValue, '156662.00');
    assert.equal(parseFloat(internalValue), 156662);
  });

  it('re-formats a stored integer-like string "156662"', () => {
    const { displayValue, internalValue } = formatAmountLive('156662');
    assert.equal(displayValue, '156.662');
    assert.equal(internalValue, '156662');
    assert.equal(parseFloat(internalValue), 156662);
  });

  it('re-formats a stored decimal with cents "1234.56"', () => {
    const { displayValue, internalValue } = formatAmountLive('1234.56');
    assert.equal(displayValue, '1.234,56');
    assert.equal(internalValue, '1234.56');
    assert.equal(parseFloat(internalValue), 1234.56);
  });
});

describe('formatAmountLive - AI-provided values (String(result.amount))', () => {
  // handleAnalyze derives both display and internal from formatAmountLive(String(result.amount)).
  it('numeric 1234.56 -> "1.234,56" / "1234.56"', () => {
    const { displayValue, internalValue } = formatAmountLive(String(1234.56));
    assert.equal(displayValue, '1.234,56');
    assert.equal(internalValue, '1234.56');
    assert.equal(parseFloat(internalValue), 1234.56);
  });

  it('string "1.234" is interpreted as 1234 (dot = thousands)', () => {
    const { displayValue, internalValue } = formatAmountLive(String('1.234'));
    assert.equal(displayValue, '1.234');
    assert.equal(internalValue, '1234');
    assert.equal(parseFloat(internalValue), 1234);
  });

  it('string "1.234,56" -> "1.234,56" / "1234.56"', () => {
    const { displayValue, internalValue } = formatAmountLive(String('1.234,56'));
    assert.equal(displayValue, '1.234,56');
    assert.equal(internalValue, '1234.56');
    assert.equal(parseFloat(internalValue), 1234.56);
  });
});

describe('handleSave sends the correct numeric value (parseFloat over form.amount)', () => {
  // For each entry path, the internalValue stored in form.amount must parseFloat to
  // the expected number, and the payload string must equal that internalValue.
  const cases: Array<{ name: string; aiOrManualInput: string; expected: number }> = [
    { name: 'manual "1.234,56"', aiOrManualInput: '1.234,56', expected: 1234.56 },
    { name: 'manual "1234"', aiOrManualInput: '1234', expected: 1234 },
    { name: 'edit "156662.00"', aiOrManualInput: '156662.00', expected: 156662 },
    { name: 'AI numeric 1234.56', aiOrManualInput: String(1234.56), expected: 1234.56 },
    { name: 'AI string "1.234"', aiOrManualInput: '1.234', expected: 1234 },
    { name: 'AI string "1.234,56"', aiOrManualInput: '1.234,56', expected: 1234.56 },
  ];

  for (const c of cases) {
    it(`${c.name} -> payload parses to ${c.expected}`, () => {
      const { internalValue } = formatAmountLive(c.aiOrManualInput);
      const result = prepareQuoteAmount(internalValue);
      assert.equal(result.ok, true, 'handleSave should accept the amount');
      assert.ok(result.ok);
      assert.equal(result.amountValue, internalValue, 'payload sends raw internal value');
      assert.equal(result.amountNum, c.expected, 'numeric value sent to backend');
    });
  }

  it('rejects empty / zero / negative / non-numeric amounts', () => {
    assert.equal(prepareQuoteAmount('').ok, false);
    assert.equal(prepareQuoteAmount('0').ok, false);
    assert.equal(prepareQuoteAmount('0.00').ok, false);
    assert.equal(prepareQuoteAmount('-5').ok, false);
    assert.equal(prepareQuoteAmount('abc').ok, false);
  });
});

describe('display and internal never desync (round-trip invariant)', () => {
  // The number derived from the visible display must equal parseFloat(internalValue).
  const inputs = ['1.234,56', '1234', '1234567', '156662.00', '1234.56', '1.234'];
  for (const input of inputs) {
    it(`round-trips "${input}"`, () => {
      const { displayValue, internalValue } = formatAmountLive(input);
      const fromDisplay = normalizeAmountInput(displayValue);
      const fromInternal = parseFloat(internalValue);
      assert.equal(fromDisplay, fromInternal, `"${displayValue}" vs "${internalValue}"`);
    });
  }
});
