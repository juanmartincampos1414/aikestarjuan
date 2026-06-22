import type { Express } from "express";
import { z } from "zod";
import * as XLSX from "xlsx";
import { storage } from "../storage";
import { db } from "../db";
import { transactions, clients, suppliers, upsertTaxProfileSchema, invoiceNumberChangeError } from "@shared/schema";
import { and, eq, gte, lte, asc, desc, inArray, isNotNull, or, sql } from "drizzle-orm";
import { requireAuth, requirePermission, sanitizeError } from "./middleware";

const filterSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  currency: z.string().optional(),
  invoiceType: z.string().optional(),
  aliquot: z.string().optional(),
  counterpartyId: z.string().optional(),
  status: z.string().optional(),
  hasAttachment: z.string().optional(),
  origin: z.string().optional(),
  includeSimulated: z.string().optional(),
  // When 'true', filas con emisión electrónica fallida (intento de emitir
  // por Facturita pero sin CAE ni anulación) se excluyen de las tablas y
  // totales. Usado para que el saldo IVA no se infle con facturas que no
  // llegaron a AFIP/ARCA.
  excludeUnemitted: z.string().optional(),
});

function parseLocalDate(val: string): Date {
  const parts = val.split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
  }
  return new Date(val);
}

function num(v: any): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Array<Record<string, any>>, headers: Array<{ key: string; label: string }>): string {
  const headerRow = headers.map(h => csvEscape(h.label)).join(',');
  const dataRows = rows.map(r => headers.map(h => csvEscape(r[h.key])).join(','));
  return [headerRow, ...dataRows].join('\n');
}

function sendCsv(res: any, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel detects UTF-8
  res.send('\uFEFF' + csv);
}

async function getTaxRows(
  orgId: string,
  params: {
    type: 'income' | 'expense';
    startDate?: string;
    endDate?: string;
    currency?: string;
    invoiceType?: string;
    aliquot?: string;
    counterpartyId?: string;
    status?: string;
    hasAttachment?: string;
    origin?: string;
    includeSimulated?: string;
    excludeUnemitted?: string;
  }
) {
  const conds: any[] = [
    eq(transactions.organizationId, orgId),
    eq(transactions.type, params.type),
  ];
  // Only invoice-bearing transactions belong in the fiscal report.
  conds.push(or(eq(transactions.hasInvoice, true), isNotNull(transactions.invoiceNumber))!);
  // Status: completed by default. Allow caller to opt into "all" or specific status.
  if (params.status && params.status !== 'all') {
    conds.push(eq(transactions.status, params.status as any));
  } else if (!params.status) {
    conds.push(eq(transactions.status, 'completed'));
  }
  if (params.startDate) conds.push(gte(transactions.imputationDate, parseLocalDate(params.startDate)));
  if (params.endDate) conds.push(lte(transactions.imputationDate, parseLocalDate(params.endDate)));
  if (params.currency) conds.push(eq(transactions.currency, params.currency));
  if (params.invoiceType) conds.push(eq(transactions.invoiceType, params.invoiceType));
  if (params.aliquot) conds.push(eq(transactions.invoiceIvaAliquot, params.aliquot));
  if (params.counterpartyId) {
    // La contraparte puede estar guardada como cliente o como proveedor,
    // independientemente del tipo de movimiento (un gasto puede tener cliente).
    conds.push(or(
      eq(transactions.clientId, params.counterpartyId),
      eq(transactions.supplierId, params.counterpartyId),
    )!);
  }
  if (params.hasAttachment === 'with') conds.push(isNotNull(transactions.invoiceFileUrl));
  if (params.hasAttachment === 'without') conds.push(sql`${transactions.invoiceFileUrl} IS NULL`);
  if (params.origin) conds.push(eq(transactions.createdVia, params.origin));
  // Exclude simulated invoices by default (they have no fiscal validity).
  if (params.includeSimulated !== 'true') {
    conds.push(or(eq(transactions.invoiceSimulated, false), sql`${transactions.invoiceSimulated} IS NULL`)!);
  }

  const txsRaw = await db.select().from(transactions).where(and(...conds)).orderBy(asc(transactions.imputationDate));
  // Excluir facturas anuladas por nota de crédito: su IVA está compensado por
  // la NC y no debe sumar al período. Se siguen pudiendo ver en Oficina → Facturas
  // (con badge "Anulada"), pero acá no aportan al cálculo de IVA Débito/Crédito.
  const txs = txsRaw.filter(t => !(t as any).invoiceCreditNoteUuid);

  // Resolve clients/suppliers names
  const clientIds = Array.from(new Set(txs.map(t => t.clientId).filter(Boolean))) as string[];
  const supplierIds = Array.from(new Set(txs.map(t => t.supplierId).filter(Boolean))) as string[];

  const [cls, sups] = await Promise.all([
    clientIds.length
      ? db.select().from(clients).where(and(inArray(clients.id, clientIds), eq(clients.organizationId, orgId)))
      : Promise.resolve([] as any[]),
    supplierIds.length
      ? db.select().from(suppliers).where(and(inArray(suppliers.id, supplierIds), eq(suppliers.organizationId, orgId)))
      : Promise.resolve([] as any[]),
  ]);
  const clientMap = new Map(cls.map(c => [c.id, c]));
  const supplierMap = new Map(sups.map(s => [s.id, s]));

  const mapped = txs.map(t => {
    const total = num(t.amount);
    const net = num(t.invoiceNetAmount);
    const iva = num(t.invoiceIvaAmount);
    const aliq = num(t.invoiceIvaAliquot);
    const other = num(t.invoiceOtherTaxes);
    // Fallbacks: if no fiscal data but has total, leave net/iva 0 (informational)
    const counterparty = t.clientId ? clientMap.get(t.clientId) : t.supplierId ? supplierMap.get(t.supplierId) : null;
    // Estado de emisión electrónica:
    //   - Si quedó como 'emitted' con CAE, todo OK.
    //   - Si tiene invoiceUuid pero status='failed'/'pending'/null y no fue
    //     anulada por nota de crédito, el intento NO llegó a AFIP.
    //   - Si NUNCA quedó invoiceUuid (intento que falló tan temprano que no
    //     se persistió, o venta cargada con IVA sin tocar "emitir"), tampoco
    //     hay factura real ante AFIP.
    //   - Excepción: si el usuario cargó manualmente un invoiceNumber (factura
    //     en papel emitida fuera del sistema), el IVA es real aunque no haya
    //     CAE registrado en Aikestar.
    const emissionStatus = (t as any).invoiceEmissionStatus as string | null;
    const cae = (t as any).invoiceCae as string | null;
    const emissionAttempted = !!(t as any).invoiceUuid;
    const simulated = !!(t as any).invoiceSimulated;
    const hasManualInvoiceNumber = !!t.invoiceNumber && !emissionAttempted;
    // Marcamos como "no emitida" cualquier movimiento con IVA cargado que
    // NO tenga CAE válido y NO sea factura manual en papel: ese IVA infla
    // el saldo del período sin respaldo real ante AFIP.
    // Nota: las anuladas por NC ya se filtran arriba (no llegan acá).
    const emissionFailed = !simulated
      && iva > 0
      && (!cae || (emissionStatus !== 'emitted'))
      && !hasManualInvoiceNumber;
    return {
      id: t.id,
      date: t.imputationDate,
      type: t.type,
      description: t.description,
      category: t.category,
      invoiceNumber: t.invoiceNumber || '',
      invoiceType: (t as any).invoiceType || '',
      invoiceFileUrl: (t as any).invoiceFileUrl || null,
      origin: t.createdVia || null,
      status: t.status,
      counterpartyName: (counterparty as any)?.name || (counterparty as any)?.businessName || '',
      counterpartyCuit: (counterparty as any)?.cuit || (counterparty as any)?.taxId || '',
      currency: t.currency || 'ARS',
      net,
      iva,
      ivaAliquot: aliq,
      otherTaxes: other,
      total,
      hasFiscalData: net > 0 || iva > 0 || other > 0,
      hasInvoice: !!(t.invoiceNumber || (t as any).invoiceFileUrl),
      simulated,
      emissionAttempted,
      emissionStatus: emissionStatus || null,
      cae: cae || null,
      emissionFailed,
    };
  });
  if (params.excludeUnemitted === 'true') {
    return mapped.filter(r => !r.emissionFailed);
  }
  return mapped;
}

function sumRows(rows: ReturnType<typeof getTaxRows> extends Promise<infer R> ? R : never) {
  return rows.reduce(
    (acc, r) => {
      acc.net += r.net;
      acc.iva += r.iva;
      acc.otherTaxes += r.otherTaxes;
      acc.total += r.total;
      acc.count += 1;
      return acc;
    },
    { net: 0, iva: 0, otherTaxes: 0, total: 0, count: 0 }
  );
}

export function registerTaxRoutes(app: Express): void {
  // GET tax profile for current org
  app.get('/api/tax-profile', requireAuth, async (req: any, res) => {
    try {
      const profile = await storage.getTaxProfile(req.organizationId);
      res.json(profile || null);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // PUT tax profile (upsert) - requires organization:settings
  app.put('/api/tax-profile', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const updates = upsertTaxProfileSchema.parse(req.body);
      const profile = await storage.upsertTaxProfile(req.organizationId, updates);
      res.json(profile);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // GET sales (income)
  app.get('/api/taxes/sales', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'income', ...f });
      res.json({ rows, totals: sumRows(rows) });
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // GET purchases (expense)
  app.get('/api/taxes/purchases', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'expense', ...f });
      res.json({ rows, totals: sumRows(rows) });
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // GET summary
  app.get('/api/taxes/summary', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const [sales, purchases] = await Promise.all([
        getTaxRows(req.organizationId, { type: 'income', ...f }),
        getTaxRows(req.organizationId, { type: 'expense', ...f }),
      ]);
      // Aggregate "unemitted" stats over the SAME period/filters but
      // ignoring the excludeUnemitted flag so the warning siempre refleja
      // cuántas facturas tienen IVA cargado pero no se emitieron bien.
      const [salesAll, purchasesAll] = f.excludeUnemitted === 'true'
        ? await Promise.all([
            getTaxRows(req.organizationId, { type: 'income', ...f, excludeUnemitted: undefined }),
            getTaxRows(req.organizationId, { type: 'expense', ...f, excludeUnemitted: undefined }),
          ])
        : [sales, purchases];
      const sumUnemittedIva = (rows: any[]) => rows
        .filter(r => r.emissionFailed && r.iva > 0)
        .reduce((s, r) => s + r.iva, 0);
      const countUnemitted = (rows: any[]) => rows.filter(r => r.emissionFailed).length;
      const unemitted = {
        salesCount: countUnemitted(salesAll),
        salesIva: sumUnemittedIva(salesAll),
        purchasesCount: countUnemitted(purchasesAll),
        purchasesIva: sumUnemittedIva(purchasesAll),
      };
      const salesTotals = sumRows(sales);
      const purchasesTotals = sumRows(purchases);
      const profile = await storage.getTaxProfile(req.organizationId);

      const ivaBalance = salesTotals.iva - purchasesTotals.iva;

      // Top counterparties
      const topClients = aggregateTop(sales, 'counterpartyName', 5);
      const topSuppliers = aggregateTop(purchases, 'counterpartyName', 5);

      // Coverage
      const salesWithFiscal = sales.filter(r => r.hasFiscalData).length;
      const purchasesWithFiscal = purchases.filter(r => r.hasFiscalData).length;

      // IVA breakdown by aliquot
      const ivaByAliquot = aggregateByAliquot(sales, purchases);

      // Monthly breakdown (sales vs purchases by YYYY-MM)
      const monthly = aggregateMonthly(sales, purchases);

      // Estimated utility (Ganancias) = total ingresos - total egresos (informativo)
      const utility = salesTotals.total - purchasesTotals.total;

      res.json({
        sales: salesTotals,
        purchases: purchasesTotals,
        ivaBalance,
        topClients,
        topSuppliers,
        ivaByAliquot,
        monthly,
        utility,
        coverage: {
          salesWithFiscal,
          salesTotal: sales.length,
          purchasesWithFiscal,
          purchasesTotal: purchases.length,
        },
        unemitted,
        profile: profile || null,
      });
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // PATCH transaction fiscal fields (used in compras inline edit)
  app.patch('/api/taxes/transactions/:id', requireAuth, requirePermission('transactions:edit'), async (req: any, res) => {
    try {
      const tx = await storage.getTransaction(req.params.id);
      if (!tx || tx.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Transacción no encontrada' });
      }
      // Inline fiscal edit is available for both ventas (income) and compras (expense).
      if (tx.type !== 'expense' && tx.type !== 'income') {
        return res.status(403).json({ message: 'Solo ingresos y egresos admiten edición fiscal en línea' });
      }
      const fiscalSchema = z.object({
        invoiceNetAmount: z.union([z.string(), z.number(), z.null()]).optional(),
        invoiceIvaAmount: z.union([z.string(), z.number(), z.null()]).optional(),
        invoiceIvaAliquot: z.union([z.string(), z.number(), z.null()]).optional(),
        invoiceOtherTaxes: z.union([z.string(), z.number(), z.null()]).optional(),
        invoiceNumber: z.string().nullable().optional(),
      });
      const parsed = fiscalSchema.parse(req.body);
      // Enforce the canonical ARCA invoice-number format only when it changes,
      // mirroring PATCH /api/transactions/:id so non-canonical historical values
      // stay editable while new values must be valid.
      if (parsed.invoiceNumber !== undefined) {
        const formatError = invoiceNumberChangeError(parsed.invoiceNumber, tx.invoiceNumber);
        if (formatError) {
          return res.status(400).json({ message: formatError, field: 'invoiceNumber' });
        }
      }
      const updates: any = {};
      for (const k of Object.keys(parsed) as Array<keyof typeof parsed>) {
        const v = (parsed as any)[k];
        if (v === undefined) continue;
        if (k === 'invoiceNumber') {
          updates[k] = v;
        } else {
          updates[k] = v === null || v === '' ? null : String(v);
        }
      }
      const updated = await storage.updateTransaction(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // CSV exports
  const exportHeaders = [
    { key: 'date', label: 'Fecha' },
    { key: 'invoiceNumber', label: 'N° Comprobante' },
    { key: 'counterpartyName', label: 'Razón Social' },
    { key: 'counterpartyCuit', label: 'CUIT' },
    { key: 'description', label: 'Descripción' },
    { key: 'category', label: 'Categoría' },
    { key: 'currency', label: 'Moneda' },
    { key: 'net', label: 'Neto' },
    { key: 'ivaAliquot', label: 'Alícuota IVA %' },
    { key: 'iva', label: 'IVA' },
    { key: 'otherTaxes', label: 'Otros Impuestos' },
    { key: 'total', label: 'Total' },
    { key: 'simulated', label: 'Simulada (sin validez fiscal)' },
  ];

  function rowsForCsv(rows: any[]) {
    return rows.map(r => ({
      ...r,
      date: r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
      net: r.net.toFixed(2),
      iva: r.iva.toFixed(2),
      ivaAliquot: r.ivaAliquot ? r.ivaAliquot.toFixed(2) : '',
      otherTaxes: r.otherTaxes.toFixed(2),
      total: r.total.toFixed(2),
      simulated: r.simulated ? 'SIMULADA' : '',
    }));
  }

  app.get('/api/taxes/sales.csv', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'income', ...f });
      const csv = toCsv(rowsForCsv(rows), exportHeaders);
      sendCsv(res, `ventas_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.csv`, csv);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/taxes/purchases.csv', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'expense', ...f });
      const csv = toCsv(rowsForCsv(rows), exportHeaders);
      sendCsv(res, `compras_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.csv`, csv);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/taxes/summary.csv', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const [sales, purchases] = await Promise.all([
        getTaxRows(req.organizationId, { type: 'income', ...f }),
        getTaxRows(req.organizationId, { type: 'expense', ...f }),
      ]);
      const s = sumRows(sales);
      const p = sumRows(purchases);
      const summaryRows = [
        { concept: 'Ventas - Total bruto', value: s.total.toFixed(2) },
        { concept: 'Ventas - Neto', value: s.net.toFixed(2) },
        { concept: 'Ventas - IVA Débito Fiscal', value: s.iva.toFixed(2) },
        { concept: 'Ventas - Otros impuestos', value: s.otherTaxes.toFixed(2) },
        { concept: 'Ventas - Cantidad de comprobantes', value: String(s.count) },
        { concept: 'Compras - Total bruto', value: p.total.toFixed(2) },
        { concept: 'Compras - Neto', value: p.net.toFixed(2) },
        { concept: 'Compras - IVA Crédito Fiscal', value: p.iva.toFixed(2) },
        { concept: 'Compras - Otros impuestos', value: p.otherTaxes.toFixed(2) },
        { concept: 'Compras - Cantidad de comprobantes', value: String(p.count) },
        { concept: 'Saldo IVA (Débito - Crédito)', value: (s.iva - p.iva).toFixed(2) },
      ];
      const csv = toCsv(summaryRows, [
        { key: 'concept', label: 'Concepto' },
        { key: 'value', label: 'Valor' },
      ]);
      sendCsv(res, `resumen_impuestos_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.csv`, csv);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  // ===== Excel (XLSX) exports =====
  function sendXlsx(res: any, filename: string, wb: XLSX.WorkBook) {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  }

  function rowsToSheet(rows: any[]) {
    const data = rows.map(r => ({
      Fecha: r.date ? new Date(r.date).toISOString().slice(0, 10) : '',
      'N° Comprobante': r.invoiceNumber || '',
      'Razón Social': r.counterpartyName || '',
      CUIT: r.counterpartyCuit || '',
      Descripción: r.description || '',
      Categoría: r.category || '',
      Moneda: r.currency || 'ARS',
      Neto: Number(r.net.toFixed(2)),
      'Alícuota IVA %': r.ivaAliquot ? Number(r.ivaAliquot.toFixed(2)) : 0,
      IVA: Number(r.iva.toFixed(2)),
      'Otros Impuestos': Number(r.otherTaxes.toFixed(2)),
      Total: Number(r.total.toFixed(2)),
      'Simulada (sin validez fiscal)': r.simulated ? 'SIMULADA' : '',
    }));
    return XLSX.utils.json_to_sheet(data);
  }

  app.get('/api/taxes/sales.xlsx', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'income', ...f });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, rowsToSheet(rows), 'Ventas');
      sendXlsx(res, `ventas_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.xlsx`, wb);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/taxes/purchases.xlsx', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const rows = await getTaxRows(req.organizationId, { type: 'expense', ...f });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, rowsToSheet(rows), 'Compras');
      sendXlsx(res, `compras_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.xlsx`, wb);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/taxes/summary.xlsx', requireAuth, async (req: any, res) => {
    try {
      const f = filterSchema.parse(req.query);
      const [sales, purchases] = await Promise.all([
        getTaxRows(req.organizationId, { type: 'income', ...f }),
        getTaxRows(req.organizationId, { type: 'expense', ...f }),
      ]);
      const s = sumRows(sales);
      const p = sumRows(purchases);
      const wb = XLSX.utils.book_new();

      const summary = [
        { Concepto: 'Ventas - Total bruto', Valor: Number(s.total.toFixed(2)) },
        { Concepto: 'Ventas - Neto', Valor: Number(s.net.toFixed(2)) },
        { Concepto: 'Ventas - IVA Débito Fiscal', Valor: Number(s.iva.toFixed(2)) },
        { Concepto: 'Ventas - Otros impuestos', Valor: Number(s.otherTaxes.toFixed(2)) },
        { Concepto: 'Ventas - Cantidad', Valor: s.count },
        { Concepto: 'Compras - Total bruto', Valor: Number(p.total.toFixed(2)) },
        { Concepto: 'Compras - Neto', Valor: Number(p.net.toFixed(2)) },
        { Concepto: 'Compras - IVA Crédito Fiscal', Valor: Number(p.iva.toFixed(2)) },
        { Concepto: 'Compras - Otros impuestos', Valor: Number(p.otherTaxes.toFixed(2)) },
        { Concepto: 'Compras - Cantidad', Valor: p.count },
        { Concepto: 'Saldo IVA (Débito - Crédito)', Valor: Number((s.iva - p.iva).toFixed(2)) },
        { Concepto: 'Utilidad estimada (Total Ventas - Total Compras)', Valor: Number((s.total - p.total).toFixed(2)) },
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Resumen');

      const byAliq = aggregateByAliquot(sales, purchases).map(r => ({
        'Alícuota %': r.aliquot,
        'Ventas Neto': Number(r.salesNet.toFixed(2)),
        'IVA Débito': Number(r.salesIva.toFixed(2)),
        'Compras Neto': Number(r.purchasesNet.toFixed(2)),
        'IVA Crédito': Number(r.purchasesIva.toFixed(2)),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byAliq), 'IVA por alícuota');

      const monthly = aggregateMonthly(sales, purchases).map(r => ({
        Mes: r.month,
        'Ventas Neto': Number(r.salesNet.toFixed(2)),
        'Ventas Total': Number(r.salesTotal.toFixed(2)),
        'IVA Débito': Number(r.salesIva.toFixed(2)),
        'Compras Neto': Number(r.purchasesNet.toFixed(2)),
        'Compras Total': Number(r.purchasesTotal.toFixed(2)),
        'IVA Crédito': Number(r.purchasesIva.toFixed(2)),
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthly), 'Mensual');

      XLSX.utils.book_append_sheet(wb, rowsToSheet(sales), 'Ventas');
      XLSX.utils.book_append_sheet(wb, rowsToSheet(purchases), 'Compras');

      sendXlsx(res, `resumen_impuestos_${f.startDate || 'inicio'}_${f.endDate || 'fin'}.xlsx`, wb);
    } catch (error: any) {
      res.status(400).json({ message: sanitizeError(error) });
    }
  });
}

function aggregateByAliquot(sales: any[], purchases: any[]) {
  const map = new Map<string, { aliquot: number; salesNet: number; salesIva: number; purchasesNet: number; purchasesIva: number }>();
  const get = (a: number) => {
    const k = a.toFixed(2);
    if (!map.has(k)) map.set(k, { aliquot: a, salesNet: 0, salesIva: 0, purchasesNet: 0, purchasesIva: 0 });
    return map.get(k)!;
  };
  for (const r of sales) {
    const e = get(r.ivaAliquot || 0);
    e.salesNet += r.net;
    e.salesIva += r.iva;
  }
  for (const r of purchases) {
    const e = get(r.ivaAliquot || 0);
    e.purchasesNet += r.net;
    e.purchasesIva += r.iva;
  }
  return Array.from(map.values()).sort((a, b) => a.aliquot - b.aliquot);
}

function aggregateMonthly(sales: any[], purchases: any[]) {
  const map = new Map<string, { month: string; salesNet: number; salesTotal: number; salesIva: number; purchasesNet: number; purchasesTotal: number; purchasesIva: number }>();
  const monthKey = (d: any) => {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  };
  const get = (m: string) => {
    if (!map.has(m)) map.set(m, { month: m, salesNet: 0, salesTotal: 0, salesIva: 0, purchasesNet: 0, purchasesTotal: 0, purchasesIva: 0 });
    return map.get(m)!;
  };
  for (const r of sales) {
    const e = get(monthKey(r.date));
    e.salesNet += r.net;
    e.salesIva += r.iva;
    e.salesTotal += r.total;
  }
  for (const r of purchases) {
    const e = get(monthKey(r.date));
    e.purchasesNet += r.net;
    e.purchasesIva += r.iva;
    e.purchasesTotal += r.total;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function aggregateTop(rows: any[], key: string, limit: number) {
  const map = new Map<string, { name: string; total: number; net: number; iva: number; count: number }>();
  for (const r of rows) {
    const name = r[key] || 'Sin identificar';
    const cur = map.get(name) || { name, total: 0, net: 0, iva: 0, count: 0 };
    cur.total += r.total;
    cur.net += r.net;
    cur.iva += r.iva;
    cur.count += 1;
    map.set(name, cur);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, limit);
}
