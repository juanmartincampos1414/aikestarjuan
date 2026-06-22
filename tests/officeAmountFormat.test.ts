import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAmountLive,
  normalizeAmountInput,
} from '../client/src/lib/currency';

// These tests protect the live amount-formatting used by the other office.tsx
// forms (besides quotes), which already has its own coverage in
// tests/quoteAmountFormat.test.ts and is reused here.
//
// All of these forms (newFixedCost ~L1483, newUniquePayable ~L1970,
// editingCost ~L2164, newRecurringIncome ~L2465, newUniqueReceivable ~L2751,
// editingPending ~L2939) share the exact same controlled-input pattern:
//
//   onChange: const { displayValue, internalValue } =
//                 formatAmountLive(e.target.value, prevState.amount);
//             setDisplay(displayValue);
//             setState({ ...state, amount: internalValue });
//
// and every save handler sends `amount: state.amount` (the internalValue) in the
// payload, where the backend does the numeric parse. So the invariant each form
// must uphold is:
//   1. the amount stored in state == internalValue produced by formatAmountLive
//      (i.e. what is shown via displayValue and what is saved never desync), and
//   2. parseFloat(state.amount) == the numeric value the backend will receive.
//
// The edit flows (handleEditFixedCost ~L1072, handleEditPending ~L1124) seed the
// form by storing `amount: stored.toString()` and showing
// formatAmountLive(stored).displayValue, then re-format on subsequent edits.

// Simulates one controlled-input change for an amount field: feeds the previous
// internal value (= state.amount) like office.tsx does, and returns the new
// state the form would hold plus the numeric value the save handler would send.
function applyAmountChange(rawInput: string, previousInternal = '') {
  const { displayValue, internalValue } = formatAmountLive(rawInput, previousInternal);
  return {
    // what setEditingX/setNewX would store in state.amount
    stateAmount: internalValue,
    // what the input visibly shows (controlled display value)
    display: displayValue,
    // what the save handler sends: parseFloat over state.amount
    payloadNumeric: parseFloat(internalValue),
  };
}

// Simulates openEdit (handleEditFixedCost / handleEditPending): seed state from a
// stored amount, then return the form state + the display the input shows.
function openEditWithStoredAmount(stored: string | number) {
  const amountStr = stored.toString();
  const { displayValue } = formatAmountLive(amountStr);
  return {
    stateAmount: amountStr,
    display: displayValue,
    payloadNumeric: parseFloat(amountStr),
  };
}

const FORMS = [
  'newFixedCost (costos fijos)',
  'newRecurringIncome (ingresos recurrentes)',
  'newUniquePayable (a pagar)',
  'newUniqueReceivable (a cobrar)',
];

const MANUAL_CASES: Array<{ input: string; display: string; internal: string; numeric: number }> = [
  { input: '1.234,56', display: '1.234,56', internal: '1234.56', numeric: 1234.56 },
  { input: '1234', display: '1.234', internal: '1234', numeric: 1234 },
  { input: '1234567', display: '1.234.567', internal: '1234567', numeric: 1234567 },
  { input: '1.234,567', display: '1.234,56', internal: '1234.56', numeric: 1234.56 },
];

for (const formName of FORMS) {
  describe(`${formName} - manual entry keeps display/internal in sync and sends correct numeric`, () => {
    for (const c of MANUAL_CASES) {
      it(`"${c.input}" -> display "${c.display}", state.amount "${c.internal}", payload ${c.numeric}`, () => {
        const r = applyAmountChange(c.input);
        assert.equal(r.display, c.display, 'displayed value');
        assert.equal(r.stateAmount, c.internal, 'state.amount stored');
        assert.equal(r.payloadNumeric, c.numeric, 'numeric value sent to backend');
        // Display and stored value must agree numerically (no desync).
        assert.equal(normalizeAmountInput(r.display), r.payloadNumeric);
      });
    }

    it('builds up "1.234,56" incrementally without desync (feeding prev internal)', () => {
      let internal = '';
      const steps: Array<[string, string, string]> = [
        ['1', '1', '1'],
        ['12', '12', '12'],
        ['123', '123', '123'],
        ['1234', '1.234', '1234'],
        ['1234,5', '1.234,5', '1234.5'],
        ['1234,56', '1.234,56', '1234.56'],
      ];
      for (const [input, expDisplay, expInternal] of steps) {
        const r = applyAmountChange(input, internal);
        assert.equal(r.display, expDisplay, `display for "${input}"`);
        assert.equal(r.stateAmount, expInternal, `state.amount for "${input}"`);
        internal = r.stateAmount;
      }
    });

    it('empty input clears both display and state.amount', () => {
      const r = applyAmountChange('');
      assert.equal(r.display, '');
      assert.equal(r.stateAmount, '');
    });
  });
}

describe('editingCost (editor de costo fijo) - edit flow', () => {
  // Stored amounts come from the DB as decimal strings or numbers.
  const stored: Array<{ value: string | number; display: string; numeric: number }> = [
    { value: '156662.00', display: '156.662,00', numeric: 156662 },
    { value: '156662', display: '156.662', numeric: 156662 },
    { value: '1234.56', display: '1.234,56', numeric: 1234.56 },
    { value: 1234.56, display: '1.234,56', numeric: 1234.56 },
  ];

  for (const s of stored) {
    it(`openEdit seeds stored ${JSON.stringify(s.value)} -> display "${s.display}", payload ${s.numeric}`, () => {
      const r = openEditWithStoredAmount(s.value);
      assert.equal(r.display, s.display, 'editingCostDisplayAmount');
      assert.equal(r.payloadNumeric, s.numeric, 'parseFloat(editingCost.amount)');
      assert.equal(r.stateAmount, s.value.toString(), 'editingCost.amount stored');
    });
  }

  it('editing the seeded amount re-formats and keeps state.amount synced with display', () => {
    const seeded = openEditWithStoredAmount('156662.00');
    // User clears cents and types a new value; feed the previous internal value.
    const edited = applyAmountChange('200000', seeded.stateAmount);
    assert.equal(edited.display, '200.000');
    assert.equal(edited.stateAmount, '200000');
    assert.equal(edited.payloadNumeric, 200000);
    assert.equal(normalizeAmountInput(edited.display), edited.payloadNumeric);
  });
});

describe('editingPending (editor de pagos/cobros pendientes) - edit flow', () => {
  const stored: Array<{ value: string | number; display: string; numeric: number }> = [
    { value: '50000.00', display: '50.000,00', numeric: 50000 },
    { value: '50000', display: '50.000', numeric: 50000 },
    { value: '999.99', display: '999,99', numeric: 999.99 },
    { value: 999.99, display: '999,99', numeric: 999.99 },
  ];

  for (const s of stored) {
    it(`openEdit seeds stored ${JSON.stringify(s.value)} -> display "${s.display}", payload ${s.numeric}`, () => {
      const r = openEditWithStoredAmount(s.value);
      assert.equal(r.display, s.display, 'editingPendingDisplayAmount');
      assert.equal(r.payloadNumeric, s.numeric, 'parseFloat(editingPending.amount)');
      assert.equal(r.stateAmount, s.value.toString(), 'editingPending.amount stored');
    });
  }

  it('editing the seeded amount re-formats and keeps state.amount synced with display', () => {
    const seeded = openEditWithStoredAmount('50000.00');
    const edited = applyAmountChange('1.250.000,75', seeded.stateAmount);
    assert.equal(edited.display, '1.250.000,75');
    assert.equal(edited.stateAmount, '1250000.75');
    assert.equal(edited.payloadNumeric, 1250000.75);
    assert.equal(normalizeAmountInput(edited.display), edited.payloadNumeric);
  });
});

describe('round-trip invariant across all office amount inputs', () => {
  // The number derived from the visible display must equal parseFloat(state.amount)
  // for every form path (creators and editors share formatAmountLive).
  const inputs = ['1.234,56', '1234', '1234567', '156662.00', '1234.56', '1.234', '999,99'];
  for (const input of inputs) {
    it(`round-trips "${input}"`, () => {
      const { display, stateAmount } = applyAmountChange(input);
      const fromDisplay = normalizeAmountInput(display);
      const fromState = parseFloat(stateAmount);
      assert.equal(fromDisplay, fromState, `"${display}" vs "${stateAmount}"`);
    });
  }
});
