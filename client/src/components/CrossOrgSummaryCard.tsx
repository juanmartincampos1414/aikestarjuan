import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Building2, Loader2, ArrowRight } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api';
import { useSwitchOrganization } from '@/lib/hooks';
import { CURRENCY_SYMBOLS } from '@shared/schema';
import { useToast } from '@/hooks/use-toast';

interface Bucket {
  overdue: number;
  today: number;
  week: number;
  later: number;
  total: number;
}

interface Row {
  orgId: string;
  orgName: string;
  logoUrl?: string | null;
  currency: string;
  operativeBalance: number;
  receivable: Bucket;
  payable: Bucket;
}

interface OrgGroup {
  orgId: string;
  orgName: string;
  logoUrl?: string | null;
  rows: Row[];
}

function formatAmount(value: number, currency: string): string {
  const symbol = (CURRENCY_SYMBOLS as Record<string, string>)[currency] || currency;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value).toLocaleString('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${symbol} ${abs}`;
}

function orgInitials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?';
}

function PendingChips({
  bucket,
  currency,
  variant,
  orgId,
}: {
  bucket: Bucket;
  currency: string;
  variant: 'receivable' | 'payable';
  orgId: string;
}) {
  const chips: Array<{ label: string; value: number; color: string; testId: string }> = [];
  if (bucket.overdue > 0)
    chips.push({
      label: 'Vencido',
      value: bucket.overdue,
      color: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30',
      testId: 'overdue',
    });
  if (bucket.today > 0)
    chips.push({
      label: 'Hoy',
      value: bucket.today,
      color: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30',
      testId: 'today',
    });
  if (bucket.week > 0)
    chips.push({
      label: '7 días',
      value: bucket.week,
      color: 'bg-[#00D4FF]/15 text-[#00D4FF] border-[#00D4FF]/30',
      testId: 'week',
    });
  if (chips.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.testId}
          className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${c.color}`}
          data-testid={`chip-${variant}-${c.testId}-${orgId}-${currency}`}
        >
          {c.label}: {formatAmount(c.value, currency)}
        </span>
      ))}
    </div>
  );
}

function MetricBlock({
  label,
  value,
  currency,
  bucket,
  variant,
  orgId,
}: {
  label: string;
  value: number;
  currency: string;
  bucket: Bucket;
  variant: 'receivable' | 'payable';
  orgId: string;
}) {
  const isZero = value === 0;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 font-mono text-sm font-semibold ${
          isZero ? 'text-muted-foreground/60' : variant === 'payable' ? 'text-foreground' : 'text-foreground'
        }`}
      >
        {formatAmount(value, currency)}
      </div>
      <PendingChips bucket={bucket} currency={currency} variant={variant} orgId={orgId} />
    </div>
  );
}

function OrgAvatar({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <img
        src={logoUrl}
        alt={name}
        onError={() => setFailed(true)}
        className="h-9 w-9 shrink-0 rounded-lg border border-slate-200/70 bg-white object-cover shadow-sm dark:border-slate-700/60 dark:bg-slate-900"
        data-testid={`img-org-logo-${name}`}
      />
    );
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#00D4FF] to-[#FF3366] text-xs font-bold text-white shadow-sm">
      {orgInitials(name)}
    </div>
  );
}

function OrgCard({
  group,
  onClick,
  disabled,
}: {
  group: OrgGroup;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && onClick()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group relative overflow-hidden rounded-xl border border-[#00D4FF]/20 bg-gradient-to-br from-white via-white to-[#00D4FF]/[0.04] p-4 transition-all dark:from-slate-900/40 dark:via-slate-900/40 dark:to-[#00D4FF]/[0.06] ${
        disabled
          ? 'cursor-wait opacity-70'
          : 'cursor-pointer hover:border-[#00D4FF]/60 hover:shadow-lg hover:shadow-[#00D4FF]/10 focus:outline-none focus:ring-2 focus:ring-[#00D4FF]/40'
      }`}
      data-testid={`card-cross-org-${group.orgId}`}
      title={`Ir a ${group.orgName}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <OrgAvatar name={group.orgName} logoUrl={group.logoUrl} />
          <div className="min-w-0">
            <div className="truncate font-semibold text-sm" data-testid={`text-org-name-${group.orgId}`}>
              {group.orgName}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {group.rows.length} {group.rows.length === 1 ? 'moneda' : 'monedas'}
            </div>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-[#00D4FF] opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      <div className="space-y-2">
        {group.rows.map((r) => (
          <div
            key={r.currency}
            className="rounded-lg border border-slate-200/60 bg-slate-50/60 p-3 dark:border-slate-800/60 dark:bg-slate-900/30"
            data-testid={`row-cross-org-${r.orgId}-${r.currency}`}
          >
            <div className="mb-2 flex items-center justify-between">
              <Badge
                variant="outline"
                className="border-[#00D4FF]/30 bg-[#00D4FF]/5 font-mono text-[10px] text-[#00D4FF]"
              >
                {r.currency}
              </Badge>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Saldo operativo
                </div>
                <div
                  className={`font-mono text-sm font-bold ${
                    r.operativeBalance < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                  }`}
                >
                  {formatAmount(r.operativeBalance, r.currency)}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-slate-200/60 pt-2 dark:border-slate-800/60">
              <MetricBlock
                label="A cobrar"
                value={r.receivable.total}
                currency={r.currency}
                bucket={r.receivable}
                variant="receivable"
                orgId={r.orgId}
              />
              <MetricBlock
                label="A pagar"
                value={r.payable.total}
                currency={r.currency}
                bucket={r.payable}
                variant="payable"
                orgId={r.orgId}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CrossOrgSummaryCard() {
  const switchOrg = useSwitchOrganization();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<{ organizations: Row[] }>({
    queryKey: ['/reports/cross-org-summary'],
    queryFn: () => fetchWithAuth('/reports/cross-org-summary'),
    staleTime: 60_000,
    retry: false,
  });

  const groups = useMemo<OrgGroup[]>(() => {
    const rows = data?.organizations || [];
    const map = new Map<string, OrgGroup>();
    for (const r of rows) {
      const g =
        map.get(r.orgId) ||
        { orgId: r.orgId, orgName: r.orgName, logoUrl: r.logoUrl ?? null, rows: [] };
      g.rows.push(r);
      map.set(r.orgId, g);
    }
    return Array.from(map.values());
  }, [data]);

  const totalsByCurrency = useMemo(() => {
    const rows = data?.organizations || [];
    const m = new Map<
      string,
      { operativeBalance: number; receivableTotal: number; payableTotal: number }
    >();
    for (const r of rows) {
      const t = m.get(r.currency) || {
        operativeBalance: 0,
        receivableTotal: 0,
        payableTotal: 0,
      };
      t.operativeBalance += r.operativeBalance;
      t.receivableTotal += r.receivable.total;
      t.payableTotal += r.payable.total;
      m.set(r.currency, t);
    }
    return Array.from(m.entries());
  }, [data]);

  if (isLoading || error) return null;
  if (groups.length === 0) return null;

  const handleClick = async (orgId: string, orgName: string) => {
    if (switchOrg.isPending) return;
    try {
      await switchOrg.mutateAsync(orgId);
      toast({ title: 'Cambiaste de organización', description: orgName });
    } catch (e: any) {
      toast({
        title: 'No pudimos cambiar de organización',
        description: e?.message || 'Intentá de nuevo en unos segundos',
        variant: 'destructive',
      });
    }
  };

  return (
    <Card
      className="overflow-hidden border-2 border-[#00D4FF]/30 bg-gradient-to-br from-[#00D4FF]/[0.04] via-transparent to-[#FF3366]/[0.04]"
      data-testid="card-cross-org-summary"
    >
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#00D4FF] to-[#FF3366] text-white">
            <Building2 className="h-4 w-4" />
          </div>
          <CardTitle className="text-base">Vista consolidada de tus organizaciones</CardTitle>
          {switchOrg.isPending && (
            <Loader2 className="h-4 w-4 animate-spin text-[#00D4FF]" />
          )}
        </div>
        <CardDescription className="mt-1">
          Resumen de cuentas operativas, a cobrar y a pagar de las organizaciones que administrás.
          Tocá una organización para abrirla.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <OrgCard
              key={g.orgId}
              group={g}
              disabled={switchOrg.isPending}
              onClick={() => handleClick(g.orgId, g.orgName)}
            />
          ))}
        </div>

        {totalsByCurrency.length > 0 && (
          <div
            className="overflow-hidden rounded-xl border border-[#00D4FF]/30 bg-gradient-to-r from-[#00D4FF]/10 via-[#00D4FF]/5 to-[#FF3366]/10 p-4"
            data-testid="strip-totals"
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#00D4FF]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#00D4FF]" />
              Totales por moneda
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {totalsByCurrency.map(([currency, t]) => (
                <div
                  key={currency}
                  className="rounded-lg bg-white/70 p-3 backdrop-blur-sm dark:bg-slate-900/40"
                  data-testid={`row-cross-org-total-${currency}`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <Badge
                      variant="outline"
                      className="border-[#00D4FF]/40 bg-[#00D4FF]/10 font-mono text-[10px] text-[#00D4FF]"
                    >
                      {currency}
                    </Badge>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Saldo operativo
                    </div>
                  </div>
                  <div
                    className={`mb-2 font-mono text-base font-bold ${
                      t.operativeBalance < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'
                    }`}
                  >
                    {formatAmount(t.operativeBalance, currency)}
                  </div>
                  <div className="grid grid-cols-2 gap-3 border-t border-[#00D4FF]/20 pt-2 text-xs">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        A cobrar
                      </div>
                      <div
                        className={`font-mono font-semibold ${
                          t.receivableTotal === 0 ? 'text-muted-foreground/60' : 'text-foreground'
                        }`}
                      >
                        {formatAmount(t.receivableTotal, currency)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        A pagar
                      </div>
                      <div
                        className={`font-mono font-semibold ${
                          t.payableTotal === 0 ? 'text-muted-foreground/60' : 'text-foreground'
                        }`}
                      >
                        {formatAmount(t.payableTotal, currency)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
