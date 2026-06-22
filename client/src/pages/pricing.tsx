import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Loader2, ArrowLeft, Sparkles, ChevronLeft } from "lucide-react";
import { PLAN_DETAILS, PLAN_LABELS, type PlanType } from "@shared/schema";
import { PlansShowcase } from "@/components/plans/PlansShowcase";
import { PlanCard } from "@/components/plans/PlanCard";

interface StripeProduct {
  id: string;
  name: string;
  description: string;
  metadata: { planType?: string };
  prices: Array<{
    id: string;
    unitAmount: number;
    currency: string;
    recurring: { interval: string } | null;
  }>;
}

interface PendingSubscription {
  hasPending: boolean;
  planType: PlanType | null;
  subscriptionId: string | null;
}

const BRAND_CYAN = "#00D4FF";
const BRAND_PINK = "#FF3366";

const PERSONAL_SUBTITLES: Record<string, string> = {
  personal: "Para uso individual",
  personal_pro: "Para emprendedores activos",
};
const BUSINESS_SUBTITLES: Record<string, string> = {
  solo: "Para profesionales solos",
  team: "Para equipos pequeños",
  business: "Para pymes en crecimiento",
  enterprise: "Para empresas grandes",
};

function PageBackground() {
  return (
    <>
      <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0F] via-[#0f1420] to-[#0A0A0F]" />
      <div className="absolute top-[-10%] right-[-10%] w-[40rem] h-[40rem] rounded-full bg-[#00D4FF]/10 blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[40rem] h-[40rem] rounded-full bg-[#FF3366]/10 blur-3xl pointer-events-none" />
      <div className="absolute inset-0 opacity-[0.07] pointer-events-none bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMwMEQ0RkYiIGZpbGwtb3BhY2l0eT0iMC42Ij48Y2lyY2xlIGN4PSIzMCIgY3k9IjMwIiByPSIxLjUiLz48L2c+PC9nPjwvc3ZnPg==')]" />
    </>
  );
}

export default function Pricing() {
  const [, setLocation] = useLocation();
  const [products, setProducts] = useState<StripeProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSubscription, setPendingSubscription] = useState<PendingSubscription | null>(null);
  const [showAllPlans, setShowAllPlans] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [productsRes, pendingRes] = await Promise.all([
        fetch('/api/stripe/products'),
        fetch('/api/user/pending-subscription', { credentials: 'include' })
      ]);

      if (productsRes.ok) {
        const productsData = await productsRes.json();
        if (Array.isArray(productsData) && productsData.length > 0) {
          setProducts(productsData);
        } else {
          console.error('[Pricing] Products response empty or invalid:', productsData);
          setError('No se pudieron cargar los planes. Intenta recargar la página.');
        }
      } else {
        console.error('[Pricing] Products fetch failed:', productsRes.status);
        setError('No se pudieron cargar los planes. Intenta recargar la página.');
      }

      if (pendingRes.ok) {
        const pendingData = await pendingRes.json();
        setPendingSubscription(pendingData);
      }
    } catch (err: any) {
      console.error('[Pricing] Error loading data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startCheckoutForPriceId = async (priceId: string, planType: string) => {
    setCheckoutLoading(planType);
    try {
      const response = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ priceId }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Error creating checkout');
      }

      const { url } = await response.json();
      if (url) {
        window.location.href = url;
      }
    } catch (err: any) {
      setError(err.message);
      setCheckoutLoading(null);
    }
  };

  const handleSelectPlanByType = (planType: PlanType) => {
    const product = getProductForPlan(planType);
    const price = product?.prices[0];
    if (!price) {
      setError('Este plan aún no está configurado en Stripe. Contactá al administrador.');
      return;
    }
    startCheckoutForPriceId(price.id, planType);
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {}
    setLocation('/register');
  };

  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 0,
    }).format(amount / 100).replace(/^\$\s?/, '$ ');
  };

  const getProductForPlan = (planType: PlanType) => {
    return products.find(p => p.metadata?.planType === planType);
  };

  const isPlanDisabled = (planType: PlanType) => {
    const product = getProductForPlan(planType);
    return !product?.prices[0];
  };

  if (loading || (products.length === 0 && !error)) {
    return (
      <div className="relative min-h-screen overflow-hidden flex items-center justify-center">
        <PageBackground />
        <Loader2 className="h-8 w-8 animate-spin text-[#00D4FF] relative z-10" />
      </div>
    );
  }

  const hasPendingPlan = pendingSubscription?.hasPending && pendingSubscription.planType;
  const pendingPlanType = pendingSubscription?.planType;

  if (hasPendingPlan && !showAllPlans) {
    const details = PLAN_DETAILS[pendingPlanType!];
    const family: "personal" | "business" = details.isTeamPlan ? "business" : "personal";

    return (
      <div className="relative min-h-screen overflow-hidden py-12 px-4">
        <PageBackground />
        <div className="relative z-10 max-w-lg mx-auto">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs text-emerald-400 font-medium">Casi listo</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold font-display text-white mb-3">
              Completá tu suscripción
            </h1>
            <p className="text-white/60">
              Elegiste el plan{' '}
              <span className="font-semibold" style={{ color: family === "personal" ? BRAND_CYAN : BRAND_PINK }}>
                {PLAN_LABELS[pendingPlanType!]}
              </span>
              . Completá el pago para acceder a Aikestar.
            </p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-center text-sm">
              {error}
            </div>
          )}

          <PlanCard
            planType={pendingPlanType!}
            details={details}
            family={family}
            isHighlighted={true}
            subtitle={
              family === "personal"
                ? PERSONAL_SUBTITLES[pendingPlanType!] || "Plan Personal"
                : BUSINESS_SUBTITLES[pendingPlanType!] || "Plan Empresarial"
            }
            loading={checkoutLoading === pendingPlanType}
            disabled={isPlanDisabled(pendingPlanType!)}
            ctaLabel="Pagar y comenzar"
            formatPrice={formatPrice}
            onSelect={handleSelectPlanByType}
          />

          {isPlanDisabled(pendingPlanType!) && (
            <p className="mt-4 text-sm text-yellow-400 text-center">
              Este plan aún no está configurado en Stripe. Contactá al administrador.
            </p>
          )}

          <p className="mt-3 text-xs text-white/50 text-center" data-testid="text-amex-notice-pending-plan">
            Aceptamos Visa y Mastercard. American Express puede no funcionar en Argentina.
          </p>

          <div className="flex flex-col items-center gap-2 mt-8">
            <Button
              variant="ghost"
              onClick={() => setShowAllPlans(true)}
              className="text-white/60 hover:text-white hover:bg-white/5"
              data-testid="button-change-plan"
            >
              <ChevronLeft className="h-4 w-4 mr-2" />
              Cambiar de plan
            </Button>
            <Button
              variant="ghost"
              onClick={handleLogout}
              className="text-white/40 hover:text-white/70 hover:bg-white/5"
              data-testid="button-logout"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Cerrar sesión
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden py-12 px-4">
      <PageBackground />
      <div className="relative z-10 max-w-7xl mx-auto">
        {/* HERO */}
        <div className="text-center mb-12 sm:mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#FF3366] animate-pulse" />
            <span className="text-xs text-white/70 font-medium">Potenciado por Inteligencia Artificial</span>
          </div>
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold font-display tracking-tight leading-[1.05] mb-4">
            <span className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] bg-clip-text text-transparent">
              {showAllPlans ? 'Elegí otro plan' : 'Elegí tu Plan'}
            </span>
          </h1>
          <p className="text-white/60 text-base sm:text-lg max-w-2xl mx-auto">
            25 funciones que hacen único a Aikestar. Elegí el plan que mejor se adapte a tu negocio.
          </p>
          <div className="mt-4 inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30">
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-sm text-emerald-400 font-medium">Primer mes gratis en todos los planes</span>
          </div>
          {showAllPlans && (
            <div className="mt-6">
              <Button
                variant="ghost"
                onClick={() => setShowAllPlans(false)}
                className="text-[#00D4FF] hover:text-[#00D4FF]/80 hover:bg-white/5"
              >
                <ChevronLeft className="h-4 w-4 mr-2" />
                Volver al plan elegido
              </Button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-center text-sm">
            {error}
          </div>
        )}

        <p className="text-center text-xs text-white/50 mb-8" data-testid="text-amex-notice-full-pricing">
          Aceptamos Visa y Mastercard. American Express puede no funcionar en Argentina.
        </p>

        <PlansShowcase
          mode="upgrade"
          onSelectPlan={handleSelectPlanByType}
          loadingPlan={checkoutLoading}
          isPlanDisabled={isPlanDisabled}
          formatPrice={formatPrice}
        />

        <div className="text-center">
          <Button
            variant="ghost"
            onClick={handleLogout}
            className="text-white/50 hover:text-white hover:bg-white/5"
            data-testid="button-logout"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cerrar sesión
          </Button>
        </div>
      </div>
    </div>
  );
}
