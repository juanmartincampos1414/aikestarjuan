import * as cron from 'node-cron';
import OpenAI from '../lib/claude';
import { MailService } from '@sendgrid/mail';
import { storage } from '../storage';
import { db } from '../db';
import { subscriptions as subscriptionsTable, weeklyDigestSends } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { AI_MODELS } from '@shared/constants';
import type { Transaction, Account, Subscription } from '@shared/schema';
import { differenceInDays, differenceInCalendarMonths, startOfWeek, endOfWeek, format, addDays } from 'date-fns';
import { es } from 'date-fns/locale';

// Cliente Claude con interfaz compatible OpenAI (ver server/lib/claude.ts).
const openai = new OpenAI();

let weeklyJob: ReturnType<typeof cron.schedule> | null = null;

// Seam de testing (Task #505): permite inyectar dependencias en
// generateWeeklyDigestForUser para verificar la idempotencia del resumen
// semanal sin una base Postgres real ni envíos de SendGrid de verdad. En
// producción __testDeps queda en null y se usan las implementaciones reales.
export interface WeeklyDigestTestDeps {
  getUser?: (userId: string) => Promise<any>;
  getOrganizationsByUser?: (userId: string) => Promise<any[]>;
  getAccountsByOrganization?: (orgId: string) => Promise<any[]>;
  getTransactionsByOrganization?: (orgId: string) => Promise<any[]>;
  generateAIAnalysis?: (orgData: any) => Promise<string>;
  sendEmail?: (userEmail: string, html: string) => Promise<boolean>;
  claimSend?: (userId: string, weekStartStr: string) => Promise<boolean>;
  releaseSend?: (userId: string, weekStartStr: string) => Promise<void>;
  hasSend?: (userId: string, weekStartStr: string) => Promise<boolean>;
  // Seam de lote (Task #507): permite inyectar la lista de usuarios y la
  // elegibilidad en runWeeklyDigestForAllUsers para probar el conteo de errores
  // del lote completo (un envío fallido tiene que dejar errors>0) sin Postgres
  // ni SendGrid reales. En producción quedan en null y se usan storage.getAllUsers
  // e isEligibleForWeeklyDigest.
  getAllUsers?: () => Promise<any[]>;
  isEligible?: (userId: string) => Promise<{ eligible: boolean; reason: EligibilityReason }>;
}

let __testDeps: WeeklyDigestTestDeps | null = null;

export function __setWeeklyDigestDepsForTesting(deps: WeeklyDigestTestDeps | null): void {
  __testDeps = deps;
}

// Reclama (claim-first) el envío de la semana para (user, week). Devuelve true
// si esta corrida ganó el claim, false si ya existía (otro envío ocurrió o está
// en curso). En tests se puede inyectar un store en memoria con la misma
// semántica de INSERT ... ON CONFLICT DO NOTHING.
async function claimWeeklyDigestSend(userId: string, weekStartStr: string): Promise<boolean> {
  if (__testDeps?.claimSend) return __testDeps.claimSend(userId, weekStartStr);
  const claimed = await db
    .insert(weeklyDigestSends)
    .values({ userId, weekStart: weekStartStr })
    .onConflictDoNothing()
    .returning({ userId: weeklyDigestSends.userId });
  return claimed.length > 0;
}

// Libera el claim de (user, week) cuando el envío falló, para que un reintento
// posterior pueda volver a reclamarlo y reenviar.
async function releaseWeeklyDigestSend(userId: string, weekStartStr: string): Promise<void> {
  if (__testDeps?.releaseSend) return __testDeps.releaseSend(userId, weekStartStr);
  await db
    .delete(weeklyDigestSends)
    .where(and(eq(weeklyDigestSends.userId, userId), eq(weeklyDigestSends.weekStart, weekStartStr)));
}

// Verifica si ya existe la fila (user, week) sin reclamarla. Se usa para el
// short-circuit barato del trigger "al despertar": cuando la app se despierta y
// vuelve a correr el lote, salteamos de entrada a los usuarios ya enviados
// ANTES de armar los datos y llamar a la IA. La dedup autoritativa sigue siendo
// el claim-first (claimWeeklyDigestSend) más abajo, que cubre la carrera entre
// procesos. En tests sin `hasSend` inyectado devolvemos false para no alterar
// la semántica claim-first que verifica Task #505.
async function wasWeeklyDigestSent(userId: string, weekStartStr: string): Promise<boolean> {
  if (__testDeps) {
    return __testDeps.hasSend ? __testDeps.hasSend(userId, weekStartStr) : false;
  }
  const rows = await db
    .select({ userId: weeklyDigestSends.userId })
    .from(weeklyDigestSends)
    .where(and(eq(weeklyDigestSends.userId, userId), eq(weeklyDigestSends.weekStart, weekStartStr)))
    .limit(1);
  return rows.length > 0;
}

function safeParseDate(val: string | Date | null | undefined): Date {
  if (!val) return new Date();
  if (val instanceof Date) return val;
  if (typeof val === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const [y, m, d] = val.split('-').map(Number);
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    if (/T00:00:00(\.\d+)?Z$/.test(val)) {
      const datePart = val.substring(0, 10);
      const [y, m, d] = datePart.split('-').map(Number);
      return new Date(y, m - 1, d, 12, 0, 0);
    }
    return new Date(val);
  }
  return new Date(val as any);
}

function calculateAccruedInterest(account: Account): number {
  const capital = account.initialInvestment ? parseFloat(account.initialInvestment) : 0;
  const rate = account.interestRate ? parseFloat(account.interestRate) : 0;
  if (capital <= 0 || rate <= 0) return 0;

  const freq = (account.interestFrequency || 'monthly') as string;
  const anchor = account.interestStartDate ?? account.createdAt;
  const startDate = anchor ? safeParseDate(anchor) : new Date();
  const endDate = account.maturityDate ? (() => {
    const mat = safeParseDate(account.maturityDate);
    return mat < new Date() ? mat : new Date();
  })() : new Date();

  if (endDate <= startDate) return 0;

  let periods = 0;
  switch (freq) {
    case 'daily':
      periods = differenceInDays(endDate, startDate);
      break;
    case 'weekly':
      periods = differenceInDays(endDate, startDate) / 7;
      break;
    case 'monthly':
      periods = differenceInCalendarMonths(endDate, startDate) +
        (endDate.getDate() - startDate.getDate()) / 30;
      break;
    case 'yearly':
      periods = differenceInCalendarMonths(endDate, startDate) / 12;
      break;
  }

  if (periods < 0) periods = 0;
  return capital * (rate / 100) * periods;
}

function formatCurrency(amount: number, currency: string = 'ARS'): string {
  try {
    const code = currency.replace('_CASH', '');
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `$${amount.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  }
}

function getAppBaseUrl(): string {
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain && process.env.NODE_ENV === 'development') {
    return `https://${devDomain}`;
  }
  return 'https://aikestar.net';
}

interface WeeklyCommitment {
  id: string;
  type: 'payable' | 'receivable';
  description: string;
  amount: number;
  currency: string;
  date: Date;
  daysUntilDue: number;
  isOverdue: boolean;
  isDueToday: boolean;
}

interface OrgDigestData {
  orgName: string;
  orgId: string;
  accounts: Account[];
  weeklyCommitments: WeeklyCommitment[];
  overdueCommitments: WeeklyCommitment[];
  totalBalance: Record<string, number>;
  totalPayable: Record<string, number>;
  totalReceivable: Record<string, number>;
  monthlyIncome: Record<string, number>;
  monthlyExpense: Record<string, number>;
  healthScore: number;
  aiAnalysis: string;
}

const normalizeAmount = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
};

function sumRecord(rec: Record<string, number>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0);
}

function formatRecord(rec: Record<string, number>): string {
  const entries = Object.entries(rec).filter(([_, v]) => v !== 0);
  if (entries.length === 0) return '$0';
  return entries.map(([currency, amount]) => formatCurrency(amount, currency)).join(' + ');
}

function addToRecord(rec: Record<string, number>, currency: string, amount: number) {
  const key = currency || 'ARS';
  rec[key] = (rec[key] || 0) + amount;
}

function scoreSingleCurrency(bal: number, pay: number, rec: number, overdueP: number): number {
  const netPosition = bal + rec - pay;
  let score = 70;

  if (netPosition < 0) {
    const deficitRatio = Math.abs(netPosition) / Math.max(pay, 1);
    score -= Math.min(40, Math.round(deficitRatio * 50));
  } else if (pay > 0) {
    const coverageRatio = (bal + rec) / pay;
    if (coverageRatio >= 1.5) score = Math.min(100, score + 10);
    else if (coverageRatio >= 1.2) score = Math.min(100, score + 5);
  }

  if (overdueP > 0) {
    const overdueRatio = overdueP / Math.max(bal, pay, 1);
    score -= Math.min(25, 10 + Math.round(overdueRatio * 15));
  }

  if (pay === 0 && rec === 0 && bal > 0) {
    score = Math.max(score, 80);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function calculateSimpleHealthScore(
  totalBalance: Record<string, number>,
  totalPayable: Record<string, number>,
  totalReceivable: Record<string, number>,
  overduePayablesAmount: Record<string, number>,
  accounts: Account[]
): number {
  const allCurrencies = new Set([
    ...Object.keys(totalBalance),
    ...Object.keys(totalPayable),
    ...Object.keys(totalReceivable),
  ]);

  if (allCurrencies.size === 0) return 70;

  const scores: number[] = [];
  for (const curr of Array.from(allCurrencies)) {
    const bal = totalBalance[curr] || 0;
    const pay = totalPayable[curr] || 0;
    const rec = totalReceivable[curr] || 0;
    const overdueP = overduePayablesAmount[curr] || 0;

    if (bal === 0 && pay === 0 && rec === 0) continue;
    scores.push(scoreSingleCurrency(bal, pay, rec, overdueP));
  }

  let baseScore = scores.length > 0 ? Math.min(...scores) : 70;

  const negativeCount = accounts.filter(a => {
    let bal = normalizeAmount(a.balance);
    if (a.accountCategory === 'investment') {
      const accrued = calculateAccruedInterest(a);
      if (accrued > 0) bal = parseFloat(a.initialInvestment || '0') + accrued;
    }
    return bal < 0;
  }).length;
  if (negativeCount > 0) baseScore -= Math.min(20, negativeCount * 10);

  return Math.max(0, Math.min(100, Math.round(baseScore)));
}

async function generateAIAnalysis(orgData: {
  orgName: string;
  totalBalance: Record<string, number>;
  monthlyIncome: Record<string, number>;
  monthlyExpense: Record<string, number>;
  healthScore: number;
  weeklyCommitments: WeeklyCommitment[];
  overdueCommitments: WeeklyCommitment[];
  totalPayable: Record<string, number>;
  totalReceivable: Record<string, number>;
}): Promise<string> {
  try {
    const balanceSummary = formatRecord(orgData.totalBalance);

    const commitmentSummary = orgData.weeklyCommitments.length > 0
      ? orgData.weeklyCommitments.map(c => 
        `- ${c.type === 'payable' ? 'Pagar' : 'Cobrar'}: ${c.description} (${formatCurrency(c.amount, c.currency)}) - ${c.isOverdue ? 'VENCIDO' : c.isDueToday ? 'HOY' : `en ${c.daysUntilDue} días`}`
      ).join('\n')
      : 'No hay compromisos esta semana.';

    const prompt = `Sos Aike, asistente financiero de Aikestar. Generá un análisis semanal breve para "${orgData.orgName}".

DATOS:
- Saldos totales: ${balanceSummary}
- Ingresos del mes: ${formatRecord(orgData.monthlyIncome)}
- Gastos del mes: ${formatRecord(orgData.monthlyExpense)}
- Salud financiera: ${orgData.healthScore}%
- Por pagar pendiente: ${formatRecord(orgData.totalPayable)}
- Por cobrar pendiente: ${formatRecord(orgData.totalReceivable)}
- Compromisos vencidos: ${orgData.overdueCommitments.length}
- Compromisos de la semana:
${commitmentSummary}

INSTRUCCIONES:
1. Dá un diagnóstico rápido (1-2 oraciones) del estado financiero
2. Si hay compromisos vencidos, mencionalo como urgente
3. Dá 2-3 consejos concretos para la semana
4. Usá español argentino casual pero profesional
5. Máximo 150 palabras
6. NO uses markdown, solo texto plano con saltos de línea`;

    const response = await openai.chat.completions.create({
      model: AI_MODELS.DEFAULT,
      messages: [
        { role: 'system', content: 'Sos un asesor financiero que envía resúmenes semanales por email. Sé conciso y práctico.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    return response.choices[0]?.message?.content || 'No se pudo generar el análisis esta semana.';
  } catch (error) {
    console.error('[WeeklyDigest] AI analysis error:', error);
    return 'No se pudo generar el análisis con IA esta semana. Revisá tu panel de Aikestar para más detalles.';
  }
}

function buildWeeklyEmailHtml(userName: string, orgsData: OrgDigestData[], weekStart: Date, weekEnd: Date): string {
  const appUrl = getAppBaseUrl();
  const weekLabel = `${format(weekStart, "d 'de' MMMM", { locale: es })} al ${format(weekEnd, "d 'de' MMMM yyyy", { locale: es })}`;

  const orgsHtml = orgsData.map(org => {
    const balanceHtml = Object.entries(org.totalBalance)
      .map(([currency, amount]) => `
        <div style="display: inline-block; padding: 8px 16px; background: #1e293b; border-radius: 8px; margin: 4px;">
          <span style="color: #94a3b8; font-size: 12px;">${currency}</span>
          <div style="color: ${amount >= 0 ? '#22d3ee' : '#f87171'}; font-size: 18px; font-weight: 600;">${formatCurrency(amount, currency)}</div>
        </div>
      `).join('');

    const healthColor = org.healthScore >= 70 ? '#22c55e' : org.healthScore >= 40 ? '#eab308' : '#ef4444';
    const healthLabel = org.healthScore >= 80 ? 'Excelente' : org.healthScore >= 60 ? 'Buena' : org.healthScore >= 40 ? 'Regular' : org.healthScore >= 20 ? 'Crítica' : 'Emergencia';

    let calendarHtml = '';
    const allCommitments = [...org.overdueCommitments, ...org.weeklyCommitments]
      .sort((a, b) => a.date.getTime() - b.date.getTime());

    if (allCommitments.length > 0) {
      const rows = allCommitments.slice(0, 15).map(c => {
        const dateStr = format(c.date, "EEE d MMM", { locale: es });
        const typeIcon = c.type === 'payable' ? '🔴' : '🟢';
        const typeLabel = c.type === 'payable' ? 'Pagar' : 'Cobrar';
        let statusBadge = '';
        if (c.isOverdue) {
          statusBadge = '<span style="background: #dc2626; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">VENCIDO</span>';
        } else if (c.isDueToday) {
          statusBadge = '<span style="background: #d97706; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">HOY</span>';
        } else if (c.daysUntilDue <= 2) {
          statusBadge = `<span style="background: #ea580c; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px;">En ${c.daysUntilDue}d</span>`;
        }

        return `
          <tr style="border-bottom: 1px solid #334155;">
            <td style="padding: 10px 12px; color: #94a3b8; font-size: 13px; white-space: nowrap;">${dateStr}</td>
            <td style="padding: 10px 8px; font-size: 13px;">${typeIcon} <span style="color: #e2e8f0;">${typeLabel}</span></td>
            <td style="padding: 10px 8px; color: #cbd5e1; font-size: 13px; max-width: 180px; overflow: hidden; text-overflow: ellipsis;">${c.description}</td>
            <td style="padding: 10px 8px; color: ${c.type === 'payable' ? '#f87171' : '#4ade80'}; font-size: 13px; font-weight: 600; text-align: right; white-space: nowrap;">${formatCurrency(c.amount, c.currency)}</td>
            <td style="padding: 10px 8px; text-align: right;">${statusBadge}</td>
          </tr>
        `;
      }).join('');

      calendarHtml = `
        <div style="margin-top: 20px;">
          <h3 style="color: #e2e8f0; font-size: 16px; margin: 0 0 12px;">📅 Calendario de la Semana</h3>
          <table style="width: 100%; border-collapse: collapse; background: #0f172a; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #1e293b;">
                <th style="padding: 8px 12px; color: #64748b; font-size: 11px; text-transform: uppercase; text-align: left;">Fecha</th>
                <th style="padding: 8px; color: #64748b; font-size: 11px; text-transform: uppercase; text-align: left;">Tipo</th>
                <th style="padding: 8px; color: #64748b; font-size: 11px; text-transform: uppercase; text-align: left;">Concepto</th>
                <th style="padding: 8px; color: #64748b; font-size: 11px; text-transform: uppercase; text-align: right;">Monto</th>
                <th style="padding: 8px; color: #64748b; font-size: 11px; text-transform: uppercase; text-align: right;">Estado</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      `;
    } else {
      calendarHtml = `
        <div style="margin-top: 20px; padding: 20px; background: #0f172a; border-radius: 8px; text-align: center;">
          <p style="color: #64748b; margin: 0;">✅ No hay compromisos pendientes esta semana</p>
        </div>
      `;
    }

    const aiHtml = org.aiAnalysis ? `
      <div style="margin-top: 20px; padding: 16px; background: linear-gradient(135deg, rgba(34, 211, 238, 0.08) 0%, rgba(236, 72, 153, 0.08) 100%); border: 1px solid rgba(34, 211, 238, 0.2); border-radius: 8px;">
        <h3 style="color: #22d3ee; font-size: 14px; margin: 0 0 10px;">🤖 Análisis de Aike</h3>
        <p style="color: #cbd5e1; font-size: 14px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${org.aiAnalysis}</p>
      </div>
    ` : '';

    return `
      <div style="margin-bottom: 30px; padding: 24px; background: #1e293b; border-radius: 12px; border: 1px solid #334155;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <h2 style="color: #f1f5f9; font-size: 20px; margin: 0;">🏢 ${org.orgName}</h2>
        </div>

        <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px;">
          <div style="flex: 1; min-width: 120px;">
            <div style="color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 4px;">Salud Financiera</div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="color: ${healthColor}; font-size: 28px; font-weight: 700;">${org.healthScore}%</span>
              <span style="color: ${healthColor}; font-size: 13px;">${healthLabel}</span>
            </div>
          </div>
          <div style="flex: 1; min-width: 120px;">
            <div style="color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 4px;">Saldos</div>
            ${balanceHtml}
          </div>
        </div>

        <div style="display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px;">
          <div style="padding: 12px 16px; background: #0f172a; border-radius: 8px; flex: 1; min-width: 100px;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Ingresos mes</div>
            <div style="color: #4ade80; font-size: 16px; font-weight: 600;">${formatRecord(org.monthlyIncome)}</div>
          </div>
          <div style="padding: 12px 16px; background: #0f172a; border-radius: 8px; flex: 1; min-width: 100px;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Gastos mes</div>
            <div style="color: #f87171; font-size: 16px; font-weight: 600;">${formatRecord(org.monthlyExpense)}</div>
          </div>
          <div style="padding: 12px 16px; background: #0f172a; border-radius: 8px; flex: 1; min-width: 100px;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Por cobrar</div>
            <div style="color: #22d3ee; font-size: 16px; font-weight: 600;">${formatRecord(org.totalReceivable)}</div>
          </div>
          <div style="padding: 12px 16px; background: #0f172a; border-radius: 8px; flex: 1; min-width: 100px;">
            <div style="color: #64748b; font-size: 11px; text-transform: uppercase;">Por pagar</div>
            <div style="color: #fb923c; font-size: 16px; font-weight: 600;">${formatRecord(org.totalPayable)}</div>
          </div>
        </div>

        ${calendarHtml}
        ${aiHtml}
      </div>
    `;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resumen Semanal - Aikestar</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 680px; width: 100%; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #334155; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);">
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; border-bottom: 1px solid #334155;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; background: linear-gradient(135deg, #22d3ee 0%, #ec4899 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                Aikestar
              </h1>
              <p style="margin: 8px 0 0; color: #94a3b8; font-size: 14px;">
                Resumen Semanal
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 40px;">
              <p style="color: #e2e8f0; font-size: 16px; margin: 0 0 8px;">
                Hola ${userName} 👋
              </p>
              <p style="color: #94a3b8; font-size: 14px; margin: 0 0 24px;">
                Acá tenés tu resumen financiero para la semana del <strong style="color: #e2e8f0;">${weekLabel}</strong>
              </p>
              ${orgsHtml}
              <div style="text-align: center; margin: 32px 0 16px;">
                <a href="${appUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #22d3ee 0%, #0891b2 100%); color: #0f172a; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                  Ir a Aikestar
                </a>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px 40px 40px; text-align: center; border-top: 1px solid #334155;">
              <p style="margin: 0; color: #64748b; font-size: 12px;">
                Este resumen se envía automáticamente cada lunes a las 6:00 AM.
              </p>
              <p style="margin: 8px 0 0; color: #475569; font-size: 11px;">
                <a href="${appUrl}" style="color: #22d3ee; text-decoration: none;">Aikestar</a> - Sistema de Gestión Administrativa e Inteligente
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

async function sendWeeklyDigestEmail(userEmail: string, html: string): Promise<boolean> {
  try {
    const manualApiKey = process.env.SENDGRID_API_KEY;
    const manualFromEmail = process.env.SENDGRID_FROM_EMAIL;
    
    let apiKey: string;
    let fromEmail: string;
    
    if (manualApiKey && manualFromEmail) {
      apiKey = manualApiKey;
      fromEmail = manualFromEmail;
    } else {
      const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
      const xReplitToken = process.env.REPL_IDENTITY
        ? 'repl ' + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? 'depl ' + process.env.WEB_REPL_RENEWAL
        : null;

      if (!hostname || !xReplitToken) {
        console.error('[WeeklyDigest] No SendGrid credentials available');
        return false;
      }

      const url = 'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=sendgrid';
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken }
      });

      if (!response.ok) {
        console.error('[WeeklyDigest] Connector API error:', response.status);
        return false;
      }

      const data = await response.json();
      const conn = data.items?.[0];
      if (!conn?.settings?.api_key || !conn?.settings?.from_email) {
        console.error('[WeeklyDigest] Missing SendGrid settings');
        return false;
      }
      apiKey = conn.settings.api_key;
      fromEmail = conn.settings.from_email;
    }

    const client = new MailService();
    client.setApiKey(apiKey);

    await client.send({
      to: userEmail,
      from: { email: fromEmail, name: 'Aikestar' },
      subject: '📊 Tu resumen semanal de Aikestar',
      html,
    });

    return true;
  } catch (error: any) {
    console.error('[WeeklyDigest] Email send error:', error.message);
    return false;
  }
}

export async function generateWeeklyDigestForUser(
  userId: string,
  opts?: { enforceOnce?: boolean; weekStartKey?: string }
): Promise<{ sent: boolean; orgsProcessed: number; alreadySent?: boolean }> {
  const getUser = __testDeps?.getUser ?? ((id: string) => storage.getUser(id));
  const getOrganizationsByUser = __testDeps?.getOrganizationsByUser ?? ((id: string) => storage.getOrganizationsByUser(id));
  const getAccountsByOrganization = __testDeps?.getAccountsByOrganization ?? ((id: string) => storage.getAccountsByOrganization(id));
  const getTransactionsByOrganization = __testDeps?.getTransactionsByOrganization ?? ((id: string) => storage.getTransactionsByOrganization(id));
  const runAIAnalysis = __testDeps?.generateAIAnalysis ?? generateAIAnalysis;
  const sendEmail = __testDeps?.sendEmail ?? sendWeeklyDigestEmail;

  const user = await getUser(userId);
  if (!user) return { sent: false, orgsProcessed: 0 };

  const userOrgs = await getOrganizationsByUser(userId);
  if (userOrgs.length === 0) return { sent: false, orgsProcessed: 0 };

  const now = new Date();
  // CRÍTICO (Task #506): la semana de idempotencia y de contenido tienen que ser
  // la MISMA que usó el wake trigger para decidir el envío, y esa se calcula en
  // hora Argentina. Si acá usáramos startOfWeek(now) en UTC, en la ventana de
  // borde (domingo noche ART = lunes UTC) la clave del claim divergiría de la del
  // trigger y rompería la dedup. El runner pasa weekStartKey (= weekKey ART); el
  // path admin manual no lo pasa y cae al cálculo UTC histórico (sin claim).
  const weekStart = opts?.weekStartKey
    ? startOfWeek(new Date(`${opts.weekStartKey}T00:00:00`), { weekStartsOn: 1 })
    : startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
  const weekStartKey = opts?.weekStartKey ?? format(weekStart, 'yyyy-MM-dd');

  // Short-circuit barato (Task #506): si el envío de esta semana ya está
  // registrado, salteamos ANTES de armar los datos y llamar a la IA. Esto hace
  // que los despertares repetidos de la app (que re-corren el lote) sean
  // baratos para los usuarios ya enviados. Solo aplica con enforceOnce (el path
  // de prueba admin pasa enforceOnce=false y nunca se saltea).
  if (opts?.enforceOnce) {
    const weekStartStr = weekStartKey;
    if (await wasWeeklyDigestSent(userId, weekStartStr)) {
      return { sent: false, orgsProcessed: 0, alreadySent: true };
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const orgsData: OrgDigestData[] = [];

  for (const org of userOrgs) {
    try {
      const accounts = await getAccountsByOrganization(org.id);
      const transactions = await getTransactionsByOrganization(org.id);

      const totalBalance: Record<string, number> = {};
      for (const acc of accounts) {
        let bal = parseFloat(acc.balance?.toString() || '0');
        if (acc.accountCategory === 'investment') {
          const accrued = calculateAccruedInterest(acc);
          if (accrued > 0) bal = parseFloat(acc.initialInvestment || '0') + accrued;
        }
        const curr = acc.currency || 'ARS';
        totalBalance[curr] = (totalBalance[curr] || 0) + bal;
      }

      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      const getTransCurrency = (t: Transaction) => t.currency || 'ARS';

      const isPending = (t: Transaction) => t.status !== 'completed' && t.status !== 'cancelled';

      const monthlyIncome: Record<string, number> = {};
      const monthlyExpense: Record<string, number> = {};
      const totalPayable: Record<string, number> = {};
      const totalReceivable: Record<string, number> = {};
      const overduePayablesRecord: Record<string, number> = {};

      for (const t of transactions) {
        const d = safeParseDate(t.date);
        const curr = getTransCurrency(t);
        const amt = normalizeAmount(t.amount);

        if (t.type === 'income' && d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
          addToRecord(monthlyIncome, curr, amt);
        }
        if (t.type === 'expense' && d.getMonth() === currentMonth && d.getFullYear() === currentYear) {
          addToRecord(monthlyExpense, curr, amt);
        }
        if (t.type === 'payable' && isPending(t)) {
          addToRecord(totalPayable, curr, amt);
          if (safeParseDate(t.date) < today) {
            addToRecord(overduePayablesRecord, curr, amt);
          }
        }
        if (t.type === 'receivable' && isPending(t)) {
          addToRecord(totalReceivable, curr, amt);
        }
      }

      const pendingCommitments = transactions.filter(t =>
        (t.type === 'payable' || t.type === 'receivable') && isPending(t)
      );

      const weeklyCommitments: WeeklyCommitment[] = [];
      const overdueCommitments: WeeklyCommitment[] = [];

      for (const c of pendingCommitments) {
        const dueDate = safeParseDate(c.date);
        dueDate.setHours(0, 0, 0, 0);
        const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        const isOverdue = daysUntilDue < 0;
        const isDueToday = daysUntilDue === 0;

        const commitment: WeeklyCommitment = {
          id: c.id,
          type: c.type as 'payable' | 'receivable',
          description: c.description || 'Sin descripción',
          amount: normalizeAmount(c.amount),
          currency: c.currency || 'ARS',
          date: dueDate,
          daysUntilDue,
          isOverdue,
          isDueToday,
        };

        if (isOverdue) {
          overdueCommitments.push(commitment);
        } else if (dueDate >= weekStart && dueDate <= weekEnd) {
          weeklyCommitments.push(commitment);
        }
      }

      const healthScore = calculateSimpleHealthScore(totalBalance, totalPayable, totalReceivable, overduePayablesRecord, accounts);

      const aiAnalysis = await runAIAnalysis({
        orgName: org.name,
        totalBalance,
        monthlyIncome,
        monthlyExpense,
        healthScore,
        weeklyCommitments,
        overdueCommitments,
        totalPayable,
        totalReceivable,
      });

      orgsData.push({
        orgName: org.name,
        orgId: org.id,
        accounts,
        weeklyCommitments,
        overdueCommitments,
        totalBalance,
        totalPayable,
        totalReceivable,
        monthlyIncome,
        monthlyExpense,
        healthScore,
        aiAnalysis,
      });
    } catch (error) {
      console.error(`[WeeklyDigest] Error processing org ${org.id}:`, error);
    }
  }

  if (orgsData.length === 0) return { sent: false, orgsProcessed: 0 };

  const userName = user.name || user.email.split('@')[0];
  const emailHtml = buildWeeklyEmailHtml(userName, orgsData, weekStart, weekEnd);

  // Idempotencia (Task #504): cuando el envío lo dispara el trigger "al
  // despertar" (o el trigger admin de "todos los usuarios"), reclamamos primero
  // la fila (user_id, week_start). Si ya existe, otro envío de esta semana ya
  // ocurrió (o está en curso) y salteamos para no duplicar el mail. Esto cubre
  // la carrera entre procesos que el short-circuit barato de arriba no atrapa.
  // Si el envío falla, liberamos el claim para que el próximo intento reenvíe.
  // El test admin (que se manda el resumen a sí mismo) pasa enforceOnce=false,
  // así puede probarse las veces que quiera sin quedar bloqueado.
  if (opts?.enforceOnce) {
    const weekStartStr = weekStartKey;
    const claimed = await claimWeeklyDigestSend(userId, weekStartStr);

    if (!claimed) {
      return { sent: false, orgsProcessed: orgsData.length, alreadySent: true };
    }

    const sent = await sendEmail(user.email, emailHtml);
    if (!sent) {
      await releaseWeeklyDigestSend(userId, weekStartStr);
    }
    return { sent, orgsProcessed: orgsData.length };
  }

  const sent = await sendEmail(user.email, emailHtml);

  return { sent, orgsProcessed: orgsData.length };
}

// Task #309 — Reglas de elegibilidad para el resumen semanal.
//
// Antes de este cambio, el cron de los lunes le mandaba el mail a TODOS los
// usuarios de la base sin filtrar nada. Los 7 usuarios bloqueados por falta
// de pago (cancelled, past_due fuera de gracia, unpaid, pending) seguían
// recibiéndolo aunque la app les muestre 402 al entrar.
//
// La regla espeja al middleware `requireSubscription`:
//  - usuarios con `deletedAt` no reciben el mail (cuenta dada de baja).
//  - se mira primero la suscripción propia: `active`/`trialing` son OK;
//    `past_due` dentro de 7 días de `paymentFailedAt` también (esos
//    usuarios todavía pueden entrar a la app y el mail los ayuda a no
//    olvidarse de actualizar el pago); `past_due` sin `paymentFailedAt`
//    también pasa (fail-open, igual que el middleware).
//  - si la suscripción propia no alcanza, se cae al fallback: si el usuario
//    es miembro de una organización cuyo dueño tiene una suscripción válida,
//    también recibe el mail (los miembros heredan acceso del dueño).
//  - cualquier otro caso queda inelegible y se loguea agregado por motivo.
//
// `reason` queda explícito para el log agregado del cron.
const WEEKLY_DIGEST_ACTIVE_STATUSES = new Set(['active', 'trialing']);
const WEEKLY_DIGEST_GRACE_DAYS = 7;

type EligibilityReason =
  | 'eligible'
  | 'deleted'
  | 'no_subscription'
  | 'cancelled'
  | 'unpaid'
  | 'pending'
  | 'past_due_expired'
  | 'unknown_status';

type SubscriptionLike = Pick<Subscription, 'status' | 'paymentFailedAt'>;

function subscriptionAllowsDigest(
  sub: SubscriptionLike | null | undefined,
): { ok: boolean; reason: EligibilityReason } {
  if (!sub) return { ok: false, reason: 'no_subscription' };
  if (WEEKLY_DIGEST_ACTIVE_STATUSES.has(sub.status)) {
    return { ok: true, reason: 'eligible' };
  }
  if (sub.status === 'past_due') {
    if (!sub.paymentFailedAt) {
      // Fail-open, mismo criterio que el middleware.
      return { ok: true, reason: 'eligible' };
    }
    const failedAt = new Date(sub.paymentFailedAt);
    const daysSince = Math.floor((Date.now() - failedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince < WEEKLY_DIGEST_GRACE_DAYS) {
      return { ok: true, reason: 'eligible' };
    }
    return { ok: false, reason: 'past_due_expired' };
  }
  if (sub.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (sub.status === 'unpaid') return { ok: false, reason: 'unpaid' };
  if (sub.status === 'pending') return { ok: false, reason: 'pending' };
  return { ok: false, reason: 'unknown_status' };
}

export async function isEligibleForWeeklyDigest(userId: string): Promise<{
  eligible: boolean;
  reason: EligibilityReason;
}> {
  try {
    const user = await storage.getUser(userId);
    if (!user) return { eligible: false, reason: 'deleted' };
    if (user.deletedAt) return { eligible: false, reason: 'deleted' };

    const ownSub = await storage.getSubscriptionByUserId(userId);
    const ownCheck = subscriptionAllowsDigest(ownSub ?? null);

    // Task #318 — Defensa adicional contra duplicados en `subscriptions`.
    // Aunque `getSubscriptionByUserId` ya deduplica por
    // `stripe_subscription_id` quedándose con la fila más reciente, puede
    // pasar que existan filas hermanas con el mismo stripe_subscription_id
    // marcadas como `cancelled`/`unpaid` con `updatedAt` viejo. Si alguna
    // hermana del subscription_id ganador está cancelada/impaga, el
    // usuario queda inelegible incluso si la fila ganadora dice
    // active/trialing — Stripe es la verdad. Esto evita seguir mandando el
    // digest los lunes a usuarios cuya suscripción real está muerta pero
    // tienen residuos viejos optimistas en la base.
    if (ownCheck.ok && ownSub?.stripeSubscriptionId) {
      const siblings = await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.stripeSubscriptionId, ownSub.stripeSubscriptionId));
      const hasDeadSibling = siblings.some(
        (s) => s.status === 'cancelled' || s.status === 'unpaid',
      );
      if (hasDeadSibling) {
        const deadReason: EligibilityReason = siblings.some((s) => s.status === 'unpaid')
          ? 'unpaid'
          : 'cancelled';
        return { eligible: false, reason: deadReason };
      }
    }

    if (ownCheck.ok) return { eligible: true, reason: 'eligible' };

    // Fallback: si es miembro de alguna organización cuyo dueño tiene una
    // suscripción válida, también recibe el mail. Si todos los owners están
    // bloqueados, reportamos el motivo del owner más informativo (no el
    // genérico del propio usuario) para que el log agregado sirva de auditoría.
    let ownerFallbackReason: EligibilityReason | null = null;
    const orgs = await storage.getOrganizationsByUser(userId);
    for (const org of orgs) {
      const owner = await storage.getOrganizationOwner(org.id);
      if (!owner || owner.id === userId) continue;
      const ownerSub = await storage.getSubscriptionByUserId(owner.id);
      const ownerCheck = subscriptionAllowsDigest(ownerSub ?? null);
      if (ownerCheck.ok) return { eligible: true, reason: 'eligible' };
      // Conservamos el primer motivo bloqueante encontrado en algún owner.
      if (!ownerFallbackReason) ownerFallbackReason = ownerCheck.reason;
    }

    return { eligible: false, reason: ownerFallbackReason ?? ownCheck.reason };
  } catch (err) {
    // Fail-open, igual que el middleware `requireSubscription`: un error
    // transitorio de DB no debería frenar el envío a un usuario que en
    // realidad sí tiene acceso a la app.
    console.error(`[WeeklyDigest] Eligibility check error for user ${userId} (fail-open):`, err);
    return { eligible: true, reason: 'eligible' };
  }
}

export async function runWeeklyDigestForAllUsers(): Promise<{
  usersProcessed: number;
  usersSkipped: number;
  emailsSent: number;
  errors: number;
  skippedByReason: Record<string, number>;
}> {
  console.log('[WeeklyDigest] Starting weekly digest generation...');
  const startTime = Date.now();

  // Seam de testing (Task #507): en producción usamos storage.getAllUsers e
  // isEligibleForWeeklyDigest; en tests se inyectan para probar el conteo de
  // errores del lote sin Postgres ni SendGrid reales.
  const getAllUsers = __testDeps?.getAllUsers ?? (() => storage.getAllUsers());
  const checkEligible = __testDeps?.isEligible ?? ((id: string) => isEligibleForWeeklyDigest(id));

  const allUsers = await getAllUsers();
  let emailsSent = 0;
  let errors = 0;
  let usersSkipped = 0;
  const skippedByReason: Record<string, number> = {};

  // Una sola clave de semana (hora Argentina) para TODO el lote, así la
  // idempotencia por usuario y el gate in-memory del wake trigger comparten
  // exactamente la misma semana (evita divergencias en la ventana de borde).
  const { weekKey } = getArgentinaWeekTrigger();

  for (const user of allUsers) {
    try {
      const eligibility = await checkEligible(user.id);
      if (!eligibility.eligible) {
        usersSkipped++;
        skippedByReason[eligibility.reason] = (skippedByReason[eligibility.reason] || 0) + 1;
        continue;
      }
      const result = await generateWeeklyDigestForUser(user.id, { enforceOnce: true, weekStartKey: weekKey });
      if (result.sent) {
        emailsSent++;
        console.log(`[WeeklyDigest] Email sent to ${user.email} (${result.orgsProcessed} orgs)`);
      } else if (result.alreadySent) {
        usersSkipped++;
        skippedByReason['already_sent'] = (skippedByReason['already_sent'] || 0) + 1;
      } else {
        // sent:false sin alreadySent = el envío falló (el claim ya se liberó en
        // generateWeeklyDigestForUser). Lo contamos como error para que el wake
        // trigger NO selle la semana (lastCompletedWeekKey solo se fija con
        // errors===0) y reintente a este usuario en el próximo despertar.
        errors++;
        console.error(`[WeeklyDigest] Email send failed for ${user.email}`);
      }
    } catch (error) {
      errors++;
      console.error(`[WeeklyDigest] Error for user ${user.id}:`, error);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  const skippedSummary = Object.entries(skippedByReason)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ') || 'none';
  console.log(
    `[WeeklyDigest] Completed in ${duration}s - ${allUsers.length} users, ` +
    `${emailsSent} emails sent, ${usersSkipped} skipped (${skippedSummary}), ${errors} errors`
  );

  return { usersProcessed: allUsers.length, usersSkipped, emailsSent, errors, skippedByReason };
}

// -----------------------------------------------------------------------------
// Trigger "al despertar" (Task #506)
//
// El deployment principal es Autoscale (escala a cero): a las 6 AM del lunes el
// contenedor está dormido y un node-cron in-process nunca dispara. En vez de
// depender de un reloj a una hora fija, la app aprovecha cada vez que se
// despierta (boot tras dormir, o tráfico mientras está despierta): si ya pasó
// el lunes 6 AM (hora Argentina) de la semana en curso y todavía no se envió el
// resumen, lo manda en ese momento. La idempotencia por (user, week) garantiza
// un solo mail por usuario por semana aunque la app se despierte muchas veces.
const WAKE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // re-chequeo mientras está despierta
const WAKE_COOLDOWN_MS = 15 * 60 * 1000; // mínimo entre intentos de lote
let digestRunning = false;
let lastCompletedWeekKey: string | null = null;
let lastWakeAttemptAt = 0;
let wakeInterval: ReturnType<typeof setInterval> | null = null;

// Calcula, en hora de Argentina, la "semana" del resumen y si ya corresponde
// enviarlo. CRÍTICO: la clave de semana y el chequeo horario tienen que vivir en
// la MISMA zona. Si la clave se calculara en UTC (startOfWeek) y el horario en
// ART, en la ventana de borde (domingo 21:00–23:59 ART = lunes UTC) la clave
// saltaría a la semana siguiente mientras el reloj ART todavía marca domingo, y
// el resumen se mandaría hasta 9 h antes de tiempo.
//
// weekKey = lunes (ART) de la semana en curso, en formato yyyy-MM-dd (semanas
// que empiezan el lunes). isDue = ya pasó el lunes 06:00 ART de esa semana; solo
// es false el tramo lunes 00:00–05:59 ART (recién empieza la semana, falta la
// hora del envío). De martes a domingo isDue es true: si por lo que sea no se
// envió el lunes, el resumen igual sale más tarde esa misma semana.
const ART_TZ = 'America/Argentina/Buenos_Aires';
const ART_WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

export function getArgentinaWeekTrigger(now: Date = new Date()): {
  weekKey: string;
  isDue: boolean;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ART_TZ,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const hour = parseInt(get('hour') || '0', 10);
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);

  // Aritmética de calendario sobre los componentes ART (tratados como números):
  // restamos el índice de día de semana para llegar al lunes de esa semana ART.
  const dowIndex = ART_WEEKDAY_INDEX[weekday] ?? 0;
  const monday = new Date(Date.UTC(year, month - 1, day));
  monday.setUTCDate(monday.getUTCDate() - dowIndex);
  const weekKey = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;

  const isDue = !(weekday === 'Mon' && hour < 6);
  return { weekKey, isDue };
}

// Núcleo del trigger: corre el lote si corresponde. Es seguro llamarlo seguido
// (en boot y en cada tick del interval); se auto-gatea para no solaparse ni
// repetir el lote sin necesidad.
export async function maybeRunWeeklyDigestOnWake(trigger: string = 'wake'): Promise<void> {
  try {
    const now = new Date();
    const { weekKey, isDue } = getArgentinaWeekTrigger(now);
    if (lastCompletedWeekKey === weekKey) return; // este proceso ya completó la semana
    if (!isDue) return; // todavía no es lunes 6 AM ART de esta semana
    if (digestRunning) return; // ya hay un lote en curso en este proceso
    if (Date.now() - lastWakeAttemptAt < WAKE_COOLDOWN_MS) return; // throttle

    digestRunning = true;
    lastWakeAttemptAt = Date.now();
    console.log(`[WeeklyDigest] Catch-up al despertar (trigger=${trigger}, semana=${weekKey})`);
    try {
      const result = await runWeeklyDigestForAllUsers();
      // Solo marcamos la semana como completada si no hubo errores, para que un
      // fallo parcial se reintente en el próximo despertar (auto-reparable). La
      // idempotencia por usuario evita reenviar a los que sí salieron.
      if (result.errors === 0) {
        lastCompletedWeekKey = weekKey;
      }
    } finally {
      digestRunning = false;
    }
  } catch (err) {
    console.error('[WeeklyDigest] Error en catch-up al despertar:', err);
  }
}

// Arranca el trigger: una verificación al bootear (la app acaba de despertar) y
// un re-chequeo periódico mientras siga viva. Activo en producción (mecanismo
// real de envío); en desarrollo queda apagado salvo ENABLE_INPROCESS_DIGEST_CRON
// =true, para no blastear mails reales en cada arranque local.
export function startWeeklyDigestWakeTrigger(): void {
  const inProd = process.env.NODE_ENV === 'production';
  if (!inProd && process.env.ENABLE_INPROCESS_DIGEST_CRON !== 'true') {
    console.log('[WeeklyDigest] Wake trigger inactivo fuera de producción (definí ENABLE_INPROCESS_DIGEST_CRON=true para forzarlo).');
    return;
  }
  void maybeRunWeeklyDigestOnWake('boot');
  if (!wakeInterval) {
    wakeInterval = setInterval(() => {
      void maybeRunWeeklyDigestOnWake('interval');
    }, WAKE_CHECK_INTERVAL_MS);
    if (typeof wakeInterval.unref === 'function') wakeInterval.unref();
  }
  console.log('[WeeklyDigest] Wake trigger activo (envía al despertar si pasó el lunes 6 AM ART y falta esta semana).');
}

export function stopWeeklyDigestWakeTrigger(): void {
  if (wakeInterval) {
    clearInterval(wakeInterval);
    wakeInterval = null;
  }
}

export function startWeeklyDigestCron(): void {
  // Task #504/#506: en producción el deployment principal es Autoscale (escala
  // a cero), así que un node-cron in-process NO se dispara confiablemente los
  // lunes 6 AM: el contenedor está dormido y el cron nunca corre. El envío real
  // lo hace ahora el trigger "al despertar" (startWeeklyDigestWakeTrigger).
  // Dejamos este cron in-process solo para desarrollo/pruebas, o si se habilita
  // explícitamente con ENABLE_INPROCESS_DIGEST_CRON=true (la idempotencia evita
  // envíos dobles si coexiste con el wake trigger).
  const inProd = process.env.NODE_ENV === 'production';
  if (inProd && process.env.ENABLE_INPROCESS_DIGEST_CRON !== 'true') {
    console.log('[WeeklyDigest] In-process cron deshabilitado en producción (usa el wake trigger). Definí ENABLE_INPROCESS_DIGEST_CRON=true para forzarlo.');
    return;
  }

  if (weeklyJob) {
    console.log('[WeeklyDigest] Cron job already running');
    return;
  }

  const options = { timezone: 'America/Argentina/Buenos_Aires' };
  weeklyJob = cron.schedule('0 6 * * 1', async () => {
    console.log('[WeeklyDigest] Weekly digest cron triggered');
    try {
      await runWeeklyDigestForAllUsers();
    } catch (error) {
      console.error('[WeeklyDigest] Cron execution error:', error);
    }
  }, options as any);

  console.log('[WeeklyDigest] Weekly digest cron started (Mondays 6:00 AM Argentina time)');
}

export function stopWeeklyDigestCron(): void {
  if (weeklyJob) {
    weeklyJob.stop();
    weeklyJob = null;
    console.log('[WeeklyDigest] Cron job stopped');
  }
}
