import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, CreditCard, ArrowLeft, Clock, Sparkles, TrendingUp, Users, BarChart3, Globe } from "lucide-react";
import { useState } from "react";
import { fetchWithAuth } from "@/lib/api";

export default function SubscriptionRequired() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);
  const urlParams = new URLSearchParams(window.location.search);
  const reason = urlParams.get("reason");
  const daysSinceFailureParam = urlParams.get("daysSinceFailure");
  const daysSinceFailure = daysSinceFailureParam ? parseInt(daysSinceFailureParam) : null;

  const getMessage = () => {
    switch (reason) {
      case "PAYMENT_BLOCKED":
        return {
          title: "Acceso Bloqueado",
          description: "Tu acceso está bloqueado por falta de pago.",
          icon: <AlertTriangle className="h-12 w-12 text-red-500" />,
          isPaymentBlocked: true,
        };
      case "SUBSCRIPTION_INACTIVE":
        return {
          title: "Suscripción Cancelada",
          description: "Tu suscripción ha sido cancelada, pero tus datos siguen guardados. Elegí un plan para recuperar el acceso a tu cuenta.",
          icon: <AlertTriangle className="h-12 w-12 text-yellow-500" />,
          isPaymentBlocked: false,
          isResubscription: true,
        };
      case "SUBSCRIPTION_REQUIRED":
      default:
        return {
          title: "Tu cuenta está lista",
          description: "Elegí un plan para empezar a gestionar tus finanzas con Aikestar.",
          icon: <Sparkles className="h-12 w-12 text-cyan-400" />,
          isPaymentBlocked: false,
          isNewUser: true,
        };
    }
  };

  const { title, description, icon, isPaymentBlocked, isNewUser, isResubscription } = getMessage() as any;

  const handlePayNow = async () => {
    setIsLoading(true);
    try {
      const response = await fetchWithAuth('/stripe/create-portal-session-blocked', {
        method: 'POST',
      }, true); // Skip auth redirect since we're already on a subscription page
      
      if (response.url) {
        window.location.href = response.url;
      } else {
        // Task #343 — fallback seguro: nunca mandar a /settings (está protegido
        // por requireAuth con check de suscripción → 402 → loop). /pricing está
        // habilitado para autenticados sin plan activo.
        window.location.href = "/pricing?recover=1";
      }
    } catch (error) {
      console.error('Error creating billing portal:', error);
      // Task #343 — idem: el catch no puede mandar a /settings porque genera
      // un loop entre /subscription-required ↔ /settings ↔ /subscription-required.
      window.location.href = "/pricing?recover=1";
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubscribe = () => {
    window.location.href = "/pricing";
  };

  const handleLogin = () => {
    setLocation("/login");
  };

  if (isPaymentBlocked) {
    return (
      <div className="relative min-h-screen overflow-hidden flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0F] via-[#1a0a0f] to-[#0A0A0F]" />
        <div className="absolute top-[-20%] right-[-10%] w-[36rem] h-[36rem] rounded-full bg-red-500/10 blur-3xl pointer-events-none" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[36rem] h-[36rem] rounded-full bg-[#FF3366]/10 blur-3xl pointer-events-none" />
        <Card className="relative z-10 w-full max-w-lg bg-white/[0.03] border border-red-500/40 backdrop-blur-md rounded-2xl shadow-[0_0_80px_-16px_rgba(239,68,68,0.5)]">
          <CardHeader className="text-center space-y-4">
            <div className="flex justify-center">{icon}</div>
            <CardTitle className="text-2xl sm:text-3xl font-bold font-display text-white">{title}</CardTitle>
            <CardDescription className="text-white/70 text-base">
              {description}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-3" data-testid="text-payment-blocked-info">
              <div className="flex items-center gap-2 text-red-400">
                <Clock className="h-5 w-5" />
                <span className="font-semibold">Regularizá tu pago para recuperar el acceso</span>
              </div>
              <p className="text-white/80">
                Tu pago no se pudo procesar y tu acceso quedó bloqueado. Tus datos siguen guardados: en cuanto actualices tu método de pago, recuperás el acceso completo a tu cuenta.
              </p>
              {daysSinceFailure !== null && daysSinceFailure > 0 && (
                <p className="text-white/60 text-sm" data-testid="text-days-since-failure">
                  Tu pago falló hace <strong className="text-white/80">{daysSinceFailure} {daysSinceFailure === 1 ? 'día' : 'días'}</strong>.
                </p>
              )}
            </div>
            
            <Button
              onClick={handlePayNow}
              disabled={isLoading}
              className="w-full bg-gradient-to-r from-red-500 to-[#FF3366] hover:opacity-90 transition-opacity text-white font-semibold py-6 text-lg border-0"
              data-testid="button-pay-now"
            >
              <CreditCard className="mr-2 h-5 w-5" />
              {isLoading ? 'Cargando...' : 'Pagar Ahora'}
            </Button>
            
            <p className="text-center text-white/50 text-sm">
              Serás redirigido a Stripe para actualizar tu método de pago
            </p>
            <p className="text-center text-white/60 text-xs" data-testid="text-amex-notice-pay-now">
              Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.
            </p>
            
            <Button
              variant="outline"
              onClick={handleLogin}
              className="w-full border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
              data-testid="button-back-login"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Volver al Inicio de Sesión
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0F] via-[#0f1420] to-[#0A0A0F]" />
      <div className="absolute top-[-20%] right-[-10%] w-[36rem] h-[36rem] rounded-full bg-[#00D4FF]/10 blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-20%] left-[-10%] w-[36rem] h-[36rem] rounded-full bg-[#FF3366]/10 blur-3xl pointer-events-none" />
      <Card className="relative z-10 w-full max-w-md bg-white/[0.03] border border-white/10 backdrop-blur-md rounded-2xl">
        <CardHeader className="text-center space-y-4">
          <div className="flex justify-center">{icon}</div>
          <CardTitle className="text-2xl sm:text-3xl font-bold font-display text-white">{title}</CardTitle>
          <CardDescription className="text-white/60 text-base">{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isResubscription && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-amber-400">
                <Clock className="h-5 w-5" />
                <span className="font-semibold">Tus datos están a salvo</span>
              </div>
              <p className="text-white/70 text-sm">
                Todas tus organizaciones, transacciones y datos financieros siguen guardados. Al elegir un plan, recuperás el acceso inmediatamente.
              </p>
            </div>
          )}
          {isNewUser && (
            <div className="space-y-3 py-2">
              <div className="flex items-center gap-3 text-white/80">
                <TrendingUp className="h-5 w-5 text-[#00D4FF] flex-shrink-0" />
                <span>Control total de ingresos y egresos</span>
              </div>
              <div className="flex items-center gap-3 text-white/80">
                <BarChart3 className="h-5 w-5 text-[#FF3366] flex-shrink-0" />
                <span>Reportes inteligentes con IA</span>
              </div>
              <div className="flex items-center gap-3 text-white/80">
                <Users className="h-5 w-5 text-[#00D4FF] flex-shrink-0" />
                <span>Gestión de clientes y proveedores</span>
              </div>
              <div className="flex items-center gap-3 text-white/80">
                <Globe className="h-5 w-5 text-[#FF3366] flex-shrink-0" />
                <span>Soporte multi-moneda y cotizaciones</span>
              </div>
            </div>
          )}
          <Button
            onClick={handleSubscribe}
            className="w-full bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90 transition-opacity text-white font-semibold py-5 text-base border-0"
            data-testid="button-subscribe"
          >
            <CreditCard className="mr-2 h-5 w-5" />
            Elegir mi Plan
          </Button>
          <p className="text-center text-white/50 text-xs" data-testid="text-amex-notice-subscribe">
            Aceptamos Visa y Mastercard. American Express puede no funcionar en Argentina.
          </p>
          <Button
            variant="outline"
            onClick={handleLogin}
            className="w-full border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
            data-testid="button-back-login"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Volver al Inicio de Sesión
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
