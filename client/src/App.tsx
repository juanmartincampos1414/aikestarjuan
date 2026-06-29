import { Switch, Route, Redirect, useLocation } from "wouter";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { userAPI } from "@/lib/api";
import React, { lazy, Suspense, useState, useEffect } from "react";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { CACHE_DURATIONS } from "@shared/constants";
import { FEATURE_FLAGS } from "@/lib/constants";

import PermissionDeniedDialog from "@/components/PermissionDeniedDialog";
import AuthPage from "@/pages/auth";
import SignupSuccessPage from "@/pages/signup-success";
import PaymentSuccessPage from "@/pages/payment-success";
import NotFound from "@/pages/not-found";
import SubscriptionRequired from "@/pages/subscription-required";
import AccessDenied from "@/pages/access-denied";
import PricingPage from "@/pages/pricing";

const DashboardPage = lazy(() => import("@/pages/dashboard"));
const TransactionsPage = lazy(() => import("@/pages/transactions"));
const AccountsPage = lazy(() => import("@/pages/accounts"));
const OfficePage = lazy(() => import("@/pages/office"));
const AIAssistantPage = lazy(() => import("@/pages/ai-assistant"));
const ReportsPage = lazy(() => import("@/pages/reports"));
const ImpuestosPage = lazy(() => import("@/pages/impuestos"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const ClientsPage = lazy(() => import("@/pages/clients"));
const SuppliersPage = lazy(() => import("@/pages/suppliers"));
const ProductsPage = lazy(() => import("@/pages/products"));
const TiendanubeCatalogPage = lazy(() => import("@/pages/tiendanube-catalog"));
const CrmPage = lazy(() => import("@/pages/crm"));
const WorkOrdersPage = lazy(() => import("@/pages/work-orders"));
const RemitosPage = lazy(() => import("@/pages/remitos"));
const InvestmentsPage = lazy(() => import("@/pages/investments"));
const InvoicesPage = lazy(() => import("@/pages/invoices"));
const CalendarPage = lazy(() => import("@/pages/calendar"));
const OrphanTransfersPage = lazy(() => import("@/pages/orphan-transfers"));
const HRPage = lazy(() => import("@/pages/hr"));
const AdminPage = lazy(() => import("@/pages/admin"));

// Landings públicas por audiencia (tráfico de anuncios). Accesibles con o sin sesión.
const PymesLanding = lazy(() => import("@/pages/landings/pymes"));
const EmprendedoresLanding = lazy(() => import("@/pages/landings/emprendedores"));
const ParejasLanding = lazy(() => import("@/pages/landings/parejas"));

// Página pública de Términos y Condiciones. Accesible con o sin sesión.
const TerminosPage = lazy(() => import("@/pages/terminos"));
const PrivacidadPage = lazy(() => import("@/pages/privacidad"));

function LandingRoutes({ path }: { path: string }) {
  const Landing =
    path === '/pymes'
      ? PymesLanding
      : path === '/emprendedores'
        ? EmprendedoresLanding
        : ParejasLanding;
  return (
    <Suspense fallback={<LoadingFallback />}>
      <Landing />
    </Suspense>
  );
}

function LoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-lg text-foreground">Cargando...</div>
    </div>
  );
}

function AuthenticatedRoutes() {
  return (
    <DashboardLayout>
      <Suspense fallback={<LoadingFallback />}>
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/transactions" component={TransactionsPage} />
          <Route path="/calendar" component={CalendarPage} />
          <Route path="/orphan-transfers" component={OrphanTransfersPage} />
          <Route path="/accounts" component={AccountsPage} />
          <Route path="/office" component={OfficePage} />
          <Route path="/ai-assistant" component={AIAssistantPage} />
          <Route path="/reports" component={ReportsPage} />
          <Route path="/impuestos" component={ImpuestosPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/team">{() => <Redirect to="/settings?tab=team" />}</Route>
          <Route path="/clients" component={ClientsPage} />
          <Route path="/suppliers" component={SuppliersPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/tiendanube-catalogo" component={TiendanubeCatalogPage} />
          <Route path="/crm" component={CrmPage} />
          <Route path="/ordenes" component={WorkOrdersPage} />
          <Route path="/remitos" component={RemitosPage} />
          <Route path="/inversiones" component={InvestmentsPage} />
          {FEATURE_FLAGS.INVOICING_ENABLED && (
            <Route path="/invoices" component={InvoicesPage} />
          )}
          <Route path="/hr" component={HRPage} />
          <Route path="/audit-logs">{() => <Redirect to="/settings?tab=audit" />}</Route>
          <Route path="/audit">{() => <Redirect to="/settings?tab=audit" />}</Route>
          <Route path="/admin" component={AdminPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </DashboardLayout>
  );
}

function Router() {
  const [location, setLocation] = useLocation();
  const qc = useQueryClient();
  const [isRecovering, setIsRecovering] = useState(false);
  const hasTriedRecovery = React.useRef(false);
  const loadingStartTime = React.useRef(Date.now());
  
  // Check session via API call (cookies are sent automatically)
  const { data: user, isLoading, isError } = useQuery({
    queryKey: ['user'],
    queryFn: userAPI.getCurrent,
    retry: false,
    staleTime: CACHE_DURATIONS.STALE_TIME,
  });
  
  // Try to recover session for mobile browsers that may have lost cookies
  // This handles both checkout redirects and login recovery
  useEffect(() => {
    const tryRecoverSession = async () => {
      // Only try once per app load
      if (hasTriedRecovery.current || isLoading || user) return;
      
      try {
        // First try checkout session recovery (for Stripe redirects)
        const savedCheckoutSession = localStorage.getItem('aikestar_checkout_session');
        const savedCheckoutTime = localStorage.getItem('aikestar_checkout_time');
        
        if (savedCheckoutSession && savedCheckoutTime) {
          const checkoutTime = parseInt(savedCheckoutTime, 10);
          if (Date.now() - checkoutTime <= 5 * 60 * 1000) {
            hasTriedRecovery.current = true;
            setIsRecovering(true);
            
            const response = await fetch('/api/auth/validate-checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ sessionId: savedCheckoutSession }),
            });
            
            localStorage.removeItem('aikestar_checkout_session');
            localStorage.removeItem('aikestar_checkout_time');
            
            if (response.ok) {
              qc.invalidateQueries({ queryKey: ['user'] });
              setIsRecovering(false);
              return;
            }
          } else {
            localStorage.removeItem('aikestar_checkout_session');
            localStorage.removeItem('aikestar_checkout_time');
          }
        }
        
        // Then try login session recovery using one-time recovery token
        // This token is NOT the session ID - it's a separate, single-use token for security
        const savedToken = localStorage.getItem('recoveryToken');
        const savedTokenTime = localStorage.getItem('recoveryTokenTime');
        
        if (savedToken && savedTokenTime) {
          const tokenTime = parseInt(savedTokenTime, 10);
          // Allow recovery within 5 minutes of login (short window for security)
          if (Date.now() - tokenTime <= 5 * 60 * 1000) {
            hasTriedRecovery.current = true;
            setIsRecovering(true);
            
            console.log('[App] Attempting session recovery with token');
            
            const response = await fetch('/api/auth/recover-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ recoveryToken: savedToken }),
            });
            
            // Always clear the token after use (one-time use)
            localStorage.removeItem('recoveryToken');
            localStorage.removeItem('recoveryTokenTime');
            
            if (response.ok) {
              console.log('[App] Session recovery successful');
              qc.invalidateQueries({ queryKey: ['user'] });
            } else {
              console.log('[App] Session recovery failed');
            }
          } else {
            console.log('[App] Recovery token expired, clearing');
            localStorage.removeItem('recoveryToken');
            localStorage.removeItem('recoveryTokenTime');
          }
        }
      } catch (err) {
        console.error('[App] Session recovery error:', err);
        localStorage.removeItem('aikestar_checkout_session');
        localStorage.removeItem('aikestar_checkout_time');
        localStorage.removeItem('recoveryToken');
        localStorage.removeItem('recoveryTokenTime');
      } finally {
        setIsRecovering(false);
      }
    };
    
    tryRecoverSession();
  }, [isLoading, user, qc]);
  
  useEffect(() => {
    if (!isLoading && !isRecovering) {
      loadingStartTime.current = Date.now();
      return;
    }
    const timer = setTimeout(() => {
      if (isLoading || isRecovering) {
        console.warn('[App] Auth check timeout after 8s — redirecting to /login');
        setIsRecovering(false);
        hasTriedRecovery.current = true;
        if (location !== '/login' && location !== '/register' && location !== '/auth') {
          setLocation('/login');
        }
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [isLoading, isRecovering, location, setLocation]);
  
  // Landings públicas por audiencia: accesibles siempre (con o sin sesión) y
  // sin esperar el chequeo de sesión. Aditivo: no afecta el resto del ruteo.
  // Se normaliza el trailing slash para aceptar variantes como "/pymes/".
  const landingPath = location.replace(/\/+$/, '') || '/';
  if (landingPath === '/pymes' || landingPath === '/emprendedores' || landingPath === '/parejas') {
    return <LandingRoutes path={landingPath} />;
  }

  // Términos y Condiciones: página pública accesible siempre (con o sin sesión),
  // sin esperar el chequeo de sesión. Aditivo: no afecta el resto del ruteo.
  if (landingPath === '/terminos') {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <TerminosPage />
      </Suspense>
    );
  }

  // Política de Privacidad: página pública accesible siempre (con o sin sesión),
  // sin esperar el chequeo de sesión. Aditivo: no afecta el resto del ruteo.
  if (landingPath === '/privacidad') {
    return (
      <Suspense fallback={<LoadingFallback />}>
        <PrivacidadPage />
      </Suspense>
    );
  }

  // Show loading state while checking auth or recovering session
  if (isLoading || isRecovering) {
    return <LoadingFallback />;
  }
  
  // If not authenticated (error or no user), show auth routes
  if (isError || !user) {
    return (
      <Switch>
        <Route path="/login">{() => <AuthPage />}</Route>
        <Route path="/register">{() => <AuthPage initialTab="register" />}</Route>
        <Route path="/auth/signup-success" component={SignupSuccessPage} />
        <Route path="/auth"><Redirect to="/login" /></Route>
        <Route path="/payment-success" component={PaymentSuccessPage} />
        <Route path="/reset-password">{() => <AuthPage />}</Route>
        <Route path="/subscription-required" component={SubscriptionRequired} />
        <Route path="/access-denied" component={AccessDenied} />
        <Route path="/pricing" component={PricingPage} />
        <Route>
          <Redirect to="/login" />
        </Route>
      </Switch>
    );
  }
  
  // Authenticated - show app routes
  return (
    <Switch>
      <Route path="/auth">
        <Redirect to="/" />
      </Route>
      <Route path="/login">
        <Redirect to="/" />
      </Route>
      <Route path="/register">
        <Redirect to="/" />
      </Route>
      <Route path="/subscription-required" component={SubscriptionRequired} />
      <Route path="/payment-success" component={PaymentSuccessPage} />
      {/* Task #339 — /pricing debe montarse standalone (sin DashboardLayout)
          también para usuarios autenticados. De lo contrario, un usuario
          con suscripción cancelada/pendiente que viene de /subscription-required
          quedaba atrapado en un loop: DashboardLayout disparaba queries
          protegidas → 402 SUBSCRIPTION_INACTIVE → el handler global en
          api.ts redirigía de vuelta a /subscription-required. */}
      <Route path="/pricing" component={PricingPage} />
      <Route>
        <AuthenticatedRoutes />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Router />
        <PermissionDeniedDialog />
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
