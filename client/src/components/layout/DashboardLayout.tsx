import React, { useState, useRef, useCallback, useEffect, createContext, useContext, useMemo } from 'react';
import { Link, useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { useUser, useOrganization, useOrganizations, useSwitchOrganization, useCreateOrganization, useMembership, useLogout } from '@/lib/hooks';
import { 
  LayoutDashboard, 
  Wallet, 
  ArrowRightLeft, 
  Sparkles, 
  Menu,
  LogOut,
  X,
  PieChart,
  Settings,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Check,
  Users,
  Crown,
  TrendingUp,
  FileText,
  ClipboardList,
  Users2,
  Briefcase,
  User,
  Upload,
  Loader2,
  Image as ImageIcon,
  PanelLeftClose,
  PanelLeft,
  Package,
  CalendarDays,
  Lock,
  Shield,
  BarChart3,
  ChevronUp,
  AlertTriangle,
  CreditCard,
  RefreshCw,
  Landmark,
  Store,
  KanbanSquare
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import AikestarLogo from '@/components/AikestarLogo';
import { FEATURE_FLAGS } from '@/lib/constants';
import aikestarIsotipo from '@/assets/aikestar-isotipo.jpg';
import FloatingAIChat from '@/components/FloatingAIChat';
import NotificationBell from '@/components/NotificationBell';
import { UndoButton } from '@/components/UndoButton';
import { RefreshDataButton } from '@/components/RefreshDataButton';
import { ICON_OPTIONS, getIconByKey } from '@/components/OrganizationBrandPicker';
import { getProfileIconByKey } from '@/components/UserProfilePicker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ROLE_LABELS, ROLE_PERMISSIONS } from '@shared/schema';
import type { Role } from '@shared/schema';
import { TransactionWizard } from '@/components/transaction-wizard';
import { fetchWithAuth } from '@/lib/api';
import TopMetricsBar from '@/components/TopMetricsBar';
import { ThemeToggleMenu } from '@/components/ThemeToggle';

// Context to share scroll state with child components
const ScrollContext = createContext<{ isScrolled: boolean }>({ isScrolled: false });
export const useScrollState = () => useContext(ScrollContext);

// Skeleton component for sidebar loading state
const SidebarSkeleton = React.memo(() => (
  <div className="flex flex-col h-full animate-pulse">
    <div className="p-5">
      <div className="flex items-center gap-3 mb-5">
        <div className="h-10 w-10 rounded-lg bg-sidebar-accent/60" />
        <div className="h-6 w-24 rounded bg-sidebar-accent/60" />
      </div>
      <div className="px-3 py-3 bg-sidebar-accent/40 rounded-xl">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-sidebar-accent/60" />
          <div className="space-y-2">
            <div className="h-3 w-20 rounded bg-sidebar-accent/60" />
            <div className="h-4 w-28 rounded bg-sidebar-accent/60" />
          </div>
        </div>
      </div>
    </div>
    <div className="flex-1 py-3 px-3 space-y-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <div className="h-8 w-8 rounded-lg bg-sidebar-accent/60" />
          <div className="h-4 w-24 rounded bg-sidebar-accent/60" />
        </div>
      ))}
    </div>
    <div className="p-4 border-t border-sidebar-border bg-sidebar-accent/30">
      <div className="flex items-center gap-3 mb-4 p-2">
        <div className="h-9 w-9 rounded-full bg-sidebar-accent/60" />
        <div className="space-y-2">
          <div className="h-4 w-20 rounded bg-sidebar-accent/60" />
          <div className="h-3 w-32 rounded bg-sidebar-accent/60" />
        </div>
      </div>
      <div className="h-10 w-full rounded-xl bg-sidebar-accent/40" />
    </div>
  </div>
));
SidebarSkeleton.displayName = 'SidebarSkeleton';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: user, isLoading: isUserLoading } = useUser();
  const { data: organization, isLoading: isOrgLoading } = useOrganization();
  const { data: organizations = [], isLoading: isOrgsLoading } = useOrganizations();
  const { data: membership, isLoading: isMembershipLoading } = useMembership();
  
  // Determine if initial data is still loading
  const isInitialLoading = isUserLoading || isOrgLoading || isOrgsLoading || isMembershipLoading;
  const switchOrgMutation = useSwitchOrganization();
  const createOrgMutation = useCreateOrganization();
  const logoutMutation = useLogout();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isNewOrgDialogOpen, setIsNewOrgDialogOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgIconKey, setNewOrgIconKey] = useState<string>('building');
  const [newOrgLogoUrl, setNewOrgLogoUrl] = useState<string | null>(null);
  const [isUploadingNewOrgLogo, setIsUploadingNewOrgLogo] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [isMobileMetricsVisible, setIsMobileMetricsVisible] = useState(false);
  const officeSubPaths = ['/clients', '/suppliers', '/products', '/hr', '/impuestos'];
  const officeAllPaths = ['/office', '/clients', '/suppliers', '/products', '/hr', '/impuestos'];
  const [isOfficeExpanded, setIsOfficeExpanded] = useState(() => {
    const stored = sessionStorage.getItem('officeExpanded');
    if (stored !== null) return stored === 'true';
    return officeAllPaths.includes(location);
  });
  
  const toggleOfficeExpanded = useCallback((val: boolean) => {
    setIsOfficeExpanded(val);
    sessionStorage.setItem('officeExpanded', String(val));
  }, []);
  

  useEffect(() => {
    if (officeAllPaths.includes(location)) {
      setIsOfficeExpanded(true);
      sessionStorage.setItem('officeExpanded', 'true');
    }
  }, [location]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  
  // Query subscription status for cancellation banner
  const { data: subscriptionStatus } = useQuery<{
    hasSubscription: boolean;
    cancellationStatus: string | null;
    cancelAtPeriodEnd: boolean;
    accessEndsAt: string | null;
    status: string | null;
    stripeStatus: { status?: string | null; id?: string; livemode?: boolean; currentPeriodEnd?: string | null } | null;
  }>({
    queryKey: ['/subscription/status'],
    queryFn: () => fetchWithAuth('/subscription/status'),
    enabled: !!user,
    staleTime: 60000, // Cache for 1 minute
  });
  
  // Check if user is platform admin
  const { data: adminCheck } = useQuery<{ isAdmin: boolean }>({
    queryKey: ['/api/admin/check'],
    queryFn: () => fetchWithAuth('/admin/check'),
    enabled: !!user,
    retry: false,
    staleTime: 300000, // Cache for 5 minutes
  });
  const isPlatformAdmin = adminCheck?.isAdmin || false;
  
  // Query plan limits to check maxOrgs
  const { data: planLimits } = useQuery<{
    limits: { maxOrgs: number; maxMembersPerOrg: number };
    usage: { organizations: number; membersInCurrentOrg: number };
    accountType: string;
    planType: string | null;
    orgPlanType?: string | null;
  }>({
    queryKey: ['/subscription/limits'],
    queryFn: () => fetchWithAuth('/subscription/limits'),
    enabled: !!user,
    staleTime: 60000,
  });
  
  // Calculate if we should show the cancellation warning (15 days before access ends)
  const showCancellationBanner = useMemo(() => {
    if (!subscriptionStatus?.cancellationStatus || subscriptionStatus.cancellationStatus !== 'pending_cancellation') {
      return false;
    }
    if (!subscriptionStatus.accessEndsAt) return false;
    
    const accessEnds = new Date(subscriptionStatus.accessEndsAt);
    const now = new Date();
    const daysUntilEnd = Math.ceil((accessEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    return daysUntilEnd <= 15 && daysUntilEnd > 0;
  }, [subscriptionStatus]);

  const daysUntilAccessEnds = useMemo(() => {
    if (!subscriptionStatus?.accessEndsAt) return 0;
    const accessEnds = new Date(subscriptionStatus.accessEndsAt);
    const now = new Date();
    return Math.ceil((accessEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  }, [subscriptionStatus?.accessEndsAt]);

  const formattedAccessEndDate = useMemo(() => {
    if (!subscriptionStatus?.accessEndsAt) return '';
    return new Date(subscriptionStatus.accessEndsAt).toLocaleDateString('es-AR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }, [subscriptionStatus?.accessEndsAt]);

  const subscriptionAlert = useMemo(() => {
    if (!subscriptionStatus) return null;

    const stripeStatus = subscriptionStatus.stripeStatus?.status;

    if (stripeStatus === 'past_due') {
      if (subscriptionStatus.accessEndsAt && daysUntilAccessEnds <= 0) {
        return {
          type: 'blocked' as const,
          message: 'Tu cuenta está suspendida por falta de pago. Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.',
          cta: 'Pagar ahora',
          action: 'portal' as const,
        };
      }
      return {
        type: 'payment_failed' as const,
        message: subscriptionStatus.accessEndsAt && daysUntilAccessEnds > 0
          ? `Tu pago falló. Tenés ${daysUntilAccessEnds} ${daysUntilAccessEnds === 1 ? 'día' : 'días'} para resolverlo. Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.`
          : 'Tu pago falló. Actualizá tu método de pago para no perder el acceso. Si pagaste con American Express, te recomendamos cambiar el método de pago a Visa o Mastercard.',
        cta: 'Actualizar pago',
        action: 'portal' as const,
      };
    }

    if (subscriptionStatus.cancellationStatus === 'pending_cancellation' || subscriptionStatus.cancelAtPeriodEnd) {
      return {
        type: 'pending_cancellation' as const,
        message: formattedAccessEndDate
          ? `Tu suscripción se cancela el ${formattedAccessEndDate}.`
          : 'Tu suscripción está programada para cancelarse.',
        cta: 'Reactivar',
        action: 'settings' as const,
      };
    }

    if (subscriptionStatus.status === 'cancelled' || stripeStatus === 'canceled') {
      return {
        type: 'cancelled' as const,
        message: 'Tu suscripción está cancelada. Renovála para mantener tu cuenta.',
        cta: 'Renovar',
        action: 'settings' as const,
      };
    }

    return null;
  }, [subscriptionStatus, formattedAccessEndDate, daysUntilAccessEnds]);

  const handleSubscriptionAlertAction = useCallback(async () => {
    if (!subscriptionAlert) return;
    if (subscriptionAlert.action === 'portal') {
      try {
        const result = await fetchWithAuth('/stripe/create-portal-session', { method: 'POST' });
        if (result.url) {
          window.location.href = result.url;
        }
      } catch {
        setLocation('/settings?tab=plan');
      }
    } else {
      setLocation('/settings?tab=plan');
    }
  }, [subscriptionAlert, setLocation]);

  // Scroll handler for detecting when user scrolls past threshold
  const handleContentScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const scrollTop = e.currentTarget.scrollTop;
    setIsScrolled(scrollTop > 100);
  }, []);
  
  // Auto-scroll sidebar to active nav item when route changes
  useEffect(() => {
    const scrollToActiveItem = () => {
      const navContainer = document.getElementById('sidebar-nav-container');
      const activeItem = navContainer?.querySelector('[data-nav-active="true"]');
      if (activeItem && navContainer) {
        activeItem.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      }
    };
    // Small delay to ensure DOM is updated
    const timeoutId = setTimeout(scrollToActiveItem, 50);
    return () => clearTimeout(timeoutId);
  }, [location]);
  
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);
  
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchEndX.current = null;
  }, []);
  
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    touchEndX.current = e.touches[0].clientX;
  }, []);
  
  const handleTouchEnd = useCallback(() => {
    if (touchStartX.current !== null && touchEndX.current !== null) {
      const swipeDistance = touchStartX.current - touchEndX.current;
      if (swipeDistance > 50) {
        setIsMobileMenuOpen(false);
      }
    }
    touchStartX.current = null;
    touchEndX.current = null;
  }, []);
  
  const handleLogout = async () => {
    await logoutMutation.mutateAsync();
    toast({ title: "Sesión cerrada", description: "Hasta pronto" });
    setTimeout(() => {
      window.location.href = '/login';
    }, 800);
  };

  const handleSwitchOrg = async (orgId: string) => {
    if (orgId === organization?.id) return;
    try {
      await switchOrgMutation.mutateAsync(orgId);
      toast({ title: "Organización cambiada" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleCreateOrg = async () => {
    if (!newOrgName.trim()) return;
    try {
      const newOrg = await createOrgMutation.mutateAsync({ 
        name: newOrgName, 
        iconKey: newOrgLogoUrl ? null : newOrgIconKey,
        logoUrl: newOrgLogoUrl 
      });
      await switchOrgMutation.mutateAsync(newOrg.id);
      toast({ title: "Organización creada", description: `${newOrgName} creada exitosamente` });
      setNewOrgName('');
      setNewOrgIconKey('building');
      setNewOrgLogoUrl(null);
      setIsNewOrgDialogOpen(false);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleNewOrgLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      toast({ title: "Error", description: "Solo se permiten archivos de imagen", variant: "destructive" });
      return;
    }
    
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Error", description: "El archivo no puede superar 2MB", variant: "destructive" });
      return;
    }

    setIsUploadingNewOrgLogo(true);
    
    try {
      const { uploadURL, objectPath } = await fetchWithAuth('/uploads/request-url', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });
      
      await fetch(uploadURL, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      
      setNewOrgLogoUrl(objectPath);
      setNewOrgIconKey('');
      
      toast({ title: "Imagen subida", description: "La imagen se subió correctamente." });
    } catch (error: any) {
      console.error('Upload error:', error);
      toast({ title: "Error", description: error.message || "No se pudo subir la imagen", variant: "destructive" });
    } finally {
      setIsUploadingNewOrgLogo(false);
      e.target.value = '';
    }
  };

  const isPersonalAccount = user?.accountType === 'personal';
  const isPersonalContext = organization?.type === 'personal';
  const isAdminOrOwner = membership?.role === 'admin' || membership?.role === 'owner';
  
  // Feature gating uses the ORG OWNER's plan, not the logged-in user's plan.
  // This way, if you're invited to a basic personal org, you see that org's restrictions.
  const orgPlanType = planLimits?.orgPlanType || planLimits?.planType;
  const isOrgBasicPersonal = orgPlanType === 'personal' || (!orgPlanType && isPersonalAccount);
  
  // Block business features when in a personal org whose owner has basic personal plan
  const shouldBlockBusinessFeatures = isPersonalContext && isOrgBasicPersonal;
  
  // Using useMemo to prevent unnecessary re-renders during navigation
  const navigation = useMemo(() => [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Cuentas', href: '/accounts', icon: Wallet },
    { name: 'Movimientos', href: '/transactions', icon: ArrowRightLeft },
    { name: 'Calendario', href: '/calendar', icon: CalendarDays },
    ...(shouldBlockBusinessFeatures ? [
          { name: 'Oficina', href: '/office', icon: Building2, disabled: true, expandable: true },
        ] : [
          { name: 'Oficina', href: '/office', icon: Building2, expandable: true },
        ]),
    ...(isPlatformAdmin ? [{ name: 'Admin', href: '/admin', icon: Shield, highlight: true }] : []),
    ...(shouldBlockBusinessFeatures ? [
          { name: 'Reportes', href: '/reports', icon: PieChart, disabled: true },
        ] : [
          { name: 'Reportes', href: '/reports', icon: PieChart },
        ]),
    { name: 'Asistente IA', href: '/ai-assistant', icon: Sparkles, highlight: true },
  ], [isPersonalContext, isAdminOrOwner, shouldBlockBusinessFeatures, isPlatformAdmin]);
  
  const officeSubItems = useMemo(() => {
    if (shouldBlockBusinessFeatures) {
      return [
        { name: 'CRM', href: '/crm', icon: KanbanSquare, disabled: true },
        { name: 'Clientes', href: '/clients', icon: Users2, disabled: true },
        { name: 'Proveedores', href: '/suppliers', icon: Briefcase, disabled: true },
        { name: 'Productos/Activos', href: '/products', icon: Package, disabled: true },
        { name: 'Tiendanube', href: '/tiendanube-catalogo', icon: Store, disabled: true },
        { name: 'Presupuestos', href: '/office?tab=quotes', icon: ClipboardList, disabled: true },
        { name: 'RR.HH', href: '/hr', icon: User, disabled: true },
        { name: 'Impuestos', href: '/impuestos', icon: Landmark, disabled: true },
      ];
    }
    return [
      { name: 'CRM', href: '/crm', icon: KanbanSquare },
      { name: 'Clientes', href: '/clients', icon: Users2 },
      { name: 'Proveedores', href: '/suppliers', icon: Briefcase },
      { name: 'Productos/Activos', href: '/products', icon: Package },
      { name: 'Tiendanube', href: '/tiendanube-catalogo', icon: Store },
      { name: 'Presupuestos', href: '/office?tab=quotes', icon: ClipboardList },
      { name: 'RR.HH', href: '/hr', icon: User },
      // Facturas e Impuestos: ocultos sólo cuando la org es Personal Y el plan
      // es el básico 'personal'. Personal Pro y superiores ven todo.
      ...(FEATURE_FLAGS.INVOICING_ENABLED && !shouldBlockBusinessFeatures
        ? [{ name: 'Facturas', href: '/invoices', icon: FileText }]
        : []),
      ...(shouldBlockBusinessFeatures
        ? []
        : [{ name: 'Impuestos', href: '/impuestos', icon: Landmark }]),
    ];
  }, [shouldBlockBusinessFeatures]);


  const NavContent = ({ onNavigate }: { onNavigate?: () => void }) => (
    <div className="flex flex-col h-full">
      <div className="p-5">
        <div className="flex items-center gap-3 mb-5">
          <img src={aikestarIsotipo} alt="Aikestar" className="h-10 w-10 rounded-lg drop-shadow-[0_0_8px_rgba(45,179,179,0.4)]" />
          <div className="flex flex-col">
            <span className="text-xl font-bold text-white tracking-tight">
              Aike<span className="text-[#ED1E3A]">star</span>
            </span>
            {planLimits?.planType && (
              <span className="text-[10px] text-sidebar-foreground/50 font-medium">
                {planLimits.planType === 'personal' ? 'Personal' : 
                 planLimits.planType === 'personal_pro' ? 'Personal Pro' :
                 planLimits.planType === 'solo' ? 'Solo' :
                 planLimits.planType === 'team' ? 'Team' :
                 planLimits.planType === 'business' ? 'Business' :
                 planLimits.planType === 'enterprise' ? 'Enterprise' : planLimits.planType}
              </span>
            )}
          </div>
        </div>
        {/* Unified Organization Selector */}
        {organization && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <div className="px-3 py-3 bg-gradient-to-r from-sidebar-accent/80 to-sidebar-accent/40 rounded-xl group cursor-pointer hover:from-sidebar-accent hover:to-sidebar-accent/60 border border-sidebar-border/30 transition-all shadow-lg shadow-black/20" data-testid="org-switcher">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {organization.type === 'personal' ? (
                      <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-md">
                        <User className="h-4 w-4 text-white" />
                      </div>
                    ) : organization.logoUrl ? (
                      <img src={organization.logoUrl} alt={organization.name} className="h-9 w-9 rounded-lg object-cover shadow-md" />
                    ) : (
                      <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-md">
                        {(() => {
                          const OrgIcon = getIconByKey(organization.iconKey);
                          return <OrgIcon className="h-4 w-4 text-white" />;
                        })()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-[10px] text-sidebar-foreground/40 uppercase font-bold tracking-wider">Organización</p>
                      <p className="text-sm font-semibold text-sidebar-foreground truncate">
                        {organization.type === 'personal' ? (organization.ownerFirstName ? `Personal de ${organization.ownerFirstName}` : 'Personal') : organization.name}
                      </p>
                      {membership?.role && (
                        <p className="text-[10px] text-sidebar-foreground/50 truncate">{ROLE_LABELS[membership.role as Role]}</p>
                      )}
                    </div>
                  </div>
                  <div className="p-1.5 rounded-lg bg-sidebar-border/30 group-hover:bg-primary/30 transition-colors">
                    <ChevronDown className="h-3.5 w-3.5 text-sidebar-foreground/50 group-hover:text-primary transition-colors" />
                  </div>
                </div>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {organizations.map((org: any) => (
                <DropdownMenuItem 
                  key={org.id} 
                  onClick={() => handleSwitchOrg(org.id)}
                  className="cursor-pointer"
                  data-testid={`org-option-${org.id}`}
                >
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      {org.type === 'personal' ? (
                        <div className="h-6 w-6 rounded bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                          <User className="h-3 w-3 text-white" />
                        </div>
                      ) : org.logoUrl ? (
                        <img src={org.logoUrl} alt={org.name} className="h-6 w-6 rounded object-cover" />
                      ) : (
                        <div className="h-6 w-6 rounded bg-gradient-to-br from-primary to-accent flex items-center justify-center">
                          {(() => {
                            const OrgIcon = getIconByKey(org.iconKey);
                            return <OrgIcon className="h-3 w-3 text-white" />;
                          })()}
                        </div>
                      )}
                      <span>{org.type === 'personal' ? (org.ownerFirstName ? `Personal de ${org.ownerFirstName}` : 'Personal') : org.name}</span>
                    </div>
                    {org.id === organization.id && <Check className="h-4 w-4 text-primary" />}
                  </div>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {/* Show new org button if plan allows more organizations */}
              {planLimits && organizations.length < planLimits.limits.maxOrgs && (
                <DropdownMenuItem onClick={() => setIsNewOrgDialogOpen(true)} className="cursor-pointer" data-testid="button-new-org">
                  <Plus className="h-4 w-4 mr-2" /> Nueva Organización ({organizations.length}/{planLimits.limits.maxOrgs})
                </DropdownMenuItem>
              )}
              {/* Only show edit orgs when user has more than 1 organization allowed */}
              {(planLimits?.limits.maxOrgs ?? 1) > 1 && (
                <Link href="/settings?tab=organizations">
                  <DropdownMenuItem className="cursor-pointer" data-testid="button-edit-orgs">
                    <Settings className="h-4 w-4 mr-2" /> Editar organizaciones
                  </DropdownMenuItem>
                </Link>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Upgrade CTA - only show when in personal context with basic plan (maxOrgs = 1) */}
        {isPersonalAccount && organization?.type === 'personal' && planLimits?.limits.maxOrgs === 1 && (
          <button
            onClick={() => setLocation('/settings?tab=plan')}
            className="w-full mt-2 px-3 py-2 text-xs text-left rounded-lg bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/30 hover:border-amber-500/50 transition-all group"
            data-testid="button-upgrade-account"
          >
            <div className="flex items-center gap-2">
              <Crown className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-amber-300 font-medium group-hover:text-amber-200">Actualizar a Empresarial</span>
            </div>
          </button>
        )}

      </div>

      <div className="flex-1 py-3 px-3 space-y-1.5 overflow-y-auto" id="sidebar-nav-container">
        {navigation.map((item: any) => {
          const isActive = location === item.href;
          const isDisabled = item.disabled === true;
          const isExpandable = item.expandable === true;
          const isOfficeActive = isActive || officeSubPaths.includes(location);
          
          if (isDisabled && !isExpandable) {
            return (
              <div key={item.name}>
                <div
                  onClick={() => setShowUpgradeModal(true)}
                  className="group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer text-sidebar-foreground/40 hover:bg-sidebar-accent/50"
                >
                  <div className="p-1.5 rounded-lg bg-sidebar-accent/50">
                    <item.icon className="h-4 w-4 text-sidebar-foreground/40" />
                  </div>
                  {item.name}
                  <Lock className="ml-auto h-3 w-3 text-sidebar-foreground/30" />
                </div>
              </div>
            );
          }

          if (isDisabled && isExpandable) {
            return (
              <div key={item.name}>
                <div className="flex items-center gap-0">
                  <div
                    onClick={() => setShowUpgradeModal(true)}
                    className="flex-1 group flex items-center gap-3 px-3 py-2.5 rounded-l-xl text-sm font-medium transition-all duration-200 cursor-pointer text-sidebar-foreground/40 hover:bg-sidebar-accent/50"
                  >
                    <div className="p-1.5 rounded-lg bg-sidebar-accent/50">
                      <item.icon className="h-4 w-4 text-sidebar-foreground/40" />
                    </div>
                    {item.name}
                    <Lock className="ml-auto h-3 w-3 text-sidebar-foreground/30" />
                  </div>
                  <button
                    onClick={() => toggleOfficeExpanded(!isOfficeExpanded)}
                    className="px-2 py-2.5 rounded-r-xl text-sidebar-foreground/40 hover:bg-sidebar-accent/50 cursor-pointer"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${isOfficeExpanded ? '' : '-rotate-90'}`} />
                  </button>
                </div>
                {isOfficeExpanded && (
                  <div className="ml-4 mt-1 space-y-0.5 border-l border-sidebar-border/40 pl-2">
                    {officeSubItems.map((sub: any) => (
                      <div
                        key={sub.name}
                        onClick={() => setShowUpgradeModal(true)}
                        className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium cursor-pointer text-sidebar-foreground/40 hover:bg-sidebar-accent/50"
                      >
                        <sub.icon className="h-3.5 w-3.5 text-sidebar-foreground/40" />
                        {sub.name}
                        <Lock className="ml-auto h-2.5 w-2.5 text-sidebar-foreground/30" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          if (isExpandable) {
            return (
              <div key={item.name}>
                <div className="flex items-center gap-0">
                  <Link href={item.href} className="flex-1">
                    <div
                      onClick={() => { toggleOfficeExpanded(true); onNavigate?.(); }}
                      data-nav-active={isActive ? 'true' : undefined}
                      className={`group flex items-center gap-3 px-3 py-2.5 rounded-l-xl text-sm font-medium transition-all duration-200 cursor-pointer
                        ${isActive
                          ? 'bg-gradient-to-r from-primary to-primary/80 text-white shadow-lg shadow-primary/25'
                          : isOfficeActive
                            ? 'bg-sidebar-accent text-sidebar-foreground'
                            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:translate-x-1'
                        }
                      `}
                    >
                      <div className={`p-1.5 rounded-lg transition-colors ${isActive ? 'bg-black/20' : 'bg-sidebar-accent group-hover:bg-sidebar-border'}`}>
                        <item.icon className={`h-4 w-4 ${isActive ? 'text-white' : ''}`} />
                      </div>
                      {item.name}
                    </div>
                  </Link>
                  <button
                    onClick={() => toggleOfficeExpanded(!isOfficeExpanded)}
                    className={`px-2 py-2.5 rounded-r-xl transition-all duration-200 cursor-pointer
                      ${isActive
                        ? 'bg-primary/80 text-white'
                        : isOfficeActive
                          ? 'bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-border'
                          : 'text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-foreground'
                      }
                    `}
                    data-testid="button-toggle-office"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${isOfficeExpanded ? '' : '-rotate-90'}`} />
                  </button>
                </div>
                {isOfficeExpanded && (
                  <div className="ml-4 mt-1 space-y-0.5 border-l border-sidebar-border/40 pl-2">
                    {officeSubItems.map((sub: any) => {
                      const subActive = location === sub.href;
                      const subDisabled = sub.disabled === true;
                      if (subDisabled) {
                        return (
                          <div
                            key={sub.name}
                            onClick={() => setShowUpgradeModal(true)}
                            className="group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium cursor-pointer text-sidebar-foreground/40 hover:bg-sidebar-accent/50"
                          >
                            <sub.icon className="h-3.5 w-3.5 text-sidebar-foreground/40" />
                            {sub.name}
                            <Lock className="ml-auto h-2.5 w-2.5 text-sidebar-foreground/30" />
                          </div>
                        );
                      }
                      return (
                        <Link key={sub.name} href={sub.href}>
                          <div
                            onClick={() => onNavigate?.()}
                            data-nav-active={subActive ? 'true' : undefined}
                            className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-all duration-200 cursor-pointer
                              ${subActive
                                ? 'bg-primary/20 text-primary-foreground text-white'
                                : 'text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground'
                              }
                            `}
                          >
                            <sub.icon className={`h-3.5 w-3.5 ${subActive ? 'text-white' : ''}`} />
                            {sub.name}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          
          return (
            <Link key={item.name} href={item.href}>
              <div
                onClick={() => onNavigate?.()}
                data-nav-active={isActive ? 'true' : undefined}
                className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer
                  ${isActive 
                    ? 'bg-gradient-to-r from-primary to-primary/80 text-white shadow-lg shadow-primary/25' 
                    : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:translate-x-1'
                  }
                  ${item.highlight && !isActive ? 'text-purple-400 hover:text-purple-300' : ''}
                `}
              >
                <div className={`p-1.5 rounded-lg transition-colors ${isActive ? 'bg-black/20' : 'bg-sidebar-accent group-hover:bg-sidebar-border'}`}>
                  <item.icon className={`h-4 w-4 ${item.highlight && !isActive ? 'text-purple-400' : ''} ${isActive ? 'text-white' : ''}`} />
                </div>
                {item.name}
                {item.highlight && !isActive && (
                  <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 font-medium">IA</span>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      <div className="px-3 pb-3 border-t border-sidebar-border/30 pt-2 space-y-1">
        <Link href="/settings">
          <div
            onClick={() => onNavigate?.()}
            data-nav-active={location === '/settings' ? 'true' : undefined}
            className={`group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer
              ${location === '/settings'
                ? 'bg-sidebar-accent text-sidebar-foreground'
                : 'text-sidebar-foreground/50 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground/80'
              }
            `}
            data-testid="nav-settings"
          >
            <Settings className={`h-4 w-4 ${location === '/settings' ? 'text-sidebar-foreground/70' : 'text-sidebar-foreground/40'}`} />
            Configuración
          </div>
        </Link>
      </div>

    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      {/* Desktop Sidebar */}
      <div className={`hidden md:block sidebar-gradient border-r border-sidebar-border/50 fixed h-full z-40 transition-all duration-300 shadow-2xl shadow-black/20 ${isSidebarCollapsed ? 'w-0 overflow-hidden' : 'w-64'}`}>
        {isInitialLoading ? <SidebarSkeleton /> : <NavContent />}
      </div>
      
      {/* Desktop Sidebar Toggle Button */}
      <button
        onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        className={`hidden md:flex fixed z-50 items-center justify-center h-7 w-7 rounded-md border transition-all duration-300 ${
          isSidebarCollapsed 
            ? 'top-14 left-2 bg-white dark:bg-card border-gray-200 dark:border-slate-800 hover:bg-gray-100 dark:hover:bg-slate-800 shadow-sm' 
            : 'top-[72px] left-[232px] bg-sidebar border-sidebar-border hover:bg-sidebar-accent'
        }`}
        data-testid="sidebar-toggle"
      >
        {isSidebarCollapsed ? (
          <PanelLeft className="h-4 w-4 text-gray-600 dark:text-slate-300" />
        ) : (
          <PanelLeftClose className="h-4 w-4 text-sidebar-foreground" />
        )}
      </button>

      {/* Mobile Header - Logo only, menu moved to bottom bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 sidebar-gradient border-b border-sidebar-border/50 z-20 px-3 py-2.5 flex items-center justify-center shadow-lg overflow-hidden">
        <div className="flex items-center gap-2 max-w-[80vw] w-full">
          <img src={aikestarIsotipo} alt="Aikestar" className="h-7 w-7 rounded-lg drop-shadow-[0_0_6px_rgba(45,179,179,0.4)] flex-shrink-0" />
          <div className="flex flex-col min-w-0 overflow-hidden">
            <span className="text-base font-bold text-white tracking-tight">
              Aike<span className="text-[#ED1E3A]">star</span>
            </span>
            {/* Show org name in mobile header instead of plan type */}
            {organization ? (
              <span className="text-[10px] text-sidebar-foreground/70 font-medium -mt-0.5 truncate max-w-full">
                {organization.type === 'personal' ? (organization.ownerFirstName ? `Personal de ${organization.ownerFirstName}` : 'Personal') : organization.name}
              </span>
            ) : planLimits?.planType && (
              <span className="text-[9px] text-sidebar-foreground/50 font-medium -mt-0.5">
                {planLimits.planType === 'personal' ? 'Personal' : 
                 planLimits.planType === 'personal_pro' ? 'Personal Pro' :
                 planLimits.planType === 'solo' ? 'Solo' :
                 planLimits.planType === 'team' ? 'Team' :
                 planLimits.planType === 'business' ? 'Business' :
                 planLimits.planType === 'enterprise' ? 'Enterprise' : planLimits.planType}
              </span>
            )}
          </div>
        </div>
      </div>
      
      {/* Mobile Menu Sheet - rendered here but triggered from bottom bar */}
      <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
        <SheetContent 
          side="left" 
          className="p-0 sidebar-gradient border-r border-sidebar-border/50 w-64"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {isInitialLoading ? <SidebarSkeleton /> : <NavContent onNavigate={() => setIsMobileMenuOpen(false)} />}
        </SheetContent>
      </Sheet>

      {/* Main Content */}
      <div className={`flex flex-col h-screen pt-14 md:pt-0 transition-all duration-300 ${isSidebarCollapsed ? 'md:ml-0 w-full' : 'md:ml-64 md:w-[calc(100%-16rem)]'} w-full min-w-0`}>
        {/* Fixed Header Bars - Organization Indicator and Metrics */}
        <div className="flex-shrink-0">
          {/* Organization Indicator Bar - shown for all users on desktop */}
          {organization && (
            <div className="hidden md:block bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-100 px-4 md:px-8 py-2 overflow-hidden">
              <div className="w-full flex items-center justify-between gap-3 min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  {organization.logoUrl ? (
                    <img 
                      src={organization.logoUrl.startsWith('/objects') ? organization.logoUrl : `/objects${organization.logoUrl}`} 
                      alt={organization.name}
                      className="h-7 w-7 rounded-lg object-cover ring-2 ring-blue-200"
                    />
                  ) : organization.iconKey ? (
                    <div className="h-7 w-7 rounded-lg bg-blue-100 flex items-center justify-center ring-2 ring-blue-200">
                      {React.createElement(getIconByKey(organization.iconKey), { className: "h-4 w-4 text-blue-600" })}
                    </div>
                  ) : (
                    <div className="h-7 w-7 rounded-lg bg-blue-100 flex items-center justify-center ring-2 ring-blue-200">
                      <Building2 className="h-4 w-4 text-blue-600" />
                    </div>
                  )}
                  <span className="text-sm font-medium text-blue-800 truncate">
                    Trabajando en: <span className="font-semibold">{organization.name}</span>
                  </span>
                </div>
                
                {/* User info and settings */}
                {user && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Undo Button */}
                    <UndoButton />
                    {/* Refresh Data Button */}
                    <RefreshDataButton />
                    {/* Notification Bell */}
                    <NotificationBell />
                    
                    {user.profileImageUrl ? (
                      <img 
                        src={user.profileImageUrl} 
                        alt={user.name}
                        className="h-7 w-7 rounded-full object-cover ring-2 ring-blue-200"
                      />
                    ) : (
                      <div className="h-7 w-7 rounded-full bg-blue-100 flex items-center justify-center ring-2 ring-blue-200">
                        <span className="text-xs font-semibold text-blue-600">
                          {user.name?.charAt(0)?.toUpperCase() || 'U'}
                        </span>
                      </div>
                    )}
                    <span className="text-sm font-medium text-blue-800 hidden sm:block">{user.name}</span>
                    
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded-lg"
                          data-testid="button-user-settings"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <Link href="/settings">
                          <DropdownMenuItem className="cursor-pointer" data-testid="menu-settings">
                            <Settings className="h-4 w-4 mr-2" />
                            Configuración
                          </DropdownMenuItem>
                        </Link>
                        <ThemeToggleMenu />
                        <DropdownMenuSeparator />
                        <DropdownMenuItem 
                          onClick={handleLogout}
                          className="cursor-pointer text-red-500 focus:text-red-500 focus:bg-red-500/10"
                          disabled={logoutMutation.isPending}
                          data-testid="button-logout"
                        >
                          <LogOut className="h-4 w-4 mr-2" />
                          {logoutMutation.isPending ? 'Cerrando...' : 'Cerrar Sesión'}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Subscription Alert Bar */}
          {subscriptionAlert && (
            <div
              className={`px-3 py-2 border-b text-sm ${
                subscriptionAlert.type === 'payment_failed' || subscriptionAlert.type === 'blocked' || subscriptionAlert.type === 'cancelled'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
              data-testid="subscription-alert-bar"
            >
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {subscriptionAlert.type === 'payment_failed' || subscriptionAlert.type === 'blocked' ? (
                    <CreditCard className="h-4 w-4 flex-shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  )}
                  <span className="text-sm leading-snug">{subscriptionAlert.message}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 px-3 text-xs font-semibold flex-shrink-0 self-start sm:self-auto ${
                    subscriptionAlert.type === 'payment_failed' || subscriptionAlert.type === 'blocked' || subscriptionAlert.type === 'cancelled'
                      ? 'text-red-700 hover:bg-red-100 hover:text-red-900'
                      : 'text-amber-700 hover:bg-amber-100 hover:text-amber-900'
                  }`}
                  onClick={handleSubscriptionAlertAction}
                  data-testid="button-subscription-alert-action"
                >
                  {subscriptionAlert.type === 'payment_failed' || subscriptionAlert.type === 'blocked' ? (
                    <CreditCard className="h-3 w-3 mr-1" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  {subscriptionAlert.cta}
                </Button>
              </div>
            </div>
          )}

          {/* Top Metrics Bar - shows key financial metrics at a glance */}
          {/* Desktop: always visible */}
          <div className="hidden md:block">
            <TopMetricsBar />
          </div>
          {/* Mobile: collapsible metrics + user controls bar */}
          <div className="md:hidden">
            {isMobileMetricsVisible && <TopMetricsBar />}
            <div className="flex items-center justify-between px-3 py-1.5 border-t border-border/50 bg-background/80">
              {/* Left side: Menu button */}
              <button
                onClick={() => setIsMobileMenuOpen(true)}
                className="flex items-center justify-center h-7 w-7 text-foreground hover:text-foreground/80 transition-colors"
                data-testid="button-mobile-menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              
              {/* Center: Toggle saldos button */}
              <button
                onClick={() => setIsMobileMetricsVisible(!isMobileMetricsVisible)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                data-testid="toggle-mobile-metrics"
              >
                {isMobileMetricsVisible ? (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    <span>Ocultar saldos</span>
                  </>
                ) : (
                  <>
                    <BarChart3 className="h-3 w-3" />
                    <span>Ver saldos</span>
                  </>
                )}
              </button>
              
              {/* User controls - right side */}
              {user && (
                <div className="flex items-center gap-1.5">
                  <UndoButton />
                  <RefreshDataButton />
                  <NotificationBell />
                  {user.profileImageUrl ? (
                    <img 
                      src={user.profileImageUrl} 
                      alt={user.name}
                      className="h-6 w-6 rounded-full object-cover ring-1 ring-border"
                    />
                  ) : (
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center ring-1 ring-border">
                      <span className="text-[10px] font-semibold text-primary">
                        {user.name?.charAt(0)?.toUpperCase() || 'U'}
                      </span>
                    </div>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        data-testid="button-mobile-settings"
                      >
                        <Settings className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <Link href="/settings">
                        <DropdownMenuItem className="cursor-pointer" data-testid="menu-mobile-settings">
                          <Settings className="h-4 w-4 mr-2" />
                          Configuración
                        </DropdownMenuItem>
                      </Link>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={handleLogout}
                        className="cursor-pointer text-red-500 focus:text-red-500 focus:bg-red-500/10"
                        disabled={logoutMutation.isPending}
                        data-testid="button-mobile-logout"
                      >
                        <LogOut className="h-4 w-4 mr-2" />
                        {logoutMutation.isPending ? 'Cerrando...' : 'Cerrar Sesión'}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>
        </div>
        
        {/* Scrollable Content Area */}
        <div ref={scrollContainerRef} onScroll={handleContentScroll} className="flex-1 overflow-y-auto">
          <main className="px-4 py-6 md:px-8 md:py-8 w-full overflow-x-hidden">
          {showCancellationBanner && (
            <div className="mb-6 p-4 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30" data-testid="cancellation-warning-banner">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <svg className="h-5 w-5 text-amber-600 dark:text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                    Tu suscripción está cancelada
                  </h4>
                  <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                    Tu suscripción se cancela el <strong>{formattedAccessEndDate}</strong> ({daysUntilAccessEnds} {daysUntilAccessEnds === 1 ? 'día' : 'días'} restantes). Después, tus datos se conservarán por 60 días.
                    <Link href="/settings?tab=plan" className="ml-1 underline font-medium hover:text-amber-900 dark:hover:text-amber-100">
                      Reactivá tu suscripción
                    </Link> para mantener tu cuenta.
                  </p>
                </div>
              </div>
            </div>
          )}
          <ScrollContext.Provider value={{ isScrolled }}>
            {switchOrgMutation.isPending ? (
              <div className="flex items-center justify-center h-[60vh]" data-testid="org-switch-loading">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                  <p className="text-sm text-muted-foreground">Cambiando de organización...</p>
                </div>
              </div>
            ) : children}
          </ScrollContext.Provider>
        </main>
        </div>
      </div>

      {/* Floating AI Chat */}
      {location !== '/ai-assistant' && <FloatingAIChat />}

      {/* New organization dialog - rendered outside NavContent to prevent re-mounting */}
      <Dialog open={isNewOrgDialogOpen} onOpenChange={setIsNewOrgDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva Organización</DialogTitle>
            <DialogDescription>
              Podés tener hasta {planLimits?.limits.maxOrgs || 1} organizaciones. Cada una tiene sus propias cuentas y movimientos.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Nombre de la organización</Label>
              <Input 
                placeholder="Mi Empresa"
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newOrgName.trim()) handleCreateOrg(); }}
                autoFocus
                data-testid="input-new-org-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Logo o Icono</Label>
              <Tabs defaultValue="icons" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="icons" onClick={() => setNewOrgLogoUrl(null)}>Icono</TabsTrigger>
                  <TabsTrigger value="upload" onClick={() => setNewOrgIconKey('')}>Subir Logo</TabsTrigger>
                </TabsList>
                <TabsContent value="icons" className="mt-3">
                  <ScrollArea className="h-32">
                    <div className="grid grid-cols-8 gap-1.5">
                      {ICON_OPTIONS.slice(0, 32).map(({ key, icon: Icon, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => { setNewOrgIconKey(key); setNewOrgLogoUrl(null); }}
                          className={`p-2 rounded-lg border transition-all hover:bg-primary/10 ${
                            newOrgIconKey === key && !newOrgLogoUrl
                              ? 'border-primary bg-primary/10' 
                              : 'border-transparent hover:border-primary/30'
                          }`}
                          title={label}
                          data-testid={`new-org-icon-${key}`}
                        >
                          <Icon className="h-4 w-4 mx-auto text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </TabsContent>
                <TabsContent value="upload" className="mt-3">
                  <div className="flex flex-col items-center gap-3">
                    {newOrgLogoUrl ? (
                      <div className="relative">
                        <img src={newOrgLogoUrl} alt="Logo preview" className="h-20 w-20 rounded-xl object-cover border-2 border-primary" />
                        <button
                          type="button"
                          onClick={() => setNewOrgLogoUrl(null)}
                          className="absolute -top-2 -right-2 p-1 bg-red-500 text-white rounded-full hover:bg-red-600"
                        >
                          <span className="text-xs font-bold">×</span>
                        </button>
                      </div>
                    ) : (
                      <label className="flex flex-col items-center gap-2 p-6 border-2 border-dashed border-gray-300 dark:border-slate-700 rounded-xl cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors w-full">
                        {isUploadingNewOrgLogo ? (
                          <Loader2 className="h-8 w-8 animate-spin text-primary" />
                        ) : (
                          <>
                            <Upload className="h-8 w-8 text-gray-400" />
                            <span className="text-sm text-gray-500 dark:text-slate-400">Clic para subir imagen</span>
                            <span className="text-xs text-gray-400">PNG, JPG hasta 2MB</span>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleNewOrgLogoUpload}
                          disabled={isUploadingNewOrgLogo}
                        />
                      </label>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewOrgDialogOpen(false)}>Cancelar</Button>
            <Button 
              onClick={handleCreateOrg} 
              disabled={!newOrgName.trim() || createOrgMutation.isPending || isUploadingNewOrgLogo}
              data-testid="button-create-org"
            >
              {createOrgMutation.isPending ? 'Creando...' : 'Crear'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upgrade Modal - shown when clicking disabled menu items */}
      <Dialog open={showUpgradeModal} onOpenChange={setShowUpgradeModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-amber-400" />
              Función Empresarial
            </DialogTitle>
            <DialogDescription>
              Esta función está disponible en los planes empresariales. Actualiza tu plan para acceder a:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <Building2 className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-sm">Oficina</p>
                <p className="text-xs text-muted-foreground">Activos, inversiones y bienes de tu empresa</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <PieChart className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-sm">Reportes</p>
                <p className="text-xs text-muted-foreground">Análisis financieros y exportación de datos</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-sm">Equipo</p>
                <p className="text-xs text-muted-foreground">Invita colaboradores con diferentes roles</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              <Users2 className="h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-sm">Clientes, Proveedores y Productos</p>
                <p className="text-xs text-muted-foreground">Base de datos operativa completa</p>
              </div>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setShowUpgradeModal(false)}>
              Ahora no
            </Button>
            <Button 
              onClick={() => {
                setShowUpgradeModal(false);
                setLocation('/settings?tab=plan');
              }}
              className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600"
            >
              <Crown className="h-4 w-4 mr-2" />
              Ver planes empresariales
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating Action Button for creating transactions */}
      {/* On dashboard: only shown when scrolled (header has its own button) */}
      {/* On other pages: always visible */}
      {(() => {
        const userRole = (membership?.role as Role) || 'viewer';
        const userPermissions = ROLE_PERMISSIONS[userRole] || [];
        const canCreateTransactions = userPermissions.includes('transactions:create');
        
        if (!canCreateTransactions) return null;
        
        // On dashboard, only show FAB when scrolled (header button visible at top)
        // On other pages, always show FAB
        const isDashboard = location === '/dashboard' || location === '/';
        const shouldShowFab = isDashboard ? isScrolled : true;
        
        if (!shouldShowFab) return null;
        
        return (
          <div className={`fixed bottom-24 right-6 z-50 ${isDashboard ? 'animate-in fade-in slide-in-from-bottom-4 duration-300' : ''}`}>
            <TransactionWizard>
              <button
                className="h-12 w-12 rounded-full shadow-lg hover:shadow-xl transition-all duration-200 bg-primary hover:bg-primary/90 hover:scale-105 flex items-center justify-center"
                data-testid="fab-create-transaction"
              >
                <Plus className="h-6 w-6 text-white" />
              </button>
            </TransactionWizard>
          </div>
        );
      })()}
    </div>
  );
}
