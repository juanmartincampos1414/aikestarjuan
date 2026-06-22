import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { userAPI, organizationAPI, accountAPI, transactionAPI, authAPI, exchangeRatesAPI, clientAPI, supplierAPI, productAPI, fetchWithAuth } from './api';
import type { Client, Supplier } from '@shared/schema';

// User hooks
export function useUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: userAPI.getCurrent,
    retry: false,
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name?: string; email?: string; profileImageUrl?: string | null; profileIconKey?: string | null }) => userAPI.update(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
    },
  });
}

export function useMembership() {
  return useQuery({
    queryKey: ['membership'],
    queryFn: userAPI.getMembership,
    retry: false,
  });
}

// Organization hooks
export function useOrganization() {
  return useQuery({
    queryKey: ['organization'],
    queryFn: organizationAPI.getCurrent,
    retry: false,
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations'],
    queryFn: organizationAPI.getAll,
    retry: false,
  });
}

export function useCreateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; iconKey?: string | null; logoUrl?: string | null }) => organizationAPI.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

export function useSwitchOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) => organizationAPI.switch(organizationId),
    onSuccess: async () => {
      const preserveKeys = ['/api/user', 'user'];
      queryClient.getQueryCache().getAll().forEach(query => {
        const key = String(query.queryKey[0]);
        if (!preserveKeys.includes(key)) {
          queryClient.removeQueries({ queryKey: query.queryKey });
        }
      });
      await queryClient.refetchQueries({ queryKey: ['organization'] });
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['accounts'] }),
        queryClient.refetchQueries({ queryKey: ['transactions'] }),
        queryClient.refetchQueries({ queryKey: ['exchange-rates'] }),
        queryClient.refetchQueries({ queryKey: ['membership'] }),
        queryClient.refetchQueries({ queryKey: ['/api/notifications/summary'] }),
        queryClient.refetchQueries({ queryKey: ['organizations'] }),
      ]);
    },
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string }) => organizationAPI.update(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });
}

export function useUpdateOrganizationById() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; logoUrl?: string | null; iconKey?: string | null; contactEmail?: string | null; contactPhone?: string | null; quotePdfLogoUrl?: string | null; quotePdfContactEmail?: string | null; quotePdfContactPhone?: string | null; quotePdfCompanyName?: string | null; quotePdfContactName?: string | null } }) => organizationAPI.updateById(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });
}

export function useDeleteOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => organizationAPI.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      await queryClient.invalidateQueries({ queryKey: ['organization'] });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

// Members hook — lista de miembros de la organización activa.
// Devuelve { userId, name, email, role } por cada miembro confirmado.
// Usado por Reportes para el filtro y el bloque "Por miembro del equipo".
export function useMembers() {
  return useQuery<Array<{ userId: string; name: string; email: string; role: string }>>({
    queryKey: ['/api/organization/members'],
    queryFn: async () => {
      // IMPORTANTE: dos cosas que han roto este endpoint en el pasado:
      // 1) fetchWithAuth ya antepone '/api' (API_BASE), así que el endpoint
      //    debe pasarse SIN ese prefijo. Pasarlo con '/api/...' producía
      //    '/api/api/organization/members' y el server devolvía index.html.
      // 2) fetchWithAuth devuelve el JSON YA PARSEADO (no un Response).
      //    Hacer `if (!res.ok) return []; return res.json()` siempre
      //    devolvía [] porque `res.ok` es undefined sobre un array. Ese
      //    bug ocultaba silenciosamente el bloque "Por miembro del equipo"
      //    de Reportes y la columna "Creado por" de Movimientos aunque
      //    el server respondiera correctamente con los 4 miembros de la org.
      try {
        const data = await fetchWithAuth('/organization/members');
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },
  });
}

// Plan-aware gating: oculta features de Empresa (Facturas, Impuestos, Clientes,
// Proveedores en wizard, etc.) sólo cuando la org es de tipo 'personal' Y el
// plan asociado es el básico 'personal'. Cualquier plan pago de personal_pro
// en adelante destrababa estas funciones aunque la org sea Personal.
export function useIsPersonalBasic(): boolean {
  const { data: organization } = useOrganization();
  const { data: user } = useUser() as { data: { accountType?: string } | undefined };
  const { data: planLimits } = useQuery<{
    accountType?: string;
    planType?: string | null;
    orgPlanType?: string | null;
  }>({
    queryKey: ['/subscription/limits'],
    queryFn: () => fetchWithAuth('/subscription/limits'),
    enabled: !!user,
    staleTime: 60000,
  });
  const orgType = (organization as { type?: string } | undefined)?.type;
  const isPersonalContext = orgType === 'personal';
  const orgPlanType = planLimits?.orgPlanType || planLimits?.planType;
  // Si todavía no tenemos planType, caemos a accountType del usuario para no
  // mostrar features que después vamos a tener que esconder en el primer render.
  const isPersonalAccount = user?.accountType === 'personal';
  const isOrgBasicPersonal = orgPlanType === 'personal' || (!orgPlanType && isPersonalAccount);
  return isPersonalContext && isOrgBasicPersonal;
}

// Account hooks
export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: accountAPI.getAll,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; type: string; currency?: string; balance: number | string; organizationId: string; accountCategory?: string; customTypeLabel?: string | null; initialInvestment?: string | null; maturityDate?: string | null; interestRate?: string | null; interestFrequency?: string | null }) =>
      accountAPI.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => accountAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, targetAccountId }: { id: string; action?: 'transfer' | 'adjust'; targetAccountId?: string }) => 
      accountAPI.delete(id, { action, targetAccountId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useAdjustAccountBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newBalance, reason }: { id: string; newBalance: string; reason?: string }) =>
      accountAPI.adjustBalance(id, { newBalance, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });
}

export function useForceAccountBalance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newBalance }: { id: string; newBalance: string }) =>
      accountAPI.forceBalance(id, newBalance),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

// Transaction hooks
export function useTransactions(status?: 'completed' | 'scheduled') {
  return useQuery({
    queryKey: status ? ['transactions', status] : ['transactions'],
    queryFn: () => transactionAPI.getAll(status),
  });
}

export function useCompletedTransactions() {
  return useQuery({
    queryKey: ['transactions', 'completed'],
    queryFn: transactionAPI.getCompleted,
  });
}

export function useScheduledTransactions() {
  return useQuery({
    queryKey: ['transactions', 'scheduled'],
    queryFn: transactionAPI.getScheduled,
  });
}

export function useCreateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => transactionAPI.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

export function useUpdateTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => transactionAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

export function useDeleteTransaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transactionAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/audit-logs'] });
      queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

// Traceability hooks
export interface LinkableTransaction {
  id: string;
  transactionNumber: string | null;
  description: string;
  amount: string;
  date: string;
  type: string;
  category: string;
  linkedAmount: number;
  availableBalance: number;
}

export function useLinkableTransactions() {
  return useQuery<LinkableTransaction[]>({
    queryKey: ['transactions', 'linkable'],
    queryFn: async () => {
      const res = await fetch('/api/transactions/linkable', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch linkable transactions');
      return res.json();
    },
  });
}

export function useLinkedTransactions(transactionId: string | null) {
  return useQuery({
    queryKey: ['transactions', 'linked', transactionId],
    queryFn: async () => {
      if (!transactionId) return null;
      const res = await fetch(`/api/transactions/${transactionId}/linked`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch linked transactions');
      return res.json();
    },
    enabled: !!transactionId,
  });
}

export function useTraceability(transactionId: string | null) {
  return useQuery({
    queryKey: ['transactions', 'traceability', transactionId],
    queryFn: async () => {
      if (!transactionId) return null;
      const res = await fetch(`/api/transactions/${transactionId}/traceability`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch traceability');
      return res.json();
    },
    enabled: !!transactionId,
  });
}

// Auth hooks
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      authAPI.login(email, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authAPI.logout,
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, name, password, organizationName }: { 
      email: string; 
      name: string; 
      password: string; 
      organizationName?: string;
    }) => authAPI.register(email, name, password, organizationName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });
}

// Exchange rates hooks
export function useExchangeRates() {
  return useQuery({
    queryKey: ['exchange-rates'],
    queryFn: exchangeRatesAPI.get,
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    retry: 1,
  });
}

// Client hooks
export function useClients(activeOnly?: boolean) {
  return useQuery<Client[]>({
    queryKey: ['clients', activeOnly],
    queryFn: () => clientAPI.getAll(activeOnly),
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: clientAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => clientAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

// Supplier hooks
export function useSuppliers(activeOnly?: boolean) {
  return useQuery<Supplier[]>({
    queryKey: ['suppliers', activeOnly],
    queryFn: () => supplierAPI.getAll(activeOnly),
  });
}

export function useCreateSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: supplierAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useUpdateSupplier() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => supplierAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

// Product hooks
export function useProducts(activeOnly?: boolean) {
  return useQuery({
    queryKey: ['products', activeOnly],
    queryFn: () => productAPI.getAll(activeOnly),
  });
}

export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: productAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

export function useUpdateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => productAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });
}

// Asset API
const assetAPI = {
  getAll: async (activeOnly?: boolean) => {
    const res = await fetch(`/api/assets?active=${activeOnly || false}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch assets');
    return res.json();
  },
  get: async (id: string) => {
    const res = await fetch(`/api/assets/${id}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch asset');
    return res.json();
  },
  create: async (data: any) => {
    return fetchWithAuth('/assets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  update: async (id: string, data: any) => {
    return fetchWithAuth(`/assets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  delete: async (id: string) => {
    return fetchWithAuth(`/assets/${id}`, {
      method: 'DELETE',
    });
  },
};

// Investment API
const investmentAPI = {
  getAll: async (activeOnly?: boolean) => {
    const res = await fetch(`/api/investments?active=${activeOnly || false}`, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch investments');
    return res.json();
  },
  create: async (data: any) => {
    return fetchWithAuth('/investments', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  update: async (id: string, data: any) => {
    return fetchWithAuth(`/investments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },
  delete: async (id: string) => {
    return fetchWithAuth(`/investments/${id}`, {
      method: 'DELETE',
    });
  },
};

// Asset hooks
export function useAssets(activeOnly?: boolean) {
  return useQuery({
    queryKey: ['assets', activeOnly],
    queryFn: () => assetAPI.getAll(activeOnly),
  });
}

export function useAsset(id: string) {
  return useQuery({
    queryKey: ['assets', id],
    queryFn: () => assetAPI.get(id),
    enabled: !!id,
  });
}

export function useCreateAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: assetAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

export function useUpdateAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => assetAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

export function useDeleteAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: assetAPI.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

export function useRunDepreciation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return fetchWithAuth('/assets/depreciation', {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });
}

// Investment hooks
export function useInvestments(activeOnly?: boolean) {
  return useQuery({
    queryKey: ['investments', activeOnly],
    queryFn: () => investmentAPI.getAll(activeOnly),
  });
}

export function useCreateInvestment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: investmentAPI.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments'] });
    },
  });
}

export function useUpdateInvestment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => investmentAPI.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments'] });
    },
  });
}

export function useDeleteInvestment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: investmentAPI.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investments'] });
    },
  });
}
