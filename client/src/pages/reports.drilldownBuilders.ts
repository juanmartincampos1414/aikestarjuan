import type { Transaction } from '@shared/schema';
import type { GenericDrillDownItem } from '@/components/DrillDownModal';
import { normalizeAmountInput } from '@/lib/currency';

export interface DrillDownPayload {
  open: true;
  title: string;
  formula?: string;
  formulaLines?: { label: string; value: string; isResult?: boolean; sign?: '+' | '-' | '=' }[];
  transactions?: Transaction[];
  groups?: { label: string; color: string; transactions: Transaction[] }[];
  genericItems?: GenericDrillDownItem[];
  genericItemsLabel?: string;
  totalLabel?: string;
  totalValue?: number;
  totalFormatted?: string;
}

export interface CcyHelpers {
  convertToSelected: (amount: number, ccy: string) => number;
  getAccountCurrency: (accountId: string | null) => string;
  formatCurrencyFull: (val: number) => string;
  // Task #476 — optional per-line código de rentabilidad distribution factor.
  // When provided, each transaction contributes only the share of its amount
  // that belongs to the lines using the selected code, keeping recomputed
  // drill-down totals (Flujo / Económico months) in lockstep with the chart
  // cards that already distribute. Defaults to 1 (no change) when omitted.
  codeAmountFactor?: (t: any) => number;
}

export function txCurrency(t: any, getAccountCurrency: (id: string | null) => string): string {
  return t.currency || getAccountCurrency(t.accountId) || 'ARS';
}

export function sumTxs(txs: Transaction[], h: CcyHelpers): number {
  return txs.reduce(
    (s, t: any) => {
      const factor = h.codeAmountFactor ? h.codeAmountFactor(t) : 1;
      return s + h.convertToSelected(normalizeAmountInput(t.amount), txCurrency(t, h.getAccountCurrency)) * factor;
    },
    0,
  );
}

// === Burn Rate (average per month). Card top = totalEgresos / periodMonths.
export function buildBurnRateDrillDown(opts: {
  allExpenses: Transaction[];
  totalEgresos: number;
  periodMonths: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  const { allExpenses, totalEgresos, periodMonths, formatCurrencyFull } = opts;
  const burnRate = totalEgresos / (periodMonths || 1);
  return {
    open: true,
    title: 'Burn Rate - Todos los egresos',
    formula: `Gasto total del período dividido ${periodMonths} mes(es)`,
    transactions: allExpenses,
    totalLabel: 'Burn Rate Promedio',
    totalValue: burnRate,
    totalFormatted: formatCurrencyFull(burnRate),
    formulaLines: [
      { label: 'Total egresos', value: formatCurrencyFull(totalEgresos) },
      { label: `÷ ${periodMonths} meses`, value: '' },
      { label: 'Burn Rate Promedio', value: formatCurrencyFull(burnRate), isResult: true },
    ],
  };
}

// === Flujo Neto (current/clicked month). Card top = income - expense.
export function buildFinancialBarDrillDown(opts: {
  monthName: string;
  monthTx: Transaction[];
  helpers: CcyHelpers;
}): DrillDownPayload {
  const { monthName, monthTx, helpers } = opts;
  const completedTx = monthTx.filter((t: any) => t.status === 'completed');
  const incomeTx = completedTx.filter((t: any) => t.type === 'income');
  const expenseTx = completedTx.filter((t: any) => t.type === 'expense');
  const incomeTotal = sumTxs(incomeTx, helpers);
  const expenseTotal = sumTxs(expenseTx, helpers);
  const neto = incomeTotal - expenseTotal;
  const f = helpers.formatCurrencyFull;
  return {
    open: true,
    title: `Movimientos de ${monthName}`,
    formula: 'Flujo de caja: Ingresos cobrados menos Egresos pagados',
    formulaLines: [
      { label: 'Ingresos', value: f(incomeTotal), sign: '+' },
      { label: 'Egresos', value: f(expenseTotal), sign: '-' },
      { label: 'Flujo Neto', value: f(neto), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ingresos', color: 'bg-cyan-500', transactions: incomeTx },
      { label: 'Egresos', color: 'bg-purple-500', transactions: expenseTx },
    ],
    totalLabel: 'Flujo Neto',
    totalValue: neto,
    totalFormatted: f(neto),
  };
}

// === Economic monthly P&L (clicked month).
export function buildEconomicChartDrillDown(opts: {
  monthName: string;
  monthTx: Transaction[];
  helpers: CcyHelpers;
}): DrillDownPayload {
  const { monthName, monthTx, helpers } = opts;
  const ventasTx = monthTx.filter((t: any) => t.type === 'income' || t.type === 'receivable');
  const costosTx = monthTx.filter((t: any) => (t.type === 'expense' || t.type === 'payable') && t.expenseSubtype === 'cost');
  const gastosTx = monthTx.filter((t: any) => (t.type === 'expense' || t.type === 'payable') && t.expenseSubtype !== 'cost');
  const ventasTotal = sumTxs(ventasTx, helpers);
  const costosTotal = sumTxs(costosTx, helpers);
  const gastosTotal = sumTxs(gastosTx, helpers);
  const resultado = ventasTotal - costosTotal - gastosTotal;
  const f = helpers.formatCurrencyFull;
  return {
    open: true,
    title: `P&L de ${monthName}`,
    formula: 'Resultado = Ventas - Costos - Gastos (por fecha de imputación)',
    formulaLines: [
      { label: 'Ventas', value: f(ventasTotal), sign: '+' },
      { label: 'Costos', value: f(costosTotal), sign: '-' },
      { label: 'Gastos', value: f(gastosTotal), sign: '-' },
      { label: 'Resultado', value: f(resultado), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ventas', color: 'bg-cyan-500', transactions: ventasTx },
      { label: 'Costos', color: 'bg-orange-500', transactions: costosTx },
      { label: 'Gastos', color: 'bg-rose-500', transactions: gastosTx },
    ],
    totalLabel: 'Resultado',
    totalValue: resultado,
    totalFormatted: f(resultado),
  };
}

// === P&L cards: Ventas / Costos / Gastos (single-list cards).
export function buildVentasDrillDown(opts: {
  ventasTx: Transaction[];
  totalVentas: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Ventas (por imputación)',
    formula: 'Ingresos + Cuentas a cobrar del período',
    transactions: opts.ventasTx,
    totalLabel: 'Total Ventas',
    totalValue: opts.totalVentas,
    totalFormatted: opts.formatCurrencyFull(opts.totalVentas),
  };
}

export function buildCostosDrillDown(opts: {
  costosTx: Transaction[];
  totalCostos: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Costos',
    formula: 'Egresos clasificados como Costo de producción',
    transactions: opts.costosTx,
    totalLabel: 'Total Costos',
    totalValue: opts.totalCostos,
    totalFormatted: opts.formatCurrencyFull(opts.totalCostos),
  };
}

export function buildGastosDrillDown(opts: {
  gastosTx: Transaction[];
  totalGastos: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Gastos Operativos',
    formula: 'Egresos clasificados como Gastos (no producción)',
    transactions: opts.gastosTx,
    totalLabel: 'Total Gastos',
    totalValue: opts.totalGastos,
    totalFormatted: opts.formatCurrencyFull(opts.totalGastos),
  };
}

// === IVA discriminado en facturas (Débito / Crédito / Saldo).
// Muestra el IVA acumulado tomado del campo invoiceIvaAmount de cada
// transacción que tiene factura cargada (emitida o registrada).
export function buildIvaDrillDown(opts: {
  title: string;
  formula: string;
  transactions: Transaction[];
  totalLabel: string;
  totalValue: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: opts.title,
    formula: opts.formula,
    transactions: opts.transactions,
    totalLabel: opts.totalLabel,
    totalValue: opts.totalValue,
    totalFormatted: opts.formatCurrencyFull(opts.totalValue),
  };
}

export function buildSaldoIvaDrillDown(opts: {
  ivaDebitoTx: Transaction[];
  ivaCreditoTx: Transaction[];
  totalDebito: number;
  totalCredito: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  const saldo = opts.totalDebito - opts.totalCredito;
  const f = opts.formatCurrencyFull;
  return {
    open: true,
    title: 'Saldo de IVA del período',
    formula: 'IVA Débito (ventas) menos IVA Crédito (compras/gastos)',
    formulaLines: [
      { label: 'IVA Débito Fiscal', value: f(opts.totalDebito), sign: '+' },
      { label: 'IVA Crédito Fiscal', value: f(opts.totalCredito), sign: '-' },
      { label: saldo >= 0 ? 'Saldo a pagar' : 'Saldo a favor', value: f(Math.abs(saldo)), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'IVA Débito (ventas)', color: 'bg-cyan-500', transactions: opts.ivaDebitoTx },
      { label: 'IVA Crédito (compras)', color: 'bg-orange-500', transactions: opts.ivaCreditoTx },
    ],
    totalLabel: saldo >= 0 ? 'Saldo a pagar' : 'Saldo a favor',
    totalValue: saldo,
    totalFormatted: f(saldo),
  };
}

// === P&L grouped cards: Margen Bruto / Resultado.
export function buildMargenBrutoDrillDown(opts: {
  ventasTx: Transaction[];
  costosTx: Transaction[];
  totalVentas: number;
  totalCostos: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  const margenBruto = opts.totalVentas - opts.totalCostos;
  const f = opts.formatCurrencyFull;
  return {
    open: true,
    title: 'Margen Bruto',
    formula: 'Ventas menos Costos directos',
    formulaLines: [
      { label: 'Ventas', value: f(opts.totalVentas), sign: '+' },
      { label: 'Costos', value: f(opts.totalCostos), sign: '-' },
      { label: 'Margen Bruto', value: f(margenBruto), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ventas', color: 'bg-cyan-500', transactions: opts.ventasTx },
      { label: 'Costos', color: 'bg-orange-500', transactions: opts.costosTx },
    ],
    totalValue: margenBruto,
    totalFormatted: f(margenBruto),
  };
}

// === Account-balance cards (Patrimonio Operativo / Patrimonio en Inversiones)
// Card top is a precomputed balance number; the modal lists the underlying
// accounts. We pass totalValue explicitly so the modal can never recompute a
// different number from the items list.
export function buildPatrimonioOperativoDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Patrimonio Operativo',
    formula: 'Suma de saldos de cuentas operativas',
    genericItems: opts.items,
    genericItemsLabel: 'Cuentas operativas',
    totalLabel: 'Total Operativo',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

export function buildPatrimonioInversionesDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Patrimonio en Inversiones',
    formula: 'Cuentas de inversión + rendimiento acumulado',
    genericItems: opts.items,
    genericItemsLabel: 'Cuentas de inversión',
    totalLabel: 'Total Inversiones',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

// === Activos Físicos (sidebar) — assets + product-assets at book value.
export function buildActivosFisicosDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Activos Físicos (Valor Libros)',
    formula: 'Costo de adquisición menos depreciación acumulada',
    genericItems: opts.items,
    genericItemsLabel: 'Activos',
    totalLabel: 'Total Activos',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

// === Inversiones (Valor Actual) — investments + investment accounts.
export function buildInversionesValorActualDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Inversiones (Valor Actual)',
    formula: 'Acciones, bonos, cuentas de inversión y otros activos financieros',
    genericItems: opts.items,
    genericItemsLabel: 'Inversiones',
    totalLabel: 'Total Inversiones',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

// === Valoración Total — top-level company valuation card.
export function buildValoracionTotalDrillDown(opts: {
  items: GenericDrillDownItem[];
  ebitda: number;
  assetsBookValue: number;
  investmentsValue: number;
  totalValuation: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  const f = opts.formatValue;
  return {
    open: true,
    title: 'Valor Estimado de la Empresa',
    formula: 'EBITDA + Valor Libros Activos + Inversiones',
    formulaLines: [
      { label: 'EBITDA (Ingresos - Gastos Op.)', value: f(opts.ebitda), sign: '+' },
      { label: 'Activos Físicos (Valor Libros)', value: f(opts.assetsBookValue), sign: '+' },
      { label: 'Inversiones (Valor Actual)', value: f(opts.investmentsValue), sign: '+' },
      { label: 'Valoración Total', value: f(opts.totalValuation), isResult: true, sign: '=' },
    ],
    genericItems: opts.items,
    genericItemsLabel: 'Componentes de la valoración',
    totalLabel: 'Valoración Total',
    totalValue: opts.totalValuation,
    totalFormatted: f(opts.totalValuation),
  };
}

// === EBITDA (bloque Valoración) — used by both the EBITDA card and the
// EBITDA sidebar row. Card top = totalRevenue − totalExpenses.
export function buildValuationEbitdaDrillDown(opts: {
  revTx: Transaction[];
  expTx: Transaction[];
  totalRevenue: number;
  totalExpenses: number;
  ebitda: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  const f = opts.formatValue;
  return {
    open: true,
    title: 'EBITDA',
    formula: 'Ingresos menos Gastos Operativos (excl. adquisiciones)',
    formulaLines: [
      { label: 'Ingresos', value: f(opts.totalRevenue), sign: '+' },
      { label: 'Gastos Operativos', value: f(opts.totalExpenses), sign: '-' },
      { label: 'EBITDA', value: f(opts.ebitda), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ingresos', color: 'bg-cyan-500', transactions: opts.revTx },
      { label: 'Gastos Operativos', color: 'bg-rose-500', transactions: opts.expTx },
    ],
    totalLabel: 'EBITDA',
    totalValue: opts.ebitda,
    totalFormatted: f(opts.ebitda),
  };
}

// === Disponibilidad Operativa (financial tab top card) — sums saldos
// of operative accounts. Card top is the precomputed converted balance.
export function buildOperativeAvailabilityDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Disponibilidad Operativa',
    formula: 'Suma de saldos de todas las cuentas operativas',
    genericItems: opts.items,
    genericItemsLabel: 'Cuentas operativas',
    totalLabel: 'Total Operativo',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatCurrencyFull(opts.totalValue),
  };
}

// === Inversiones (financial tab card) — sums saldos of investment accounts
// + accrued interest. Card top is the precomputed converted balance.
export function buildFinancialInvestmentsDrillDown(opts: {
  items: GenericDrillDownItem[];
  totalValue: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Inversiones',
    formula: 'Cuentas de inversión + rendimiento acumulado',
    genericItems: opts.items,
    genericItemsLabel: 'Cuentas de inversión',
    totalLabel: 'Total Inversiones',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatCurrencyFull(opts.totalValue),
  };
}

// === Costos (Valoración) — Costo subtype expenses. Card top is the
// precomputed converted total in the selected currency.
export function buildValuationCostosDrillDown(opts: {
  costosTx: Transaction[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Costos (Valoración)',
    formula: 'Costos de producción del período',
    transactions: opts.costosTx,
    totalLabel: 'Total Costos',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

// === Gastos Operativos (Valoración) — non-Costo expenses.
export function buildValuationGastosDrillDown(opts: {
  gastosTx: Transaction[];
  totalValue: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: 'Gastos Operativos (Valoración)',
    formula: 'Gastos no productivos del período',
    transactions: opts.gastosTx,
    totalLabel: 'Total Gastos',
    totalValue: opts.totalValue,
    totalFormatted: opts.formatValue(opts.totalValue),
  };
}

// === Margen Bruto (Valoración) — totalRevenue - totalCosts.
export function buildValuationMargenBrutoDrillDown(opts: {
  revTx: Transaction[];
  costTx: Transaction[];
  totalRevenue: number;
  totalCosts: number;
  margenBruto: number;
  formatValue: (val: number) => string;
}): DrillDownPayload {
  const f = opts.formatValue;
  return {
    open: true,
    title: 'Margen Bruto (Valoración)',
    formula: 'Ingresos totales menos Costos directos',
    formulaLines: [
      { label: 'Ingresos', value: f(opts.totalRevenue), sign: '+' },
      { label: 'Costos', value: f(opts.totalCosts), sign: '-' },
      { label: 'Margen Bruto', value: f(opts.margenBruto), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ingresos', color: 'bg-cyan-500', transactions: opts.revTx },
      { label: 'Costos', color: 'bg-orange-500', transactions: opts.costTx },
    ],
    totalValue: opts.margenBruto,
    totalFormatted: f(opts.margenBruto),
  };
}

// === Gastos por categoría — drill-down from expensesByCategory bar/click.
// Card top equals the converted sum of all transactions in that category.
export function buildExpenseCategoryDrillDown(opts: {
  categoryName: string;
  categoryTx: Transaction[];
  totalValue: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  return {
    open: true,
    title: `Gastos: ${opts.categoryName}`,
    formula: `Todos los egresos en la categoría "${opts.categoryName}"`,
    transactions: opts.categoryTx,
    totalLabel: `Total ${opts.categoryName}`,
    totalValue: opts.totalValue,
    totalFormatted: opts.formatCurrencyFull(opts.totalValue),
  };
}

// === Por miembro del equipo (Task #202)
// Card top = Ingresos − Egresos del miembro en el período. Mismas reglas
// de exclusión que el resto de Reportes (los inputs ya vienen filtrados
// por los selectores selectIngresosRows / selectAllExpensesRows aplicados
// SIN el filtro global de miembro, y luego restringidos al miembro
// específico por el llamador). El builder sólo arma el payload del modal.
export function buildMemberDrillDown(opts: {
  memberLabel: string;
  ingresosTx: Transaction[];
  egresosTx: Transaction[];
  totalIngresos: number;
  totalEgresos: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  const neto = opts.totalIngresos - opts.totalEgresos;
  const f = opts.formatCurrencyFull;
  return {
    open: true,
    title: `Movimientos de ${opts.memberLabel}`,
    formula: 'Ingresos menos Egresos cargados por este miembro en el período',
    formulaLines: [
      { label: 'Ingresos', value: f(opts.totalIngresos), sign: '+' },
      { label: 'Egresos', value: f(opts.totalEgresos), sign: '-' },
      { label: 'Neto', value: f(neto), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ingresos', color: 'bg-cyan-500', transactions: opts.ingresosTx },
      { label: 'Egresos', color: 'bg-rose-500', transactions: opts.egresosTx },
    ],
    totalLabel: 'Neto',
    totalValue: neto,
    totalFormatted: f(neto),
  };
}

export function buildResultadoDrillDown(opts: {
  ventasTx: Transaction[];
  costosTx: Transaction[];
  gastosTx: Transaction[];
  totalVentas: number;
  totalCostos: number;
  totalGastos: number;
  formatCurrencyFull: (val: number) => string;
}): DrillDownPayload {
  const resultado = opts.totalVentas - opts.totalCostos - opts.totalGastos;
  const f = opts.formatCurrencyFull;
  return {
    open: true,
    title: 'Resultado Neto',
    formula: 'Ventas menos Costos menos Gastos',
    formulaLines: [
      { label: 'Ventas', value: f(opts.totalVentas), sign: '+' },
      { label: 'Costos', value: f(opts.totalCostos), sign: '-' },
      { label: 'Gastos', value: f(opts.totalGastos), sign: '-' },
      { label: 'Resultado Neto', value: f(resultado), isResult: true, sign: '=' },
    ],
    groups: [
      { label: 'Ventas', color: 'bg-cyan-500', transactions: opts.ventasTx },
      { label: 'Costos', color: 'bg-orange-500', transactions: opts.costosTx },
      { label: 'Gastos', color: 'bg-rose-500', transactions: opts.gastosTx },
    ],
    totalLabel: 'Resultado Neto',
    totalValue: resultado,
    totalFormatted: f(resultado),
  };
}
