import { useLocation } from "wouter";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UserX, Building2, ArrowRight, UserPlus } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export default function AccessDenied() {
  const [, setLocation] = useLocation();
  const [acknowledging, setAcknowledging] = useState(false);
  const urlParams = new URLSearchParams(window.location.search);
  const reason = urlParams.get("reason");
  const orgName = urlParams.get("org");
  const removedBy = urlParams.get("removedBy");
  const eventId = urlParams.get("eventId");

  const getMessage = () => {
    switch (reason) {
      case "ORG_OWNER_DELETED":
        return {
          title: "Organización Eliminada",
          description: orgName
            ? `El propietario de "${orgName}" ha eliminado su cuenta y la organización.`
            : "El propietario de tu organización ha eliminado su cuenta.",
          subtext: "Ya no tenés acceso a esta organización, pero podés crear tu propia cuenta y empezar de nuevo.",
          icon: <Building2 className="h-12 w-12 text-amber-400" />,
        };
      case "MEMBER_REMOVED":
        return {
          title: "Acceso Revocado",
          description: orgName && removedBy
            ? `${removedBy} te ha removido de "${orgName}".`
            : orgName
            ? `Has sido removido de "${orgName}".`
            : "Has sido removido del equipo.",
          subtext: "Si creés que esto es un error, contactá al administrador de la organización. También podés crear tu propia cuenta.",
          icon: <UserX className="h-12 w-12 text-[#FF3366]" />,
        };
      default:
        return {
          title: "Acceso Denegado",
          description: "Tu acceso a esta organización ha cambiado.",
          subtext: "Podés crear tu propia cuenta para empezar a usar Aikestar.",
          icon: <UserX className="h-12 w-12 text-[#00D4FF]" />,
        };
    }
  };

  const { title, description, subtext, icon } = getMessage();

  const handleCreateAccount = async () => {
    setAcknowledging(true);
    try {
      if (eventId) {
        await apiRequest("POST", "/api/auth/access-denied-acknowledge", { eventId });
      }
    } catch (err) {
    }
    setLocation("/register");
  };

  const handleBackToLogin = async () => {
    setAcknowledging(true);
    try {
      if (eventId) {
        await apiRequest("POST", "/api/auth/access-denied-acknowledge", { eventId });
      }
    } catch (err) {
    }
    setLocation("/login");
  };

  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0F] via-[#0f1420] to-[#0A0A0F]" />
      <div className="absolute top-[-20%] right-[-10%] w-[36rem] h-[36rem] rounded-full bg-[#00D4FF]/10 blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-20%] left-[-10%] w-[36rem] h-[36rem] rounded-full bg-[#FF3366]/10 blur-3xl pointer-events-none" />

      <Card className="relative z-10 w-full max-w-lg bg-white/[0.03] border border-white/10 backdrop-blur-md rounded-2xl shadow-2xl shadow-black/40">
        <CardHeader className="text-center space-y-5 pb-4">
          <div className="flex justify-center">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
              {icon}
            </div>
          </div>
          <div className="space-y-2">
            <CardTitle
              className="text-2xl sm:text-3xl font-bold font-display text-white"
              data-testid="text-access-denied-title"
            >
              {title}
            </CardTitle>
            <CardDescription className="text-white/70 text-base">
              {description}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-center text-white/60 text-sm">
            {subtext}
          </p>

          <div className="space-y-3">
            <Button
              onClick={handleCreateAccount}
              disabled={acknowledging}
              className="w-full h-12 text-base font-semibold bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:opacity-90 transition-opacity text-white border-0 shadow-lg shadow-[#00D4FF]/20"
              data-testid="button-create-account"
            >
              <UserPlus className="mr-2 h-5 w-5" />
              Crear Mi Propia Cuenta
            </Button>

            <Button
              variant="outline"
              onClick={handleBackToLogin}
              disabled={acknowledging}
              className="w-full h-10 border-white/15 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white"
              data-testid="button-back-login"
            >
              <ArrowRight className="mr-2 h-4 w-4" />
              Volver al Inicio de Sesión
            </Button>
          </div>

          <div className="pt-4 border-t border-white/10">
            <p className="text-center text-white/50 text-xs">
              Si tenés alguna pregunta, contactanos a{" "}
              <span className="text-[#00D4FF]">soporte@aikestar.com</span>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
