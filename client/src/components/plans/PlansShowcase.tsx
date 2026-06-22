import { useState } from "react";
import { ChevronDown, ChevronUp, User, Users } from "lucide-react";
import { PLAN_DETAILS, type PlanType } from "@shared/schema";
import { PlanCard } from "./PlanCard";
import { PlansComparisonTable } from "./PlansComparisonTable";

export type PlansShowcaseMode = "register" | "upgrade";

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

interface PlansShowcaseProps {
  mode: PlansShowcaseMode;
  selectedPlan?: PlanType | null;
  onSelectPlan: (plan: PlanType) => void;
  loadingPlan?: PlanType | string | null;
  isPlanDisabled?: (plan: PlanType) => boolean;
  formatPrice?: (cents: number) => string;
  showComparisonByDefault?: boolean;
  comparisonToggleLabel?: string;
  /**
   * Restringe los planes visibles a este conjunto (usado por las landings
   * por audiencia). Si no se pasa, se muestran TODOS los planes (comportamiento
   * por defecto del registro común — no se debe romper).
   */
  allowedPlans?: PlanType[];
}

const ALL_PERSONAL_PLANS: PlanType[] = ["personal", "personal_pro"];
const ALL_BUSINESS_PLANS: PlanType[] = ["solo", "team", "business", "enterprise"];

export function PlansShowcase({
  mode,
  selectedPlan,
  onSelectPlan,
  loadingPlan,
  isPlanDisabled,
  formatPrice,
  showComparisonByDefault,
  comparisonToggleLabel = "Comparar todas las funciones por plan",
  allowedPlans,
}: PlansShowcaseProps) {
  const personalPlans: PlanType[] = allowedPlans
    ? ALL_PERSONAL_PLANS.filter((p) => allowedPlans.includes(p))
    : ALL_PERSONAL_PLANS;
  const businessPlans: PlanType[] = allowedPlans
    ? ALL_BUSINESS_PLANS.filter((p) => allowedPlans.includes(p))
    : ALL_BUSINESS_PLANS;
  const [showComparison, setShowComparison] = useState(
    showComparisonByDefault ?? mode === "register",
  );

  const ctaLabel = mode === "register" ? "Elegir este plan" : undefined;
  const ctaIcon = mode === "register" ? "arrow-right" : "credit-card";

  return (
    <div className="w-full">
      {/* PERSONAL PLANS */}
      {personalPlans.length > 0 && (
      <section className="mb-14 sm:mb-16" data-testid="section-personal-plans">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent to-[#00D4FF]/30" />
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full border border-[#00D4FF]/30 bg-[#00D4FF]/5">
            <User className="h-4 w-4 text-[#00D4FF]" />
            <span className="text-sm font-semibold text-[#00D4FF]">Planes Personales</span>
          </div>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent to-[#00D4FF]/30" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl mx-auto">
          {personalPlans.map((planType) => {
            const details = PLAN_DETAILS[planType];
            return (
              <PlanCard
                key={planType}
                planType={planType}
                details={details}
                family="personal"
                isHighlighted={!!details.highlight}
                highlightLabel={details.highlight}
                subtitle={PERSONAL_SUBTITLES[planType] || "Plan Personal"}
                isSelected={selectedPlan === planType}
                loading={loadingPlan === planType}
                disabled={isPlanDisabled?.(planType) ?? false}
                ctaLabel={ctaLabel}
                ctaIcon={ctaIcon}
                formatPrice={formatPrice}
                onSelect={onSelectPlan}
              />
            );
          })}
        </div>
      </section>
      )}

      {/* BUSINESS PLANS */}
      {businessPlans.length > 0 && (
      <section className="mb-14 sm:mb-16" data-testid="section-business-plans">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent to-[#FF3366]/30" />
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full border border-[#FF3366]/30 bg-[#FF3366]/5">
            <Users className="h-4 w-4 text-[#FF3366]" />
            <span className="text-sm font-semibold text-[#FF3366]">Planes Empresa</span>
          </div>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent to-[#FF3366]/30" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {businessPlans.map((planType) => {
            const details = PLAN_DETAILS[planType];
            const isPopular = details.highlight === "Popular";
            return (
              <PlanCard
                key={planType}
                planType={planType}
                details={details}
                family="business"
                isHighlighted={isPopular}
                highlightLabel={isPopular ? "Popular" : undefined}
                subtitle={BUSINESS_SUBTITLES[planType] || "Plan Empresarial"}
                isSelected={selectedPlan === planType}
                loading={loadingPlan === planType}
                disabled={isPlanDisabled?.(planType) ?? false}
                ctaLabel={ctaLabel}
                ctaIcon={ctaIcon}
                formatPrice={formatPrice}
                onSelect={onSelectPlan}
              />
            );
          })}
        </div>
      </section>
      )}

      {/* COMPARISON */}
      <div className="mb-12">
        <button
          type="button"
          onClick={() => setShowComparison(!showComparison)}
          className="w-full flex items-center justify-center gap-2 py-4 px-6 text-white/80 hover:text-white transition-colors border border-white/10 hover:border-white/20 rounded-2xl bg-white/[0.03] hover:bg-white/[0.06] backdrop-blur-sm"
          data-testid="button-toggle-comparison"
        >
          <span className="font-semibold">{comparisonToggleLabel}</span>
          {showComparison ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>

        {showComparison && (
          <div className="mt-6">
            <PlansComparisonTable personalPlans={personalPlans} businessPlans={businessPlans} />
          </div>
        )}
      </div>
    </div>
  );
}
