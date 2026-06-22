import { 
  type User, type InsertUser,
  type Organization, type InsertOrganization,
  type Membership, type InsertMembership,
  type Account, type InsertAccount,
  type Transaction, type InsertTransaction,
  type PasswordReset,
  type Client, type InsertClient,
  type Quote, type InsertQuote,
  type ClientProject, type InsertClientProject,
  type Supplier, type InsertSupplier,
  type Employee, type InsertEmployee,
  type EmployeeClientAllocation, type InsertEmployeeClientAllocation,
  type Product, type InsertProduct,
  type StockMovement, type InsertStockMovement,
  type TransactionItem, type InsertTransactionItem,
  type QuoteItem, type InsertQuoteItem,
  type AuditLog, type InsertAuditLog,
  type Asset, type InsertAsset,
  type Investment, type InsertInvestment,
  type TeamInvitation, type InsertTeamInvitation,
  type Subscription, type InsertSubscription,
  type TransactionCategory, type InsertTransactionCategory,
  type AccessDeniedEvent, type InsertAccessDeniedEvent,
  type PendingSignup, type InsertPendingSignup,
  type SessionLog, type InsertSessionLog,
  type SystemError, type InsertSystemError,
  type MrrSnapshot, type InsertMrrSnapshot,
  mrrSnapshots,
  type AccountDeletion, type InsertAccountDeletion, type AccountDeletionReason,
  accountDeletions,
  type ChatMessage, type InsertChatMessage,
  type Notification, type InsertNotification,
  type WhatsappPreferences, type InsertWhatsappPreferences,
  type DashboardPreferences, type InsertDashboardPreferences,
  type ClientInvoiceEmailPrefs, type InsertClientInvoiceEmailPrefs,
  type SupplierInvoiceEmailPrefs, type InsertSupplierInvoiceEmailPrefs,
  type SubscriptionPlan, type InsertSubscriptionPlan,
  subscriptionPlans,
  users, organizations, memberships, accounts, transactions, transactionItems, quoteItems, passwordResets,
  clients, quotes, clientProjects, suppliers, employees, employeeClientAllocations, products, stockMovements, auditLogs, assets, investments, teamInvitations, subscriptions, transactionCategories,
  accessDeniedEvents, pendingSignups, sessionLogs, systemErrors, chatMessages, notifications, whatsappPreferences, dashboardPreferences, clientInvoiceEmailPrefs, supplierInvoiceEmailPrefs,
  taxProfiles, type TaxProfile, type InsertTaxProfile,
  invoicingAccounts, invoicingSellingPoints,
  type InvoicingAccount, type InsertInvoicingAccount,
  type InvoicingSellingPoint, type InsertInvoicingSellingPoint,
  profitabilityCodes, type ProfitabilityCode, type InsertProfitabilityCode,
  paymentMethods, type PaymentMethod, type InsertPaymentMethod, type PaymentMethodWithConcepts,
  paymentMethodConcepts, type PaymentMethodConcept, type InsertPaymentMethodConcept,
  DEFAULT_INCOME_CATEGORIES, DEFAULT_EXPENSE_CATEGORIES, DEFAULT_COST_CATEGORIES,
  PLAN_DETAILS,
  businessSettings, type BusinessSettings, type UpdateBusinessSettings, BUSINESS_SETTINGS_SINGLETON_ID,
  acquisitionSpend, type AcquisitionSpend, type UpsertAcquisitionSpend, type UpdateAcquisitionConfig
} from "@shared/schema";
import { db } from "./db";
import { eq, ne, and, desc, lte, gte, asc, count, sql, inArray, not, isNull, lt, isNotNull, or, type SQL } from "drizzle-orm";
import { arPhoneCandidates } from "@shared/phone";
import { USD_ARS_RATE_DEFAULT, SAAS_KPI_ESTIMATES } from "@shared/constants";

export type UserUpdate = Partial<InsertUser & { stripeCustomerId: string | null; stripeSubscriptionId: string | null }>;

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  // Task #343 — filtra deleted_at IS NULL. Usar en flujos de registro,
  // invitación y recovery; ver doc en la implementación.
  getUserByActiveEmail(email: string): Promise<User | undefined>;
  getUserByPhone(phoneNumber: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: UserUpdate): Promise<User | undefined>;
  getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  
  // Organization operations
  getOrganization(id: string): Promise<Organization | undefined>;
  getOrganizationsByUser(userId: string): Promise<(Organization & { membershipRole: string })[]>;
  createOrganization(org: InsertOrganization): Promise<Organization>;
  updateOrganization(id: string, updates: Partial<InsertOrganization>): Promise<Organization | undefined>;
  deleteOrganization(id: string): Promise<boolean>;
  incrementTransactionCounter(organizationId: string): Promise<number>;
  
  // Membership operations
  createMembership(membership: InsertMembership): Promise<Membership>;
  getMembershipByUserAndOrg(userId: string, organizationId: string): Promise<Membership | undefined>;
  getMembersByOrganization(organizationId: string): Promise<Array<{ user: User; membership: Membership }>>;
  getOrganizationOwner(organizationId: string): Promise<User | undefined>;
  updateMembershipRole(membershipId: string, role: string): Promise<Membership | undefined>;
  deleteMembership(id: string): Promise<boolean>;
  
  // Account operations
  getAccountsByOrganization(organizationId: string): Promise<Account[]>;
  getAccount(id: string): Promise<Account | undefined>;
  createAccount(account: InsertAccount): Promise<Account>;
  updateAccount(id: string, updates: Partial<InsertAccount>): Promise<Account | undefined>;
  deleteAccount(id: string): Promise<boolean>;
  
  // Transaction operations
  getTransactionsByOrganization(organizationId: string, status?: 'completed' | 'scheduled', options?: { limit?: number; offset?: number; startDate?: string; endDate?: string; includeCancelled?: boolean; dateField?: 'date' | 'imputation'; categories?: string[] }): Promise<Transaction[]>;
  getScheduledTransactions(organizationId: string): Promise<Transaction[]>;
  promoteScheduledTransactions(organizationId: string): Promise<Transaction[]>;
  getTransaction(id: string): Promise<Transaction | undefined>;
  getTransactionCountByOrganization(organizationId: string): Promise<number>;
  createTransaction(transaction: InsertTransaction): Promise<Transaction>;
  updateTransaction(id: string, updates: Partial<InsertTransaction>): Promise<Transaction | undefined>;
  deleteTransaction(id: string): Promise<{ deleted: boolean; cancellationId?: string }>;
  
  // Password reset operations
  createPasswordReset(data: { userId: string; token: string; expiresAt: Date }): Promise<PasswordReset>;
  getPasswordResets(userId: string): Promise<PasswordReset[]>;
  markPasswordResetUsed(id: string): Promise<boolean>;
  
  // Client operations
  getClientsByOrganization(organizationId: string, activeOnly?: boolean, includeArchived?: boolean): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  createClient(client: InsertClient): Promise<Client>;
  updateClient(id: string, updates: Partial<InsertClient>): Promise<Client | undefined>;
  deleteClient(id: string): Promise<boolean>;
  archiveClient(id: string): Promise<Client | undefined>; // Task #363
  unarchiveClient(id: string): Promise<Client | undefined>; // Task #363

  // Quote (presupuesto) operations
  getQuotesByOrganization(organizationId: string, status?: string): Promise<Quote[]>;
  getQuote(id: string): Promise<Quote | undefined>;
  createQuote(quote: InsertQuote): Promise<Quote>;
  updateQuote(id: string, updates: Partial<InsertQuote>): Promise<Quote | undefined>;
  deleteQuote(id: string): Promise<boolean>;
  markQuoteWon(id: string, transactionId: string): Promise<Quote | undefined>;
  markQuoteLost(id: string): Promise<Quote | undefined>;
  reopenQuote(id: string): Promise<Quote | undefined>;

  // Subscription plan operations
  getSubscriptionPlans(organizationId: string, activeOnly?: boolean): Promise<SubscriptionPlan[]>;
  getSubscriptionPlan(id: string, organizationId?: string): Promise<SubscriptionPlan | undefined>;
  createSubscriptionPlan(plan: InsertSubscriptionPlan): Promise<SubscriptionPlan>;
  updateSubscriptionPlan(id: string, updates: Partial<InsertSubscriptionPlan>): Promise<SubscriptionPlan | undefined>;
  deleteSubscriptionPlan(id: string): Promise<boolean>;
  getSubscriberClientsDue(organizationId: string | null, currentMonth: string): Promise<Client[]>;
  
  getProjectsByClient(clientId: string): Promise<ClientProject[]>;
  getProject(id: string): Promise<ClientProject | undefined>;
  createProject(project: InsertClientProject): Promise<ClientProject>;
  updateProject(id: string, updates: Partial<InsertClientProject>): Promise<ClientProject | undefined>;
  deleteProject(id: string): Promise<boolean>;
  
  // Supplier operations
  getSuppliersByOrganization(organizationId: string, activeOnly?: boolean, includeArchived?: boolean): Promise<Supplier[]>;
  getSupplier(id: string): Promise<Supplier | undefined>;
  createSupplier(supplier: InsertSupplier): Promise<Supplier>;
  updateSupplier(id: string, updates: Partial<InsertSupplier>): Promise<Supplier | undefined>;
  deleteSupplier(id: string): Promise<boolean>;
  archiveSupplier(id: string): Promise<Supplier | undefined>; // Task #363
  unarchiveSupplier(id: string): Promise<Supplier | undefined>; // Task #363
  
  // Employee operations
  getEmployeesByOrganization(organizationId: string, activeOnly?: boolean): Promise<Employee[]>;
  getEmployee(id: string): Promise<Employee | undefined>;
  createEmployee(employee: InsertEmployee): Promise<Employee>;
  updateEmployee(id: string, updates: Partial<InsertEmployee>): Promise<Employee | undefined>;
  deleteEmployee(id: string): Promise<boolean>;
  
  // Employee-Client allocation operations
  getAllocationsByEmployee(employeeId: string): Promise<EmployeeClientAllocation[]>;
  getAllocationsByClient(clientId: string): Promise<EmployeeClientAllocation[]>;
  getAllocationsWithEmployeesByOrganization(organizationId: string): Promise<Array<{ id: string; employeeId: string; clientId: string; projectId: string | null; projectName: string; percentage: string; commissionRate: string; createdAt: Date; grossSalary: string; currency: string; employeeStatus: string }>>;
  setAllocationsForEmployee(employeeId: string, allocations: { clientId: string; projectId?: string; projectName?: string; percentage: string; commissionRate?: string }[]): Promise<EmployeeClientAllocation[]>;
  
  // Product operations
  getProductsByOrganization(organizationId: string, activeOnly?: boolean): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  createProduct(product: InsertProduct): Promise<Product>;
  updateProduct(id: string, updates: Partial<InsertProduct>): Promise<Product | undefined>;
  deleteProduct(id: string): Promise<boolean>;
  
  // Stock movement operations
  getStockMovementsByProduct(productId: string): Promise<StockMovement[]>;
  createStockMovement(movement: InsertStockMovement): Promise<StockMovement>;

  // Transaction items (multi-product, Task #475)
  getTransactionItems(transactionId: string): Promise<TransactionItem[]>;
  getTransactionItemsByTransactionIds(transactionIds: string[]): Promise<TransactionItem[]>;
  createTransactionItems(items: InsertTransactionItem[]): Promise<TransactionItem[]>;
  deleteTransactionItems(transactionId: string): Promise<void>;

  // Quote items (productos/servicios, Task #481)
  getQuoteItems(quoteId: string): Promise<QuoteItem[]>;
  getQuoteItemsByQuoteIds(quoteIds: string[]): Promise<QuoteItem[]>;
  createQuoteItems(items: InsertQuoteItem[]): Promise<QuoteItem[]>;
  deleteQuoteItems(quoteId: string): Promise<void>;

  // Profitability code operations
  getProfitabilityCodesByOrganization(organizationId: string, activeOnly?: boolean, includeArchived?: boolean): Promise<ProfitabilityCode[]>;
  deleteProfitabilityCode(id: string): Promise<boolean>; // Task #363 hard delete
  archiveProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined>; // Task #363
  unarchiveProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined>; // Task #363
  getProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined>;
  findProfitabilityCodeByCode(organizationId: string, code: string): Promise<ProfitabilityCode | undefined>;
  createProfitabilityCode(code: InsertProfitabilityCode): Promise<ProfitabilityCode>;
  updateProfitabilityCode(id: string, updates: Partial<InsertProfitabilityCode>): Promise<ProfitabilityCode | undefined>;

  // Payment methods (Task #229)
  getPaymentMethodsByOrganization(organizationId: string, activeOnly?: boolean): Promise<PaymentMethodWithConcepts[]>;
  getPaymentMethodWithConcepts(id: string): Promise<PaymentMethodWithConcepts | undefined>;
  createPaymentMethodWithConcepts(
    method: InsertPaymentMethod,
    concepts: Omit<InsertPaymentMethodConcept, 'paymentMethodId'>[],
  ): Promise<PaymentMethodWithConcepts>;
  updatePaymentMethodWithConcepts(
    id: string,
    updates: Partial<InsertPaymentMethod>,
    concepts?: Omit<InsertPaymentMethodConcept, 'paymentMethodId'>[],
  ): Promise<PaymentMethodWithConcepts | undefined>;
  deletePaymentMethod(id: string): Promise<boolean>;
  /** Atomically create a parent income/receivable plus one child cost
   *  transaction per concept, all linked via linkedTransactionId. Account
   *  balance is updated for completed parents/children. Returns the parent
   *  and the list of created children. */
  createTransactionWithPaymentMethodChildren(
    parent: InsertTransaction,
    paymentMethod: PaymentMethodWithConcepts,
    options: {
      childTransactionNumbers: string[]; // pre-generated, one per concept
    },
  ): Promise<{ parent: Transaction; children: Transaction[] }>;
  /** Returns the auto-generated payable children of a parent transaction
   *  (filtered by parent.paymentMethodId IS NOT NULL for safety). */
  getPaymentMethodChildren(parentId: string): Promise<Transaction[]>;
  /** Propagates a payment received against a parent receivable to its
   *  payable children. ratio is the fraction of the parent that was just
   *  collected (0 < ratio <= 1). When ratio === 1 (full collection) children
   *  are marked completed and account balance is updated. When ratio < 1
   *  children's amounts are reduced proportionally and remain pending. */
  propagateCollectionToPaymentMethodChildren(
    parentId: string,
    ratio: number,
    userId: string,
    triggeredByTransactionId: string,
  ): Promise<{ updatedChildren: Transaction[]; completedChildren: Transaction[] }>;
  
  // Audit log operations
  createAuditLog(log: InsertAuditLog): Promise<AuditLog>;
  getAuditLogsByEntity(entityType: string, entityId: string): Promise<AuditLog[]>;
  getAuditLogsByOrganization(organizationId: string, limit?: number): Promise<AuditLog[]>;
  
  // Asset operations
  getAssetsByOrganization(organizationId: string, activeOnly?: boolean): Promise<Asset[]>;
  getAsset(id: string): Promise<Asset | undefined>;
  createAsset(asset: InsertAsset): Promise<Asset>;
  updateAsset(id: string, updates: Partial<InsertAsset>): Promise<Asset | undefined>;
  deleteAsset(id: string): Promise<boolean>;
  
  // Investment operations
  getInvestmentsByOrganization(organizationId: string, activeOnly?: boolean): Promise<Investment[]>;
  getInvestment(id: string): Promise<Investment | undefined>;
  createInvestment(investment: InsertInvestment): Promise<Investment>;
  updateInvestment(id: string, updates: Partial<InsertInvestment>): Promise<Investment | undefined>;
  deleteInvestment(id: string): Promise<boolean>;
  
  // Team invitation operations
  getTeamInvitationsByOrganization(organizationId: string, status?: string): Promise<TeamInvitation[]>;
  getTeamInvitation(id: string): Promise<TeamInvitation | undefined>;
  getTeamInvitationByEmail(email: string): Promise<TeamInvitation | undefined>;
  createTeamInvitation(invitation: InsertTeamInvitation): Promise<TeamInvitation>;
  updateTeamInvitation(id: string, updates: Partial<InsertTeamInvitation>): Promise<TeamInvitation | undefined>;
  deleteTeamInvitation(id: string): Promise<boolean>;
  
  // Subscription operations
  getSubscriptionByUserId(userId: string): Promise<Subscription | undefined>;
  // Devuelve TODAS las filas de suscripciones (sin deduplicar por usuario) para
  // calcular churn/LTV sobre el historial completo de ciclos de vida.
  getAllSubscriptions(): Promise<Subscription[]>;
  // Devuelve un mapa de precios de Stripe (id -> monto/moneda/recurrencia)
  // para resolver el MRR. El esquema `stripe` vive fuera de Drizzle, por eso
  // se consulta con SQL crudo. Usado por el panel ADMIN para MRR/ARR/ARPU
  // sobre la suscripción canónica de cada usuario.
  getStripePriceMap(): Promise<Map<string, { unitAmount: number | null; currency: string | null; recurring: { interval?: string; interval_count?: number } | null }>>;
  getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | undefined>;
  updateSubscription(id: string, data: Partial<InsertSubscription>): Promise<Subscription>;
  createSubscription(data: InsertSubscription): Promise<Subscription>;
  upsertSubscriptionByStripeId(
    stripeSubscriptionId: string,
    userId: string,
    data: Partial<InsertSubscription>,
  ): Promise<Subscription>;
  
  // Counting operations for plan limits
  countOrganizationsByUser(userId: string): Promise<number>;
  countOwnedOrganizationsByUser(userId: string): Promise<number>;
  countMembersByOrganization(organizationId: string): Promise<number>;
  countPendingInvitationsByOrganization(organizationId: string): Promise<number>;
  
  // Transaction category operations
  getTransactionCategoriesByOrganization(organizationId: string, type?: 'income' | 'expense', includeArchived?: boolean): Promise<TransactionCategory[]>;
  getTransactionCategory(id: string): Promise<TransactionCategory | undefined>;
  createTransactionCategory(category: InsertTransactionCategory): Promise<TransactionCategory>;
  updateTransactionCategory(id: string, updates: Partial<InsertTransactionCategory>): Promise<TransactionCategory | undefined>;
  deleteTransactionCategory(id: string): Promise<boolean>;
  archiveTransactionCategory(id: string): Promise<TransactionCategory | undefined>; // Task #363
  unarchiveTransactionCategory(id: string): Promise<TransactionCategory | undefined>; // Task #363
  seedDefaultCategories(organizationId: string, createdBy?: string): Promise<TransactionCategory[]>;
  seedDefaultAccount(organizationId: string, currency: string): Promise<Account>;
  
  // Access denied events operations
  createAccessDeniedEvent(event: InsertAccessDeniedEvent): Promise<AccessDeniedEvent>;
  getAccessDeniedEventByEmail(email: string): Promise<AccessDeniedEvent | undefined>;
  acknowledgeAccessDeniedEvent(id: string): Promise<boolean>;
  
  // Pending signup operations
  createPendingSignup(signup: InsertPendingSignup): Promise<PendingSignup>;
  getPendingSignup(id: string): Promise<PendingSignup | undefined>;
  getPendingSignupByEmail(email: string): Promise<PendingSignup | undefined>;
  getPendingSignupByStripeSessionId(sessionId: string): Promise<PendingSignup | undefined>;
  updatePendingSignup(id: string, updates: Partial<InsertPendingSignup>): Promise<PendingSignup | undefined>;
  deletePendingSignup(id: string): Promise<boolean>;
  deleteExpiredPendingSignups(): Promise<number>;
  
  // Admin operations
  getAllUsers(): Promise<User[]>;
  isUserAdmin(userId: string): Promise<boolean>;
  getAdminEmails(): Promise<string[]>;
  
  // Session log operations
  createSessionLog(log: InsertSessionLog): Promise<SessionLog>;
  getSessionLogsByUser(userId: string, limit?: number): Promise<SessionLog[]>;
  getAllSessionLogs(limit?: number): Promise<SessionLog[]>;

  // MRR snapshots (admin panel — evolución del MRR)
  upsertMrrSnapshot(snapshot: InsertMrrSnapshot): Promise<MrrSnapshot>;
  getMrrSnapshots(limit?: number): Promise<MrrSnapshot[]>;

  // Account deletions log (admin panel — bajas automáticas)
  recordAccountDeletion(deletion: InsertAccountDeletion): Promise<AccountDeletion>;
  getAccountDeletions(limit?: number): Promise<AccountDeletion[]>;
  countAccountDeletions(reason?: AccountDeletionReason): Promise<number>;

  // System errors (admin panel)
  recordSystemError(error: InsertSystemError): Promise<SystemError>;
  getSystemErrors(status?: string, limit?: number): Promise<SystemError[]>;
  getSystemError(id: string): Promise<SystemError | undefined>;
  updateSystemErrorStatus(id: string, status: 'open' | 'resolved' | 'archived', resolvedBy: string | null): Promise<SystemError | undefined>;
  
  // Chat message operations (persistent AI conversation history per user per organization)
  getChatMessagesByOrganization(organizationId: string, limit?: number, userId?: string): Promise<ChatMessage[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;
  clearChatHistory(organizationId: string, userId: string): Promise<boolean>;
  
  // Notification operations
  getNotificationsByUser(userId: string, organizationId?: string, includeRead?: boolean): Promise<Notification[]>;
  getUnreadNotificationCount(userId: string, organizationId?: string): Promise<number>;
  createNotification(notification: InsertNotification): Promise<Notification>;
  markNotificationRead(id: string): Promise<Notification | undefined>;
  markAllNotificationsRead(userId: string, organizationId?: string): Promise<number>;
  deleteNotification(id: string): Promise<boolean>;
  deleteOldNotifications(daysOld: number): Promise<number>;
  markInvoiceEmailFailureNotificationsRead(transactionId: string): Promise<number>;

  findInvoiceEmailsDueForRetry(opts: { maxRetries: number; backoffMinutes: number[]; limit?: number }): Promise<Transaction[]>;

  getWhatsappPreferences(userId: string, organizationId: string): Promise<WhatsappPreferences | undefined>;
  upsertWhatsappPreferences(userId: string, organizationId: string, updates: Partial<InsertWhatsappPreferences>): Promise<WhatsappPreferences>;

  getDashboardPreferences(userId: string, organizationId: string): Promise<DashboardPreferences | undefined>;
  upsertDashboardPreferences(userId: string, organizationId: string, updates: Partial<InsertDashboardPreferences>): Promise<DashboardPreferences>;
  getClientInvoiceEmailPrefs(clientId: string): Promise<ClientInvoiceEmailPrefs | undefined>;
  upsertClientInvoiceEmailPrefs(organizationId: string, clientId: string, updates: { defaultCcEmails: string[]; sendCopyToSelf: boolean }): Promise<ClientInvoiceEmailPrefs>;
  getSupplierInvoiceEmailPrefs(supplierId: string): Promise<SupplierInvoiceEmailPrefs | undefined>;
  upsertSupplierInvoiceEmailPrefs(organizationId: string, supplierId: string, updates: { defaultCcEmails: string[]; sendCopyToSelf: boolean }): Promise<SupplierInvoiceEmailPrefs>;

  // Invoicing (Facturita)
  getInvoicingAccount(organizationId: string): Promise<InvoicingAccount | undefined>;
  upsertInvoicingAccount(organizationId: string, data: Partial<InsertInvoicingAccount>): Promise<InvoicingAccount>;
  getSellingPointsByOrganization(organizationId: string): Promise<InvoicingSellingPoint[]>;
  replaceSellingPoints(organizationId: string, items: Array<{ number: number; description?: string | null; isActive?: boolean }>): Promise<InvoicingSellingPoint[]>;
  getEmittedInvoicesByOrganization(organizationId: string, filters?: { startDate?: string; endDate?: string; environment?: string; status?: string; clientId?: string; docType?: string; emitterCuit?: string }): Promise<Array<Transaction & { clientName: string | null; clientTaxId: string | null }>>;

  // Business settings (singleton) — panel admin
  getBusinessSettings(): Promise<BusinessSettings | undefined>;
  upsertBusinessSettings(values: UpdateBusinessSettings, updatedBy: string | null): Promise<BusinessSettings>;
  getAcquisitionSpends(): Promise<AcquisitionSpend[]>;
  upsertAcquisitionSpend(values: UpsertAcquisitionSpend, updatedBy: string | null): Promise<AcquisitionSpend>;
  deleteAcquisitionSpend(month: string): Promise<void>;
  upsertAcquisitionConfig(values: UpdateAcquisitionConfig, updatedBy: string | null): Promise<BusinessSettings>;
  getAllOrganizations(): Promise<Organization[]>;
}

export class DatabaseStorage implements IStorage {
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    // Task #343 — IMPORTANTE: este método puede devolver usuarios soft-deleted
    // (deleted_at != null). Es intencional: el middleware de auth, el flujo
    // de login y otros lugares lo usan para detectar cuentas eliminadas y
    // mostrar el mensaje correspondiente (ACCOUNT_DELETED).
    //
    // A partir de Task #343 puede haber MÚLTIPLES filas con el mismo email
    // (una soft-deleted + una activa) porque el índice único es parcial
    // (WHERE deleted_at IS NULL). Para evitar no-determinismo en lookups
    // ambiguos, ordenamos por deletedAt NULLS FIRST (activos primero) y
    // luego por createdAt DESC (el más reciente). Para flujos donde sólo
    // interesa el usuario activo, usar `getUserByActiveEmail`.
    const normalized = email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalized}`)
      .orderBy(sql`${users.deletedAt} NULLS FIRST, ${users.createdAt} DESC`)
      .limit(1);
    return user;
  }

  // Task #343 — Lookup que ignora soft-deleted. Usar en cualquier flujo de
  // registro / re-suscripción / invitación / recovery donde "usuario existente"
  // signifique "usuario activo". El partial unique index garantiza que esto
  // siempre devuelva 0 o 1 fila.
  async getUserByActiveEmail(email: string): Promise<User | undefined> {
    const normalized = email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalized} AND ${users.deletedAt} IS NULL`)
      .limit(1);
    return user;
  }

  async getUserByPhone(phoneNumber: string): Promise<User | undefined> {
    if (!phoneNumber) return undefined;
    const candidates = arPhoneCandidates(phoneNumber);
    if (candidates.length === 0) return undefined;

    const matches = await db
      .select()
      .from(users)
      .where(inArray(users.phoneNumber, candidates));

    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];

    // Ambiguity: more than one user maps to the same logical phone (e.g. one stored
    // legacy '+5411...' and another canonical '+54911...'). Refuse to pick — returning
    // the wrong identity here would route WhatsApp messages to the wrong account.
    const ids = matches.map(m => m.id);
    console.warn(
      `[getUserByPhone] Ambiguous lookup for "${phoneNumber}" matched ${matches.length} users (${ids.join(', ')}). Returning undefined to avoid mis-routing.`
    );
    return undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const normalized: InsertUser & { phoneNumberAddedAt?: Date | null } = {
      ...insertUser,
      email: insertUser.email.toLowerCase().trim(),
    };
    // Task #219: stamp phone_number_added_at when a user is created with an
    // unverified phoneNumber (the only path today is signup, which never
    // marks `phoneVerified=true`). The dashboard banner uses this to detect
    // the "abandoned wizard" case after 24h.
    if (insertUser.phoneNumber && !insertUser.phoneVerified) {
      normalized.phoneNumberAddedAt = new Date();
    }
    const [user] = await db.insert(users).values(normalized).returning();
    return user;
  }

  async updateUser(id: string, updates: UserUpdate): Promise<User | undefined> {
    // Task #219: future-proof — when a caller assigns a phoneNumber to a user
    // who previously had none (and doesn't mark it verified or supply its own
    // timestamp), stamp `phoneNumberAddedAt` so the dashboard reminder banner
    // timing stays consistent across all code paths (signup, potential admin
    // tools, future "add WhatsApp from Settings" flow, etc.). We deliberately
    // only stamp on the no-phone -> has-phone transition: callers that merely
    // re-canonicalize an existing phone (e.g. WhatsApp inbound lazy-migration)
    // must NOT have their timestamp reset, which would silently delay the
    // banner by another 24h.
    const normalized: UserUpdate & { phoneNumberAddedAt?: Date | null } = { ...updates };
    const setsPhone =
      Object.prototype.hasOwnProperty.call(updates, 'phoneNumber') &&
      !!updates.phoneNumber;
    const setsAddedAt = Object.prototype.hasOwnProperty.call(
      updates,
      'phoneNumberAddedAt',
    );
    const explicitlyVerified = updates.phoneVerified === true;
    if (setsPhone && !explicitlyVerified && !setsAddedAt) {
      const [existing] = await db
        .select({ phoneNumber: users.phoneNumber })
        .from(users)
        .where(eq(users.id, id));
      if (existing && !existing.phoneNumber) {
        normalized.phoneNumberAddedAt = new Date();
      }
    }
    const [user] = await db.update(users).set(normalized).where(eq(users.id, id)).returning();
    return user;
  }

  async getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, stripeCustomerId));
    return user;
  }

  async deleteUser(id: string): Promise<boolean> {
    // Delete user's memberships first
    await db.delete(memberships).where(eq(memberships.userId, id));
    const result = await db.delete(users).where(eq(users.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Organization operations
  async getOrganization(id: string): Promise<Organization | undefined> {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, id));
    return org;
  }

  async getOrganizationsByUser(userId: string): Promise<(Organization & { membershipRole: string })[]> {
    const result = await db
      .select({ 
        organization: organizations,
        role: memberships.role 
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, userId));
    return result.map(r => ({ ...r.organization, membershipRole: r.role }));
  }

  async createOrganization(insertOrg: InsertOrganization): Promise<Organization> {
    const [org] = await db.insert(organizations).values(insertOrg).returning();
    return org;
  }

  async updateOrganization(id: string, updates: Partial<InsertOrganization>): Promise<Organization | undefined> {
    const [org] = await db.update(organizations).set(updates).where(eq(organizations.id, id)).returning();
    return org;
  }

  async deleteOrganization(id: string): Promise<boolean> {
    // Delete all related data first (memberships, accounts, transactions)
    await db.delete(transactions).where(eq(transactions.organizationId, id));
    await db.delete(accounts).where(eq(accounts.organizationId, id));
    await db.delete(memberships).where(eq(memberships.organizationId, id));
    const result = await db.delete(organizations).where(eq(organizations.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async incrementTransactionCounter(organizationId: string): Promise<number> {
    // Atomic increment using SQL - returns the NEW value after increment
    const [result] = await db
      .update(organizations)
      .set({ 
        transactionCounter: sql`${organizations.transactionCounter} + 1`
      })
      .where(eq(organizations.id, organizationId))
      .returning({ newCounter: organizations.transactionCounter });
    return result?.newCounter || 1;
  }

  // Membership operations
  async createMembership(insertMembership: InsertMembership): Promise<Membership> {
    const [membership] = await db.insert(memberships).values(insertMembership).returning();
    return membership;
  }

  async getMembershipByUserAndOrg(userId: string, organizationId: string): Promise<Membership | undefined> {
    const [membership] = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
    return membership;
  }

  async getMembersByOrganization(organizationId: string): Promise<Array<{ user: User; membership: Membership }>> {
    const result = await db
      .select({ user: users, membership: memberships })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.organizationId, organizationId));
    return result;
  }

  async getOrganizationOwner(organizationId: string): Promise<User | undefined> {
    const result = await db
      .select({ user: users })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, 'owner')
      ))
      .limit(1);
    return result[0]?.user;
  }

  async updateMembershipRole(membershipId: string, role: string): Promise<Membership | undefined> {
    const [membership] = await db
      .update(memberships)
      .set({ role })
      .where(eq(memberships.id, membershipId))
      .returning();
    return membership;
  }

  async deleteMembership(id: string): Promise<boolean> {
    const result = await db.delete(memberships).where(eq(memberships.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Account operations
  async getAccountsByOrganization(organizationId: string): Promise<Account[]> {
    return await db.select().from(accounts).where(eq(accounts.organizationId, organizationId));
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
    return account;
  }

  async createAccount(insertAccount: InsertAccount): Promise<Account> {
    const dbValues = {
      ...insertAccount,
      maturityDate: insertAccount.maturityDate ? new Date(insertAccount.maturityDate as string | Date) : insertAccount.maturityDate,
    };
    const [account] = await db.insert(accounts).values(dbValues as any).returning();
    return account;
  }

  async updateAccount(id: string, updates: Partial<InsertAccount>): Promise<Account | undefined> {
    const dbUpdates = {
      ...updates,
      ...(updates.maturityDate !== undefined ? { maturityDate: updates.maturityDate ? new Date(updates.maturityDate as string | Date) : updates.maturityDate } : {}),
    };
    const [account] = await db.update(accounts).set(dbUpdates as any).where(eq(accounts.id, id)).returning();
    return account;
  }

  async deleteAccount(id: string): Promise<boolean> {
    const result = await db.delete(accounts).where(eq(accounts.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Transaction operations
  async getTransactionsByOrganization(organizationId: string, status?: 'completed' | 'scheduled', options?: { limit?: number; offset?: number; startDate?: string; endDate?: string; includeCancelled?: boolean; dateField?: 'date' | 'imputation'; categories?: string[] }): Promise<Transaction[]> {
    const conditions: any[] = [eq(transactions.organizationId, organizationId)];

    // Task #250: filtro opcional por categoría. Cuando el array está vacío,
    // se inyecta una condición imposible para devolver 0 filas (consistente
    // con la semántica "ninguna categoría seleccionada → ningún match").
    if (options?.categories) {
      if (options.categories.length === 0) {
        conditions.push(sql`false`);
      } else {
        conditions.push(inArray(transactions.category, options.categories));
      }
    }

    if (status === 'completed') {
      // 'completed' returns ONLY completed transactions by default. Callers that
      // also want cancelled transactions in the same list must opt in explicitly
      // via `includeCancelled: true` (e.g. the GET /api/transactions list view).
      if (options?.includeCancelled) {
        conditions.push(inArray(transactions.status, ['completed', 'cancelled']));
      } else {
        conditions.push(eq(transactions.status, 'completed'));
      }
    } else if (status === 'scheduled') {
      // Schema only allows 'scheduled' | 'completed' | 'cancelled'; the legacy
      // 'pending' value never exists in the DB.
      conditions.push(eq(transactions.status, 'scheduled'));
    }

    // When filtering by the accounting/imputation date we use
    // COALESCE(imputation_date, date). The schema marks imputation_date as
    // NOT NULL today, but legacy rows from before the column existed (or any
    // future hot-fix that nullifies it) would otherwise be silently dropped
    // from calendar buckets. The fallback mirrors the in-memory
    // `effectiveDate = imputationDate || date` used by the route.
    const dateExpr: SQL<unknown> = options?.dateField === 'imputation'
      ? sql`COALESCE(${transactions.imputationDate}, ${transactions.date})`
      : sql`${transactions.date}`;
    if (options?.startDate) {
      conditions.push(gte(dateExpr, new Date(options.startDate)));
    }
    if (options?.endDate) {
      const endDate = new Date(options.endDate);
      // For date-only inputs ("YYYY-MM-DD") we widen to end-of-day. For full
      // ISO timestamps we trust the caller's bounds verbatim — callers like the
      // calendar endpoint already encode the correct Argentina-local end-of-day
      // instant and we must not push it forward by another 24h.
      const isDateOnly = typeof options.endDate === 'string' && !options.endDate.includes('T');
      if (isDateOnly) {
        endDate.setHours(23, 59, 59, 999);
      }
      conditions.push(lte(dateExpr, endDate));
    }

    const orderDir = status === 'scheduled' ? asc(transactions.date) : desc(transactions.date);

    let query = db
      .select()
      .from(transactions)
      .where(and(...conditions))
      .orderBy(orderDir);

    if (options?.limit) {
      query = query.limit(options.limit) as any;
    }
    if (options?.offset) {
      query = query.offset(options.offset) as any;
    }

    return await query;
  }

  async getScheduledTransactions(organizationId: string): Promise<Transaction[]> {
    return await db
      .select()
      .from(transactions)
      .where(and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.status, 'scheduled')
      ))
      .orderBy(asc(transactions.date));
  }

  async promoteScheduledTransactions(organizationId: string): Promise<Transaction[]> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    
    const dueTransactions = await db
      .select()
      .from(transactions)
      .where(and(
        eq(transactions.organizationId, organizationId),
        eq(transactions.status, 'scheduled'),
        lte(transactions.date, now),
        not(inArray(transactions.type, ['payable', 'receivable']))
      ));
    
    const promoted: Transaction[] = [];
    
    for (const tx of dueTransactions) {
      const [updated] = await db
        .update(transactions)
        .set({ status: 'completed' })
        .where(eq(transactions.id, tx.id))
        .returning();
      
      if (updated && updated.accountId) {
        const amount = parseFloat(updated.amount);
        const isPositive = updated.type === 'income' || updated.type === 'receivable';
        const delta = isPositive ? amount : -amount;
        await db.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
          .where(eq(accounts.id, updated.accountId));
      }
      
      if (updated) {
        promoted.push(updated);
      }
    }
    
    return promoted;
  }

  async getTransaction(id: string): Promise<Transaction | undefined> {
    const [transaction] = await db.select().from(transactions).where(eq(transactions.id, id));
    return transaction;
  }

  async getTransactionCountByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(transactions)
      .where(eq(transactions.organizationId, organizationId));
    return result?.count || 0;
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    if ((insertTransaction.type === 'expense' || insertTransaction.type === 'payable') && !insertTransaction.expenseSubtype && insertTransaction.category && insertTransaction.organizationId) {
      const cats = await this.getTransactionCategoriesByOrganization(insertTransaction.organizationId, 'expense');
      const matched = cats.find(c => c.name === insertTransaction.category);
      if (matched?.expenseSubtype) {
        insertTransaction = { ...insertTransaction, expenseSubtype: matched.expenseSubtype };
      } else {
        insertTransaction = { ...insertTransaction, expenseSubtype: 'expense' };
      }
    }
    const [transaction] = await db.insert(transactions).values(insertTransaction).returning();
    
    if (transaction.status === 'completed' && transaction.accountId) {
      const amount = parseFloat(transaction.amount);
      const isPositive = transaction.type === 'income' || transaction.type === 'transfer_in' || transaction.type === 'receivable';
      const delta = isPositive ? amount : -amount;
      await db.update(accounts)
        .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
        .where(eq(accounts.id, transaction.accountId));
    }
    
    return transaction;
  }

  async updateTransaction(id: string, updates: Partial<InsertTransaction>): Promise<Transaction | undefined> {
    if ((updates.type || updates.category) && !updates.expenseSubtype) {
      const existing = await this.getTransaction(id);
      if (existing) {
        const finalType = updates.type || existing.type;
        const finalCategory = updates.category || existing.category;
        if (finalType === 'expense' || finalType === 'payable') {
          const cats = await this.getTransactionCategoriesByOrganization(existing.organizationId, 'expense');
          const matched = cats.find(c => c.name === finalCategory);
          updates = { ...updates, expenseSubtype: matched?.expenseSubtype || 'expense' };
        } else if (existing.expenseSubtype && finalType !== 'expense' && finalType !== 'payable') {
          updates = { ...updates, expenseSubtype: null };
        }
      }
    }
    const [transaction] = await db.update(transactions).set(updates).where(eq(transactions.id, id)).returning();
    return transaction;
  }

  async deleteTransaction(id: string): Promise<{ deleted: boolean; cancellationId?: string }> {
    const transaction = await this.getTransaction(id);
    if (!transaction) return { deleted: false };
    
    const isPending = (transaction.type === 'payable' || transaction.type === 'receivable') && 
                      transaction.status !== 'completed';
    
    let cancellationId: string | undefined;
    
    if (!isPending && transaction.status === 'completed') {
      const now = new Date();
      const inverseTypeMap: Record<string, string> = {
        income: 'expense', expense: 'income',
        receivable: 'payable', payable: 'receivable',
        transfer_in: 'transfer_out', transfer_out: 'transfer_in',
      };
      const inverseType = inverseTypeMap[transaction.type] || 'expense';
      
      const cleanDescription = transaction.description.replace(/^\[CANCELADO\]\s*/, '').replace(/^\[CANCELACIÓN\]\s*/, '');
      
      const originalData = {
        id: transaction.id,
        type: transaction.type,
        amount: transaction.amount,
        description: cleanDescription,
        category: transaction.category,
        date: transaction.date,
        imputationDate: transaction.imputationDate,
        hasInvoice: transaction.hasInvoice,
        invoiceType: transaction.invoiceType,
        invoiceNumber: transaction.invoiceNumber,
        invoiceFileUrl: transaction.invoiceFileUrl,
        transactionNumber: transaction.transactionNumber,
        clientId: transaction.clientId,
        supplierId: transaction.supplierId,
      };
      
      await db.transaction(async (tx) => {
        const [cancellation] = await tx.insert(transactions).values({
          type: inverseType,
          amount: transaction.amount,
          description: `[CANCELACIÓN] ${cleanDescription}`,
          category: transaction.category,
          date: now,
          imputationDate: now,
          accountId: transaction.accountId,
          organizationId: transaction.organizationId,
          createdBy: transaction.createdBy,
          clientId: null,
          supplierId: null,
          currency: transaction.currency,
          projectId: transaction.projectId,
          expenseSubtype: transaction.expenseSubtype,
          hasInvoice: false,
          status: 'completed',
          assetType: (transaction.type === 'transfer_in' || transaction.type === 'transfer_out') ? 'transfer' : (transaction.type === 'income' ? 'expense' : 'income'),
          originalTransactionData: JSON.stringify(originalData),
        }).returning();
        
        cancellationId = cancellation.id;
        console.log(`[DELETE TX] Created cancellation id=${cancellationId} for original id=${id} type=${transaction.type} currency=${transaction.currency} amount=${transaction.amount}`);
        
        if (transaction.accountId) {
          const amount = parseFloat(transaction.amount);
          const wasPositive = transaction.type === 'income' || transaction.type === 'transfer_in' || transaction.type === 'receivable';
          const delta = wasPositive ? -amount : amount;
          await tx.update(accounts)
            .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
            .where(eq(accounts.id, transaction.accountId));
          console.log(`[DELETE TX] Adjusted account ${transaction.accountId} balance by ${delta}`);
        }
      });
    }
    
    // If recurring, delete auto-generated next scheduled instance
    if (transaction.isRecurring && transaction.recurrenceFrequency) {
      const cleanDesc = transaction.description.replace(/^\[CANCELADO\]\s*/, '').replace(/^\[CANCELACIÓN\]\s*/, '');
      const conditions = [
        eq(transactions.organizationId, transaction.organizationId),
        eq(transactions.type, transaction.type),
        eq(transactions.status, 'scheduled'),
        eq(transactions.isRecurring, true),
      ];
      if (transaction.accountId) {
        conditions.push(eq(transactions.accountId, transaction.accountId));
      }
      const scheduledNext = await db.select().from(transactions).where(and(...conditions));
      
      const matchingNext = scheduledNext.filter(t => {
        const tDesc = (t.description || '').replace(/^\[CANCELADO\]\s*/, '').replace(/^\[CANCELACIÓN\]\s*/, '');
        return tDesc === cleanDesc && parseFloat(t.amount) === parseFloat(transaction.amount);
      });
      
      if (matchingNext.length > 0) {
        const nextInstance = matchingNext.sort((a, b) => 
          new Date(a.date).getTime() - new Date(b.date).getTime()
        )[0];
        console.log(`[DELETE TX] Also deleting auto-generated next recurring instance: id=${nextInstance.id}, date=${nextInstance.date}, desc=${nextInstance.description}`);
        await db.delete(transactions).where(eq(transactions.id, nextInstance.id));
      }
    }
    
    // Delete the original transaction
    await db.delete(transactions).where(eq(transactions.id, id));
    
    return { deleted: true, cancellationId };
  }
  
  // Password reset operations
  async createPasswordReset(data: { userId: string; token: string; expiresAt: Date }): Promise<PasswordReset> {
    const [reset] = await db.insert(passwordResets).values(data).returning();
    return reset;
  }
  
  async getPasswordResets(userId: string): Promise<PasswordReset[]> {
    return await db.select().from(passwordResets).where(eq(passwordResets.userId, userId));
  }
  
  async markPasswordResetUsed(id: string): Promise<boolean> {
    const result = await db.update(passwordResets).set({ used: true }).where(eq(passwordResets.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
  
  // Client operations
  async getClientsByOrganization(organizationId: string, activeOnly: boolean = false, includeArchived: boolean = false): Promise<Client[]> {
    const conds: any[] = [eq(clients.organizationId, organizationId)];
    if (activeOnly) {
      conds.push(eq(clients.isActive, true));
      conds.push(sql`(${clients.status} IS NULL OR ${clients.status} != 'inactive')`);
    }
    if (!includeArchived) conds.push(isNull(clients.archivedAt)); // Task #363
    return await db.select().from(clients).where(and(...conds)).orderBy(clients.name);
  }

  // Task #363: archive/unarchive
  async archiveClient(id: string): Promise<Client | undefined> {
    const [row] = await db.update(clients)
      .set({ archivedAt: new Date(), isActive: false, status: 'inactive', updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    return row;
  }
  async unarchiveClient(id: string): Promise<Client | undefined> {
    const [row] = await db.update(clients)
      .set({ archivedAt: null, isActive: true, status: 'active', updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    return row;
  }

  async getClient(id: string): Promise<Client | undefined> {
    const [client] = await db.select().from(clients).where(eq(clients.id, id));
    return client;
  }

  async createClient(insertClient: InsertClient): Promise<Client> {
    const values = { ...insertClient } as InsertClient & { isActive?: boolean };
    if (values.status !== undefined && values.isActive === undefined) {
      values.isActive = values.status !== 'inactive';
    }
    const [client] = await db.insert(clients).values(values).returning();
    return client;
  }

  async updateClient(id: string, updates: Partial<InsertClient>): Promise<Client | undefined> {
    const syncedUpdates: Partial<InsertClient> & { updatedAt: Date } = { ...updates, updatedAt: new Date() };
    if (updates.status !== undefined) {
      syncedUpdates.isActive = updates.status !== 'inactive';
    } else if (updates.isActive !== undefined) {
      syncedUpdates.status = updates.isActive ? 'active' : 'inactive';
    }
    const [client] = await db.update(clients).set(syncedUpdates).where(eq(clients.id, id)).returning();
    return client;
  }

  async deleteClient(id: string): Promise<boolean> {
    const result = await db.delete(clients).where(eq(clients.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Quote (presupuesto) operations
  async getQuotesByOrganization(organizationId: string, status?: string): Promise<Quote[]> {
    const conds: any[] = [eq(quotes.organizationId, organizationId)];
    if (status) conds.push(eq(quotes.status, status));
    return await db.select().from(quotes).where(and(...conds)).orderBy(desc(quotes.date), desc(quotes.createdAt));
  }

  async getQuote(id: string): Promise<Quote | undefined> {
    const [row] = await db.select().from(quotes).where(eq(quotes.id, id));
    return row;
  }

  async createQuote(insertQuote: InsertQuote): Promise<Quote> {
    const [row] = await db.insert(quotes).values(insertQuote as any).returning();
    return row;
  }

  async updateQuote(id: string, updates: Partial<InsertQuote>): Promise<Quote | undefined> {
    const [row] = await db.update(quotes)
      .set({ ...updates, updatedAt: new Date() } as any)
      .where(eq(quotes.id, id))
      .returning();
    return row;
  }

  async deleteQuote(id: string): Promise<boolean> {
    const result = await db.delete(quotes).where(eq(quotes.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Conditional on status='pending' so a quote can never be won twice (atomic
  // guard against duplicate movements on retries / concurrent requests).
  async markQuoteWon(id: string, transactionId: string): Promise<Quote | undefined> {
    const [row] = await db.update(quotes)
      .set({ status: 'won', linkedTransactionId: transactionId, wonAt: new Date(), lostAt: null, updatedAt: new Date() })
      .where(and(eq(quotes.id, id), eq(quotes.status, 'pending')))
      .returning();
    return row;
  }

  // Only a pending quote can be lost; clears any won-derived fields.
  async markQuoteLost(id: string): Promise<Quote | undefined> {
    const [row] = await db.update(quotes)
      .set({ status: 'lost', lostAt: new Date(), wonAt: null, linkedTransactionId: null, updatedAt: new Date() })
      .where(and(eq(quotes.id, id), eq(quotes.status, 'pending')))
      .returning();
    return row;
  }

  // Only a lost quote can be reopened; resets to a clean pending state.
  async reopenQuote(id: string): Promise<Quote | undefined> {
    const [row] = await db.update(quotes)
      .set({ status: 'pending', wonAt: null, lostAt: null, linkedTransactionId: null, updatedAt: new Date() })
      .where(and(eq(quotes.id, id), eq(quotes.status, 'lost')))
      .returning();
    return row;
  }

  // Subscription plan operations
  async getSubscriptionPlans(organizationId: string, activeOnly: boolean = false): Promise<SubscriptionPlan[]> {
    const where = activeOnly
      ? and(eq(subscriptionPlans.organizationId, organizationId), eq(subscriptionPlans.isActive, true))
      : eq(subscriptionPlans.organizationId, organizationId);
    return await db.select().from(subscriptionPlans).where(where).orderBy(subscriptionPlans.name);
  }

  async getSubscriptionPlan(id: string, organizationId?: string): Promise<SubscriptionPlan | undefined> {
    const where = organizationId
      ? and(eq(subscriptionPlans.id, id), eq(subscriptionPlans.organizationId, organizationId))
      : eq(subscriptionPlans.id, id);
    const [plan] = await db.select().from(subscriptionPlans).where(where);
    return plan;
  }

  async createSubscriptionPlan(insertPlan: InsertSubscriptionPlan): Promise<SubscriptionPlan> {
    const [plan] = await db.insert(subscriptionPlans).values(insertPlan).returning();
    return plan;
  }

  async updateSubscriptionPlan(id: string, updates: Partial<InsertSubscriptionPlan>): Promise<SubscriptionPlan | undefined> {
    const [plan] = await db.update(subscriptionPlans)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(subscriptionPlans.id, id))
      .returning();
    return plan;
  }

  async deleteSubscriptionPlan(id: string): Promise<boolean> {
    // Detach any clients referencing this plan before deletion
    await db.update(clients)
      .set({ subscriberPlanId: null, updatedAt: new Date() })
      .where(eq(clients.subscriberPlanId, id));
    const result = await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getSubscriberClientsDue(organizationId: string | null, currentMonth: string): Promise<Client[]> {
    const conds = [
      eq(clients.clientType, 'suscriptores'),
      eq(clients.isActive, true),
      sql`(${clients.status} IS NULL OR ${clients.status} != 'inactive')`,
      isNotNull(clients.subscriberQuantity),
      sql`COALESCE(${clients.subscriberLastBilledMonth}, '0000-00') < ${currentMonth}`,
      sql`(${clients.subscriberStartMonth} IS NULL OR ${clients.subscriberStartMonth} <= ${currentMonth})`,
    ];
    if (organizationId) conds.push(eq(clients.organizationId, organizationId));
    return await db.select().from(clients).where(and(...conds));
  }

  async getProjectsByClient(clientId: string): Promise<ClientProject[]> {
    return await db.select().from(clientProjects).where(eq(clientProjects.clientId, clientId)).orderBy(clientProjects.name);
  }

  async getProject(id: string): Promise<ClientProject | undefined> {
    const [project] = await db.select().from(clientProjects).where(eq(clientProjects.id, id));
    return project;
  }

  async createProject(project: InsertClientProject): Promise<ClientProject> {
    const [created] = await db.insert(clientProjects).values(project).returning();
    return created;
  }

  async updateProject(id: string, updates: Partial<InsertClientProject>): Promise<ClientProject | undefined> {
    const [updated] = await db.update(clientProjects).set(updates).where(eq(clientProjects.id, id)).returning();
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    const result = await db.delete(clientProjects).where(eq(clientProjects.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Supplier operations
  async getSuppliersByOrganization(organizationId: string, activeOnly: boolean = false, includeArchived: boolean = false): Promise<Supplier[]> {
    const conds: any[] = [eq(suppliers.organizationId, organizationId)];
    if (activeOnly) conds.push(eq(suppliers.isActive, true));
    if (!includeArchived) conds.push(isNull(suppliers.archivedAt)); // Task #363
    return await db.select().from(suppliers).where(and(...conds)).orderBy(suppliers.name);
  }

  // Task #363: archive/unarchive
  async archiveSupplier(id: string): Promise<Supplier | undefined> {
    const [row] = await db.update(suppliers)
      .set({ archivedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    return row;
  }
  async unarchiveSupplier(id: string): Promise<Supplier | undefined> {
    const [row] = await db.update(suppliers)
      .set({ archivedAt: null, isActive: true, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    return row;
  }

  async getSupplier(id: string): Promise<Supplier | undefined> {
    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.id, id));
    return supplier;
  }

  async createSupplier(insertSupplier: InsertSupplier): Promise<Supplier> {
    const [supplier] = await db.insert(suppliers).values(insertSupplier).returning();
    return supplier;
  }

  async updateSupplier(id: string, updates: Partial<InsertSupplier>): Promise<Supplier | undefined> {
    const [supplier] = await db.update(suppliers).set({ ...updates, updatedAt: new Date() }).where(eq(suppliers.id, id)).returning();
    return supplier;
  }

  async deleteSupplier(id: string): Promise<boolean> {
    const result = await db.delete(suppliers).where(eq(suppliers.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getEmployeesByOrganization(organizationId: string, activeOnly: boolean = false): Promise<Employee[]> {
    if (activeOnly) {
      return await db.select().from(employees).where(and(
        eq(employees.organizationId, organizationId),
        eq(employees.status, 'active')
      )).orderBy(employees.fullName);
    }
    return await db.select().from(employees).where(eq(employees.organizationId, organizationId)).orderBy(employees.fullName);
  }

  async getEmployee(id: string): Promise<Employee | undefined> {
    const [employee] = await db.select().from(employees).where(eq(employees.id, id));
    return employee;
  }

  async createEmployee(insertEmployee: InsertEmployee): Promise<Employee> {
    const [employee] = await db.insert(employees).values(insertEmployee).returning();
    return employee;
  }

  async updateEmployee(id: string, updates: Partial<InsertEmployee>): Promise<Employee | undefined> {
    const [employee] = await db.update(employees).set({ ...updates, updatedAt: new Date() }).where(eq(employees.id, id)).returning();
    return employee;
  }

  async deleteEmployee(id: string): Promise<boolean> {
    const result = await db.delete(employees).where(eq(employees.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async getAllocationsByEmployee(employeeId: string): Promise<EmployeeClientAllocation[]> {
    return await db.select().from(employeeClientAllocations).where(eq(employeeClientAllocations.employeeId, employeeId));
  }

  async getAllocationsByClient(clientId: string): Promise<EmployeeClientAllocation[]> {
    return await db.select().from(employeeClientAllocations).where(eq(employeeClientAllocations.clientId, clientId));
  }

  async getAllocationsWithEmployeesByOrganization(organizationId: string) {
    return db
      .select({
        id: employeeClientAllocations.id,
        employeeId: employeeClientAllocations.employeeId,
        clientId: employeeClientAllocations.clientId,
        projectId: employeeClientAllocations.projectId,
        projectName: employeeClientAllocations.projectName,
        percentage: employeeClientAllocations.percentage,
        commissionRate: employeeClientAllocations.commissionRate,
        createdAt: employeeClientAllocations.createdAt,
        grossSalary: employees.grossSalary,
        currency: employees.currency,
        employeeStatus: employees.status,
      })
      .from(employeeClientAllocations)
      .innerJoin(employees, eq(employeeClientAllocations.employeeId, employees.id))
      .innerJoin(clients, eq(employeeClientAllocations.clientId, clients.id))
      .where(and(eq(employees.organizationId, organizationId), eq(clients.organizationId, organizationId)));
  }

  async setAllocationsForEmployee(employeeId: string, allocations: { clientId: string; projectId?: string; projectName?: string; percentage: string; commissionRate?: string }[]): Promise<EmployeeClientAllocation[]> {
    await db.delete(employeeClientAllocations).where(eq(employeeClientAllocations.employeeId, employeeId));
    if (allocations.length === 0) return [];
    const rows = allocations.map(a => ({ employeeId, clientId: a.clientId, projectId: a.projectId || null, projectName: a.projectName || '', percentage: a.percentage, commissionRate: a.commissionRate || '0' }));
    return await db.insert(employeeClientAllocations).values(rows).returning();
  }

  // Product operations
  async getProductsByOrganization(organizationId: string, activeOnly: boolean = false): Promise<Product[]> {
    if (activeOnly) {
      return await db.select().from(products).where(and(
        eq(products.organizationId, organizationId),
        eq(products.isActive, true)
      )).orderBy(products.name);
    }
    return await db.select().from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async createProduct(insertProduct: InsertProduct): Promise<Product> {
    const [product] = await db.insert(products).values(insertProduct).returning();
    return product;
  }

  async updateProduct(id: string, updates: Partial<InsertProduct>): Promise<Product | undefined> {
    const [product] = await db.update(products).set({ ...updates, updatedAt: new Date() }).where(eq(products.id, id)).returning();
    return product;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const result = await db.delete(products).where(eq(products.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Stock movement operations
  async getStockMovementsByProduct(productId: string): Promise<StockMovement[]> {
    return await db.select().from(stockMovements).where(eq(stockMovements.productId, productId)).orderBy(desc(stockMovements.createdAt));
  }

  async createStockMovement(insertMovement: InsertStockMovement): Promise<StockMovement> {
    const [movement] = await db.insert(stockMovements).values(insertMovement).returning();
    return movement;
  }

  // Transaction items (multi-product, Task #475)
  async getTransactionItems(transactionId: string): Promise<TransactionItem[]> {
    return await db.select().from(transactionItems)
      .where(eq(transactionItems.transactionId, transactionId))
      .orderBy(transactionItems.createdAt);
  }

  async getTransactionItemsByTransactionIds(transactionIds: string[]): Promise<TransactionItem[]> {
    if (transactionIds.length === 0) return [];
    return await db.select().from(transactionItems)
      .where(inArray(transactionItems.transactionId, transactionIds))
      .orderBy(transactionItems.createdAt);
  }

  async createTransactionItems(items: InsertTransactionItem[]): Promise<TransactionItem[]> {
    if (items.length === 0) return [];
    return await db.insert(transactionItems).values(items).returning();
  }

  async deleteTransactionItems(transactionId: string): Promise<void> {
    await db.delete(transactionItems).where(eq(transactionItems.transactionId, transactionId));
  }

  // Quote items (productos/servicios, Task #481)
  async getQuoteItems(quoteId: string): Promise<QuoteItem[]> {
    return await db.select().from(quoteItems)
      .where(eq(quoteItems.quoteId, quoteId))
      .orderBy(quoteItems.createdAt);
  }

  async getQuoteItemsByQuoteIds(quoteIds: string[]): Promise<QuoteItem[]> {
    if (quoteIds.length === 0) return [];
    return await db.select().from(quoteItems)
      .where(inArray(quoteItems.quoteId, quoteIds))
      .orderBy(quoteItems.createdAt);
  }

  async createQuoteItems(items: InsertQuoteItem[]): Promise<QuoteItem[]> {
    if (items.length === 0) return [];
    return await db.insert(quoteItems).values(items).returning();
  }

  async deleteQuoteItems(quoteId: string): Promise<void> {
    await db.delete(quoteItems).where(eq(quoteItems.quoteId, quoteId));
  }

  // Profitability code operations
  async getProfitabilityCodesByOrganization(organizationId: string, activeOnly: boolean = false, includeArchived: boolean = false): Promise<ProfitabilityCode[]> {
    const conditions: any[] = [eq(profitabilityCodes.organizationId, organizationId)];
    if (activeOnly) conditions.push(eq(profitabilityCodes.isActive, true));
    if (!includeArchived) conditions.push(isNull(profitabilityCodes.archivedAt)); // Task #363
    return await db.select().from(profitabilityCodes).where(and(...conditions)).orderBy(asc(profitabilityCodes.code));
  }

  // Task #363: archive/unarchive + hard delete
  async deleteProfitabilityCode(id: string): Promise<boolean> {
    const result = await db.delete(profitabilityCodes).where(eq(profitabilityCodes.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }
  async archiveProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined> {
    const [row] = await db.update(profitabilityCodes)
      .set({ archivedAt: new Date(), isActive: false })
      .where(eq(profitabilityCodes.id, id))
      .returning();
    return row;
  }
  async unarchiveProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined> {
    const [row] = await db.update(profitabilityCodes)
      .set({ archivedAt: null, isActive: true })
      .where(eq(profitabilityCodes.id, id))
      .returning();
    return row;
  }

  async getProfitabilityCode(id: string): Promise<ProfitabilityCode | undefined> {
    const [row] = await db.select().from(profitabilityCodes).where(eq(profitabilityCodes.id, id));
    return row;
  }

  async findProfitabilityCodeByCode(organizationId: string, code: string): Promise<ProfitabilityCode | undefined> {
    const [row] = await db
      .select()
      .from(profitabilityCodes)
      .where(and(
        eq(profitabilityCodes.organizationId, organizationId),
        sql`lower(${profitabilityCodes.code}) = lower(${code})`,
      ));
    return row;
  }

  async createProfitabilityCode(insertCode: InsertProfitabilityCode): Promise<ProfitabilityCode> {
    const [created] = await db.insert(profitabilityCodes).values(insertCode).returning();
    return created;
  }

  async updateProfitabilityCode(id: string, updates: Partial<InsertProfitabilityCode>): Promise<ProfitabilityCode | undefined> {
    const [updated] = await db.update(profitabilityCodes).set(updates).where(eq(profitabilityCodes.id, id)).returning();
    return updated;
  }

  // ==========================================
  // Payment methods (Task #229)
  // ==========================================
  async getPaymentMethodsByOrganization(organizationId: string, activeOnly: boolean = false): Promise<PaymentMethodWithConcepts[]> {
    const conditions = [eq(paymentMethods.organizationId, organizationId)];
    if (activeOnly) conditions.push(eq(paymentMethods.isActive, true));
    const methods = await db
      .select()
      .from(paymentMethods)
      .where(and(...conditions))
      .orderBy(asc(paymentMethods.name));
    if (methods.length === 0) return [];
    const ids = methods.map(m => m.id);
    const concepts = await db
      .select()
      .from(paymentMethodConcepts)
      .where(inArray(paymentMethodConcepts.paymentMethodId, ids))
      .orderBy(asc(paymentMethodConcepts.position), asc(paymentMethodConcepts.createdAt));
    const byMethod = new Map<string, PaymentMethodConcept[]>();
    for (const c of concepts) {
      const list = byMethod.get(c.paymentMethodId) ?? [];
      list.push(c);
      byMethod.set(c.paymentMethodId, list);
    }
    return methods.map(m => ({ ...m, concepts: byMethod.get(m.id) ?? [] }));
  }

  async getPaymentMethodWithConcepts(id: string): Promise<PaymentMethodWithConcepts | undefined> {
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.id, id));
    if (!method) return undefined;
    const concepts = await db
      .select()
      .from(paymentMethodConcepts)
      .where(eq(paymentMethodConcepts.paymentMethodId, id))
      .orderBy(asc(paymentMethodConcepts.position), asc(paymentMethodConcepts.createdAt));
    return { ...method, concepts };
  }

  async createPaymentMethodWithConcepts(
    method: InsertPaymentMethod,
    concepts: Omit<InsertPaymentMethodConcept, 'paymentMethodId'>[],
  ): Promise<PaymentMethodWithConcepts> {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(paymentMethods).values(method).returning();
      let insertedConcepts: PaymentMethodConcept[] = [];
      if (concepts.length > 0) {
        const rows = concepts.map((c, idx) => ({
          ...c,
          paymentMethodId: created.id,
          position: c.position ?? idx,
        }));
        insertedConcepts = await tx.insert(paymentMethodConcepts).values(rows).returning();
        insertedConcepts.sort((a, b) => a.position - b.position);
      }
      return { ...created, concepts: insertedConcepts };
    });
  }

  async updatePaymentMethodWithConcepts(
    id: string,
    updates: Partial<InsertPaymentMethod>,
    concepts?: Omit<InsertPaymentMethodConcept, 'paymentMethodId'>[],
  ): Promise<PaymentMethodWithConcepts | undefined> {
    return await db.transaction(async (tx) => {
      let method: PaymentMethod | undefined;
      if (Object.keys(updates).length > 0) {
        const [updated] = await tx
          .update(paymentMethods)
          .set(updates)
          .where(eq(paymentMethods.id, id))
          .returning();
        method = updated;
      } else {
        const [existing] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, id));
        method = existing;
      }
      if (!method) return undefined;

      let finalConcepts: PaymentMethodConcept[];
      if (concepts !== undefined) {
        // Replace strategy: simpler than diffing for ≤10 rows. Children of
        // already-created transactions keep their data because they never
        // referenced these concept rows directly (concepts are a template).
        await tx.delete(paymentMethodConcepts).where(eq(paymentMethodConcepts.paymentMethodId, id));
        if (concepts.length > 0) {
          const rows = concepts.map((c, idx) => ({
            ...c,
            paymentMethodId: id,
            position: c.position ?? idx,
          }));
          finalConcepts = await tx.insert(paymentMethodConcepts).values(rows).returning();
          finalConcepts.sort((a, b) => a.position - b.position);
        } else {
          finalConcepts = [];
        }
      } else {
        finalConcepts = await tx
          .select()
          .from(paymentMethodConcepts)
          .where(eq(paymentMethodConcepts.paymentMethodId, id))
          .orderBy(asc(paymentMethodConcepts.position), asc(paymentMethodConcepts.createdAt));
      }
      return { ...method, concepts: finalConcepts };
    });
  }

  async deletePaymentMethod(id: string): Promise<boolean> {
    // ON DELETE CASCADE removes concepts. Existing transactions keep their
    // payment_method_id pointing to the deleted row (FK is intentionally NOT
    // enforced on transactions to allow soft references). Resolve at read
    // time as "Medio eliminado" if needed.
    const result = await db.delete(paymentMethods).where(eq(paymentMethods.id, id)).returning({ id: paymentMethods.id });
    return result.length > 0;
  }

  async createTransactionWithPaymentMethodChildren(
    parent: InsertTransaction,
    paymentMethod: PaymentMethodWithConcepts,
    options: { childTransactionNumbers: string[] },
  ): Promise<{ parent: Transaction; children: Transaction[] }> {
    if (parent.type !== 'income' && parent.type !== 'receivable') {
      throw new Error('Payment methods only apply to income or receivable transactions');
    }
    if (paymentMethod.organizationId !== parent.organizationId) {
      throw new Error('Payment method does not belong to the parent transaction organization');
    }
    if (paymentMethod.concepts.length === 0) {
      throw new Error('Payment method has no concepts');
    }
    if (options.childTransactionNumbers.length !== paymentMethod.concepts.length) {
      throw new Error('childTransactionNumbers length must match number of concepts');
    }

    const parentAmount = parseFloat(parent.amount);
    if (!Number.isFinite(parentAmount) || parentAmount <= 0) {
      throw new Error('Parent amount must be a positive number');
    }

    // Pre-load expense category names for the org so we can resolve
    // concept.expenseCategoryId → text. This is one extra query but it
    // avoids touching transaction_categories from inside the tx for each row.
    const orgExpenseCats = await this.getTransactionCategoriesByOrganization(parent.organizationId!, 'expense');
    const catById = new Map(orgExpenseCats.map(c => [c.id, c]));

    const childType: 'expense' | 'payable' = parent.type === 'income' ? 'expense' : 'payable';
    // Children inherit the parent's status: a completed income produces
    // already-paid expenses; a scheduled receivable produces scheduled
    // payables that will be completed later when the receivable is
    // collected. The system-wide status enum for transactions is
    // 'scheduled' | 'completed' | 'cancelled' (NOT 'pending'); using
    // 'pending' here would silently break autoApply and the commitments
    // notifier which both filter on `status === 'scheduled'`.
    const childStatus = parent.status ?? (parent.type === 'income' ? 'completed' : 'scheduled');
    const childIsCompleted = childStatus === 'completed';

    return await db.transaction(async (tx) => {
      // 1) Insert parent. Replicates the expenseSubtype lookup logic from
      // createTransaction (only relevant if parent ever ends up being an
      // expense subtype — for income/receivable parents, expenseSubtype is
      // null).
      const [insertedParent] = await tx.insert(transactions).values(parent).returning();

      // 2) Update parent account balance if completed.
      if (insertedParent.status === 'completed' && insertedParent.accountId) {
        const isPositive = insertedParent.type === 'income' || insertedParent.type === 'transfer_in' || insertedParent.type === 'receivable';
        const delta = isPositive ? parentAmount : -parentAmount;
        await tx.update(accounts)
          .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
          .where(eq(accounts.id, insertedParent.accountId));
      }

      // 3) Insert one child per concept.
      const children: Transaction[] = [];
      for (let i = 0; i < paymentMethod.concepts.length; i++) {
        const concept = paymentMethod.concepts[i];
        const childNumber = options.childTransactionNumbers[i];

        let childAmountNum: number;
        if (concept.kind === 'percentage') {
          childAmountNum = (parentAmount * Number(concept.value)) / 100;
        } else {
          childAmountNum = Number(concept.value);
        }
        // Round to 2 decimals to avoid sub-cent residuals creating odd UI.
        childAmountNum = Math.round(childAmountNum * 100) / 100;
        if (!Number.isFinite(childAmountNum) || childAmountNum <= 0) {
          // Skip non-positive children (e.g. percentage rounding to 0).
          // Continue with next concept.
          continue;
        }

        const matchedCat = concept.expenseCategoryId ? catById.get(concept.expenseCategoryId) : undefined;
        const categoryText = matchedCat?.name ?? 'Costos de cobro';
        const expenseSubtype = matchedCat?.expenseSubtype ?? 'expense';

        const childInsert = {
          type: childType,
          amount: String(childAmountNum),
          description: `Costo de cobro: ${concept.name} (${paymentMethod.name})`,
          category: categoryText,
          expenseSubtype,
          date: parent.date,
          imputationDate: parent.imputationDate,
          accountId: parent.accountId ?? null,
          organizationId: parent.organizationId!,
          currency: parent.currency,
          hasInvoice: false,
          status: childStatus,
          ...(childIsCompleted && {
            completedBy: parent.createdBy ?? null,
            completedAt: new Date(),
          }),
          createdBy: parent.createdBy ?? null,
          createdVia: parent.createdVia ?? 'web',
          assetType: parent.assetType ?? 'operative',
          linkedTransactionId: insertedParent.id,
          paymentMethodId: null, // children never carry the method
          profitabilityCodeId: parent.profitabilityCodeId ?? null,
          isUniquePayment: true,
          isRecurring: false,
          transactionNumber: childNumber,
        } as InsertTransaction;

        const [insertedChild] = await tx.insert(transactions).values(childInsert).returning();
        children.push(insertedChild);

        if (insertedChild.status === 'completed' && insertedChild.accountId) {
          // Children are 'expense' or 'payable' → always negative for the account.
          const delta = -childAmountNum;
          await tx.update(accounts)
            .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) + ${delta})` })
            .where(eq(accounts.id, insertedChild.accountId));
        }
      }

      return { parent: insertedParent, children };
    });
  }

  async getPaymentMethodChildren(parentId: string): Promise<Transaction[]> {
    // Guard: only return children whose parent actually carries a
    // paymentMethodId, ensuring we never treat arbitrary linkedTransactionId
    // pointers (e.g. manual payment-of-receivable links) as auto-generated
    // payment-method costs. Done as two typed queries so the returned rows
    // are properly camel-cased Transaction objects (raw db.execute leaves
    // snake_case keys, which would silently break consumers reading
    // `child.completedBy` / `child.linkedTransactionId`).
    const [parent] = await db
      .select({ id: transactions.id, paymentMethodId: transactions.paymentMethodId })
      .from(transactions)
      .where(eq(transactions.id, parentId));
    if (!parent || !parent.paymentMethodId) return [];
    const rows = await db
      .select()
      .from(transactions)
      .where(and(
        eq(transactions.linkedTransactionId, parentId),
        or(eq(transactions.type, 'payable'), eq(transactions.type, 'expense')),
      ))
      .orderBy(asc(transactions.createdAt));
    return rows;
  }

  async propagateCollectionToPaymentMethodChildren(
    parentId: string,
    ratio: number,
    userId: string,
    triggeredByTransactionId: string,
  ): Promise<{ updatedChildren: Transaction[]; completedChildren: Transaction[] }> {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return { updatedChildren: [], completedChildren: [] };
    }
    const isFull = ratio >= 0.9999;

    return await db.transaction(async (tx) => {
      // Guard parent: only propagate if the parent is genuinely a
      // payment-method parent. Avoids accidentally treating any pending
      // payable linked to this parent as a payment-method child.
      const [parentRow] = await tx
        .select({ id: transactions.id, paymentMethodId: transactions.paymentMethodId })
        .from(transactions)
        .where(eq(transactions.id, parentId));
      if (!parentRow || !parentRow.paymentMethodId) {
        return { updatedChildren: [], completedChildren: [] };
      }

      // Re-query inside the tx to read the current child amounts (may have
      // been previously partial-applied). FOR UPDATE locks the rows for the
      // duration of the transaction. Done as a typed Drizzle select so the
      // returned rows are camel-cased (raw db.execute leaves snake_case).
      const childRows = await tx
        .select()
        .from(transactions)
        .where(and(
          eq(transactions.linkedTransactionId, parentId),
          eq(transactions.type, 'payable'),
          not(eq(transactions.status, 'completed')),
        ))
        .for('update');
      const updated: Transaction[] = [];
      const completed: Transaction[] = [];

      for (const child of childRows) {
        const currentAmount = parseFloat(child.amount);
        if (!Number.isFinite(currentAmount) || currentAmount <= 0) continue;

        if (isFull) {
          await tx.update(transactions).set({
            status: 'completed',
            completedBy: userId,
            completedAt: new Date(),
            autoAppliedByTransactionId: triggeredByTransactionId,
          }).where(eq(transactions.id, child.id));
          if (child.accountId) {
            await tx.update(accounts)
              .set({ balance: sql`(CAST(${accounts.balance} AS DECIMAL) - ${currentAmount})` })
              .where(eq(accounts.id, child.accountId));
          }
          completed.push({ ...child, status: 'completed' });
        } else {
          const newAmount = Math.round(currentAmount * (1 - ratio) * 100) / 100;
          const trackOriginal = child.originalAmount ?? child.amount;
          await tx.update(transactions).set({
            amount: String(newAmount),
            originalAmount: trackOriginal,
            autoAppliedByTransactionId: triggeredByTransactionId,
          }).where(eq(transactions.id, child.id));
          updated.push({ ...child, amount: String(newAmount) });
        }
      }

      return { updatedChildren: updated, completedChildren: completed };
    });
  }

  // Audit log operations
  async createAuditLog(insertLog: InsertAuditLog): Promise<AuditLog> {
    const [log] = await db.insert(auditLogs).values(insertLog).returning();
    return log;
  }

  async getAuditLogsByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return await db.select().from(auditLogs).where(and(
      eq(auditLogs.entityType, entityType),
      eq(auditLogs.entityId, entityId)
    )).orderBy(desc(auditLogs.createdAt));
  }

  async getAuditLogsByOrganization(organizationId: string, limit: number = 100): Promise<AuditLog[]> {
    return await db.select().from(auditLogs).where(eq(auditLogs.organizationId, organizationId)).orderBy(desc(auditLogs.createdAt)).limit(limit);
  }

  // Asset operations
  async getAssetsByOrganization(organizationId: string, activeOnly: boolean = false): Promise<Asset[]> {
    if (activeOnly) {
      return await db.select().from(assets).where(and(
        eq(assets.organizationId, organizationId),
        eq(assets.isActive, true)
      )).orderBy(desc(assets.acquisitionDate));
    }
    return await db.select().from(assets).where(eq(assets.organizationId, organizationId)).orderBy(desc(assets.acquisitionDate));
  }

  async getAsset(id: string): Promise<Asset | undefined> {
    const [asset] = await db.select().from(assets).where(eq(assets.id, id));
    return asset;
  }

  async createAsset(insertAsset: InsertAsset): Promise<Asset> {
    const [asset] = await db.insert(assets).values(insertAsset).returning();
    return asset;
  }

  async updateAsset(id: string, updates: Partial<InsertAsset>): Promise<Asset | undefined> {
    const [asset] = await db.update(assets).set({ ...updates, updatedAt: new Date() }).where(eq(assets.id, id)).returning();
    return asset;
  }

  async deleteAsset(id: string): Promise<boolean> {
    const result = await db.delete(assets).where(eq(assets.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Investment operations
  async getInvestmentsByOrganization(organizationId: string, activeOnly: boolean = false): Promise<Investment[]> {
    if (activeOnly) {
      return await db.select().from(investments).where(and(
        eq(investments.organizationId, organizationId),
        eq(investments.isActive, true)
      )).orderBy(desc(investments.acquisitionDate));
    }
    return await db.select().from(investments).where(eq(investments.organizationId, organizationId)).orderBy(desc(investments.acquisitionDate));
  }

  async getInvestment(id: string): Promise<Investment | undefined> {
    const [investment] = await db.select().from(investments).where(eq(investments.id, id));
    return investment;
  }

  async createInvestment(insertInvestment: InsertInvestment): Promise<Investment> {
    const [investment] = await db.insert(investments).values(insertInvestment).returning();
    return investment;
  }

  async updateInvestment(id: string, updates: Partial<InsertInvestment>): Promise<Investment | undefined> {
    const [investment] = await db.update(investments).set({ ...updates, updatedAt: new Date() }).where(eq(investments.id, id)).returning();
    return investment;
  }

  async deleteInvestment(id: string): Promise<boolean> {
    const result = await db.delete(investments).where(eq(investments.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Team invitation operations
  async getTeamInvitationsByOrganization(organizationId: string, status?: string): Promise<TeamInvitation[]> {
    if (status) {
      return await db.select().from(teamInvitations).where(and(
        eq(teamInvitations.organizationId, organizationId),
        eq(teamInvitations.status, status)
      )).orderBy(desc(teamInvitations.createdAt));
    }
    return await db.select().from(teamInvitations).where(eq(teamInvitations.organizationId, organizationId)).orderBy(desc(teamInvitations.createdAt));
  }

  async getTeamInvitation(id: string): Promise<TeamInvitation | undefined> {
    const [invitation] = await db.select().from(teamInvitations).where(eq(teamInvitations.id, id));
    return invitation;
  }

  async getTeamInvitationByEmail(email: string): Promise<TeamInvitation | undefined> {
    const normalized = email.toLowerCase().trim();
    const [invitation] = await db.select().from(teamInvitations).where(and(
      sql`LOWER(${teamInvitations.email}) = ${normalized}`,
      eq(teamInvitations.status, 'pending'),
      gte(teamInvitations.expiresAt, new Date())
    )).orderBy(desc(teamInvitations.createdAt));
    return invitation;
  }

  async createTeamInvitation(insertInvitation: InsertTeamInvitation): Promise<TeamInvitation> {
    const normalized = { ...insertInvitation, email: insertInvitation.email.toLowerCase().trim() };
    const [invitation] = await db.insert(teamInvitations).values(normalized).returning();
    return invitation;
  }

  async updateTeamInvitation(id: string, updates: Partial<InsertTeamInvitation>): Promise<TeamInvitation | undefined> {
    const [invitation] = await db.update(teamInvitations).set(updates).where(eq(teamInvitations.id, id)).returning();
    return invitation;
  }

  async deleteTeamInvitation(id: string): Promise<boolean> {
    const result = await db.delete(teamInvitations).where(eq(teamInvitations.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Subscription operations
  async getSubscriptionByUserId(userId: string): Promise<Subscription | undefined> {
    // Task #308 — Ordenamiento determinista cuando un usuario tiene varias
    // filas en `subscriptions` (situación que en producción existe para 35
    // usuarios por un bug histórico del webhook). El criterio anterior
    // (`createdAt DESC LIMIT 1`) podía devolver una fila `cancelled` aunque
    // existiera otra `trialing`/`active` válida para el mismo usuario, y eso
    // hace que el middleware bloquee con 402 a usuarios que en realidad
    // tienen acceso.
    //
    // Task #318 — La regla "active mejor que cancelled" sin condicionar a la
    // identidad de Stripe causaba el bug opuesto: un usuario con dos filas
    // para el MISMO `stripe_subscription_id` (una vieja `trialing` que quedó
    // huérfana cuando se creó la cuenta y una nueva `cancelled` del webhook
    // de Stripe por falta de pago) terminaba viéndose como `trialing` porque
    // esa fila ganaba la prioridad, aunque la suscripción real en Stripe ya
    // estuviera cancelada. Esto producía dos síntomas convergentes:
    //   - El middleware lo dejaba entrar y el frontend rompía (pantalla
    //     blanca + cierre de sesión) al pegarle a flujos Stripe con un
    //     `subscription_id` cancelado.
    //   - El cron del resumen semanal lo consideraba elegible y le mandaba
    //     el mail los lunes pese al pago rechazado.
    //
    // Nueva regla (dos pasos):
    //   1. Cuando hay varias filas con el mismo `stripe_subscription_id` no
    //      nulo, sólo sobrevive la más recientemente actualizada — esa fila
    //      es la representación canónica del estado actual de esa
    //      suscripción en Stripe.
    //   2. Sobre el conjunto deduplicado, aplicamos la prioridad funcional
    //      (active > trialing > past_due > unpaid > pending > cancelled).
    // Si un usuario tiene una sola fila el comportamiento no cambia. Si
    // tiene dos suscripciones distintas (`stripe_subscription_id`
    // diferentes), la prioridad funcional sigue valiendo igual que antes.
    const rows = await db.select().from(subscriptions).where(
      eq(subscriptions.userId, userId),
    );
    if (rows.length === 0) return undefined;
    if (rows.length === 1) return rows[0];

    const STATUS_PRIO: Record<string, number> = {
      active: 1, trialing: 2, past_due: 3, unpaid: 4, pending: 5, cancelled: 6,
    };
    const prioOf = (s: string | null | undefined) => STATUS_PRIO[s ?? ''] ?? 7;
    const updatedAtMs = (r: Subscription) =>
      r.updatedAt ? new Date(r.updatedAt).getTime() : 0;

    // Paso 1: deduplicar por stripe_subscription_id (no nulo).
    const byStripeId = new Map<string, Subscription>();
    const standalone: Subscription[] = [];
    for (const r of rows) {
      if (!r.stripeSubscriptionId) {
        standalone.push(r);
        continue;
      }
      const prev = byStripeId.get(r.stripeSubscriptionId);
      if (!prev || updatedAtMs(r) > updatedAtMs(prev)) {
        byStripeId.set(r.stripeSubscriptionId, r);
      }
    }
    const dedup = [...byStripeId.values(), ...standalone];

    // Paso 2: prioridad funcional, desempate por updated_at desc.
    dedup.sort((a, b) => {
      const dp = prioOf(a.status) - prioOf(b.status);
      if (dp !== 0) return dp;
      return updatedAtMs(b) - updatedAtMs(a);
    });
    return dedup[0];
  }

  async getAllSubscriptions(): Promise<Subscription[]> {
    return await db.select().from(subscriptions);
  }

  async getStripePriceMap(): Promise<Map<string, { unitAmount: number | null; currency: string | null; recurring: { interval?: string; interval_count?: number } | null }>> {
    // No se filtra por active: una suscripción puede referenciar un precio
    // archivado y aun así queremos resolver su monto real.
    const result = await db.execute<{
      id: string;
      unit_amount: number | string | null;
      currency: string | null;
      recurring: { interval?: string; interval_count?: number } | null;
    }>(sql`
      SELECT id, unit_amount, currency, recurring
      FROM stripe.prices
    `);

    const rows = (result as any).rows ?? result;
    const map = new Map<string, { unitAmount: number | null; currency: string | null; recurring: { interval?: string; interval_count?: number } | null }>();
    for (const row of rows as Array<{
      id: string;
      unit_amount: number | string | null;
      currency: string | null;
      recurring: { interval?: string; interval_count?: number } | null;
    }>) {
      const unitAmount = row.unit_amount != null ? Number(row.unit_amount) : null;
      map.set(row.id, {
        unitAmount: unitAmount != null && !Number.isNaN(unitAmount) ? unitAmount : null,
        currency: row.currency,
        recurring: row.recurring,
      });
    }
    return map;
  }

  async updateSubscription(id: string, data: Partial<InsertSubscription>): Promise<Subscription> {
    const [subscription] = await db.update(subscriptions).set({ ...data, updatedAt: new Date() }).where(eq(subscriptions.id, id)).returning();
    return subscription;
  }

  async createSubscription(data: InsertSubscription): Promise<Subscription> {
    const [subscription] = await db.insert(subscriptions).values(data).returning();
    return subscription;
  }

  // Task #310 — Upsert idempotente para los webhooks de Stripe.
  //
  // Esta es la primitiva canónica que los handlers de Stripe deben usar
  // cuando conocen el `stripe_subscription_id`. Antes el código hacía
  // get-por-userId + (update o create), y eso producía duplicados cuando
  // dos eventos del mismo subscription_id llegaban casi simultáneamente.
  //
  // Orden de búsqueda:
  //   1. Por `stripe_subscription_id` (clave canónica): si existe, update.
  //   2. Por `userId` con stripe_subscription_id NULL (placeholder pre-checkout):
  //      si existe, le pegamos el stripe_subscription_id y los datos.
  //   3. Insert nuevo.
  //
  // Si por una race condition dos handlers entran en el paso 3
  // simultáneamente, el índice único parcial sobre stripe_subscription_id
  // hace que el segundo insert falle. En ese caso reintentamos una vez
  // por el camino 1 (que ahora ve la fila del primero).
  // Task #310 — lookup keyed por stripe_subscription_id, usado por
  // handleSubscriptionDeleted y demás handlers que deben actuar sobre la
  // fila canónica (no la "primera" del usuario, que en casos de plan
  // change puede ser otra suscripción histórica).
  async getSubscriptionByStripeId(stripeSubscriptionId: string): Promise<Subscription | undefined> {
    const [row] = await db.select().from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
      .limit(1);
    return row;
  }

  async upsertSubscriptionByStripeId(
    stripeSubscriptionId: string,
    userId: string,
    data: Partial<InsertSubscription>,
  ): Promise<Subscription> {
    const doUpsert = async (): Promise<Subscription> => {
      const [byStripeId] = await db.select().from(subscriptions)
        .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
        .limit(1);

      if (byStripeId) {
        const [updated] = await db.update(subscriptions)
          .set({ ...data, userId, stripeSubscriptionId, updatedAt: new Date() })
          .where(eq(subscriptions.id, byStripeId.id))
          .returning();
        return updated;
      }

      const [placeholder] = await db.select().from(subscriptions)
        .where(and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.stripeSubscriptionId),
        ))
        .limit(1);

      if (placeholder) {
        const [updated] = await db.update(subscriptions)
          .set({ ...data, stripeSubscriptionId, updatedAt: new Date() })
          .where(eq(subscriptions.id, placeholder.id))
          .returning();
        return updated;
      }

      const insertValues = {
        ...data,
        userId,
        stripeSubscriptionId,
        planType: data.planType ?? 'personal',
        status: data.status ?? 'active',
      } as InsertSubscription;
      const [created] = await db.insert(subscriptions).values(insertValues).returning();
      return created;
    };

    try {
      return await doUpsert();
    } catch (err: any) {
      // 23505 = unique_violation. Algún otro handler insertó la fila entre
      // nuestro SELECT y nuestro INSERT — la retomamos por el camino 1.
      if (err?.code === '23505') {
        console.log(`[upsertSubscriptionByStripeId] Unique violation for ${stripeSubscriptionId}, retrying as update`);
        return await doUpsert();
      }
      throw err;
    }
  }

  // Counting operations for plan limits
  async countOrganizationsByUser(userId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return result?.count || 0;
  }
  
  // Count only organizations where user is owner (for plan limits)
  // Organizations where user is invited member don't count against their plan
  async countOwnedOrganizationsByUser(userId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(memberships)
      .where(and(
        eq(memberships.userId, userId),
        eq(memberships.role, 'owner')
      ));
    return result?.count || 0;
  }

  async countMembersByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(memberships)
      .where(eq(memberships.organizationId, organizationId));
    return result?.count || 0;
  }

  async countPendingInvitationsByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(teamInvitations)
      .where(and(
        eq(teamInvitations.organizationId, organizationId),
        eq(teamInvitations.status, 'pending')
      ));
    return result?.count || 0;
  }

  // Transaction category operations
  async getTransactionCategoriesByOrganization(organizationId: string, type?: 'income' | 'expense', includeArchived: boolean = false): Promise<TransactionCategory[]> {
    const conds: any[] = [eq(transactionCategories.organizationId, organizationId)];
    if (type) conds.push(eq(transactionCategories.type, type));
    if (!includeArchived) conds.push(isNull(transactionCategories.archivedAt)); // Task #363
    if (type) {
      return db.select().from(transactionCategories)
        .where(and(...conds))
        .orderBy(asc(transactionCategories.name));
    }
    return db.select().from(transactionCategories)
      .where(and(...conds))
      .orderBy(asc(transactionCategories.type), asc(transactionCategories.name));
  }

  // Task #363: archive/unarchive
  async archiveTransactionCategory(id: string): Promise<TransactionCategory | undefined> {
    const [row] = await db.update(transactionCategories)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(transactionCategories.id, id))
      .returning();
    return row;
  }
  async unarchiveTransactionCategory(id: string): Promise<TransactionCategory | undefined> {
    const [row] = await db.update(transactionCategories)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(transactionCategories.id, id))
      .returning();
    return row;
  }

  async getTransactionCategory(id: string): Promise<TransactionCategory | undefined> {
    const [category] = await db.select().from(transactionCategories).where(eq(transactionCategories.id, id));
    return category;
  }

  async createTransactionCategory(category: InsertTransactionCategory): Promise<TransactionCategory> {
    const [newCategory] = await db.insert(transactionCategories).values(category).returning();
    return newCategory;
  }

  async updateTransactionCategory(id: string, updates: Partial<InsertTransactionCategory>): Promise<TransactionCategory | undefined> {
    const [category] = await db.update(transactionCategories)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(transactionCategories.id, id))
      .returning();
    return category;
  }

  async deleteTransactionCategory(id: string): Promise<boolean> {
    const result = await db.delete(transactionCategories).where(eq(transactionCategories.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async seedDefaultCategories(organizationId: string, createdBy?: string): Promise<TransactionCategory[]> {
    const incomeCategories = DEFAULT_INCOME_CATEGORIES.map(name => ({
      organizationId,
      name,
      type: 'income' as const,
      isDefault: true,
      createdBy: createdBy || null,
    }));
    
    const expenseCategories = DEFAULT_EXPENSE_CATEGORIES.map(name => ({
      organizationId,
      name,
      type: 'expense' as const,
      expenseSubtype: DEFAULT_COST_CATEGORIES.includes(name) ? 'cost' : 'expense',
      isDefault: true,
      createdBy: createdBy || null,
    }));
    
    const allCategories = [...incomeCategories, ...expenseCategories];
    const created = await db.insert(transactionCategories).values(allCategories).returning();
    return created;
  }

  async seedDefaultAccount(organizationId: string, currency: string): Promise<Account> {
    const [account] = await db.insert(accounts).values({
      name: 'Cuenta General',
      type: 'bank',
      accountCategory: 'operative',
      currency: currency || 'ARS',
      balance: '0',
      organizationId,
    }).returning();
    return account;
  }

  // Access denied events operations
  async createAccessDeniedEvent(event: InsertAccessDeniedEvent): Promise<AccessDeniedEvent> {
    const [created] = await db.insert(accessDeniedEvents).values(event).returning();
    return created;
  }

  async getAccessDeniedEventByEmail(email: string): Promise<AccessDeniedEvent | undefined> {
    const normalized = email.toLowerCase().trim();
    const [event] = await db.select().from(accessDeniedEvents)
      .where(and(
        sql`LOWER(${accessDeniedEvents.userEmail}) = ${normalized}`,
        eq(accessDeniedEvents.acknowledged, false)
      ))
      .orderBy(desc(accessDeniedEvents.createdAt))
      .limit(1);
    return event;
  }

  async acknowledgeAccessDeniedEvent(id: string): Promise<boolean> {
    const result = await db.update(accessDeniedEvents)
      .set({ acknowledged: true })
      .where(eq(accessDeniedEvents.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  // Pending signup operations
  async createPendingSignup(signup: InsertPendingSignup): Promise<PendingSignup> {
    const normalized = { ...signup, email: signup.email.toLowerCase().trim() };
    const [created] = await db.insert(pendingSignups).values(normalized).returning();
    return created;
  }

  async getPendingSignup(id: string): Promise<PendingSignup | undefined> {
    const [signup] = await db.select().from(pendingSignups).where(eq(pendingSignups.id, id));
    return signup;
  }

  async getPendingSignupByEmail(email: string): Promise<PendingSignup | undefined> {
    const normalized = email.toLowerCase().trim();
    const [signup] = await db.select().from(pendingSignups)
      .where(and(
        sql`LOWER(${pendingSignups.email}) = ${normalized}`,
        eq(pendingSignups.status, 'pending')
      ))
      .orderBy(desc(pendingSignups.createdAt))
      .limit(1);
    return signup;
  }

  async getPendingSignupByStripeSessionId(sessionId: string): Promise<PendingSignup | undefined> {
    const [signup] = await db.select().from(pendingSignups)
      .where(eq(pendingSignups.stripeSessionId, sessionId));
    return signup;
  }

  async updatePendingSignup(id: string, updates: Partial<InsertPendingSignup>): Promise<PendingSignup | undefined> {
    const [signup] = await db.update(pendingSignups)
      .set(updates)
      .where(eq(pendingSignups.id, id))
      .returning();
    return signup;
  }

  async deletePendingSignup(id: string): Promise<boolean> {
    const result = await db.delete(pendingSignups).where(eq(pendingSignups.id, id));
    return result.rowCount !== null && result.rowCount > 0;
  }

  async deleteExpiredPendingSignups(): Promise<number> {
    const result = await db.delete(pendingSignups)
      .where(and(
        eq(pendingSignups.status, 'pending'),
        lte(pendingSignups.expiresAt, new Date())
      ));
    return result.rowCount || 0;
  }

  // Admin operations
  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async isUserAdmin(userId: string): Promise<boolean> {
    const [user] = await db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, userId));
    return user?.isAdmin === true;
  }

  async getAdminEmails(): Promise<string[]> {
    const admins = await db
      .select({ email: users.email })
      .from(users)
      .where(and(eq(users.isAdmin, true), isNull(users.deletedAt)));
    return admins.map(a => a.email);
  }

  // Session log operations
  async createSessionLog(log: InsertSessionLog): Promise<SessionLog> {
    const [sessionLog] = await db.insert(sessionLogs).values(log).returning();
    return sessionLog;
  }

  async getSessionLogsByUser(userId: string, limit: number = 50): Promise<SessionLog[]> {
    return await db.select().from(sessionLogs)
      .where(eq(sessionLogs.userId, userId))
      .orderBy(desc(sessionLogs.createdAt))
      .limit(limit);
  }

  async getAllSessionLogs(limit: number = 100): Promise<SessionLog[]> {
    return await db.select().from(sessionLogs)
      .orderBy(desc(sessionLogs.createdAt))
      .limit(limit);
  }

  // Persiste un error del sistema agrupando por huella estable. Si ya existe un
  // registro "abierto" (open) con la misma huella, incrementa el contador y
  // actualiza la última vez vista (y el contexto más reciente). Si no existe uno
  // abierto, crea una fila nueva. Los registros resueltos/archivados quedan como
  // historial: si el error reaparece, se crea una entrada nueva (el admin puede
  // reabrir manualmente si lo prefiere).
  async upsertMrrSnapshot(snapshot: InsertMrrSnapshot): Promise<MrrSnapshot> {
    // Upsert atómico contra el UNIQUE de snapshot_month: una fila por mes. Si el
    // mes en curso ya tiene snapshot, lo refresca con el último valor observado;
    // al cambiar de mes, queda fijada la última cifra del mes anterior.
    const [row] = await db.insert(mrrSnapshots)
      .values(snapshot)
      .onConflictDoUpdate({
        target: mrrSnapshots.snapshotMonth,
        set: {
          mrrArs: snapshot.mrrArs,
          mrrUsd: snapshot.mrrUsd,
          activeSubscriptions: snapshot.activeSubscriptions,
          usdArsRate: snapshot.usdArsRate,
          capturedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getMrrSnapshots(limit: number = 36): Promise<MrrSnapshot[]> {
    const rows = await db.select().from(mrrSnapshots)
      .orderBy(desc(mrrSnapshots.snapshotMonth))
      .limit(limit);
    // Devolvemos en orden cronológico ascendente para que el gráfico lea de
    // izquierda (más viejo) a derecha (más nuevo).
    return rows.reverse();
  }

  async recordAccountDeletion(deletion: InsertAccountDeletion): Promise<AccountDeletion> {
    const [row] = await db.insert(accountDeletions).values(deletion).returning();
    return row;
  }

  async getAccountDeletions(limit: number = 100): Promise<AccountDeletion[]> {
    return db.select().from(accountDeletions)
      .orderBy(desc(accountDeletions.deletedAt))
      .limit(limit);
  }

  async countAccountDeletions(reason?: AccountDeletionReason): Promise<number> {
    const [row] = reason
      ? await db.select({ value: count() }).from(accountDeletions).where(eq(accountDeletions.reason, reason))
      : await db.select({ value: count() }).from(accountDeletions);
    return row?.value ?? 0;
  }

  async recordSystemError(error: InsertSystemError): Promise<SystemError> {
    // Upsert atómico contra el índice único parcial (fingerprint WHERE
    // status='open'): si ya hay una fila abierta con esa huella, incrementa el
    // contador y refresca el contexto; si no, inserta una nueva. Resuelve la
    // condición de carrera ante ráfagas de errores idénticos sin duplicar filas.
    const [row] = await db.insert(systemErrors)
      .values({ ...error, status: 'open' })
      .onConflictDoUpdate({
        target: systemErrors.fingerprint,
        targetWhere: eq(systemErrors.status, 'open'),
        set: {
          occurrenceCount: sql`${systemErrors.occurrenceCount} + 1`,
          lastSeenAt: new Date(),
          message: sql`excluded.message`,
          stack: sql`COALESCE(excluded.stack, ${systemErrors.stack})`,
          statusCode: sql`COALESCE(excluded.status_code, ${systemErrors.statusCode})`,
          method: sql`COALESCE(excluded.method, ${systemErrors.method})`,
          path: sql`COALESCE(excluded.path, ${systemErrors.path})`,
          userId: sql`COALESCE(excluded.user_id, ${systemErrors.userId})`,
          userEmail: sql`COALESCE(excluded.user_email, ${systemErrors.userEmail})`,
          organizationId: sql`COALESCE(excluded.organization_id, ${systemErrors.organizationId})`,
          ip: sql`COALESCE(excluded.ip, ${systemErrors.ip})`,
          userAgent: sql`COALESCE(excluded.user_agent, ${systemErrors.userAgent})`,
        },
      })
      .returning();
    return row;
  }

  async getSystemErrors(status?: string, limit: number = 100): Promise<SystemError[]> {
    const query = db.select().from(systemErrors);
    if (status) {
      return await query
        .where(eq(systemErrors.status, status))
        .orderBy(desc(systemErrors.lastSeenAt))
        .limit(limit);
    }
    return await query
      .orderBy(desc(systemErrors.lastSeenAt))
      .limit(limit);
  }

  async getSystemError(id: string): Promise<SystemError | undefined> {
    const [error] = await db.select().from(systemErrors).where(eq(systemErrors.id, id));
    return error;
  }

  async updateSystemErrorStatus(
    id: string,
    status: 'open' | 'resolved' | 'archived',
    resolvedBy: string | null,
  ): Promise<SystemError | undefined> {
    // Reabrir requiere cuidado: el índice único parcial permite a lo sumo una
    // fila "open" por huella. Si el error ya reapareció (hay otra fila open con
    // la misma huella), reabrir el histórico violaría el índice. Lo detectamos y
    // lanzamos un conflicto controlado (la ruta responde 409) en vez de un 500.
    if (status === 'open') {
      const [target] = await db.select({ fingerprint: systemErrors.fingerprint })
        .from(systemErrors)
        .where(eq(systemErrors.id, id));
      if (!target) return undefined;
      const [conflict] = await db.select({ id: systemErrors.id })
        .from(systemErrors)
        .where(and(
          eq(systemErrors.fingerprint, target.fingerprint),
          eq(systemErrors.status, 'open'),
          ne(systemErrors.id, id),
        ))
        .limit(1);
      if (conflict) {
        const err: any = new Error('OPEN_EXISTS');
        err.code = 'OPEN_EXISTS';
        throw err;
      }
    }

    try {
      const [updated] = await db.update(systemErrors)
        .set({
          status,
          resolvedBy: status === 'resolved' ? resolvedBy : null,
          resolvedAt: status === 'resolved' ? new Date() : null,
        })
        .where(eq(systemErrors.id, id))
        .returning();
      return updated;
    } catch (e: any) {
      // Red de seguridad ante la carrera TOCTOU del pre-check: si entre la
      // verificación y el UPDATE apareció una fila open con la misma huella,
      // Postgres devuelve 23505 (unique violation). Lo normalizamos a conflicto.
      if (e?.code === '23505') {
        const err: any = new Error('OPEN_EXISTS');
        err.code = 'OPEN_EXISTS';
        throw err;
      }
      throw e;
    }
  }

  // Chat message operations (persistent AI conversation history)
  // Get messages by organization AND user for privacy isolation
  async getChatMessagesByOrganization(organizationId: string, limit: number = 100, userId?: string): Promise<ChatMessage[]> {
    if (userId) {
      return await db.select().from(chatMessages)
        .where(and(
          eq(chatMessages.organizationId, organizationId),
          eq(chatMessages.userId, userId)
        ))
        .orderBy(asc(chatMessages.createdAt))
        .limit(limit);
    }
    return await db.select().from(chatMessages)
      .where(eq(chatMessages.organizationId, organizationId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(limit);
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [chatMessage] = await db.insert(chatMessages).values(message).returning();
    return chatMessage;
  }

  async clearChatHistory(organizationId: string, userId: string): Promise<boolean> {
    await db.delete(chatMessages).where(
      and(
        eq(chatMessages.organizationId, organizationId),
        eq(chatMessages.userId, userId)
      )
    );
    return true;
  }

  // Notification operations
  async getNotificationsByUser(userId: string, organizationId?: string, includeRead: boolean = true): Promise<Notification[]> {
    if (organizationId) {
      if (includeRead) {
        return await db.select().from(notifications)
          .where(and(
            eq(notifications.userId, userId),
            eq(notifications.organizationId, organizationId)
          ))
          .orderBy(desc(notifications.createdAt))
          .limit(100);
      }
      return await db.select().from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.organizationId, organizationId),
          eq(notifications.isRead, false)
        ))
        .orderBy(desc(notifications.createdAt))
        .limit(100);
    }
    if (includeRead) {
      return await db.select().from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(100);
    }
    return await db.select().from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
  }

  async getUnreadNotificationCount(userId: string, organizationId?: string): Promise<number> {
    if (organizationId) {
      const [result] = await db.select({ count: count() }).from(notifications)
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.organizationId, organizationId),
          eq(notifications.isRead, false)
        ));
      return result?.count || 0;
    }
    const [result] = await db.select({ count: count() }).from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      ));
    return result?.count || 0;
  }

  async createNotification(notification: InsertNotification): Promise<Notification> {
    const [newNotification] = await db.insert(notifications).values(notification).returning();
    return newNotification;
  }

  async markNotificationRead(id: string): Promise<Notification | undefined> {
    const [notification] = await db.update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(eq(notifications.id, id))
      .returning();
    return notification;
  }

  async markAllNotificationsRead(userId: string, organizationId?: string): Promise<number> {
    if (organizationId) {
      const result = await db.update(notifications)
        .set({ isRead: true, readAt: new Date() })
        .where(and(
          eq(notifications.userId, userId),
          eq(notifications.organizationId, organizationId),
          eq(notifications.isRead, false)
        ))
        .returning();
      return result.length;
    }
    const result = await db.update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.isRead, false)
      ))
      .returning();
    return result.length;
  }

  async deleteNotification(id: string): Promise<boolean> {
    await db.delete(notifications).where(eq(notifications.id, id));
    return true;
  }

  async deleteOldNotifications(daysOld: number): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    const result = await db.delete(notifications)
      .where(lte(notifications.createdAt, cutoffDate))
      .returning();
    return result.length;
  }

  async markInvoiceEmailFailureNotificationsRead(transactionId: string): Promise<number> {
    const result = await db.update(notifications)
      .set({ isRead: true, readAt: new Date() })
      .where(and(
        eq(notifications.transactionId, transactionId),
        eq(notifications.type, 'invoice_email_failed'),
        eq(notifications.isRead, false),
      ))
      .returning();
    return result.length;
  }

  async findInvoiceEmailsDueForRetry(opts: { maxRetries: number; backoffMinutes: number[]; limit?: number }): Promise<Transaction[]> {
    // Auto-retries explicitly disabled — short-circuit so we don't hit the DB
    // and so the bucket logic below doesn't have to special-case zero buckets.
    if (opts.maxRetries <= 0) return [];
    // We need rows where:
    //   invoice_email_status = 'failed'
    //   invoice_email_retry_count < maxRetries
    //   invoice_email_last_recipients IS NOT NULL
    //   invoice_email_last_attempt_at < (now - backoff_for(retry_count))
    // The backoff differs per retry_count, so build per-bucket conditions.
    const buckets = [];
    for (let i = 0; i < opts.maxRetries; i++) {
      const minutes = opts.backoffMinutes[Math.min(i, opts.backoffMinutes.length - 1)] ?? 5;
      buckets.push(and(
        eq(transactions.invoiceEmailRetryCount, i),
        lt(transactions.invoiceEmailLastAttemptAt, sql`now() - (${minutes} || ' minutes')::interval`),
      ));
    }
    const dueByBucket = buckets.length === 1 ? buckets[0] : or(...buckets);
    const rows = await db.select().from(transactions).where(and(
      eq(transactions.invoiceEmailStatus, 'failed'),
      isNotNull(transactions.invoiceEmailLastRecipients),
      lt(transactions.invoiceEmailRetryCount, opts.maxRetries),
      dueByBucket!,
    )).limit(opts.limit ?? 50);
    return rows;
  }

  async getWhatsappPreferences(userId: string, organizationId: string): Promise<WhatsappPreferences | undefined> {
    const [prefs] = await db.select().from(whatsappPreferences)
      .where(and(
        eq(whatsappPreferences.userId, userId),
        eq(whatsappPreferences.organizationId, organizationId)
      ));
    return prefs;
  }

  async upsertWhatsappPreferences(userId: string, organizationId: string, updates: Partial<InsertWhatsappPreferences>): Promise<WhatsappPreferences> {
    const existing = await this.getWhatsappPreferences(userId, organizationId);
    if (existing) {
      const [updated] = await db.update(whatsappPreferences)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(whatsappPreferences.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(whatsappPreferences)
      .values({ userId, organizationId, ...updates })
      .returning();
    return created;
  }

  async getDashboardPreferences(userId: string, organizationId: string): Promise<DashboardPreferences | undefined> {
    const [prefs] = await db.select().from(dashboardPreferences)
      .where(and(
        eq(dashboardPreferences.userId, userId),
        eq(dashboardPreferences.organizationId, organizationId)
      ));
    return prefs;
  }

  async upsertDashboardPreferences(userId: string, organizationId: string, updates: Partial<InsertDashboardPreferences>): Promise<DashboardPreferences> {
    const existing = await this.getDashboardPreferences(userId, organizationId);
    if (existing) {
      const [updated] = await db.update(dashboardPreferences)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(dashboardPreferences.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(dashboardPreferences)
      .values({ userId, organizationId, ...updates })
      .returning();
    return created;
  }

  // ============== CLIENT INVOICE EMAIL PREFERENCES ==============
  async getClientInvoiceEmailPrefs(clientId: string): Promise<ClientInvoiceEmailPrefs | undefined> {
    const [prefs] = await db.select().from(clientInvoiceEmailPrefs)
      .where(eq(clientInvoiceEmailPrefs.clientId, clientId));
    return prefs;
  }

  async upsertClientInvoiceEmailPrefs(
    organizationId: string,
    clientId: string,
    updates: { defaultCcEmails: string[]; sendCopyToSelf: boolean }
  ): Promise<ClientInvoiceEmailPrefs> {
    const existing = await this.getClientInvoiceEmailPrefs(clientId);
    if (existing) {
      const [updated] = await db.update(clientInvoiceEmailPrefs)
        .set({
          defaultCcEmails: updates.defaultCcEmails,
          sendCopyToSelf: updates.sendCopyToSelf,
          updatedAt: new Date(),
        })
        .where(eq(clientInvoiceEmailPrefs.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(clientInvoiceEmailPrefs)
      .values({
        organizationId,
        clientId,
        defaultCcEmails: updates.defaultCcEmails,
        sendCopyToSelf: updates.sendCopyToSelf,
      })
      .returning();
    return created;
  }

  // ============== SUPPLIER INVOICE EMAIL PREFERENCES ==============
  async getSupplierInvoiceEmailPrefs(supplierId: string): Promise<SupplierInvoiceEmailPrefs | undefined> {
    const [prefs] = await db.select().from(supplierInvoiceEmailPrefs)
      .where(eq(supplierInvoiceEmailPrefs.supplierId, supplierId));
    return prefs;
  }

  async upsertSupplierInvoiceEmailPrefs(
    organizationId: string,
    supplierId: string,
    updates: { defaultCcEmails: string[]; sendCopyToSelf: boolean }
  ): Promise<SupplierInvoiceEmailPrefs> {
    const existing = await this.getSupplierInvoiceEmailPrefs(supplierId);
    if (existing) {
      const [updated] = await db.update(supplierInvoiceEmailPrefs)
        .set({
          defaultCcEmails: updates.defaultCcEmails,
          sendCopyToSelf: updates.sendCopyToSelf,
          updatedAt: new Date(),
        })
        .where(eq(supplierInvoiceEmailPrefs.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(supplierInvoiceEmailPrefs)
      .values({
        organizationId,
        supplierId,
        defaultCcEmails: updates.defaultCcEmails,
        sendCopyToSelf: updates.sendCopyToSelf,
      })
      .returning();
    return created;
  }

  // ============== TAX PROFILE ==============
  async getTaxProfile(organizationId: string): Promise<TaxProfile | undefined> {
    const [row] = await db.select().from(taxProfiles).where(eq(taxProfiles.organizationId, organizationId)).limit(1);
    return row;
  }

  async upsertTaxProfile(organizationId: string, updates: Partial<InsertTaxProfile>): Promise<TaxProfile> {
    const existing = await this.getTaxProfile(organizationId);
    if (existing) {
      const [updated] = await db.update(taxProfiles)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(taxProfiles.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(taxProfiles)
      .values({ organizationId, ...updates } as InsertTaxProfile)
      .returning();
    return created;
  }

  // ============================================================================
  // Invoicing (Facturita)
  // ============================================================================
  async getInvoicingAccount(organizationId: string): Promise<InvoicingAccount | undefined> {
    const [acc] = await db.select().from(invoicingAccounts).where(eq(invoicingAccounts.organizationId, organizationId));
    return acc;
  }

  async upsertInvoicingAccount(organizationId: string, data: Partial<InsertInvoicingAccount>): Promise<InvoicingAccount> {
    const existing = await this.getInvoicingAccount(organizationId);
    if (existing) {
      const [updated] = await db.update(invoicingAccounts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(invoicingAccounts.organizationId, organizationId))
        .returning();
      return updated;
    }
    if (!data.cuit || !data.ivaCondition) {
      throw new Error('Faltan campos obligatorios (cuit, ivaCondition) para crear la cuenta de facturación');
    }
    const [created] = await db.insert(invoicingAccounts).values({
      organizationId,
      cuit: data.cuit,
      adminCuit: data.adminCuit ?? null,
      ivaCondition: data.ivaCondition,
      environment: data.environment ?? 'sandbox',
      razonSocial: data.razonSocial ?? null,
      defaultSellingPoint: data.defaultSellingPoint ?? null,
      encryptedCert: data.encryptedCert ?? null,
      encryptedKey: data.encryptedKey ?? null,
      isActive: data.isActive ?? false,
      isSimulated: data.isSimulated ?? false,
      lastValidatedAt: data.lastValidatedAt ?? null,
      lastSyncedAt: data.lastSyncedAt ?? null,
      notes: data.notes ?? null,
      createdBy: data.createdBy ?? null,
    }).returning();
    return created;
  }

  async getSellingPointsByOrganization(organizationId: string): Promise<InvoicingSellingPoint[]> {
    return db.select().from(invoicingSellingPoints)
      .where(eq(invoicingSellingPoints.organizationId, organizationId))
      .orderBy(asc(invoicingSellingPoints.number));
  }

  async replaceSellingPoints(organizationId: string, items: Array<{ number: number; description?: string | null; isActive?: boolean }>): Promise<InvoicingSellingPoint[]> {
    return db.transaction(async (tx) => {
      await tx.delete(invoicingSellingPoints).where(eq(invoicingSellingPoints.organizationId, organizationId));
      if (items.length === 0) return [];
      const inserted = await tx.insert(invoicingSellingPoints)
        .values(items.map(it => ({
          organizationId,
          number: it.number,
          description: it.description ?? null,
          isActive: it.isActive ?? true,
        })))
        .returning();
      return inserted;
    });
  }

  async getEmittedInvoicesByOrganization(organizationId: string, filters: { startDate?: string; endDate?: string; environment?: string; status?: string; clientId?: string; docType?: string; emitterCuit?: string } = {}): Promise<Array<Transaction & { clientName: string | null; clientTaxId: string | null }>> {
    const conditions = [
      eq(transactions.organizationId, organizationId),
      sql`${transactions.invoiceUuid} IS NOT NULL`,
    ];
    if (filters.startDate) conditions.push(gte(transactions.invoiceEmittedAt, new Date(filters.startDate)));
    if (filters.endDate) {
      // `endDate` arrives as a date-only string (YYYY-MM-DD). `new Date(...)`
      // would parse it as 00:00 UTC and exclude every invoice emitted later
      // on the same day. Push it to end-of-day so today's invoices are included.
      const end = new Date(filters.endDate);
      end.setUTCHours(23, 59, 59, 999);
      conditions.push(lte(transactions.invoiceEmittedAt, end));
    }
    if (filters.environment) conditions.push(eq(transactions.invoiceEnvironment, filters.environment));
    if (filters.status) conditions.push(eq(transactions.invoiceEmissionStatus, filters.status));
    if (filters.docType) conditions.push(eq(transactions.invoiceDocType, filters.docType));
    if (filters.clientId) conditions.push(eq(transactions.clientId, filters.clientId));
    if (filters.emitterCuit) conditions.push(eq(transactions.invoiceEmitterCuit, filters.emitterCuit));
    const rows = await db.select({
      transaction: transactions,
      clientName: clients.name,
      clientTaxId: clients.taxId,
    })
      .from(transactions)
      .leftJoin(clients, and(eq(clients.id, transactions.clientId), eq(clients.organizationId, transactions.organizationId)))
      .where(and(...conditions))
      .orderBy(desc(transactions.invoiceEmittedAt));
    return rows.map(r => ({
      ...r.transaction,
      clientName: r.clientName ?? null,
      clientTaxId: r.clientTaxId ?? r.transaction.invoiceTaxId ?? null,
    }));
  }

  // ===== Business settings (singleton) =====
  async getBusinessSettings(): Promise<BusinessSettings | undefined> {
    const [row] = await db.select().from(businessSettings)
      .where(eq(businessSettings.id, BUSINESS_SETTINGS_SINGLETON_ID));
    return row;
  }

  async upsertBusinessSettings(values: UpdateBusinessSettings, updatedBy: string | null): Promise<BusinessSettings> {
    const [row] = await db.insert(businessSettings)
      .values({
        id: BUSINESS_SETTINGS_SINGLETON_ID,
        usdArsRate: values.usdArsRate,
        cacUsdMin: values.cacUsdMin,
        cacUsdMax: values.cacUsdMax,
        ltvCacRatio: values.ltvCacRatio,
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: businessSettings.id,
        set: {
          usdArsRate: values.usdArsRate,
          cacUsdMin: values.cacUsdMin,
          cacUsdMax: values.cacUsdMax,
          ltvCacRatio: values.ltvCacRatio,
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  // ===== Acquisition spend (gasto de adquisición por mes) =====
  async getAcquisitionSpends(): Promise<AcquisitionSpend[]> {
    return await db.select().from(acquisitionSpend).orderBy(desc(acquisitionSpend.month));
  }

  async upsertAcquisitionSpend(values: UpsertAcquisitionSpend, updatedBy: string | null): Promise<AcquisitionSpend> {
    const [row] = await db.insert(acquisitionSpend)
      .values({
        month: values.month,
        amountArs: values.amountArs,
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: acquisitionSpend.month,
        set: {
          amountArs: values.amountArs,
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async deleteAcquisitionSpend(month: string): Promise<void> {
    await db.delete(acquisitionSpend).where(eq(acquisitionSpend.month, month));
  }

  // Task #433: configuración de derivación automática del gasto de adquisición.
  // Actualiza SOLO las columnas de derivación del singleton business_settings,
  // preservando los KPI ya cargados. Si la fila no existe todavía, se inserta
  // con los defaults de KPI (la lectura de KPI cae a esos mismos defaults).
  async upsertAcquisitionConfig(values: UpdateAcquisitionConfig, updatedBy: string | null): Promise<BusinessSettings> {
    const [row] = await db.insert(businessSettings)
      .values({
        id: BUSINESS_SETTINGS_SINGLETON_ID,
        usdArsRate: USD_ARS_RATE_DEFAULT,
        cacUsdMin: SAAS_KPI_ESTIMATES.cacUsdMin,
        cacUsdMax: SAAS_KPI_ESTIMATES.cacUsdMax,
        ltvCacRatio: SAAS_KPI_ESTIMATES.ltvCacRatio,
        acquisitionAutoEnabled: values.acquisitionAutoEnabled,
        acquisitionOrgId: values.acquisitionOrgId,
        acquisitionAccountIds: values.acquisitionAccountIds,
        acquisitionCategories: values.acquisitionCategories,
        acquisitionProfitabilityCodeIds: values.acquisitionProfitabilityCodeIds,
        updatedBy,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: businessSettings.id,
        set: {
          acquisitionAutoEnabled: values.acquisitionAutoEnabled,
          acquisitionOrgId: values.acquisitionOrgId,
          acquisitionAccountIds: values.acquisitionAccountIds,
          acquisitionCategories: values.acquisitionCategories,
          acquisitionProfitabilityCodeIds: values.acquisitionProfitabilityCodeIds,
          updatedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async getAllOrganizations(): Promise<Organization[]> {
    return await db.select().from(organizations).orderBy(asc(organizations.name));
  }
}

export const storage = new DatabaseStorage();
