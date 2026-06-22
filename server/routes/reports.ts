import type { Express } from 'express';
import { storage } from '../storage';
import { requireAuth, sanitizeError } from './middleware';
import { ADMIN_ROLES } from '@shared/schema';

const ADMIN_ROLE_SET = new Set<string>(ADMIN_ROLES);

function arDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function daysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number);
  const [ty, tm, td] = toKey.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86400000);
}

interface Bucket {
  overdue: number;
  today: number;
  week: number;
  later: number;
  total: number;
}

interface OrgCurrencyRow {
  orgId: string;
  orgName: string;
  logoUrl: string | null;
  currency: string;
  operativeBalance: number;
  receivable: Bucket;
  payable: Bucket;
}

export function registerReportsRoutes(app: Express) {
  app.get('/api/reports/cross-org-summary', requireAuth, async (req: any, res) => {
    try {
      const orgs = await storage.getOrganizationsByUser(req.userId);
      const adminOrgs = orgs.filter((o) => ADMIN_ROLE_SET.has(o.membershipRole));

      if (adminOrgs.length < 2) {
        return res.json({ organizations: [] });
      }

      const todayKey = arDateKey(new Date());
      const rows: OrgCurrencyRow[] = [];

      await Promise.all(
        adminOrgs.map(async (org) => {
          const [accs, txs] = await Promise.all([
            storage.getAccountsByOrganization(org.id),
            storage.getTransactionsByOrganization(org.id, 'scheduled'),
          ]);

          const perCurrency = new Map<
            string,
            { operativeBalance: number; receivable: Bucket; payable: Bucket }
          >();

          const ensure = (cur: string) => {
            let bucket = perCurrency.get(cur);
            if (!bucket) {
              bucket = {
                operativeBalance: 0,
                receivable: { overdue: 0, today: 0, week: 0, later: 0, total: 0 },
                payable: { overdue: 0, today: 0, week: 0, later: 0, total: 0 },
              };
              perCurrency.set(cur, bucket);
            }
            return bucket;
          };

          for (const a of accs) {
            if ((a.accountCategory || 'operative') !== 'operative') continue;
            const cur = a.currency || 'ARS';
            ensure(cur).operativeBalance += Number(a.balance || 0);
          }

          for (const t of txs) {
            if (t.type !== 'receivable' && t.type !== 'payable') continue;
            if (t.status !== 'scheduled') continue;
            const cur = t.currency || 'ARS';
            const bucket = ensure(cur);
            const dir = t.type === 'receivable' ? bucket.receivable : bucket.payable;
            const amt = Number(t.amount || 0);
            const dueKey = arDateKey(new Date(t.date as any));
            const diff = daysBetween(todayKey, dueKey);
            if (diff < 0) dir.overdue += amt;
            else if (diff === 0) dir.today += amt;
            else if (diff <= 7) dir.week += amt;
            else dir.later += amt;
            dir.total += amt;
          }

          for (const [currency, agg] of perCurrency) {
            rows.push({
              orgId: org.id,
              orgName: org.name,
              logoUrl: org.logoUrl || null,
              currency,
              ...agg,
            });
          }
        }),
      );

      rows.sort(
        (a, b) =>
          a.orgName.localeCompare(b.orgName, 'es') ||
          a.currency.localeCompare(b.currency),
      );

      res.json({ organizations: rows });
    } catch (err: any) {
      console.error('[Reports] cross-org-summary error:', err);
      res.status(500).json({ message: sanitizeError(err) });
    }
  });
}
