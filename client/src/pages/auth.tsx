import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useLogin } from '@/lib/hooks';
import { fetchWithAuth, AccessDeniedError } from '@/lib/api';
import { useLocation, useSearch } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { User, Users, Building2, ArrowLeft, Mail, Lock, UserPlus, KeyRound, Globe, Eye, EyeOff, Loader2, Sparkles, ShieldCheck, Check, X, Zap, Brain, Smartphone, DollarSign, BarChart3, FileText, Clock, Shield, MessageSquare, TrendingUp, UsersRound, Briefcase, Target, Phone } from 'lucide-react';
import { COUNTRIES, COUNTRY_LABELS, type Country } from '@/lib/constants';
import CountryPhoneInput from '@/components/CountryPhoneInput';
import { PROFILE_ICON_OPTIONS } from '@/components/UserProfilePicker';
import { PLAN_DETAILS, PLAN_LABELS, PLAN_TYPES, type PlanType } from '@shared/schema';
import { PlansShowcase } from '@/components/plans/PlansShowcase';
import aikestarLogo from '@/assets/aikestar-logo.png';

// Planes visibles por audiencia (landings por anuncio). Sin audiencia se
// muestran todos los planes (registro común intacto).
const AUDIENCE_PLANS: Record<'pymes' | 'emprendedores' | 'parejas', PlanType[]> = {
  pymes: ['solo', 'team', 'business'],
  emprendedores: ['personal_pro', 'solo'],
  parejas: ['personal_pro'],
};

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Contraseña requerida'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Nombre muy corto'),
  email: z.string().email('Email inválido'),
  password: z.string().min(5, 'Mínimo 5 caracteres'),
  confirmPassword: z.string(),
  accountType: z.enum(['personal', 'business']),
  organizationName: z.string().optional(),
  country: z.enum(COUNTRIES),
  profileIconKey: z.string().optional(),
  planType: z.enum(PLAN_TYPES).optional(),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: 'Debes aceptar los Términos y Condiciones',
  }),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Las contraseñas no coinciden",
  path: ["confirmPassword"],
});

const forgotSchema = z.object({
  email: z.string().email('Email inválido'),
});

const resetSchema = z.object({
  email: z.string().email('Email inválido'),
  token: z.string().min(1, 'Token requerido'),
  newPassword: z.string().min(5, 'Mínimo 5 caracteres'),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Las contraseñas no coinciden",
  path: ["confirmPassword"],
});

const changePasswordSchema = z.object({
  newPassword: z.string().min(5, 'Mínimo 5 caracteres'),
  confirmPassword: z.string(),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Las contraseñas no coinciden",
  path: ["confirmPassword"],
});

type LoginFormValues = z.infer<typeof loginSchema>;
type RegisterFormValues = z.infer<typeof registerSchema>;
type ForgotFormValues = z.infer<typeof forgotSchema>;
type ResetFormValues = z.infer<typeof resetSchema>;
type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

function FuturisticLoader() {
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="relative">
        <div className="w-5 h-5 border-2 border-transparent border-t-[#00D4FF] border-r-[#FF3366] rounded-full animate-spin"></div>
        <div className="absolute inset-0 w-5 h-5 border-2 border-transparent border-b-[#00D4FF] border-l-[#FF3366] rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '0.8s' }}></div>
      </div>
      <span className="text-white/80">Conectando...</span>
    </div>
  );
}

export default function AuthPage({ initialTab }: { initialTab?: 'login' | 'register' } = {}) {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const loginMutation = useLogin();
  
  const deriveTab = (): string => {
    if (initialTab) return initialTab;
    if (location === '/register') return 'register';
    return 'login';
  };
  const [activeTab, setActiveTab] = useState<string>(deriveTab);

  useEffect(() => {
    const tab = deriveTab();
    if (tab !== activeTab && tab !== 'forgot') {
      setActiveTab(tab);
    }
  }, [location, initialTab]);
  const [showResetForm, setShowResetForm] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showNewConfirmPassword, setShowNewConfirmPassword] = useState(false);
  const [registerStep, setRegisterStep] = useState<'plan' | 'form'>('plan');
  const [selectedPlan, setSelectedPlan] = useState<PlanType | null>(null);
  const [registerPhone, setRegisterPhone] = useState('');

  // Fetch Stripe products to get priceIds (public endpoint)
  const { data: stripeProducts = [], isLoading: isLoadingProducts } = useQuery<any[]>({
    queryKey: ['/stripe/products'],
    queryFn: async () => {
      const res = await fetch('/api/stripe/products');
      if (!res.ok) {
        console.error('Failed to fetch Stripe products:', res.status);
        return [];
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2,
  });

  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { 
      name: '', 
      email: '', 
      password: '', 
      confirmPassword: '',
      accountType: 'business',
      organizationName: '',
      country: 'AR',
      profileIconKey: PROFILE_ICON_OPTIONS[Math.floor(Math.random() * PROFILE_ICON_OPTIONS.length)].key,
      acceptTerms: false,
    },
  });

  const forgotForm = useForm<ForgotFormValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: '' },
  });

  const resetForm = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { email: resetEmail, token: resetToken, newPassword: '', confirmPassword: '' },
  });

  const changePasswordForm = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const accountType = registerForm.watch('accountType');

  // Audiencia (landings por anuncio): ?audience=pymes|emprendedores|parejas.
  // Sin audiencia válida => undefined => el registro común muestra TODOS los planes.
  const audienceParam = new URLSearchParams(searchString || '').get('audience');
  const audience =
    audienceParam === 'pymes' || audienceParam === 'emprendedores' || audienceParam === 'parejas'
      ? audienceParam
      : null;
  const allowedPlans = audience ? AUDIENCE_PLANS[audience] : undefined;

  // Si la audiencia tiene un único plan (parejas => personal_pro), lo
  // preseleccionamos y saltamos directo al formulario. Sólo una vez.
  useEffect(() => {
    if (
      activeTab === 'register' &&
      allowedPlans &&
      allowedPlans.length === 1 &&
      !selectedPlan
    ) {
      const plan = allowedPlans[0];
      setSelectedPlan(plan);
      registerForm.setValue(
        'accountType',
        PLAN_DETAILS[plan].isTeamPlan ? 'business' : 'personal',
      );
      registerForm.setValue('planType', plan);
      setRegisterStep('form');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, audience]);

  // CRITICAL FIX: Clean up stale auth state when landing on login page
  // This handles cases where browser has old cookies pointing to deleted sessions
  // BUT: Don't destroy session if user just logged in (has fresh authToken)
  useEffect(() => {
    const cleanupAuthState = async () => {
      // Check if there's a recent auth token (indicates fresh login)
      // If there is, DON'T clear it - the user was just redirected here due to a cookie issue
      // and we need to preserve the authToken for Bearer authentication
      let existingToken: string | null = null;
      try {
        existingToken = localStorage.getItem('aikestar_auth_token');
      } catch (e) {
        // Ignore
      }
      
      if (existingToken) {
        console.log('[Auth] Found existing authToken, skipping cleanup to preserve session');
        // Don't clear anything - the token should be used for authentication
        return;
      }
      
      console.log('[Auth] No auth token found, cleaning up stale state...');
      
      // Clear any stale recovery tokens from localStorage (but not authToken since we already checked)
      try {
        localStorage.removeItem('recoveryToken');
        localStorage.removeItem('recoveryTokenTime');
      } catch (e) {
        console.warn('[Auth] Could not clear localStorage:', e);
      }
      
      // Call force-logout to clear server-side cookies
      try {
        await fetch('/api/auth/force-logout', {
          method: 'POST',
          credentials: 'include',
        });
        console.log('[Auth] Force logout completed - stale auth state cleaned');
      } catch (e) {
        console.warn('[Auth] Force logout failed:', e);
      }
    };
    
    // Only run cleanup on initial mount, not on every re-render
    cleanupAuthState();
  }, []); // Empty deps - only on mount

  // Sync state with reset data from various sources
  // Priority: 1. sessionStorage, 2. localStorage, 3. URL hash, 4. query params
  useEffect(() => {
    const syncResetData = () => {
      console.log('[Auth] Syncing reset data...', { 
        pathname: window.location.pathname,
        hash: window.location.hash ? 'present' : 'none',
        search: window.location.search ? 'present' : 'none'
      });
      
      // Helper to apply reset data
      const applyResetData = (source: string, data: { email: string; token: string }) => {
        console.log('[Auth] Reset password flow detected from ' + source + ':', { email: data.email });
        setShowResetForm(true);
        setActiveTab('forgot'); // Switch to the forgot tab where the reset form is displayed
        setResetToken(data.token);
        setResetEmail(data.email);
        resetForm.reset({
          email: data.email,
          token: data.token,
          newPassword: '',
          confirmPassword: ''
        });
      };
      
      // 1. Check sessionStorage first (set by /api/auth/reset-redirect, most reliable)
      const sessionData = sessionStorage.getItem('passwordResetData');
      if (sessionData) {
        try {
          const resetData = JSON.parse(sessionData);
          if (resetData.email && resetData.token) {
            applyResetData('sessionStorage', resetData);
            sessionStorage.removeItem('passwordResetData');
            return;
          }
        } catch (e) {
          console.error('[Auth] Failed to parse session reset data:', e);
        }
        sessionStorage.removeItem('passwordResetData');
      }
      
      // 2. Check localStorage (backup from redirect page)
      const storedData = localStorage.getItem('passwordResetData');
      if (storedData) {
        try {
          const resetData = JSON.parse(storedData);
          const age = Date.now() - (resetData.timestamp || resetData.ts || 0);
          
          if (age < 60 * 60 * 1000 && resetData.email && resetData.token) {
            applyResetData('localStorage', resetData);
            localStorage.removeItem('passwordResetData');
            return;
          }
        } catch (e) {
          console.error('[Auth] Failed to parse stored reset data:', e);
        }
        localStorage.removeItem('passwordResetData');
      }
      
      // 3. Check URL hash (fallback)
      const hash = window.location.hash;
      if (hash.startsWith('#reset=')) {
        try {
          const encodedData = hash.substring(7);
          const resetData = JSON.parse(decodeURIComponent(encodedData));
          if (resetData.email && resetData.token) {
            applyResetData('URL hash', resetData);
            window.history.replaceState(null, '', window.location.pathname);
            return;
          }
        } catch (e) {
          console.error('[Auth] Failed to parse hash reset data:', e);
        }
      }
      
      // 4. Check URL query params (original method)
      const params = new URLSearchParams(window.location.search);
      const tokenFromUrl = params.get('token');
      const emailFromUrl = params.get('email');
      const modeFromUrl = params.get('mode');
      
      if (tokenFromUrl && emailFromUrl) {
        applyResetData('query params', { email: emailFromUrl, token: tokenFromUrl });
        return;
      }
      
      // Handle register mode
      if (modeFromUrl === 'register') {
        setActiveTab('register');
      }
    };
    
    // Run immediately
    syncResetData();
    
    // Also run after delays to handle hydration/timing issues
    const timer1 = setTimeout(syncResetData, 50);
    const timer2 = setTimeout(syncResetData, 200);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [searchString]);

  const onLogin = async (data: LoginFormValues) => {
    try {
      const result = await loginMutation.mutateAsync(data);
      
      // CRITICAL: Save auth token for Bearer authentication fallback
      // This is the primary fix for cookie-based authentication failures
      if (result.authToken) {
        const { setAuthToken } = await import('@/lib/api');
        setAuthToken(result.authToken);
      }
      
      // CRITICAL FIX: Always use recovery token to establish session
      // This handles cases where browser cookies are not being set correctly
      if (result.recoveryToken) {
        try {
          console.log('[Auth] Calling recover-session to ensure session is established...');
          const recoverResponse = await fetch('/api/auth/recover-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recoveryToken: result.recoveryToken }),
            credentials: 'include',
          });
          
          if (recoverResponse.ok) {
            console.log('[Auth] Session recovered successfully via token');
          } else {
            console.log('[Auth] Recovery failed, continuing with normal flow');
            // Store token for later use in App.tsx fallback
            localStorage.setItem('recoveryToken', result.recoveryToken);
            localStorage.setItem('recoveryTokenTime', Date.now().toString());
          }
        } catch (recoverError) {
          console.error('[Auth] Recovery call failed:', recoverError);
          // Store token for later use
          localStorage.setItem('recoveryToken', result.recoveryToken);
          localStorage.setItem('recoveryTokenTime', Date.now().toString());
        }
      }
      
      toast({
        title: "¡Bienvenido!",
        description: `Hola ${result.user?.name || 'usuario'}. Ingresando...`,
      });
      // Clear all React Query cache before redirect to ensure fresh data fetch
      // This prevents stale 401 responses from being used after login
      const { queryClient } = await import('@/lib/queryClient');
      queryClient.clear();
      
      // Small delay so user can see the welcome message
      setTimeout(() => {
        if (result.user?.mustChangePassword) {
          window.location.href = '/settings?firstLogin=true';
        } else {
          window.location.href = '/';
        }
      }, 1000);
    } catch (error: any) {
      // Handle access denied (member removed or org owner deleted)
      if (error instanceof AccessDeniedError) {
        const params = new URLSearchParams({
          reason: error.code,
          org: error.organizationName,
          eventId: error.eventId,
        });
        if (error.removedByUserName) {
          params.set('removedBy', error.removedByUserName);
        }
        window.location.href = `/access-denied?${params.toString()}`;
        return;
      }
      
      toast({
        title: "Error de autenticación",
        description: error.message || "Email o contraseña incorrectos",
        variant: "destructive",
      });
    }
  };

  const onChangePassword = async (data: ChangePasswordFormValues) => {
    setIsChangingPassword(true);
    try {
      const result = await fetchWithAuth('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: data.newPassword }),
      });
      
      toast({
        title: "Contraseña actualizada",
        description: "Ya puedes usar tu nueva contraseña",
      });
      setShowChangePasswordDialog(false);
      window.location.href = '/';
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const onRegister = async (data: RegisterFormValues) => {
    if (!selectedPlan) {
      toast({
        title: "Selecciona un plan",
        description: "Debes elegir un plan antes de continuar",
        variant: "destructive",
      });
      setRegisterStep('plan');
      return;
    }
    
    // Check if products are loaded - if not, try to fetch them
    if (!stripeProducts || stripeProducts.length === 0) {
      if (isLoadingProducts) {
        toast({
          title: "Cargando",
          description: "Estamos cargando la información de pago. Intentá de nuevo en unos segundos.",
        });
      } else {
        toast({
          title: "Error de conexión",
          description: "No pudimos cargar los planes de pago. Recargá la página e intentá de nuevo.",
          variant: "destructive",
        });
      }
      return;
    }
    
    // Find the priceId for the selected plan
    const selectedProduct = stripeProducts.find(
      (p: any) => p.metadata?.planType === selectedPlan
    );
    
    if (!selectedProduct || !selectedProduct.prices?.[0]?.id) {
      toast({
        title: "Error",
        description: "No se encontró el precio del plan seleccionado. Intenta de nuevo.",
        variant: "destructive",
      });
      return;
    }
    
    const priceId = selectedProduct.prices[0].id;
    
    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: data.email.toLowerCase().trim(),
          name: data.name,
          password: data.password,
          accountType: data.accountType,
          organizationName: data.accountType === 'business' ? data.organizationName : undefined,
          country: data.country,
          profileIconKey: data.profileIconKey,
          planType: selectedPlan,
          priceId: priceId,
          phoneNumber: registerPhone || undefined,
          acceptTerms: data.acceptTerms === true,
        }),
      });
      
      const result = await response.json().catch(() => ({ message: 'Error de conexión. Por favor intentá de nuevo.' }));
      
      if (!response.ok) {
        throw new Error(result.message || 'Error al registrar');
      }
      
      // Redirect to Stripe checkout
      if (result.checkoutUrl) {
        toast({
          title: "Configurando tu cuenta...",
          description: "Ingresá tu método de pago para activar tu mes gratis",
        });
        window.location.href = result.checkoutUrl;
      } else {
        throw new Error('No se recibió URL de checkout');
      }
    } catch (error: any) {
      toast({
        title: "Error al registrar",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onForgotPassword = async (data: ForgotFormValues) => {
    setIsLoading(true);
    try {
      const result = await fetchWithAuth('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: data.email.toLowerCase().trim() }),
      }, true);
      
      if (result.token) {
        setResetToken(result.token);
        setResetEmail(data.email);
        resetForm.setValue('email', data.email);
        resetForm.setValue('token', result.token);
        setShowResetForm(true);
        toast({
          title: "Token generado",
          description: "Ingresa tu nueva contraseña",
        });
      } else {
        toast({
          title: "Solicitud enviada",
          description: result.message,
        });
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const onResetPassword = async (data: ResetFormValues) => {
    setIsLoading(true);
    try {
      const result = await fetchWithAuth('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          email: data.email.toLowerCase().trim(),
          token: data.token,
          newPassword: data.newPassword,
        }),
      }, true);
      
      toast({
        title: "Contraseña actualizada",
        description: "Ya puedes iniciar sesión con tu nueva contraseña",
      });
      setShowResetForm(false);
      setActiveTab('login');
      setLocation('/login');
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const inputClasses = "bg-white/5 border-white/10 text-white placeholder:text-white/40 focus:border-[#00D4FF] focus:ring-[#00D4FF]/20 transition-all duration-300 hover:border-white/20";
  const labelClasses = "text-white/80 font-medium";

  return (
    <div className={`min-h-screen grid ${activeTab === 'register' && registerStep === 'form' ? 'lg:grid-cols-2' : ''} bg-[#0A0A0F]`}>
      {/* Left side - Forms */}
      <div className="flex items-center justify-center p-6 sm:p-8 relative overflow-hidden">
        {/* Animated background gradients */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-radial from-[#00D4FF]/10 to-transparent rounded-full blur-3xl animate-pulse" style={{ animationDuration: '4s' }}></div>
          <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-radial from-[#FF3366]/10 to-transparent rounded-full blur-3xl animate-pulse" style={{ animationDuration: '5s', animationDelay: '1s' }}></div>
        </div>
        
        <div className={`w-full ${activeTab === 'register' && registerStep === 'plan' ? 'max-w-7xl' : 'max-w-md'} space-y-6 relative z-10`}>
          {/* Logo with animation */}
          <div className="flex flex-col items-center text-center space-y-4">
            <div className="relative group">
              <div className="absolute inset-0 bg-gradient-to-r from-[#00D4FF] to-[#FF3366] rounded-full blur-xl opacity-30 group-hover:opacity-50 transition-opacity duration-500"></div>
              <img 
                src={aikestarLogo} 
                alt="Aikestar" 
                className="h-20 w-20 relative z-10 animate-logo-pulse drop-shadow-[0_0_15px_rgba(0,212,255,0.5)]" 
              />
            </div>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold font-display tracking-tight">
                <span className="gradient-text">AI.KESTAR</span>
              </h1>
              <p className="text-white/60 mt-2">Tu gestión administrativa e inteligente</p>
            </div>
          </div>

          {/* Card with glassmorphism */}
          <Card className="border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl shadow-black/50">
            <CardContent className="pt-6">
              <Tabs value={activeTab} onValueChange={(val) => { setLocation((val === 'register' ? '/register' : '/login') + (audience ? `?audience=${audience}` : '')); }}>
                <TabsList className="grid w-full grid-cols-2 mb-6 bg-white/5 border border-white/10">
                  <TabsTrigger 
                    value="login" 
                    className="gap-2 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF]/20 data-[state=active]:to-[#FF3366]/20 data-[state=active]:text-white text-white/60 transition-all duration-300" 
                    data-testid="tab-login"
                  >
                    <Lock className="h-4 w-4" />
                    Ingresar
                  </TabsTrigger>
                  <TabsTrigger 
                    value="register" 
                    className="gap-2 data-[state=active]:bg-gradient-to-r data-[state=active]:from-[#00D4FF]/20 data-[state=active]:to-[#FF3366]/20 data-[state=active]:text-white text-white/60 transition-all duration-300" 
                    data-testid="tab-register"
                  >
                    <UserPlus className="h-4 w-4" />
                    Crear Cuenta
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="login">
                  <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="login-email" className={labelClasses}>Email</Label>
                      <div className="relative group">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 group-focus-within:text-[#00D4FF] transition-colors" />
                        <Input 
                          id="login-email" 
                          type="email"
                          placeholder="tu@email.com" 
                          {...loginForm.register('email')}
                          className={`pl-10 ${inputClasses} ${loginForm.formState.errors.email ? "border-red-500" : ""}`}
                          data-testid="input-login-email"
                        />
                      </div>
                      {loginForm.formState.errors.email && (
                        <p className="text-xs text-red-400">{loginForm.formState.errors.email.message}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="login-password" className={labelClasses}>Contraseña</Label>
                      <div className="relative group">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 group-focus-within:text-[#00D4FF] transition-colors" />
                        <Input 
                          id="login-password" 
                          type={showLoginPassword ? "text" : "password"} 
                          placeholder="••••••••" 
                          {...loginForm.register('password')}
                          className={`pl-10 pr-10 ${inputClasses} ${loginForm.formState.errors.password ? "border-red-500" : ""}`}
                          data-testid="input-login-password"
                        />
                        <button
                          type="button"
                          onClick={() => setShowLoginPassword(!showLoginPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                          data-testid="toggle-login-password"
                        >
                          {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {loginForm.formState.errors.password && (
                        <p className="text-xs text-red-400">{loginForm.formState.errors.password.message}</p>
                      )}
                    </div>
                    <Button 
                      type="submit" 
                      className="w-full h-12 text-lg font-semibold bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 text-white border-0 shadow-lg shadow-[#00D4FF]/20 transition-all duration-300 hover:shadow-[#00D4FF]/40 hover:scale-[1.02]"
                      disabled={loginMutation.isPending}
                      data-testid="button-login"
                    >
                      {loginMutation.isPending ? <FuturisticLoader /> : (
                        <>
                          <Sparkles className="h-5 w-5 mr-2" />
                          Ingresar
                        </>
                      )}
                    </Button>
                  </form>
                  <button
                    type="button"
                    onClick={() => setActiveTab('forgot')}
                    className="w-full mt-4 text-sm text-[#00D4FF] hover:text-[#00D4FF]/80 transition-colors"
                    data-testid="link-forgot-password"
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      // Force clear all auth state and reload
                      try {
                        localStorage.removeItem('aikestar_auth_token');
                        localStorage.removeItem('recoveryToken');
                        localStorage.removeItem('recoveryTokenTime');
                        await fetch('/api/auth/force-logout', { method: 'POST', credentials: 'include' });
                      } catch (e) {
                        console.warn('Cleanup failed:', e);
                      }
                      window.location.reload();
                    }}
                    className="w-full mt-2 text-xs text-white/40 hover:text-white/60 transition-colors"
                    data-testid="link-clear-session"
                  >
                    ¿Problemas para iniciar sesión? Limpiar y reintentar
                  </button>
                </TabsContent>

                <TabsContent value="register">
                  {registerStep === 'plan' ? (
                    <div className="space-y-6">
                      <div className="text-center mb-6">
                        <h3 className="text-2xl sm:text-3xl font-bold font-display text-white">
                          <span className="bg-gradient-to-r from-[#00D4FF] to-[#FF3366] bg-clip-text text-transparent">
                            Elegí tu plan
                          </span>
                        </h3>
                        <p className="text-sm text-white/70 mt-2">
                          25 funciones que hacen único a Aikestar. Compará y elegí el que mejor se adapte a tu negocio.
                        </p>
                        <div className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-[#00D4FF]/20 to-[#FF3366]/20 border border-[#00D4FF]/30">
                          <Sparkles className="h-4 w-4 text-[#00D4FF]" />
                          <span className="text-sm font-medium bg-gradient-to-r from-[#00D4FF] to-[#FF3366] bg-clip-text text-transparent">
                            Primer mes gratis - Hoy: $0
                          </span>
                        </div>
                      </div>

                      <PlansShowcase
                        mode="register"
                        allowedPlans={allowedPlans}
                        selectedPlan={selectedPlan}
                        onSelectPlan={(plan) => {
                          setSelectedPlan(plan);
                          registerForm.setValue(
                            'accountType',
                            PLAN_DETAILS[plan].isTeamPlan ? 'business' : 'personal',
                          );
                          registerForm.setValue('planType', plan);
                          setRegisterStep('form');
                        }}
                        showComparisonByDefault
                      />

                    </div>
                  ) : (
                    <form onSubmit={registerForm.handleSubmit(onRegister)} className="space-y-4">
                      {selectedPlan && (
                        <>
                          <div className="flex items-center justify-between p-3 rounded-xl border border-white/10 bg-white/5 mb-2">
                            <div className="flex items-center gap-3">
                              {PLAN_DETAILS[selectedPlan].isTeamPlan ? (
                                <Users className="h-5 w-5 text-[#FF3366]" />
                              ) : (
                                <User className="h-5 w-5 text-[#00D4FF]" />
                              )}
                              <div>
                                <span className="text-white font-medium text-sm">{PLAN_LABELS[selectedPlan]}</span>
                                <span className="text-white/40 text-sm ml-2">ARS ${PLAN_DETAILS[selectedPlan].price.toLocaleString('es-AR')}/mes</span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setRegisterStep('plan')}
                              className="text-[#00D4FF] hover:text-[#00D4FF]/80 hover:bg-white/5 text-xs"
                              data-testid="button-change-plan"
                            >
                              Cambiar plan
                            </Button>
                          </div>
                          <div className="flex flex-wrap gap-1 mb-4">
                            {PLAN_DETAILS[selectedPlan].features.map((feature, i) => (
                              <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/60 border border-white/10">
                                {feature}
                              </span>
                            ))}
                          </div>
                        </>
                      )}
                    
                    <div className="space-y-2">
                      <Label htmlFor="name" className={labelClasses}>Nombre completo</Label>
                      <Input 
                        id="name" 
                        placeholder="Juan Pérez" 
                        {...registerForm.register('name')}
                        className={`${inputClasses} ${registerForm.formState.errors.name ? "border-red-500" : ""}`}
                        data-testid="input-register-name"
                      />
                      {registerForm.formState.errors.name && (
                        <p className="text-xs text-red-400">{registerForm.formState.errors.name.message}</p>
                      )}
                    </div>

                    
                    {accountType === 'business' && (
                      <div className="space-y-2">
                        <Label htmlFor="organizationName" className={labelClasses}>Nombre de la organización</Label>
                        <Input 
                          id="organizationName" 
                          placeholder="Mi Organización" 
                          {...registerForm.register('organizationName')}
                          className={inputClasses}
                          data-testid="input-register-org"
                        />
                      </div>
                    )}
                    
                    <div className="space-y-2">
                      <Label className={`flex items-center gap-2 ${labelClasses}`}>
                        <Globe className="h-4 w-4" />
                        País
                      </Label>
                      <Select
                        value={registerForm.watch('country')}
                        onValueChange={(value) => registerForm.setValue('country', value as Country)}
                      >
                        <SelectTrigger className={inputClasses} data-testid="select-country">
                          <SelectValue placeholder="Selecciona tu país" />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a2e] border-white/10">
                          {COUNTRIES.map((code) => (
                            <SelectItem 
                              key={code} 
                              value={code} 
                              className="text-white hover:bg-white/10 focus:bg-white/10"
                              data-testid={`country-option-${code}`}
                            >
                              {COUNTRY_LABELS[code]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label className={`flex items-center gap-2 ${labelClasses}`}>
                        <Phone className="h-4 w-4" />
                        Celular / WhatsApp
                        <span className="text-white/40 text-xs font-normal">(opcional)</span>
                      </Label>
                      <CountryPhoneInput
                        value={registerPhone}
                        onChange={setRegisterPhone}
                        defaultCountryCode={registerForm.watch('country')}
                        inputClassName={inputClasses}
                        selectorClassName="bg-white/5 border-white/10 text-white hover:bg-white/10 hover:text-white hover:border-white/20"
                        searchInputClassName="text-white placeholder:text-white/40 border-white/10"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="register-email" className={labelClasses}>Email</Label>
                      <div className="relative group">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 group-focus-within:text-[#00D4FF] transition-colors" />
                        <Input 
                          id="register-email" 
                          type="email"
                          placeholder="tu@email.com" 
                          {...registerForm.register('email')}
                          className={`pl-10 ${inputClasses} ${registerForm.formState.errors.email ? "border-red-500" : ""}`}
                          data-testid="input-register-email"
                        />
                      </div>
                      {registerForm.formState.errors.email && (
                        <p className="text-xs text-red-400">{registerForm.formState.errors.email.message}</p>
                      )}
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="register-password" className={labelClasses}>Contraseña</Label>
                        <div className="relative">
                          <Input 
                            id="register-password" 
                            type={showRegisterPassword ? "text" : "password"} 
                            placeholder="••••••••" 
                            {...registerForm.register('password')}
                            className={`pr-10 ${inputClasses} ${registerForm.formState.errors.password ? "border-red-500" : ""}`}
                            data-testid="input-register-password"
                          />
                          <button
                            type="button"
                            onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                            data-testid="toggle-register-password"
                          >
                            {showRegisterPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {registerForm.formState.errors.password && (
                          <p className="text-xs text-red-400">{registerForm.formState.errors.password.message}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirm-password" className={labelClasses}>Confirmar</Label>
                        <div className="relative">
                          <Input 
                            id="confirm-password" 
                            type={showConfirmPassword ? "text" : "password"} 
                            placeholder="••••••••" 
                            {...registerForm.register('confirmPassword')}
                            className={`pr-10 ${inputClasses} ${registerForm.formState.errors.confirmPassword ? "border-red-500" : ""}`}
                            data-testid="input-register-confirm"
                          />
                          <button
                            type="button"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                            data-testid="toggle-register-confirm"
                          >
                            {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {registerForm.formState.errors.confirmPassword && (
                          <p className="text-xs text-red-400">{registerForm.formState.errors.confirmPassword.message}</p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id="register-accept-terms"
                          checked={registerForm.watch('acceptTerms')}
                          onCheckedChange={(checked) =>
                            registerForm.setValue('acceptTerms', checked === true, { shouldValidate: true })
                          }
                          className="mt-0.5 border-white/30 data-[state=checked]:bg-[#00D4FF] data-[state=checked]:border-[#00D4FF]"
                          data-testid="checkbox-accept-terms"
                        />
                        <Label
                          htmlFor="register-accept-terms"
                          className="text-sm text-white/70 font-normal leading-snug cursor-pointer"
                        >
                          Acepto los{' '}
                          <a
                            href="/terminos"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#00D4FF] hover:underline"
                            data-testid="link-terminos"
                          >
                            Términos y Condiciones
                          </a>
                        </Label>
                      </div>
                      {registerForm.formState.errors.acceptTerms && (
                        <p className="text-xs text-red-400" data-testid="error-accept-terms">{registerForm.formState.errors.acceptTerms.message}</p>
                      )}
                    </div>

                    <Button 
                      type="submit" 
                      className="w-full h-12 text-lg font-semibold bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 text-white border-0 shadow-lg shadow-[#00D4FF]/20 transition-all duration-300 hover:shadow-[#00D4FF]/40 hover:scale-[1.02]"
                      disabled={isLoading}
                      data-testid="button-register"
                    >
                      {isLoading ? <FuturisticLoader /> : (
                        <>
                          <Sparkles className="h-5 w-5 mr-2" />
                          Comenzar mes gratis
                        </>
                      )}
                    </Button>
                    <p className="text-xs text-white/50 text-center mt-2" data-testid="text-legal-notice-register">
                      Al crear tu cuenta aceptás los{' '}
                      <a
                        href="/terminos"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#00D4FF] hover:underline"
                        data-testid="link-terminos-register"
                      >
                        Términos y Condiciones
                      </a>{' '}
                      y la{' '}
                      <a
                        href="/privacidad"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#00D4FF] hover:underline"
                        data-testid="link-privacidad-register"
                      >
                        Política de Privacidad
                      </a>
                      .
                    </p>
                    {selectedPlan && (
                      <p className="text-xs text-white/50 text-center mt-2" data-testid="text-amex-notice-register">
                        Aceptamos Visa y Mastercard. American Express puede no funcionar en Argentina.
                      </p>
                    )}
                    </form>
                  )}
                </TabsContent>

                <TabsContent value="forgot">
                  {!showResetForm ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setActiveTab('login'); setLocation('/login'); }}
                        className="flex items-center gap-2 text-sm text-white/60 hover:text-white mb-4 transition-colors"
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Volver a iniciar sesión
                      </button>
                      <form onSubmit={forgotForm.handleSubmit(onForgotPassword)} className="space-y-4">
                        <div className="text-center mb-4">
                          <KeyRound className="h-12 w-12 mx-auto text-[#00D4FF] mb-2" />
                          <h3 className="text-lg font-semibold text-white">Recuperar contraseña</h3>
                          <p className="text-sm text-white/60">Ingresa tu email para continuar</p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="forgot-email" className={labelClasses}>Email</Label>
                          <div className="relative group">
                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 group-focus-within:text-[#00D4FF] transition-colors" />
                            <Input 
                              id="forgot-email" 
                              type="email"
                              placeholder="tu@email.com" 
                              {...forgotForm.register('email')}
                              className={`pl-10 ${inputClasses} ${forgotForm.formState.errors.email ? "border-red-500" : ""}`}
                              data-testid="input-forgot-email"
                            />
                          </div>
                          {forgotForm.formState.errors.email && (
                            <p className="text-xs text-red-400">{forgotForm.formState.errors.email.message}</p>
                          )}
                        </div>
                        <Button 
                          type="submit" 
                          className="w-full h-12 bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 text-white border-0"
                          disabled={isLoading}
                          data-testid="button-forgot"
                        >
                          {isLoading ? <FuturisticLoader /> : 'Enviar instrucciones'}
                        </Button>
                      </form>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => { setShowResetForm(false); setActiveTab('login'); setLocation('/login'); }}
                        className="flex items-center gap-2 text-sm text-white/60 hover:text-white mb-4 transition-colors"
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Volver a iniciar sesión
                      </button>
                      <form onSubmit={resetForm.handleSubmit(onResetPassword)} className="space-y-4">
                        <div className="text-center mb-4">
                          <Lock className="h-12 w-12 mx-auto text-[#00D4FF] mb-2" />
                          <h3 className="text-lg font-semibold text-white">Nueva contraseña</h3>
                          <p className="text-sm text-white/60">Ingresa tu nueva contraseña</p>
                        </div>
                        <input type="hidden" {...resetForm.register('email')} />
                        <input type="hidden" {...resetForm.register('token')} />
                        <div className="space-y-2">
                          <Label htmlFor="reset-password" className={labelClasses}>Nueva contraseña</Label>
                          <div className="relative">
                            <Input 
                              id="reset-password" 
                              type={showResetPassword ? "text" : "password"} 
                              placeholder="••••••••" 
                              {...resetForm.register('newPassword')}
                              className={`pr-10 ${inputClasses} ${resetForm.formState.errors.newPassword ? "border-red-500" : ""}`}
                              data-testid="input-reset-password"
                            />
                            <button
                              type="button"
                              onClick={() => setShowResetPassword(!showResetPassword)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                              data-testid="toggle-reset-password"
                            >
                              {showResetPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          {resetForm.formState.errors.newPassword && (
                            <p className="text-xs text-red-400">{resetForm.formState.errors.newPassword.message}</p>
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="reset-confirm" className={labelClasses}>Confirmar contraseña</Label>
                          <div className="relative">
                            <Input 
                              id="reset-confirm" 
                              type={showResetConfirm ? "text" : "password"} 
                              placeholder="••••••••" 
                              {...resetForm.register('confirmPassword')}
                              className={`pr-10 ${inputClasses} ${resetForm.formState.errors.confirmPassword ? "border-red-500" : ""}`}
                              data-testid="input-reset-confirm"
                            />
                            <button
                              type="button"
                              onClick={() => setShowResetConfirm(!showResetConfirm)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                              data-testid="toggle-reset-confirm"
                            >
                              {showResetConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          {resetForm.formState.errors.confirmPassword && (
                            <p className="text-xs text-red-400">{resetForm.formState.errors.confirmPassword.message}</p>
                          )}
                        </div>
                        <Button 
                          type="submit" 
                          className="w-full h-12 bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 text-white border-0"
                          disabled={isLoading}
                          data-testid="button-reset"
                        >
                          {isLoading ? <FuturisticLoader /> : 'Actualizar contraseña'}
                        </Button>
                      </form>
                    </>
                  )}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
      
      {/* Right side - Features (only show on register tab when on form step) */}
      {activeTab === 'register' && registerStep === 'form' && (
        <div className="hidden lg:flex flex-col justify-center p-8 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#0A0A0F] via-[#0f1420] to-[#0A0A0F]"></div>
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-0 left-0 w-full h-full bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMwMEQ0RkYiIGZpbGwtb3BhY2l0eT0iMC4xIj48Y2lyY2xlIGN4PSIzMCIgY3k9IjMwIiByPSIxLjUiLz48L2c+PC9nPjwvc3ZnPg==')]"></div>
          </div>
          <div className="absolute top-1/4 right-0 w-96 h-96 bg-[#00D4FF]/10 rounded-full blur-3xl"></div>
          <div className="absolute bottom-1/4 left-0 w-96 h-96 bg-[#FF3366]/10 rounded-full blur-3xl"></div>
          
          {(() => {
            const displayPlan = selectedPlan;
            const planDetails = displayPlan ? PLAN_DETAILS[displayPlan] : null;
            const isPersonalPlan = planDetails ? !planDetails.isTeamPlan : accountType === 'personal';
            const accentColor = isPersonalPlan ? '#00D4FF' : '#FF3366';
            
            const featureCategories = [
              {
                title: 'Inteligencia Artificial',
                icon: Brain,
                color: '#00D4FF',
                items: [
                  { text: 'Mandás un audio o foto de factura y Aike lo convierte en movimiento', bold: 'IA de verdad' },
                  { text: 'Detecta errores, evita duplicaciones y te sugiere acciones', bold: 'IA que ordena tu admin' },
                ],
              },
              {
                title: 'Gestión Financiera',
                icon: DollarSign,
                color: '#FF3366',
                items: [
                  { text: 'Ingreso, egreso, deuda o cobro: cargás una vez y Aikestar lo ordena', bold: 'Un solo botón' },
                  { text: 'Ves el dinero real hoy y cómo viene tu negocio a futuro', bold: 'Foto y Película' },
                  { text: 'Indicador visual de salud sin saber contabilidad', bold: 'Salud financiera' },
                  { text: 'Cruza pagos, cobros y deudas para que tus números cierren', bold: 'Conciliación 1 click' },
                ],
              },
              {
                title: 'Equipo y Empresa',
                icon: UsersRound,
                color: '#00D4FF',
                items: [
                  { text: 'Varios negocios y tu economía personal en un solo lugar', bold: 'Multiempresa' },
                  { text: 'Visualizás empleados, roles y costos de forma editable', bold: 'Organigrama vivo' },
                  { text: 'Sueldos, honorarios y costos laborales centralizados', bold: 'Nómina' },
                ],
              },
              {
                title: 'Reportes y Exportación',
                icon: BarChart3,
                color: '#FF3366',
                items: [
                  { text: 'Excel, PDF o WhatsApp para socios, contadores o inversores', bold: 'Exportás todo' },
                  { text: 'Reportes claros, exportables y compartibles', bold: 'Listo para tu contador' },
                  { text: 'Calculamos cuánto vale tu negocio con datos reales', bold: 'Valuación automática' },
                ],
              },
              {
                title: 'Más funciones',
                icon: Sparkles,
                color: '#00D4FF',
                items: [
                  { text: 'Pesos, dólares y más, con reportes consolidados', bold: 'Multimoneda' },
                  { text: 'Diseñado mobile-first para controlar todo desde cualquier lugar', bold: '100% mobile' },
                  { text: 'Mensajes, ventas y movimientos conectados', bold: 'WhatsApp Business' },
                  { text: 'Caja blanca e informal con alertas inteligentes', bold: 'Blanco y negro' },
                ],
              },
            ];
            
            return (
              <div className="relative z-10 max-w-lg mx-auto space-y-6 overflow-y-auto max-h-[calc(100vh-4rem)] pr-2 scrollbar-thin">
                {planDetails ? (
                  <>
                    <div>
                      <p className="text-sm text-white/50 mb-2">Plan seleccionado</p>
                      <h2 className="text-4xl font-bold font-display leading-tight text-white">
                        {PLAN_LABELS[displayPlan!]}
                      </h2>
                      <p className="text-2xl font-bold mt-2" style={{ color: accentColor }}>
                        <span className="text-sm font-medium text-white/60">ARS</span> ${planDetails.price.toLocaleString('es-AR')}<span className="text-sm text-white/50 font-normal">/mes</span>
                      </p>
                      <p className="text-xs text-green-400 font-medium">Primer mes gratis</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                        <p className="text-xs text-white/50 mb-1">Organizaciones</p>
                        <p className="font-semibold text-white">
                          {planDetails.maxOrgs === -1 ? 'Ilimitadas' : `Hasta ${planDetails.maxOrgs}`}
                        </p>
                      </div>
                      <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                        <p className="text-xs text-white/50 mb-1">{planDetails.isTeamPlan ? 'Miembros por org' : 'Invitados'}</p>
                        <p className="font-semibold text-white">
                          {planDetails.maxMembersPerOrg === -1 ? 'Ilimitados' : planDetails.isTeamPlan ? `Hasta ${planDetails.maxMembersPerOrg}` : `+${planDetails.maxMembersPerOrg - 1} invitado/a`}
                        </p>
                      </div>
                    </div>
                    <ul className="space-y-2.5">
                      {planDetails.features.map((feature, i) => (
                        <li key={i} className="flex items-start gap-3 group">
                          <span 
                            className="h-7 w-7 rounded-full flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform text-sm"
                            style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                          >✓</span>
                          <div>
                            <span className="font-medium text-white text-sm">{feature}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    <div>
                      <h2 className="text-3xl font-bold font-display leading-tight bg-gradient-to-r from-[#00D4FF] to-[#FF3366] bg-clip-text text-transparent">
                        25 funciones que hacen único a Aikestar
                      </h2>
                      <p className="text-base text-white/60 mt-2">
                        {isPersonalPlan 
                          ? 'Todo lo que necesitás para ordenar tus finanzas personales.'
                          : 'Herramientas profesionales para pymes y emprendedores.'}
                      </p>
                    </div>
                    
                    <div className="space-y-5">
                      {featureCategories.map((cat, ci) => {
                        const Icon = cat.icon;
                        return (
                          <div key={ci} data-testid={`section-features-${ci}`}>
                            <div className="flex items-center gap-2 mb-2.5">
                              <Icon className="h-4 w-4" style={{ color: cat.color }} />
                              <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: cat.color }}>{cat.title}</h3>
                            </div>
                            <div className="space-y-2">
                              {cat.items.map((item, ii) => (
                                <div key={ii} className="flex items-start gap-2.5 group">
                                  <span 
                                    className="h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs"
                                    style={{ backgroundColor: `${cat.color}15`, color: cat.color }}
                                  >✓</span>
                                  <p className="text-sm text-white/80">
                                    <span className="font-medium text-white">{item.bold}:</span> {item.text}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap gap-2 pt-2">
                      {['CRM integrado', 'Importación de datos', 'Rentabilidad por proyecto'].map((item, i) => (
                        <span key={i} className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/50">
                          {item} <span className="text-[#FF3366]/60 ml-1">pronto</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Mandatory Password Change Dialog */}
      <Dialog open={showChangePasswordDialog} onOpenChange={() => {}}>
        <DialogContent 
          className="bg-[#1a1a2e] border-white/10 text-white sm:max-w-md"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <div className="flex justify-center mb-4">
              <div className="h-16 w-16 rounded-full bg-gradient-to-r from-[#00D4FF]/20 to-[#FF3366]/20 flex items-center justify-center">
                <ShieldCheck className="h-8 w-8 text-[#00D4FF]" />
              </div>
            </div>
            <DialogTitle className="text-center text-xl">Cambia tu contraseña</DialogTitle>
            <DialogDescription className="text-center text-white/60">
              Por seguridad, debes cambiar tu contraseña antes de continuar.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={changePasswordForm.handleSubmit(onChangePassword)} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="new-password" className={labelClasses}>Nueva contraseña</Label>
              <div className="relative">
                <Input 
                  id="new-password" 
                  type={showNewPassword ? "text" : "password"} 
                  placeholder="••••••••" 
                  {...changePasswordForm.register('newPassword')}
                  className={`pr-10 ${inputClasses} ${changePasswordForm.formState.errors.newPassword ? "border-red-500" : ""}`}
                  data-testid="input-change-new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                  data-testid="toggle-change-new-password"
                >
                  {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {changePasswordForm.formState.errors.newPassword && (
                <p className="text-xs text-red-400">{changePasswordForm.formState.errors.newPassword.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password" className={labelClasses}>Confirmar contraseña</Label>
              <div className="relative">
                <Input 
                  id="confirm-new-password" 
                  type={showNewConfirmPassword ? "text" : "password"} 
                  placeholder="••••••••" 
                  {...changePasswordForm.register('confirmPassword')}
                  className={`pr-10 ${inputClasses} ${changePasswordForm.formState.errors.confirmPassword ? "border-red-500" : ""}`}
                  data-testid="input-change-confirm-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNewConfirmPassword(!showNewConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 transition-colors"
                  data-testid="toggle-change-confirm-password"
                >
                  {showNewConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {changePasswordForm.formState.errors.confirmPassword && (
                <p className="text-xs text-red-400">{changePasswordForm.formState.errors.confirmPassword.message}</p>
              )}
            </div>
            <Button 
              type="submit" 
              className="w-full h-12 bg-gradient-to-r from-[#00D4FF] to-[#FF3366] hover:from-[#00D4FF]/90 hover:to-[#FF3366]/90 text-white border-0"
              disabled={isChangingPassword}
              data-testid="button-change-password"
            >
              {isChangingPassword ? <FuturisticLoader /> : 'Cambiar contraseña'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
