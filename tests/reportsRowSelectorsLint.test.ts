import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task #199 / Task #200 — guardrail test that prevents anyone from
// re-introducing inline filter predicates (`buildReportableTxFilter` +
// `transactions.filter` + asset type / expenseSubtype branches) inside an
// onClick handler in reports.tsx.
//
// The contract is simple:
//   ✓ Every drill-down handler must obtain its row list from the shared
//     selectors module `client/src/pages/reports.rowSelectors.ts`.
//   ✗ No onClick handler may build its own `buildReportableTxFilter(...)`,
//     mention `asset_acquisition`, or filter `transactions` directly.
//   ✓ Task #200 — the wrappers `getIncludedTxByType` and
//     `getMonthTransactions` (used by Económico, Flujo, Burn Rate handlers)
//     also delegate to the shared selectors, so the guardrail covers the
//     whole Reports page and not just the Valoración block.
//
// We verify this by extracting every `onClick={() => { ... }}` body via
// brace matching and inspecting it. If a regression slips in (the same kind
// of bug Task #175 already had to fix once), this test fails with a precise
// message pointing at the offending handler.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPORTS_TSX = join(__dirname, '..', 'client', 'src', 'pages', 'reports.tsx');

interface OnClickHandler {
  startIndex: number;
  body: string;
  testId: string | null;
}

function extractOnClickHandlers(source: string): OnClickHandler[] {
  const handlers: OnClickHandler[] = [];
  const opener = 'onClick={() => {';
  let cursor = 0;
  while (true) {
    const idx = source.indexOf(opener, cursor);
    if (idx === -1) break;
    let depth = 1;
    let i = idx + opener.length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = source.slice(idx + opener.length, i - 1);
    // Try to associate a nearby data-testid for a better error message.
    const tail = source.slice(i, Math.min(i + 600, source.length));
    const m = tail.match(/data-testid="([^"]+)"/);
    handlers.push({ startIndex: idx, body, testId: m ? m[1] : null });
    cursor = i;
  }
  return handlers;
}

function lineNumberOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

describe('Task #199 — reports.tsx onClick handlers must not contain inline row-filter predicates', () => {
  const source = readFileSync(REPORTS_TSX, 'utf8');
  const handlers = extractOnClickHandlers(source);

  it('finds onClick handlers to inspect (sanity check)', () => {
    assert.ok(handlers.length > 5, `expected to find several onClick handlers, got ${handlers.length}`);
  });

  it('no onClick handler instantiates buildReportableTxFilter directly', () => {
    const offenders = handlers.filter(h => h.body.includes('buildReportableTxFilter'));
    if (offenders.length > 0) {
      const list = offenders.map(h =>
        `  - line ${lineNumberOf(source, h.startIndex)} (${h.testId ?? 'unknown handler'})`,
      ).join('\n');
      assert.fail(
        `Found ${offenders.length} onClick handler(s) that build buildReportableTxFilter inline.\n`
        + `Use the shared selectors in client/src/pages/reports.rowSelectors.ts instead.\n`
        + list,
      );
    }
  });

  it('no onClick handler filters `transactions` directly (must go through a shared selector)', () => {
    // Stronger guardrail: no onClick handler may call `transactions.filter`
    // for any reason. The whole point of the row selectors module is that
    // every drill-down row list is built there, not inline. Bare period /
    // type filters belong in selectors too so the lint can keep up as new
    // selectors are added (e.g. period-scoped Económico variants).
    const offenders = handlers.filter(h => h.body.includes('transactions.filter'));
    if (offenders.length > 0) {
      const list = offenders.map(h =>
        `  - line ${lineNumberOf(source, h.startIndex)} (${h.testId ?? 'unknown handler'})`,
      ).join('\n');
      assert.fail(
        `Found ${offenders.length} onClick handler(s) that filter \`transactions\` inline.\n`
        + `Use a shared row selector from client/src/pages/reports.rowSelectors.ts instead\n`
        + `(selectCostosRows / selectGastosRows / selectAllExpensesRows / selectIngresosRows / selectCategoryRows / pickCostSubtype / pickGastoSubtype),\n`
        + `or extend that module if a new bucket is needed.\n`
        + list,
      );
    }
  });

  it('the Valoración and sidebar EBITDA handlers exist and reference the shared selectors', () => {
    // Spot-check the handlers explicitly named in Task #199 — Costos, Gastos,
    // Margen Bruto, EBITDA (card + sidebar), Categorías. Each must use one
    // of the shared selectors.
    const requiredTestIds = [
      'card-valuation-costos',
      'card-valuation-gastos',
      'card-valuation-margen',
      'card-valuation-ebitda',
      'sidebar-ebitda',
    ];
    for (const id of requiredTestIds) {
      const handler = handlers.find(h => h.testId === id);
      assert.ok(handler, `expected an onClick handler with data-testid="${id}"`);
      const usesSelector = /select(Costos|Gastos|AllExpenses|Ingresos|Category)Rows/.test(handler!.body);
      assert.ok(
        usesSelector,
        `handler "${id}" (line ${lineNumberOf(source, handler!.startIndex)}) does not invoke any shared row selector. `
        + `Use selectCostosRows / selectGastosRows / selectAllExpensesRows / selectIngresosRows / selectCategoryRows.`,
      );
    }
  });

  it('handlePieClick (Categorías pie) uses selectCategoryRows and not an inline category filter', () => {
    // handlePieClick is a top-level useCallback rather than an inline JSX
    // arrow, so we look for it by name and scan its body.
    const startMarker = 'const handlePieClick = useCallback((_: any, index: number) => {';
    const start = source.indexOf(startMarker);
    assert.ok(start !== -1, 'expected to find handlePieClick definition');
    let depth = 1;
    let i = start + startMarker.length;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = source.slice(start + startMarker.length, i - 1);
    assert.ok(body.includes('selectCategoryRows'), 'handlePieClick must use selectCategoryRows');
    assert.ok(!body.includes('buildReportableTxFilter'),
      'handlePieClick must not build buildReportableTxFilter inline');
    assert.ok(!body.includes('transactions.filter'),
      'handlePieClick must not filter `transactions` inline');
  });

  // === Task #200 spot-checks for Económico / Flujo / Burn Rate handlers ===
  // Same shape as the Valoración spot-checks above. Every cash-flow / P&L
  // handler must reference one of the shared selectors (directly via a
  // `select*Rows`/`pickCostSubtype`/`pickGastoSubtype` call, or transitively
  // through the `getIncludedTxByType` / `getMonthTransactions` wrappers
  // — both of which the next test forces to delegate to selectors).
  const ECONOMIC_FLOW_HANDLER_IDS = [
    'card-financial-burnrate', // Burn Rate — getIncludedTxByType('expense')
    'card-pl-ventas',          // Ventas (P&L) — getIncludedTxByType + builder
    'card-pl-costos',          // Costos (P&L) — pickCostSubtype(getIncludedTxByType)
    'card-pl-gastos',          // Gastos (P&L) — pickGastoSubtype(getIncludedTxByType)
    'card-pl-margen',          // Margen Bruto (P&L)
    'card-pl-resultado',       // Resultado Neto (P&L)
  ];
  const SHARED_SELECTOR_PATTERN = /(select(IncludedTxByType|MonthRows|Costos|Gastos|AllExpenses|Ingresos|Category)Rows?|pickCostSubtype|pickGastoSubtype|getIncludedTxByType|getMonthTransactions)/;
  it('Económico / Flujo / Burn Rate handlers exist and source rows from the shared selectors', () => {
    for (const id of ECONOMIC_FLOW_HANDLER_IDS) {
      const handler = handlers.find(h => h.testId === id);
      assert.ok(handler, `expected an onClick handler with data-testid="${id}"`);
      assert.ok(
        SHARED_SELECTOR_PATTERN.test(handler!.body),
        `handler "${id}" (line ${lineNumberOf(source, handler!.startIndex)}) must source its row list `
        + `from a shared row selector (select*Rows / pickCostSubtype / pickGastoSubtype) `
        + `or through getIncludedTxByType / getMonthTransactions (which themselves go through the selectors).`,
      );
    }
  });

  // === Task #200 — the period-aware wrappers must delegate to the shared
  // selector module. If a future refactor inlines `transactions.filter` or
  // `buildReportableTxFilter` back into these helpers, the Económico / Flujo
  // handlers (which call them) would silently start filtering "off-grid"
  // again. This test pins them to the shared selectors.
  function extractTopLevelHelper(name: string): string {
    const marker = `const ${name} = useCallback(`;
    const start = source.indexOf(marker);
    assert.ok(start !== -1, `expected to find a useCallback for ${name}`);
    // Walk to the opening `{` of the arrow body, then brace-match.
    let i = start + marker.length;
    while (i < source.length && source[i] !== '{') i++;
    assert.ok(i < source.length, `expected an arrow body for ${name}`);
    const bodyStart = i + 1;
    let depth = 1;
    i = bodyStart;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return source.slice(bodyStart, i - 1);
  }

  it('getIncludedTxByType delegates to selectIncludedTxByType (no inline reportable / filter)', () => {
    const body = extractTopLevelHelper('getIncludedTxByType');
    assert.ok(body.includes('selectIncludedTxByType'),
      'getIncludedTxByType must delegate to selectIncludedTxByType from rowSelectors');
    assert.ok(!body.includes('buildReportableTxFilter'),
      'getIncludedTxByType must not build buildReportableTxFilter inline; the selector module owns it');
    assert.ok(!body.includes('transactions.filter'),
      'getIncludedTxByType must not call transactions.filter directly');
  });

  it('getMonthTransactions delegates to selectMonthRows (no inline reportable / filter)', () => {
    const body = extractTopLevelHelper('getMonthTransactions');
    assert.ok(body.includes('selectMonthRows'),
      'getMonthTransactions must delegate to selectMonthRows from rowSelectors');
    assert.ok(!body.includes('buildReportableTxFilter'),
      'getMonthTransactions must not build buildReportableTxFilter inline; the selector module owns it');
    assert.ok(!body.includes('transactions.filter'),
      'getMonthTransactions must not call transactions.filter directly');
  });

  // === Task #201 — extend the guardrail to JSX-level IIFEs.
  // The Económico tab renders its "Cuentas a Pagar" / "Cuentas a Cobrar"
  // lists inside `(() => { ... })()` blocks rather than onClick handlers.
  // Without this check, anyone could re-introduce
  // `transactions.filter((t) => t.type === 'payable' && t.status === 'scheduled')`
  // and silently bypass the global exclusion rules. Scanning every IIFE
  // body in reports.tsx keeps the page-wide invariant honest.
  function extractIifeBodies(src: string): { startIndex: number; body: string }[] {
    // True IIFEs only: `(() => { ... })()`. We brace-match the body and
    // then require the closing `})()` so we don't accidentally pick up
    // `useMemo(() => { ... })` / `useCallback(() => { ... })` callbacks.
    const bodies: { startIndex: number; body: string }[] = [];
    const opener = '(() => {';
    let cursor = 0;
    while (true) {
      const idx = src.indexOf(opener, cursor);
      if (idx === -1) break;
      let depth = 1;
      let i = idx + opener.length;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      // After brace-match, `i` sits one past the closing `}`. For an IIFE
      // we expect `)()` immediately after — the closing wrapper paren and
      // the empty call-site arg list.
      if (src.slice(i, i + 3) === ')()') {
        bodies.push({ startIndex: idx, body: src.slice(idx + opener.length, i - 1) });
      }
      cursor = i;
    }
    return bodies;
  }

  it('no IIFE in reports.tsx filters `transactions` inline (must go through a shared selector)', () => {
    const bodies = extractIifeBodies(source);
    assert.ok(bodies.length > 0, 'expected to find at least one IIFE in reports.tsx');
    const offenders = bodies.filter(b =>
      b.body.includes('transactions.filter') || b.body.includes('buildReportableTxFilter'),
    );
    if (offenders.length > 0) {
      const list = offenders.map(o => `  - line ${lineNumberOf(source, o.startIndex)}`).join('\n');
      assert.fail(
        `Found ${offenders.length} IIFE(s) that filter \`transactions\` (or build buildReportableTxFilter) inline.\n`
        + `Use a shared row selector from client/src/pages/reports.rowSelectors.ts instead\n`
        + `(e.g. selectPendingPayables / selectPendingReceivables / selectIncludedTxByType / selectMonthRows),\n`
        + `or extend that module if a new bucket is needed.\n`
        + list,
      );
    }
  });

  // === Task #202 — el bloque "Por miembro del equipo" debe alimentarse
  // exclusivamente de los selectores compartidos para heredar las mismas
  // exclusiones (cancelados, espejos [CANCELACIÓN], transferencias,
  // out-of-scope, código de rentabilidad, miembro). Si alguien refactorea y
  // mete un transactions.filter inline ahí, este check lo bloquea.
  it('Task #202 — el IIFE del bloque "Por miembro del equipo" usa selectIngresosRows / selectAllExpensesRows', () => {
    const bodies = extractIifeBodies(source);
    const block = bodies.find(b => b.body.includes('card-by-member') || b.body.includes('grid-by-member'));
    assert.ok(block, 'expected to find the "Por miembro del equipo" IIFE in reports.tsx');
    assert.ok(block!.body.includes('selectIngresosRows'),
      'el bloque por miembro debe sourcear ingresos vía selectIngresosRows');
    assert.ok(block!.body.includes('selectAllExpensesRows'),
      'el bloque por miembro debe sourcear gastos vía selectAllExpensesRows');
    // Y el card debe terminar invocando el builder centralizado
    assert.ok(block!.body.includes('buildMemberDrillDown'),
      'el drill-down de las tarjetas por miembro debe usar buildMemberDrillDown');
  });

  it('the Cuentas a Pagar / Cobrar IIFE uses selectPendingPayables / selectPendingReceivables', () => {
    // Pin the specific block called out by Task #201 so the migration
    // can't be silently undone (e.g. someone re-introducing inline type
    // filters but spelling them differently). We look for the IIFE that
    // declares `pendingPayables` and verify it sources both lists from
    // the shared selectors.
    const bodies = extractIifeBodies(source);
    const block = bodies.find(b => b.body.includes('pendingPayables') && b.body.includes('pendingReceivables'));
    assert.ok(block, 'expected to find the Cuentas a Pagar / Cobrar IIFE in reports.tsx');
    assert.ok(block!.body.includes('selectPendingPayables'),
      'Cuentas a Pagar IIFE must source its rows from selectPendingPayables');
    assert.ok(block!.body.includes('selectPendingReceivables'),
      'Cuentas a Cobrar IIFE must source its rows from selectPendingReceivables');
  });
});
