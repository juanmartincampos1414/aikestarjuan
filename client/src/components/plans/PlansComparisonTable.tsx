import { Check, X } from "lucide-react";
import { PLAN_DETAILS, PLAN_LABELS, PLAN_FEATURES_COMPARISON, type PlanType } from "@shared/schema";

const BRAND_CYAN = "#00D4FF";
const BRAND_PINK = "#FF3366";

const SUPPORT_LABELS: Record<PlanType, string> = {
  personal: "Email",
  personal_pro: "Prioritario",
  solo: "Email",
  team: "Prioritario",
  business: "Dedicado",
  enterprise: "24/7",
};

interface PlansComparisonTableProps {
  personalPlans: PlanType[];
  businessPlans: PlanType[];
}

export function PlansComparisonTable({ personalPlans, businessPlans }: PlansComparisonTableProps) {
  const allPlans: PlanType[] = [...personalPlans, ...businessPlans];

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.02] backdrop-blur-sm">
      <table className="w-full min-w-[800px]" data-testid="table-comparison">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left py-4 px-4 text-white/60 text-sm font-medium w-[280px]">
              Función
            </th>
            {allPlans.map((plan) => {
              const isPersonal = personalPlans.includes(plan);
              return (
                <th key={plan} className="text-center py-4 px-2 min-w-[100px]">
                  <span
                    className="text-sm font-bold font-display block"
                    style={{ color: isPersonal ? BRAND_CYAN : BRAND_PINK }}
                  >
                    {PLAN_LABELS[plan]}
                  </span>
                  <p className="text-xs text-white/40 mt-1">
                    ${PLAN_DETAILS[plan].price.toLocaleString("es-AR")}
                  </p>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {PLAN_FEATURES_COMPARISON.map((feature, idx) => (
            <tr
              key={feature.key}
              className={`border-b border-white/5 ${idx % 2 === 0 ? "bg-white/[0.015]" : ""} hover:bg-white/[0.04] transition-colors`}
              data-testid={`row-feature-${feature.key}`}
            >
              <td className="py-3 px-4">
                <div>
                  <span className="text-sm text-white/90 font-medium">{feature.label}</span>
                  {"comingSoon" in feature && feature.comingSoon && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#FF3366]/15 text-[#FF3366] font-medium">
                      pronto
                    </span>
                  )}
                  <p className="text-xs text-white/40 mt-0.5">{feature.description}</p>
                </div>
              </td>
              {allPlans.map((plan) => {
                const included = feature.plans.includes(plan);
                const isPersonal = personalPlans.includes(plan);
                return (
                  <td key={plan} className="text-center py-3 px-2">
                    {included ? (
                      <Check
                        className="h-5 w-5 mx-auto"
                        style={{ color: isPersonal ? BRAND_CYAN : BRAND_PINK }}
                      />
                    ) : (
                      <X className="h-4 w-4 mx-auto text-white/15" />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr className="border-b border-white/5">
            <td className="py-3 px-4">
              <span className="text-sm text-white/90 font-medium">Organizaciones</span>
            </td>
            {allPlans.map((plan) => (
              <td key={plan} className="text-center py-3 px-2 text-sm text-white/70 font-medium">
                {PLAN_DETAILS[plan].maxOrgs === -1 ? "Ilimitadas" : PLAN_DETAILS[plan].maxOrgs}
              </td>
            ))}
          </tr>
          <tr className="border-b border-white/5 bg-white/[0.015]">
            <td className="py-3 px-4">
              <span className="text-sm text-white/90 font-medium">Miembros por org</span>
            </td>
            {allPlans.map((plan) => (
              <td key={plan} className="text-center py-3 px-2 text-sm text-white/70 font-medium">
                {PLAN_DETAILS[plan].maxMembersPerOrg === -1
                  ? "Ilimitados"
                  : PLAN_DETAILS[plan].maxMembersPerOrg}
              </td>
            ))}
          </tr>
          <tr>
            <td className="py-3 px-4">
              <span className="text-sm text-white/90 font-medium">Soporte</span>
            </td>
            {allPlans.map((plan) => (
              <td key={plan} className="text-center py-3 px-2 text-xs text-white/60">
                {SUPPORT_LABELS[plan]}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
