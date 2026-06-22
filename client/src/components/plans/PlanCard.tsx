import { Button } from "@/components/ui/button";
import { Check, Loader2, CreditCard, ArrowRight } from "lucide-react";
import { User, Users } from "lucide-react";
import { PLAN_DETAILS, PLAN_LABELS, type PlanType } from "@shared/schema";

const BRAND_CYAN = "#00D4FF";
const BRAND_PINK = "#FF3366";

export interface PlanCardProps {
  planType: PlanType;
  details: typeof PLAN_DETAILS[PlanType];
  family: "personal" | "business";
  isHighlighted: boolean;
  highlightLabel?: string;
  subtitle: string;
  isSelected?: boolean;
  loading?: boolean;
  disabled?: boolean;
  ctaLabel?: string;
  ctaIcon?: "credit-card" | "arrow-right";
  formatPrice?: (cents: number) => string;
  onSelect: (planType: PlanType) => void;
}

export function PlanCard({
  planType,
  details,
  family,
  isHighlighted,
  highlightLabel,
  subtitle,
  isSelected,
  loading,
  disabled,
  ctaLabel,
  ctaIcon = "credit-card",
  formatPrice,
  onSelect,
}: PlanCardProps) {
  const accent = family === "personal" ? BRAND_CYAN : BRAND_PINK;
  const accentSoft = family === "personal" ? "rgba(0,212,255,0.15)" : "rgba(255,51,102,0.15)";
  const Icon = family === "personal" ? User : Users;
  const showSelectedRing = !!isSelected;
  const formattedPrice = formatPrice
    ? formatPrice(details.price * 100)
    : `$${details.price.toLocaleString("es-AR")}`;

  return (
    <div
      className={`group relative rounded-2xl backdrop-blur-md transition-all duration-300 flex flex-col ${
        isHighlighted
          ? "border-2 lg:scale-[1.03] lg:-mt-2 shadow-[0_0_60px_-12px] z-10"
          : showSelectedRing
            ? "border-2"
            : "border border-white/10 hover:border-white/20"
      }`}
      style={{
        background: isHighlighted
          ? `linear-gradient(145deg, ${accentSoft}, rgba(255,255,255,0.02))`
          : showSelectedRing
            ? `linear-gradient(145deg, ${accentSoft}, rgba(255,255,255,0.02))`
            : "rgba(255,255,255,0.03)",
        borderColor: isHighlighted || showSelectedRing ? accent : undefined,
        boxShadow: isHighlighted
          ? `0 0 80px -16px ${accent}`
          : showSelectedRing
            ? `0 0 40px -16px ${accent}`
            : undefined,
      }}
      data-testid={`card-plan-${planType}`}
    >
      {highlightLabel && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-20">
          <span
            className="text-white text-xs font-semibold px-4 py-1.5 rounded-full shadow-lg whitespace-nowrap"
            style={{
              background: `linear-gradient(90deg, ${BRAND_CYAN}, ${BRAND_PINK})`,
            }}
          >
            {highlightLabel}
          </span>
        </div>
      )}

      <div className="p-6 sm:p-7 flex flex-col flex-1">
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ backgroundColor: accentSoft }}
          >
            <Icon className="h-5 w-5" style={{ color: accent }} />
          </div>
          <div>
            <h3 className="text-lg sm:text-xl font-bold text-white font-display leading-tight">
              {PLAN_LABELS[planType]}
            </h3>
            <p className="text-xs text-white/50">{subtitle}</p>
          </div>
        </div>

        <div className="mb-5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-medium text-white/50 mt-2">ARS</span>
            <span className="text-4xl sm:text-5xl font-bold text-white font-display tracking-tight">
              {formattedPrice}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-sm text-white/50">/mes</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">
              1er mes gratis
            </span>
          </div>
        </div>

        <ul className="space-y-2.5 mb-6 flex-1">
          {details.features.map((feature, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-white/80">
              <span
                className="h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                style={{ backgroundColor: accentSoft }}
              >
                <Check className="h-3 w-3" style={{ color: accent }} />
              </span>
              <span>{feature}</span>
            </li>
          ))}
        </ul>

        <Button
          className="w-full h-11 text-white font-semibold border-0 hover:opacity-90 transition-opacity"
          style={{
            background: isHighlighted
              ? `linear-gradient(90deg, ${BRAND_CYAN}, ${BRAND_PINK})`
              : `linear-gradient(90deg, ${accent}, ${accent}cc)`,
          }}
          disabled={disabled || loading}
          onClick={() => onSelect(planType)}
          data-testid={`button-select-${planType}`}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : ctaIcon === "arrow-right" ? (
            <ArrowRight className="h-4 w-4 mr-2" />
          ) : (
            <CreditCard className="h-4 w-4 mr-2" />
          )}
          {ctaLabel || (disabled ? "No disponible" : "Elegir plan")}
        </Button>
      </div>
    </div>
  );
}
