import { storage } from "../storage";
import { PLAN_DETAILS, type Subscription } from "@shared/schema";
import { USD_ARS_RATE_DEFAULT, SAAS_KPI_ESTIMATES } from "@shared/constants";
import { computeChurnAndLtv, type ChurnLtvResult } from "../lib/churnLtv";
import { computeRealCac, type CacResult } from "../lib/cac";
import {
  configFromSettings,
  configHasTags,
  deriveAcquisitionSpendByMonth,
  mergeAcquisitionSpend,
  buildItemCodesByTx,
} from "../lib/acquisitionSpend";

export type StripePriceInfo = {
  unitAmount: number | null;
  currency: string | null;
  recurring: { interval?: string; interval_count?: number } | null;
};

// Monto mensual normalizado (y su moneda) de una suscripción. Usa el precio
// real de Stripe si está disponible; si no, cae al precio del plan en ARS.
export function monthlyRevenueForSubscription(
  subscription: Subscription,
  priceMap: Map<string, StripePriceInfo>,
): { amount: number; currency: string } {
  const price = subscription.stripePriceId ? priceMap.get(subscription.stripePriceId) : undefined;
  if (price && price.unitAmount != null) {
    // Stripe guarda el monto en la unidad mínima (centavos).
    let amount = price.unitAmount / 100;
    const interval = price.recurring?.interval ?? 'month';
    const rawCount = price.recurring?.interval_count;
    const intervalCount = typeof rawCount === 'number' && rawCount >= 1 ? rawCount : 1;
    if (interval === 'year') amount = amount / (12 * intervalCount);
    else if (interval === 'week') amount = (amount * 52) / (12 * intervalCount);
    else if (interval === 'day') amount = (amount * 365) / (12 * intervalCount);
    else amount = amount / intervalCount; // month
    return { amount, currency: (price.currency || 'ars').toLowerCase() };
  }
  const planDetail = (PLAN_DETAILS as Record<string, { price: number }>)[subscription.planType];
  return { amount: planDetail?.price ?? 0, currency: 'ars' };
}

export interface BusinessRevenue {
  mrrArs: number;
  mrrUsd: number;
  arrArs: number;
  arrUsd: number;
  arpuArs: number;
  arpuUsd: number;
  activeCount: number;
  usdArsRate: number;
}

export interface SaasKpiEstimates {
  cacUsdMin: number;
  cacUsdMax: number;
  ltvCacRatio: number;
}

export interface AdminBusinessMetrics {
  totalUsers: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  paymentFailures: number;
  cancelledSubscriptions: number;
  cancelScheduledSubscriptions: number;
  subscriptionsByPlan: Record<string, number>;
  usersWithoutSubscription: number;
  deletedForNonPayment: number;
  revenue: BusinessRevenue;
  estimates: SaasKpiEstimates;
  churn: ChurnLtvResult;
  cac: CacResult;
}

export interface ResolvedBusinessSettings {
  usdArsRate: number;
  cacUsdMin: number;
  cacUsdMax: number;
  ltvCacRatio: number;
  source: 'db' | 'env' | 'default';
  updatedAt: Date | null;
}

// Resuelve los valores de negocio editables (tipo de cambio USD/ARS y
// estimaciones de SaaS) con la siguiente prioridad: fila persistida en DB >
// variable de entorno USD_ARS_RATE (solo para el tipo de cambio) > defaults de
// shared/constants.ts. Devuelve siempre valores válidos y de dónde viene cada
// uno para la UI.
export async function resolveBusinessSettings(
  storageDep: typeof storage = storage,
): Promise<ResolvedBusinessSettings> {
  let row: Awaited<ReturnType<typeof storage.getBusinessSettings>> | undefined;
  try {
    row = await storageDep.getBusinessSettings();
  } catch (err) {
    console.error('[BusinessMetrics] Error loading business settings (using defaults):', err);
  }

  const parsedEnvRate = Number(process.env.USD_ARS_RATE);
  const envRate = Number.isFinite(parsedEnvRate) && parsedEnvRate > 0 ? parsedEnvRate : null;

  return {
    usdArsRate: row?.usdArsRate ?? envRate ?? USD_ARS_RATE_DEFAULT,
    cacUsdMin: row?.cacUsdMin ?? SAAS_KPI_ESTIMATES.cacUsdMin,
    cacUsdMax: row?.cacUsdMax ?? SAAS_KPI_ESTIMATES.cacUsdMax,
    ltvCacRatio: row?.ltvCacRatio ?? SAAS_KPI_ESTIMATES.ltvCacRatio,
    source: row ? 'db' : (envRate != null ? 'env' : 'default'),
    updatedAt: row?.updatedAt ?? null,
  };
}

// Calcula los KPIs de negocio (MRR, ARR, ARPU) a partir de las suscripciones
// activas reales. Los cobros son en ARS; el equivalente en USD es solo
// referencial y usa un tipo de cambio configurable (sin feed en vivo).
// El MRR se acumula sobre la suscripción canónica de cada usuario (la que
// devuelve getSubscriptionByUserId, ya deduplicada) para no inflar el total con
// filas duplicadas de Stripe.
export async function computeAdminBusinessMetrics(
  storageDep: typeof storage = storage,
): Promise<AdminBusinessMetrics> {
  const users = await storageDep.getAllUsers();
  const totalUsers = users.length;

  const subscriptionsByPlan: Record<string, number> = {};
  let paymentFailures = 0;
  let cancelledSubscriptions = 0;
  let cancelScheduledSubscriptions = 0;
  let activeSubscriptions = 0;
  // Denominador de ARPU / conteo para revenue. A diferencia de la tarjeta
  // "Activas", incluye las suscripciones `active` con baja agendada
  // (`cancelAtPeriodEnd`) porque siguen siendo facturables hasta fin del
  // período y aportan MRR. Sacarlas subestimaría el revenue.
  let activeRevenueCount = 0;
  let trialingSubscriptions = 0;
  // Cuenta SOLO usuarios no borrados sin suscripción, para que coincida con el
  // filtro `no_subscription` del panel (`!deletedAt && !subscription`). No se
  // deriva de `totalUsers - (usuarios con sub)` porque ese total incluye a los
  // soft-deleted (que el filtro de la tarjeta excluye), lo que rompía la
  // paridad tarjeta ↔ lista cuando un usuario borrado conservaba su sub.
  let usersWithoutSubscription = 0;

  const settings = await resolveBusinessSettings(storageDep);
  const usdArsRate = settings.usdArsRate;

  let priceMap: Map<string, StripePriceInfo> = new Map();
  try {
    priceMap = await storageDep.getStripePriceMap();
  } catch (priceErr) {
    console.error('[BusinessMetrics] Error loading Stripe price map (using plan fallback):', priceErr);
  }

  const mrrByCurrency: Record<string, number> = {};
  const unsupportedCurrencies = new Set<string>();

  for (const user of users) {
    try {
      // Los usuarios dados de baja (soft-delete) no cuentan como suscriptores
      // en ninguna métrica de estado (activas/prueba/canceladas/pagos fallidos).
      // El panel filtra estas tarjetas con `!deletedAt`, así que el conteo del
      // backend debe excluirlos también para que el número de la tarjeta coincida
      // exactamente con las filas que muestra al hacer click. (El total de
      // usuarios sí los incluye, igual que el filtro "total" del panel.)
      if (user.deletedAt) continue;
      const subscription = await storageDep.getSubscriptionByUserId(user.id);
      if (subscription) {
        const plan = subscription.planType || 'unknown';
        subscriptionsByPlan[plan] = (subscriptionsByPlan[plan] || 0) + 1;

        // "Cancelará" (baja agendada): sigue activo o en prueba hasta fin del
        // período, pero ya pidió la baja (cancelAtPeriodEnd). Es churn inminente,
        // no un cliente sano, así que tiene su propio cubo y se EXCLUYE de
        // activas/prueba para que esas tarjetas no lo cuenten. El badge del panel
        // muestra "Pago fallido" antes que "Cancelará", por eso acá también
        // excluimos paymentFailedAt: el filtro del frontend usa el mismo criterio,
        // manteniendo la paridad tarjeta ↔ lista. `cancelled` (baja efectiva)
        // tiene su propia tarjeta y queda fuera de este cubo.
        const isCancelScheduled =
          !!subscription.cancelAtPeriodEnd &&
          !subscription.paymentFailedAt &&
          subscription.status !== 'cancelled';
        if (isCancelScheduled) {
          cancelScheduledSubscriptions++;
        }

        if (subscription.status === 'active') {
          // Revenue: toda sub `active` aporta MRR/ARPU mientras siga vigente,
          // incluso con baja agendada (se factura hasta fin del período).
          activeRevenueCount++;
          const { amount, currency } = monthlyRevenueForSubscription(subscription, priceMap);
          mrrByCurrency[currency] = (mrrByCurrency[currency] || 0) + amount;
          if (currency !== 'ars' && currency !== 'usd') {
            unsupportedCurrencies.add(currency);
          }
          // Tarjeta "Activas": excluye las que cancelarán (van al cubo propio).
          if (!subscription.cancelAtPeriodEnd) {
            activeSubscriptions++;
          }
        }
        if (subscription.status === 'trialing' && !subscription.cancelAtPeriodEnd) {
          trialingSubscriptions++;
        }
        if (subscription.paymentFailedAt) {
          paymentFailures++;
        }
        // `cancelled` es el estado real de baja. No contamos cancelAtPeriodEnd
        // como cancelación porque esos siguen activos hasta fin del período
        // (e incluye usuarios en prueba con la baja agendada), lo que inflaba
        // este número con gente que en realidad todavía usa la app.
        if (subscription.status === 'cancelled') {
          cancelledSubscriptions++;
        }
      } else {
        usersWithoutSubscription++;
      }
    } catch {}
  }

  // Unificamos a ARS (convirtiendo subs en USD a ARS) y derivamos el USD.
  // Las monedas no soportadas no se pueden convertir sin tipo de cambio; se
  // excluyen del total y se avisan por log para no subestimar en silencio (hoy
  // todos los planes se cobran en ARS).
  if (unsupportedCurrencies.size > 0) {
    console.warn(
      '[BusinessMetrics] MRR: monedas sin tipo de cambio excluidas del total:',
      Array.from(unsupportedCurrencies).join(', '),
    );
  }
  const mrrArs = (mrrByCurrency.ars || 0) + (mrrByCurrency.usd || 0) * usdArsRate;
  const mrrUsd = usdArsRate > 0 ? mrrArs / usdArsRate : 0;

  const revenue: BusinessRevenue = {
    mrrArs,
    mrrUsd,
    arrArs: mrrArs * 12,
    arrUsd: mrrUsd * 12,
    arpuArs: activeRevenueCount > 0 ? mrrArs / activeRevenueCount : 0,
    arpuUsd: activeRevenueCount > 0 ? mrrUsd / activeRevenueCount : 0,
    activeCount: activeRevenueCount,
    usdArsRate,
  };

  // Churn mensual real (sobre el historial completo de suscripciones) y LTV
  // derivado (ARPU / churn). Si no hay datos suficientes, computeChurnAndLtv
  // marca hasEnoughData=false y el frontend cae a la estimación.
  let churn: ChurnLtvResult;
  let allSubscriptions: Subscription[] = [];
  try {
    allSubscriptions = await storageDep.getAllSubscriptions();
    churn = computeChurnAndLtv(allSubscriptions, revenue.arpuArs, revenue.arpuUsd, new Date());
  } catch (churnErr) {
    console.error('[BusinessMetrics] Error computing churn/LTV:', churnErr);
    churn = {
      monthlyRatePct: null,
      avgLifetimeMonths: null,
      ltvArs: null,
      ltvUsd: null,
      cancellationsInWindow: 0,
      monthsWithData: 0,
      windowMonths: 6,
      hasEnoughData: false,
    };
  }

  // CAC real a partir del gasto de adquisición registrado por mes y las altas
  // reales. Si no hay gasto cargado o no hay altas en esos meses,
  // computeRealCac marca hasEnoughData=false y el frontend cae a la estimación.
  let cac: CacResult;
  try {
    const manualSpends = await storageDep.getAcquisitionSpends();

    // Task #433: si está habilitada la derivación automática, sumamos el gasto
    // etiquetado por mes y lo combinamos con la carga manual (manual gana por
    // mes, así no se duplica el gasto ya cargado a mano).
    let derived = new Map<string, number>();
    try {
      const settingsRow = await storageDep.getBusinessSettings();
      const config = configFromSettings(settingsRow);
      if (config.enabled && config.orgId && configHasTags(config)) {
        const txs = await storageDep.getTransactionsByOrganization(config.orgId, 'completed');
        // #477: incluir códigos de rentabilidad de los renglones para no
        // subcontar ventas/compras multi-producto (campo legacy en null).
        const items = await storageDep.getTransactionItemsByTransactionIds(txs.map((t) => t.id));
        const itemCodesByTx = buildItemCodesByTx(items);
        derived = deriveAcquisitionSpendByMonth(txs, config, usdArsRate, itemCodesByTx);
      }
    } catch (deriveErr) {
      console.error('[BusinessMetrics] Error deriving acquisition spend (using manual only):', deriveErr);
    }

    const merged = mergeAcquisitionSpend(manualSpends, derived);
    cac = computeRealCac(merged, allSubscriptions, usdArsRate);
  } catch (cacErr) {
    console.error('[BusinessMetrics] Error computing CAC:', cacErr);
    cac = {
      cacArs: null,
      cacUsd: null,
      totalSpendArs: 0,
      totalSignups: 0,
      monthsWithSpend: 0,
      hasEnoughData: false,
    };
  }

  // Cuentas eliminadas por falta de pago (registradas por la limpieza de
  // cancelados). Es un total histórico desde que existe el log; las bajas
  // anteriores a esta función no quedaron registradas y no se pueden recuperar.
  let deletedForNonPayment = 0;
  try {
    deletedForNonPayment = await storageDep.countAccountDeletions('non_payment');
  } catch (delErr) {
    console.error('[BusinessMetrics] Error counting non-payment deletions:', delErr);
  }

  return {
    totalUsers,
    activeSubscriptions,
    trialingSubscriptions,
    paymentFailures,
    cancelledSubscriptions,
    cancelScheduledSubscriptions,
    subscriptionsByPlan,
    usersWithoutSubscription,
    deletedForNonPayment,
    revenue,
    estimates: {
      cacUsdMin: settings.cacUsdMin,
      cacUsdMax: settings.cacUsdMax,
      ltvCacRatio: settings.ltvCacRatio,
    },
    churn,
    cac,
  };
}
