// API client for backend communication

const API_BASE = '/api';

// Custom error class for access denied scenarios
export class AccessDeniedError extends Error {
  code: string;
  eventId: string;
  organizationName: string;
  removedByUserName?: string;
  
  constructor(data: { code: string; eventId: string; organizationName: string; removedByUserName?: string; message: string }) {
    super(data.message);
    this.code = data.code;
    this.eventId = data.eventId;
    this.organizationName = data.organizationName;
    this.removedByUserName = data.removedByUserName;
    this.name = 'AccessDeniedError';
  }
}

// CSRF Token management
let csrfToken: string | null = null;

async function fetchCSRFToken(): Promise<string> {
  // Only use cached token if it's a non-empty string
  if (csrfToken && csrfToken.length > 0) return csrfToken;
  
  try {
    console.log('[CSRF] Fetching new CSRF token...');
    const response = await fetch(`${API_BASE}/csrf-token`, {
      credentials: 'include',
    });
    
    if (response.ok) {
      const data = await response.json();
      const token = data?.csrfToken || '';
      if (token && token.length > 0) {
        csrfToken = token;
        console.log('[CSRF] Token obtained successfully, length:', token.length);
        return token;
      } else {
        console.warn('[CSRF] Received empty token from server');
      }
    } else {
      console.warn('[CSRF] Failed to fetch token, status:', response.status);
    }
  } catch (err) {
    console.error('[CSRF] Error fetching token:', err);
  }
  
  return '';
}

export function clearCSRFToken() {
  csrfToken = null;
}

// Session management
// Primary: HTTP-only cookies managed by server
// Fallback: Bearer token in localStorage (for mobile browsers and cross-origin issues)

const AUTH_TOKEN_KEY = 'aikestar_auth_token';

export function setAuthToken(token: string) {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    console.log('[Auth] Saved auth token to localStorage');
  } catch (e) {
    console.warn('[Auth] Could not save auth token to localStorage:', e);
  }
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch (e) {
    return null;
  }
}

export function clearAuthToken() {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch (e) {
    // Ignore
  }
}

// Legacy functions for backward compatibility
export function setSessionToken(_token: string) {
  // Sessions are now managed via HTTP-only cookies + auth token fallback
}

export function clearSessionToken() {
  // Clear all auth data
  clearCSRFToken();
  clearAuthToken();
}

export function getSessionToken() {
  return null; // Sessions are now managed via HTTP-only cookies
}

export async function fetchWithAuth(endpoint: string, options: RequestInit = {}, skipAuthRedirect = false) {
  const existingHeaders = options.headers instanceof Headers 
    ? Object.fromEntries(options.headers.entries())
    : (options.headers as Record<string, string>) || {};

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...existingHeaders,
  };

  // Add Bearer token for authentication fallback (when cookies don't work)
  const authToken = getAuthToken();
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const method = options.method?.toUpperCase() || 'GET';
  const needsCSRF = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const isAuthEndpoint = endpoint === '/auth/login' || endpoint === '/auth/register';

  if (needsCSRF && !isAuthEndpoint) {
    const token = await fetchCSRFToken();
    if (token) {
      headers['X-CSRF-Token'] = token;
    }
    clearCSRFToken();
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (response.status === 401 && !skipAuthRedirect) {
    // Soft handling: clear caches and let App.tsx detect the unauthenticated
    // state via the /api/user query (which uses skipAuthRedirect=true).
    // A hard window.location redirect here used to kick paying users out on
    // ANY transient 401 (DB hiccup, race after session save, etc.).
    clearCSRFToken();
    try {
      const { queryClient } = await import('@/lib/queryClient');
      // Invalidate the user query so App.tsx re-checks auth and renders the
      // login routes if the user is truly gone. If the 401 was transient,
      // the refetch will succeed and the user stays in the app.
      queryClient.invalidateQueries({ queryKey: ['user'] });
    } catch (e) {
      // queryClient unavailable (very early boot) — ignore.
    }
    throw new Error('Session expired');
  }

  // Handle subscription-related errors (402 Payment Required)
  //
  // Task #318 — Antes esto se saltaba cuando `skipAuthRedirect=true`, que es
  // el caso del query `/api/user` que App.tsx usa para detectar login. El
  // efecto era: usuario con pago rechazado iniciaba sesión OK, el query de
  // user tiraba 402, el handler no redirigía → throw → isError=true → App
  // mostraba pantalla blanca o caía a /login. Ahora el 402 SIEMPRE redirige
  // a /subscription-required, conservando la sesión. `skipAuthRedirect`
  // solo afecta al 401 (estado de "no logueado todavía"), no al 402
  // ("logueado pero con suscripción bloqueada"). La página
  // /subscription-required está registrada tanto en el switch autenticado
  // como en el no-autenticado de App.tsx, así que el redirect es seguro
  // independientemente del estado del query de user.
  if (response.status === 402) {
    clearCSRFToken();
    const error = await response.json().catch(() => ({ message: 'Suscripción requerida' }));
    // Redirect to subscription page with error info
    const errorCode = error.code || 'SUBSCRIPTION_REQUIRED';
    const params = new URLSearchParams({ reason: errorCode });
    
    // Pass additional info for payment blocked.
    // Task #340 — Ya no propagamos `daysUntilDeletion`: el cron no borra
    // cuentas en `past_due`, así que esa cuenta regresiva era falsa.
    // `daysSinceFailure` sí es un dato real y lo mostramos como contexto.
    if (error.daysSinceFailure !== undefined) {
      params.set('daysSinceFailure', String(error.daysSinceFailure));
    }

    // Evitamos un loop si ya estamos en una página de "recovery" (es decir,
    // una página pensada precisamente para usuarios con suscripción inactiva).
    // Estas páginas hacen llamadas a /api/user u otros endpoints protegidos
    // que devuelven 402; si redirigimos a /subscription-required desde acá
    // se forma un loop infinito (ej.: usuario `cancelled` aprieta "Elegir mi
    // Plan" → va a /pricing → /api/user devuelve 402 → handler lo manda de
    // vuelta a /subscription-required → no puede ver los planes).
    //
    // Task #343 — agregamos /pricing, /payment-success y /access-denied a la
    // whitelist. Todas ellas necesitan poder cargarse para usuarios con
    // suscripción cancelada / past_due.
    const recoveryPaths = ['/subscription-required', '/pricing', '/payment-success', '/access-denied'];
    if (typeof window !== 'undefined' && !recoveryPaths.includes(window.location.pathname)) {
      window.location.href = `/subscription-required?${params.toString()}`;
    }
    throw new Error(error.message || 'Subscription required');
  }

  if (response.status === 403) {
    const error = await response.json().catch(() => ({ message: 'Forbidden' }));
    
    // Handle access denied for login (member removed or org owner deleted)
    if (error.code === 'ORG_OWNER_DELETED' || error.code === 'MEMBER_REMOVED') {
      throw new AccessDeniedError({
        code: error.code,
        eventId: error.eventId,
        organizationName: error.organizationName,
        removedByUserName: error.removedByUserName,
        message: error.message,
      });
    }

    // Permission-denied (role lacks the required permission). Surface a global
    // event so a top-level dialog can show a clear, friendly explanation.
    if (error.code === 'FORBIDDEN_PERMISSION' && typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('aikestar:permission-denied', {
          detail: {
            userRole: error.userRole,
            requiredPermission: error.requiredPermission,
            requiredRole: error.requiredRole,
            message: error.message,
          },
        }));
      } catch { /* ignore */ }
      const err = new Error(error.message || 'Forbidden') as Error & { code?: string };
      err.code = 'FORBIDDEN_PERMISSION';
      throw err;
    }

    if (error.message?.includes('CSRF') || error.code === 'EBADCSRFTOKEN') {
      clearCSRFToken();
      const token = await fetchCSRFToken();
      if (token) {
        headers['X-CSRF-Token'] = token;
        const retryResponse = await fetch(`${API_BASE}${endpoint}`, {
          ...options,
          headers,
          credentials: 'include',
        });
        if (!retryResponse.ok) {
          const retryError = await retryResponse.json().catch(() => ({ message: 'Request failed' }));
          throw new Error(retryError.message || `HTTP ${retryResponse.status}`);
        }
        return parseResponseBody(retryResponse);
      }
    }
    throw new Error(error.message || 'Forbidden');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    const err = new Error(error.message || `HTTP ${response.status}`) as Error & { code?: string; detectedHeaders?: string[] };
    if (error.code) {
      err.code = error.code;
    }
    if (Array.isArray(error.detectedHeaders)) {
      err.detectedHeaders = error.detectedHeaders;
    }
    throw err;
  }

  return parseResponseBody(response);
}

async function parseResponseBody(response: Response) {
  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');
  
  if (response.status === 204 || contentLength === '0' || !contentType?.includes('application/json')) {
    return undefined;
  }
  
  const text = await response.text();
  if (!text || text.trim() === '') {
    return undefined;
  }
  
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Alias for backward compatibility
const fetchAPI = fetchWithAuth;

// Auth API
export const authAPI = {
  login: async (email: string, password: string) => {
    const data = await fetchWithAuth('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
    }, true);
    return data;
  },

  register: async (email: string, name: string, password: string, organizationName?: string) => {
    const data = await fetchAPI('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: email.toLowerCase().trim(), name, password, organizationName }),
    });
    return data;
  },

  logout: async () => {
    await fetchAPI('/auth/logout', { method: 'POST' });
    // Clear auth token on logout
    clearAuthToken();
  },
};

// User API
export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  accountType: string;
  profileImageUrl: string | null;
  profileIconKey: string | null;
  mustChangePassword: boolean;
  planType: string | null;
  stripeCustomerId: string | null;
  phoneNumber: string | null;
  phoneVerified: boolean;
  // ISO 8601 timestamp marking when the unverified phone number was set,
  // used by the dashboard banner to fire only after >24h.
  phoneNumberAddedAt: string | null;
  // Informational-only phone collected at signup (Task #221). Stored on
  // users.pending_phone_number; used by settings.tsx to pre-fill the
  // WhatsApp linking wizard. Never treated as the verified phone.
  pendingPhoneNumber: string | null;
  whatsappDefaultOrganizationId: string | null;
  isAdmin?: boolean;
}

export const userAPI = {
  getCurrent: (): Promise<CurrentUser> => fetchAPI('/user', {}, true), // Skip auth redirect - App.tsx handles this
  update: (data: { name?: string; email?: string; profileImageUrl?: string | null; profileIconKey?: string | null }) =>
    fetchAPI('/user', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  getMembership: () => fetchAPI('/user/membership'),
};

// Organization API
export const organizationAPI = {
  getCurrent: () => fetchAPI('/organization'),
  getAll: () => fetchAPI('/organizations'),
  create: (data: { name: string; iconKey?: string | null; logoUrl?: string | null }) =>
    fetchAPI('/organizations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  switch: (organizationId: string) =>
    fetchAPI('/organizations/switch', {
      method: 'POST',
      body: JSON.stringify({ organizationId }),
    }),
  update: (data: { name: string }) =>
    fetchAPI('/organization', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  updateById: (id: string, data: { name?: string; logoUrl?: string | null; iconKey?: string | null; contactEmail?: string | null; contactPhone?: string | null; quotePdfLogoUrl?: string | null; quotePdfContactEmail?: string | null; quotePdfContactPhone?: string | null; quotePdfCompanyName?: string | null; quotePdfContactName?: string | null }) =>
    fetchAPI(`/organizations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchAPI(`/organizations/${id}`, {
      method: 'DELETE',
    }),
};

// Account API
export const accountAPI = {
  getAll: () => fetchAPI('/accounts'),
  create: (data: { name: string; type: string; balance: number | string }) =>
    fetchAPI('/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; type?: string; balance?: number | string }) =>
    fetchAPI(`/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string, opts?: { action?: 'transfer' | 'adjust'; targetAccountId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.action) params.set('action', opts.action);
    if (opts?.targetAccountId) params.set('targetAccountId', opts.targetAccountId);
    const qs = params.toString();
    return fetchAPI(`/accounts/${id}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  adjustBalance: (id: string, data: { newBalance: string; reason?: string }) =>
    fetchAPI(`/accounts/${id}/adjust-balance`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  forceBalance: (id: string, newBalance: string) =>
    fetchAPI(`/accounts/${id}/force-balance`, {
      method: 'POST',
      body: JSON.stringify({ newBalance }),
    }),
};

// Exchange Rates API
export const exchangeRatesAPI = {
  get: () => fetchAPI('/exchange-rates'),
};

// El WAF del borde del deploy (Google Cloud Armor, regla OWASP CRS 933150)
// bloquea cualquier body que contenga la subcadena `settype` (case-insensitive,
// porque `settype` es una función PHP de alto riesgo). La clave JSON `assetType`
// la contiene, por eso se cortaba TODO movimiento con un 403 HTML. Renombramos la
// clave a `asset_type` en el cable (el WAF la deja pasar) y el server la mapea de
// vuelta. Sólo toca esa clave; el resto del payload queda intacto.
function renameAssetTypeKey(data: any): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  if (!('assetType' in data)) return data;
  const { assetType, ...rest } = data;
  return { ...rest, asset_type: assetType };
}

// Transaction API
export const transactionAPI = {
  getAll: (status?: 'completed' | 'scheduled') => 
    fetchAPI(status ? `/transactions?status=${status}` : '/transactions'),
  getCompleted: () => fetchAPI('/transactions?status=completed'),
  getScheduled: () => fetchAPI('/transactions?status=scheduled'),
  create: (data: any) =>
    fetchAPI('/transactions', {
      method: 'POST',
      // El WAF del borde del deploy (Google Cloud Armor, regla OWASP CRS 933150
      // "high-risk PHP function") corta cualquier body que contenga la subcadena
      // `settype` case-insensitive. La clave `assetType` la contiene, así que se
      // bloqueaba TODO movimiento con un 403 HTML antes de llegar a Express. La
      // mandamos como `asset_type` (que el WAF deja pasar) y el server la mapea
      // de vuelta a `assetType`.
      body: JSON.stringify(renameAssetTypeKey(data)),
    }),
  update: (id: string, data: any) =>
    fetchAPI(`/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(renameAssetTypeKey(data)),
    }),
  delete: (id: string) =>
    fetchAPI(`/transactions/${id}`, {
      method: 'DELETE',
    }),
  bulkDelete: (ids: string[]) =>
    fetchAPI('/transactions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }) as Promise<{ deleted: string[]; skipped: { id: string; reason: string }[] }>,
};

// Client API
export const clientAPI = {
  getAll: (activeOnly?: boolean, opts?: { includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (activeOnly) params.set('activeOnly', 'true');
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return fetchAPI(`/clients${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => fetchAPI(`/clients/${id}`),
  create: (data: { name: string; email?: string; phone?: string; address?: string; taxId?: string; notes?: string; clientType?: string; status?: string }) =>
    fetchAPI('/clients', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<{ name: string; email: string; phone: string; address: string; taxId: string; notes: string; clientType: string; status: string; isActive: boolean }>) =>
    fetchAPI(`/clients/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  bulkImport: (rows: any[], dryRun: boolean) =>
    fetchAPI('/clients/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ rows, dryRun }),
    }),
  // Task #363: delete devuelve { deleted | archived, undoKey? }
  delete: (id: string, opts?: { force?: boolean }) =>
    fetchAPI(`/clients/${id}${opts?.force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }) as Promise<{ success: boolean; deleted?: boolean; archived?: boolean; undoKey?: string }>,
  archive: (id: string) =>
    fetchAPI(`/clients/${id}/archive`, { method: 'POST' }),
  unarchive: (id: string) =>
    fetchAPI(`/clients/${id}/unarchive`, { method: 'POST' }),
  getEmployees: (clientId: string) => fetchAPI(`/clients/${clientId}/employees`),
  getAllAllocations: () => fetchAPI('/allocations/by-organization') as Promise<Record<string, Array<{ grossSalary: string; currency: string; percentage: string; commissionRate: string }>>>,
  getProjects: (clientId: string) => fetchAPI(`/clients/${clientId}/projects`),
  createProject: (clientId: string, data: { name: string; description?: string }) =>
    fetchAPI(`/clients/${clientId}/projects`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateProject: (clientId: string, projectId: string, data: { name?: string; description?: string; isActive?: boolean }) =>
    fetchAPI(`/clients/${clientId}/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteProject: (clientId: string, projectId: string) =>
    fetchAPI(`/clients/${clientId}/projects/${projectId}`, {
      method: 'DELETE',
    }),
  getInvoiceEmailPrefs: (clientId: string) =>
    fetchAPI(`/clients/${clientId}/invoice-email-prefs`) as Promise<{ clientId: string; defaultCcEmails: string[]; sendCopyToSelf: boolean }>,
  updateInvoiceEmailPrefs: (clientId: string, data: { defaultCcEmails?: string[]; sendCopyToSelf?: boolean }) =>
    fetchAPI(`/clients/${clientId}/invoice-email-prefs`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// Quote (presupuesto) API
export const quoteAPI = {
  getAll: (status?: string) => fetchAPI(`/quotes${status ? `?status=${status}` : ''}`),
  get: (id: string) => fetchAPI(`/quotes/${id}`),
  create: (data: any) =>
    fetchAPI('/quotes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: any) =>
    fetchAPI(`/quotes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchAPI(`/quotes/${id}`, {
      method: 'DELETE',
    }),
  win: (id: string, transactionId: string) =>
    fetchAPI(`/quotes/${id}/win`, {
      method: 'POST',
      body: JSON.stringify({ transactionId }),
    }),
  lose: (id: string) =>
    fetchAPI(`/quotes/${id}/lose`, {
      method: 'POST',
    }),
  reopen: (id: string) =>
    fetchAPI(`/quotes/${id}/reopen`, {
      method: 'POST',
    }),
};

// Supplier API
export const supplierAPI = {
  getAll: (activeOnly?: boolean, opts?: { includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (activeOnly) params.set('activeOnly', 'true');
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return fetchAPI(`/suppliers${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => fetchAPI(`/suppliers/${id}`),
  create: (data: { name: string; email?: string; phone?: string; address?: string; taxId?: string; notes?: string; supplierType?: string }) =>
    fetchAPI('/suppliers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<{ name: string; email: string; phone: string; address: string; taxId: string; notes: string; supplierType: string; isActive: boolean }>) =>
    fetchAPI(`/suppliers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  bulkImport: (rows: any[], dryRun: boolean) =>
    fetchAPI('/suppliers/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ rows, dryRun }),
    }),
  // Task #363
  delete: (id: string, opts?: { force?: boolean }) =>
    fetchAPI(`/suppliers/${id}${opts?.force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }) as Promise<{ success: boolean; deleted?: boolean; archived?: boolean; undoKey?: string }>,
  archive: (id: string) =>
    fetchAPI(`/suppliers/${id}/archive`, { method: 'POST' }),
  unarchive: (id: string) =>
    fetchAPI(`/suppliers/${id}/unarchive`, { method: 'POST' }),
};

// Employee API
export const employeeAPI = {
  getAll: (activeOnly?: boolean) => fetchAPI(`/employees${activeOnly ? '?activeOnly=true' : ''}`),
  get: (id: string) => fetchAPI(`/employees/${id}`),
  create: (data: Record<string, unknown>) =>
    fetchAPI('/employees', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Record<string, unknown>) =>
    fetchAPI(`/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchAPI(`/employees/${id}`, {
      method: 'DELETE',
    }),
  getAllocations: (id: string) => fetchAPI(`/employees/${id}/allocations`),
  setAllocations: (id: string, allocations: { clientId: string; projectId?: string; projectName?: string; percentage: string; commissionRate?: string }[]) =>
    fetchAPI(`/employees/${id}/allocations`, {
      method: 'PUT',
      body: JSON.stringify({ allocations }),
    }),
  getProfitability: (id: string) => fetchAPI(`/employees/${id}/profitability`),
  getPayrollSummary: () => fetchAPI('/employees/payroll-summary'),
  setPayrollPayDay: (payrollPayDay: number) =>
    fetchAPI('/organization/payroll-settings', {
      method: 'PATCH',
      body: JSON.stringify({ payrollPayDay }),
    }),
  payPayroll: (accountId: string) =>
    fetchAPI('/payroll/pay', {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
};

// Product API - catalog fields exposed in UI, price fields hidden but sent with defaults
export const productAPI = {
  getAll: (activeOnly?: boolean) => fetchAPI(`/products${activeOnly ? '?activeOnly=true' : ''}`),
  get: (id: string) => fetchAPI(`/products/${id}`),
  create: (data: any) =>
    fetchAPI('/products', {
      method: 'POST',
      body: JSON.stringify({ costPrice: '0', salePrice: '0', ...data }),
    }),
  update: (id: string, data: any) =>
    fetchAPI(`/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchAPI(`/products/${id}`, {
      method: 'DELETE',
    }),
  bulkDelete: (ids: string[], opts?: { force?: boolean }) =>
    fetchAPI('/products/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids, force: opts?.force === true }),
    }) as Promise<{ deleted: string[]; skipped: { id: string; reason: string }[] }>,
  getStockMovements: (id: string) => fetchAPI(`/products/${id}/movements`),
  createStockMovement: (id: string, data: { type: string; quantity: string; reason?: string }) =>
    fetchAPI(`/products/${id}/movements`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  bulkImport: (rows: any[], dryRun: boolean) =>
    fetchAPI('/products/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ rows, dryRun }),
    }),
};

// Undo Delete API
export const undoAPI = {
  restore: (undoKey: string) =>
    fetchAPI('/undo-delete', {
      method: 'POST',
      body: JSON.stringify({ undoKey }),
    }),
};

// Profitability Codes API
export const profitabilityCodeAPI = {
  getAll: (activeOnly?: boolean, opts?: { includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (activeOnly) params.set('activeOnly', 'true');
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return fetchAPI(`/profitability-codes${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => fetchAPI(`/profitability-codes/${id}`),
  create: (data: any) =>
    fetchAPI('/profitability-codes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: any) =>
    fetchAPI(`/profitability-codes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  // Task #363
  delete: (id: string, opts?: { force?: boolean }) =>
    fetchAPI(`/profitability-codes/${id}${opts?.force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }) as Promise<{ success: boolean; deleted?: boolean; archived?: boolean }>,
  archive: (id: string) =>
    fetchAPI(`/profitability-codes/${id}/archive`, { method: 'POST' }),
  unarchive: (id: string) =>
    fetchAPI(`/profitability-codes/${id}/unarchive`, { method: 'POST' }),
};

// Task #363: Transaction Categories API (centralizado)
export const categoryAPI = {
  getAll: (type?: 'income' | 'expense', opts?: { includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return fetchAPI(`/organization/categories${qs ? `?${qs}` : ''}`);
  },
  delete: (id: string, opts?: { force?: boolean; reassignTo?: string }) =>
    fetchAPI(`/organization/categories/${id}${opts?.force ? '?force=true' : ''}`, {
      method: 'DELETE',
      body: opts?.reassignTo ? JSON.stringify({ reassignTo: opts.reassignTo }) : undefined,
    }) as Promise<{ success: boolean; deleted?: boolean; archived?: boolean; reassignedCount?: number }>,
  archive: (id: string) =>
    fetchAPI(`/organization/categories/${id}/archive`, { method: 'POST' }),
  unarchive: (id: string) =>
    fetchAPI(`/organization/categories/${id}/unarchive`, { method: 'POST' }),
};

// Payment Methods API (Task #229)
export const paymentMethodAPI = {
  getAll: (activeOnly?: boolean) => fetchAPI(`/payment-methods${activeOnly ? '?activeOnly=true' : ''}`),
  get: (id: string) => fetchAPI(`/payment-methods/${id}`),
  create: (data: any) =>
    fetchAPI('/payment-methods', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: any) =>
    fetchAPI(`/payment-methods/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchAPI(`/payment-methods/${id}`, {
      method: 'DELETE',
    }),
};

// Audit Log API
export const auditLogAPI = {
  getAll: (limit?: number) => fetchAPI(`/audit-logs${limit ? `?limit=${limit}` : ''}`),
  getByEntity: (entityType: string, entityId: string) => fetchAPI(`/audit-logs/${entityType}/${entityId}`),
};
