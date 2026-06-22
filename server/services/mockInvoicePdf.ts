import PDFDocument from "pdfkit";
import { storage } from "../storage";
import type {
  Transaction,
  InvoicingAccount,
  TaxProfile,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Unified renderer for the SIMULATED invoice/credit-note PDF.
//
// This is the single source of truth for the mock PDF that gets served from
// `GET /api/invoicing/mock-pdf/:uuid`, attached to outbound emails when the
// comprobante was emitted by the internal sandbox mock, and used wherever
// else we need to show the simulated PDF. The layout intentionally mimics
// the visual structure of a real ARCA-authorised invoice (header with cajas,
// letter box, items table, totals box, ARCA + QR + CAE footer) so users can
// preview their integration. A diagonal "SIMULADO – SIN VALIDEZ FISCAL"
// watermark is overlaid in light grey behind the content.
//
// Layout uses **absolute positioning** for every block. Do NOT use the flow
// `doc.text(...)` API outside of explicit `{x, y}` coordinates — the previous
// implementation called `doc.text(..., 0, height/2)` for the watermark which
// pushed the text cursor to the middle of the page and compressed the body.
// ---------------------------------------------------------------------------

export interface MockInvoicePdfContext {
  tx: Transaction & Record<string, any>;
  acc?: InvoicingAccount | null;
  isCreditNote: boolean;
  emitterTaxProfile?: TaxProfile | null;
  receptorName?: string | null;
  receptorAddress?: string | null;
  receptorPhone?: string | null;
  receptorIvaCondition?: string | null;
}

const IVA_LABELS: Record<string, string> = {
  responsable_inscripto: "IVA Responsable Inscripto",
  monotributo: "Responsable Monotributo",
  exento: "IVA Exento",
  consumidor_final: "Consumidor Final",
};

// AFIP comprobante codes per letter / type. Reference: AFIP RG 1415 tabla de
// tipos de comprobante. The task description listed A=011/B=006/C=001 which is
// the inverse; AFIP-real values are A=001 / B=006 / C=011 (and 003/008/013 for
// the corresponding notas de crédito). We follow the AFIP-real mapping so the
// COD shown in the letter box matches what users see on actual ARCA invoices.
const DOC_TYPE_META: Record<
  string,
  { letter: "A" | "B" | "C"; code: string; title: string }
> = {
  FA: { letter: "A", code: "001", title: "FACTURA" },
  FB: { letter: "B", code: "006", title: "FACTURA" },
  FC: { letter: "C", code: "011", title: "FACTURA" },
  NCA: { letter: "A", code: "003", title: "NOTA DE CRÉDITO" },
  NCB: { letter: "B", code: "008", title: "NOTA DE CRÉDITO" },
  NCC: { letter: "C", code: "013", title: "NOTA DE CRÉDITO" },
};

function ivaLabel(raw: string | null | undefined): string {
  if (!raw) return "—";
  return IVA_LABELS[raw] ?? raw;
}

function fmtMoney(value: string | number | null | undefined): string {
  const n =
    typeof value === "number" ? value : parseFloat((value ?? "0") as string);
  if (!isFinite(n)) return "0,00";
  return n.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("es-AR");
  } catch {
    return "—";
  }
}

function safe(value: any, fallback = "—"): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s.length ? s : fallback;
}

function splitVoucherNumber(raw: string | null | undefined): {
  pv: string;
  num: string;
} {
  if (!raw) return { pv: "0000", num: "00000000" };
  // Expected format PPPP-NNNNNNNN; tolerate other separators.
  const m = String(raw).match(/^(\d{1,8})[^\d]?(\d{1,8})$/);
  if (!m) return { pv: "0000", num: String(raw).padStart(8, "0") };
  return {
    pv: m[1].padStart(4, "0"),
    num: m[2].padStart(8, "0"),
  };
}

// ---------------------------------------------------------------------------
// Pure render: given an open PDFKit document, paint the invoice on the
// current page. Caller is responsible for `doc.end()`.
// ---------------------------------------------------------------------------
export function resolveMockInvoiceDocMeta(
  tx: Transaction & Record<string, any>,
  isCreditNote: boolean,
): { letter: "A" | "B" | "C"; code: string; title: string } {
  const FA_TO_NC: Record<string, string> = { FA: "NCA", FB: "NCB", FC: "NCC" };
  const rawDocType = (tx.invoiceDocType as string) || (isCreditNote ? "NCC" : "FC");
  const docTypeKey = isCreditNote
    ? (rawDocType.startsWith("NC") ? rawDocType : (FA_TO_NC[rawDocType] ?? "NCC"))
    : rawDocType;
  const meta =
    DOC_TYPE_META[docTypeKey] ??
    (isCreditNote
      ? { letter: "C" as const, code: "013", title: "NOTA DE CRÉDITO" }
      : { letter: "C" as const, code: "011", title: "FACTURA" });
  return isCreditNote ? { ...meta, title: "NOTA DE CRÉDITO" } : meta;
}

export function renderMockInvoicePdfToDoc(
  doc: PDFKit.PDFDocument,
  ctx: MockInvoicePdfContext,
): void {
  const { tx, acc, isCreditNote } = ctx;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const M = 28; // margin
  const innerW = pageW - M * 2;

  const meta = resolveMockInvoiceDocMeta(tx, isCreditNote);
  const title = meta.title;

  // ---------- Watermark (drawn first, behind content) ----------
  doc.save();
  doc.opacity(0.12);
  doc.rotate(-30, { origin: [pageW / 2, pageH / 2] });
  doc
    .font("Helvetica-Bold")
    .fontSize(72)
    .fillColor("#dc2626")
    .text("SIMULADO", 0, pageH / 2 - 60, {
      width: pageW,
      align: "center",
      lineBreak: false,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor("#dc2626")
    .text("SIN VALIDEZ FISCAL", 0, pageH / 2 + 24, {
      width: pageW,
      align: "center",
      lineBreak: false,
    });
  doc.restore();

  doc.fillColor("#000").opacity(1);

  // ---------- Outer frame ----------
  doc.lineWidth(0.8).rect(M, M, innerW, pageH - M * 2).stroke();

  // ---------- "ORIGINAL" badge (top center, on the frame) ----------
  const origW = 80;
  const origH = 14;
  const origX = (pageW - origW) / 2;
  const origY = M - origH / 2;
  doc.save();
  doc.rect(origX, origY, origW, origH).fillAndStroke("#fff", "#000");
  doc
    .fillColor("#000")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("ORIGINAL", origX, origY + 3, {
      width: origW,
      align: "center",
      lineBreak: false,
    });
  doc.restore();

  // ---------- Header: bipartite (left = emitter, right = letter + comprobante) ----------
  const headerY = M + 10;
  const headerH = 110;
  const colW = innerW / 2;
  // vertical divider
  doc
    .moveTo(M + colW, headerY)
    .lineTo(M + colW, headerY + headerH)
    .stroke();
  // horizontal line under header
  doc
    .moveTo(M, headerY + headerH)
    .lineTo(M + innerW, headerY + headerH)
    .stroke();

  // ---- Left column: emitter ----
  const lx = M + 10;
  const lw = colW - 20;
  let ly = headerY + 8;
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#000");
  doc.text(safe(acc?.razonSocial, "Tu Empresa"), lx, ly, {
    width: lw,
    lineBreak: false,
    ellipsis: true,
  });
  ly += 22;
  doc.font("Helvetica").fontSize(8.5).fillColor("#333");
  doc.text("Razón Social: ", lx, ly, { continued: true, lineBreak: false });
  doc.font("Helvetica-Bold").text(safe(acc?.razonSocial), { lineBreak: false });
  ly += 13;
  doc.font("Helvetica").text("Domicilio Comercial: ", lx, ly, {
    continued: true,
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").text(safe(acc?.address ?? null), {
    width: lw,
    lineBreak: false,
    ellipsis: true,
  });
  ly += 13;
  if (acc?.phone) {
    doc.font("Helvetica").text("Teléfono: ", lx, ly, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").text(safe(acc.phone), {
      lineBreak: false,
    });
    ly += 13;
  }
  doc.font("Helvetica").text("Condición frente al IVA: ", lx, ly, {
    continued: true,
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").text(ivaLabel(acc?.ivaCondition), {
    lineBreak: false,
  });

  // ---- Right column: letter box (centered top) + comprobante info ----
  // Letter box on the divider line
  const boxW = 56;
  const boxH = 56;
  const boxX = M + colW - boxW / 2;
  const boxY = headerY + 4;
  doc.save();
  doc.rect(boxX, boxY, boxW, boxH).fillAndStroke("#fff", "#000");
  doc
    .fillColor("#000")
    .font("Helvetica-Bold")
    .fontSize(34)
    .text(meta.letter, boxX, boxY + 6, {
      width: boxW,
      align: "center",
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(7)
    .text(`COD. ${meta.code}`, boxX, boxY + 44, {
      width: boxW,
      align: "center",
      lineBreak: false,
    });
  doc.restore();

  // Right column text starts to the right of the letter box
  const rx = M + colW + boxW / 2 + 14;
  const rw = colW - boxW / 2 - 24;
  let ry = headerY + 8;
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#000");
  doc.text(title, rx, ry, { width: rw, lineBreak: false });
  ry += 20;
  doc.font("Helvetica").fontSize(8.5).fillColor("#333");
  const { pv, num } = splitVoucherNumber(tx.invoiceVoucherId);
  const issued = tx.invoiceEmittedAt ? new Date(tx.invoiceEmittedAt) : new Date();

  const rightLines: Array<[string, string]> = [
    ["Punto de Venta: ", pv],
    ["Comp. Nro: ", num],
    ["Fecha de Emisión: ", fmtDate(issued)],
    ["CUIT: ", safe(acc?.cuit ?? tx.invoiceEmitterCuit)],
    [
      "Ingresos Brutos: ",
      safe(ctx.emitterTaxProfile?.iibbInscribed ? ctx.emitterTaxProfile.iibbNumber ?? "—" : null),
    ],
    ["Fecha de Inicio de Actividades: ", "—"],
  ];
  for (const [lbl, val] of rightLines) {
    doc.font("Helvetica").text(lbl, rx, ry, { continued: true, lineBreak: false });
    doc.font("Helvetica-Bold").text(val, { lineBreak: false });
    ry += 12;
  }

  // ---------- Period band ----------
  const periodY = headerY + headerH + 6;
  const periodH = 22;
  doc.rect(M, periodY, innerW, periodH).stroke();
  const cellW = innerW / 3;
  doc.moveTo(M + cellW, periodY).lineTo(M + cellW, periodY + periodH).stroke();
  doc
    .moveTo(M + cellW * 2, periodY)
    .lineTo(M + cellW * 2, periodY + periodH)
    .stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#333");
  const periodCells: Array<[string, string]> = [
    ["Período Facturado Desde: ", fmtDate(issued)],
    ["Hasta: ", fmtDate(issued)],
    ["Fecha de Vto. para el pago: ", fmtDate(issued)],
  ];
  periodCells.forEach(([lbl, val], i) => {
    const cx = M + cellW * i + 8;
    doc.font("Helvetica").text(lbl, cx, periodY + 7, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").text(val, { lineBreak: false });
  });

  // ---------- Receptor block ----------
  const recY = periodY + periodH + 6;
  const recH = 88;
  doc.rect(M, recY, innerW, recH).stroke();
  const halfW = innerW / 2;
  doc.moveTo(M + halfW, recY).lineTo(M + halfW, recY + recH).stroke();

  const rrxL = M + 8;
  const rrxR = M + halfW + 8;
  let rryL = recY + 8;
  let rryR = recY + 8;
  const rcwL = halfW - 16;
  const rcwR = halfW - 16;

  doc.font("Helvetica").fontSize(8.5).fillColor("#333");
  // left col
  doc.text("CUIT: ", rrxL, rryL, { continued: true, lineBreak: false });
  doc.font("Helvetica-Bold").text(safe(tx.invoiceTaxId), { lineBreak: false });
  rryL += 14;
  doc.font("Helvetica").text("Apellido y Nombre / Razón Social: ", rrxL, rryL, {
    continued: true,
    lineBreak: false,
  });
  doc
    .font("Helvetica-Bold")
    .text(safe(ctx.receptorName, "Consumidor Final"), { lineBreak: false });
  rryL += 14;
  doc.font("Helvetica").text("Domicilio: ", rrxL, rryL, {
    width: rcwL,
    continued: true,
    lineBreak: false,
  });
  // Prefer the snapshot persisted on the transaction at emission time so the
  // printed PDF doesn't change if the client/supplier is later edited.
  const receptorAddressFinal =
    (tx.invoiceAddress as string | null | undefined) ??
    ctx.receptorAddress ??
    null;
  doc.font("Helvetica-Bold").text(safe(receptorAddressFinal), {
    width: rcwL,
    lineBreak: false,
    ellipsis: true,
  });
  rryL += 14;
  const receptorPhoneFinal =
    (tx.invoicePhone as string | null | undefined) ?? ctx.receptorPhone ?? null;
  if (receptorPhoneFinal) {
    doc.font("Helvetica").text("Teléfono: ", rrxL, rryL, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").text(safe(receptorPhoneFinal), {
      width: rcwL,
      lineBreak: false,
      ellipsis: true,
    });
  }

  // right col
  doc.font("Helvetica").text("Condición frente al IVA: ", rrxR, rryR, {
    continued: true,
    lineBreak: false,
  });
  doc
    .font("Helvetica-Bold")
    .text(ivaLabel(ctx.receptorIvaCondition), { lineBreak: false });
  rryR += 14;
  doc.font("Helvetica").text("Condición de venta: ", rrxR, rryR, {
    continued: true,
    lineBreak: false,
  });
  doc.font("Helvetica-Bold").text("Otra", { lineBreak: false });
  rryR += 14;
  if (isCreditNote && tx.invoiceUuid) {
    doc.font("Helvetica").text("Comprobante asociado: ", rrxR, rryR, {
      continued: true,
      lineBreak: false,
    });
    doc.font("Helvetica-Bold").text(safe(tx.invoiceVoucherId), {
      lineBreak: false,
    });
  }

  // ---------- Items table ----------
  const tblY = recY + recH + 6;
  const colHdrH = 18;
  // Column widths (sum must equal innerW)
  const cols = [
    { key: "code", label: "Código", w: 50, align: "left" as const },
    { key: "desc", label: "Producto / Servicio", w: 0, align: "left" as const },
    { key: "qty", label: "Cant.", w: 38, align: "right" as const },
    { key: "um", label: "U. Med.", w: 50, align: "left" as const },
    { key: "pu", label: "Precio Unit.", w: 70, align: "right" as const },
    { key: "bonifPct", label: "% Bonif.", w: 45, align: "right" as const },
    { key: "bonifImp", label: "Imp. Bonif.", w: 60, align: "right" as const },
    { key: "sub", label: "Subtotal", w: 70, align: "right" as const },
  ];
  const fixedW = cols.reduce((s, c) => s + c.w, 0);
  cols[1].w = innerW - fixedW; // desc takes remaining space
  // header background
  doc.save();
  doc.rect(M, tblY, innerW, colHdrH).fillAndStroke("#f0f0f0", "#000");
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(8);
  let cx = M;
  cols.forEach((c) => {
    doc.text(c.label, cx + 4, tblY + 5, {
      width: c.w - 8,
      align: c.align,
      lineBreak: false,
    });
    cx += c.w;
  });
  doc.restore();

  // single row from transaction
  const total = parseFloat((tx.amount ?? "0") as string);
  const net = parseFloat((tx.invoiceNetAmount ?? "0") as string);
  const subtotal = net > 0 ? net : total;
  const row = {
    code: "001",
    desc: safe(tx.description, "Servicios prestados"),
    qty: "1,00",
    um: "unidades",
    pu: fmtMoney(subtotal),
    bonifPct: "0,00",
    bonifImp: "0,00",
    sub: fmtMoney(subtotal),
  };
  const rowY = tblY + colHdrH;
  const rowH = 22;
  doc.rect(M, rowY, innerW, rowH).stroke();
  doc.font("Helvetica").fontSize(8.5).fillColor("#000");
  cx = M;
  cols.forEach((c) => {
    doc.text((row as any)[c.key], cx + 4, rowY + 6, {
      width: c.w - 8,
      align: c.align,
      lineBreak: false,
      ellipsis: true,
    });
    cx += c.w;
  });

  // ---------- Totals box (bottom right) ----------
  const totalsW = 230;
  const totalsX = M + innerW - totalsW;
  const totalsY = rowY + rowH + 10;
  const lineH = 16;

  const ivaAliquot = parseFloat((tx.invoiceIvaAliquot ?? "0") as string);
  const ivaAmount = parseFloat((tx.invoiceIvaAmount ?? "0") as string);
  const otherTaxes = parseFloat((tx.invoiceOtherTaxes ?? "0") as string);

  const totalsRows: Array<{ label: string; value: string; bold?: boolean }> = [
    { label: "Subtotal", value: `$ ${fmtMoney(subtotal)}` },
  ];
  if (meta.letter === "A" && ivaAmount > 0) {
    totalsRows.push({
      label: `IVA ${isFinite(ivaAliquot) ? ivaAliquot.toFixed(2) : "21,00"}%`,
      value: `$ ${fmtMoney(ivaAmount)}`,
    });
  }
  totalsRows.push({
    label: "Importe Otros Tributos",
    value: `$ ${fmtMoney(otherTaxes)}`,
  });
  totalsRows.push({
    label: "Importe Total",
    value: `$ ${fmtMoney(total)}`,
    bold: true,
  });

  const totalsH = totalsRows.length * lineH + 8;
  doc.rect(totalsX, totalsY, totalsW, totalsH).stroke();
  let trY = totalsY + 4;
  for (const r of totalsRows) {
    doc.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(r.bold ? 10 : 9);
    doc.text(r.label, totalsX + 8, trY + 2, {
      width: totalsW / 2 - 8,
      align: "left",
      lineBreak: false,
    });
    doc.text(r.value, totalsX + totalsW / 2, trY + 2, {
      width: totalsW / 2 - 8,
      align: "right",
      lineBreak: false,
    });
    trY += lineH;
  }

  // Currency line on the left, aligned with totals
  doc.font("Helvetica").fontSize(9).fillColor("#333");
  doc.text(`Moneda: ${safe(tx.currency, "ARS")}`, M + 8, totalsY + 4, {
    width: totalsX - M - 16,
    lineBreak: false,
  });

  // ---------- Footer (ARCA logo + QR + CAE) ----------
  const footerH = 90;
  const footerY = pageH - M - footerH - 4;
  doc.moveTo(M, footerY).lineTo(M + innerW, footerY).stroke();

  // ARCA logo box
  const logoW = 90;
  const logoH = 40;
  const logoX = M + 8;
  const logoY = footerY + 12;
  doc.save();
  doc.rect(logoX, logoY, logoW, logoH).fillAndStroke("#0f3a8a", "#0f3a8a");
  doc
    .fillColor("#ffffff")
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("ARCA", logoX, logoY + 9, {
      width: logoW,
      align: "center",
      lineBreak: false,
    });
  doc.restore();
  doc.font("Helvetica").fontSize(6.5).fillColor("#333");
  doc.text(
    "Agencia de Recaudación\ny Control Aduanero",
    logoX,
    logoY + logoH + 2,
    { width: logoW, align: "center" },
  );

  // QR placeholder (grid)
  const qrX = logoX + logoW + 18;
  const qrY = footerY + 10;
  const qrSize = 64;
  doc.save();
  doc.rect(qrX, qrY, qrSize, qrSize).fillAndStroke("#fff", "#000");
  // pseudo-QR pattern
  const cells = 9;
  const cell = qrSize / cells;
  doc.fillColor("#000");
  // deterministic-ish pattern based on uuid/voucher
  const seedStr = String(tx.invoiceUuid ?? tx.invoiceVoucherId ?? tx.id ?? "x");
  let seed = 0;
  for (let i = 0; i < seedStr.length; i++) seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0;
  for (let r = 0; r < cells; r++) {
    for (let c = 0; c < cells; c++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      if ((seed & 1) === 1) {
        doc.rect(qrX + c * cell, qrY + r * cell, cell, cell).fill();
      }
    }
  }
  // finder squares (corners)
  doc.fillColor("#000");
  [
    [0, 0],
    [cells - 3, 0],
    [0, cells - 3],
  ].forEach(([cc, rr]) => {
    doc.rect(qrX + cc * cell, qrY + rr * cell, cell * 3, cell * 3).fill();
    doc
      .rect(qrX + (cc + 1) * cell, qrY + (rr + 1) * cell, cell, cell)
      .fillAndStroke("#fff", "#fff");
  });
  doc.restore();

  // CAE info to the right
  const caeX = qrX + qrSize + 18;
  const caeY = footerY + 14;
  const caeW = M + innerW - caeX - 8;
  doc.font("Helvetica").fontSize(9).fillColor("#000");
  doc.text("CAE Nº: ", caeX, caeY, { continued: true, lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .text(safe(tx.invoiceCae), { lineBreak: false });
  doc
    .font("Helvetica")
    .text("Fecha de Vto. de CAE: ", caeX, caeY + 14, {
      continued: true,
      lineBreak: false,
    });
  doc
    .font("Helvetica-Bold")
    .text(fmtDate(tx.invoiceCaeExpirationDate), { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .text("Comprobante Autorizado", caeX, caeY + 32, {
      width: caeW,
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(6.5)
    .fillColor("#555")
    .text(
      "Esta Administración Federal no se responsabiliza por los datos ingresados en el detalle de la operación.",
      caeX,
      caeY + 46,
      { width: caeW },
    );
}

// ---------------------------------------------------------------------------
// Resolve receptor (client / supplier) details from the transaction so the
// caller doesn't have to.
// ---------------------------------------------------------------------------
export async function resolveMockInvoiceContext(
  tx: Transaction & Record<string, any>,
  organizationId: string,
  isCreditNote: boolean,
): Promise<MockInvoicePdfContext> {
  const acc = await storage.getInvoicingAccount(organizationId);
  let emitterTaxProfile: TaxProfile | undefined;
  try {
    emitterTaxProfile = await storage.getTaxProfile(organizationId);
  } catch {
    emitterTaxProfile = undefined;
  }
  let receptorName: string | null = null;
  let receptorAddress: string | null = null;
  let receptorPhone: string | null = null;
  let receptorIvaCondition: string | null = null;
  try {
    if (tx.clientId) {
      const c = await storage.getClient(tx.clientId);
      if (c) {
        receptorName = c.name ?? null;
        receptorAddress = (c as any).address ?? null;
        receptorPhone = (c as any).phone ?? null;
        receptorIvaCondition = (c as any).ivaCondition ?? null;
      }
    } else if (tx.supplierId) {
      const s = await storage.getSupplier(tx.supplierId);
      if (s) {
        receptorName = s.name ?? null;
        receptorAddress = (s as any).address ?? null;
        receptorPhone = (s as any).phone ?? null;
        receptorIvaCondition = (s as any).ivaCondition ?? null;
      }
    }
  } catch {
    // best-effort — fall back to "Consumidor Final"
  }
  return {
    tx,
    acc: acc ?? null,
    isCreditNote,
    emitterTaxProfile: emitterTaxProfile ?? null,
    receptorName,
    receptorAddress,
    receptorPhone,
    receptorIvaCondition,
  };
}

export function pipeMockInvoicePdf(
  res: { setHeader: (k: string, v: string) => void } & NodeJS.WritableStream,
  ctx: MockInvoicePdfContext,
  filenameBase: string,
): void {
  const doc = new PDFDocument({ size: "A4", margin: 28 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${filenameBase.replace(/[^\w-]/g, "_")}.pdf"`,
  );
  doc.pipe(res as any);
  renderMockInvoicePdfToDoc(doc, ctx);
  doc.end();
}

export async function renderMockInvoicePdfToBuffer(
  ctx: MockInvoicePdfContext,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 28 });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      renderMockInvoicePdfToDoc(doc, ctx);
      doc.end();
    } catch (e) {
      reject(e as Error);
    }
  });
}
