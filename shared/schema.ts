import { sql } from "drizzle-orm";
import { pgTable, text, varchar, decimal, doublePrecision, timestamp, boolean, integer, uniqueIndex, jsonb, primaryKey, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// Account types (for users)
export const ACCOUNT_TYPES = ['personal', 'business'] as const;

export const ARCA_INVOICE_NUMBER_REGEX = /^\d{4}-\d{8}$/;

export function normalizeArcaInvoiceNumber(input: string | null | undefined): string {
  if (input == null) return '';
  const cleaned = String(input).replace(/\s+/g, '').replace(/[–—]/g, '-');
  const m = cleaned.match(/^(\d{1,4})-(\d{1,8})$/);
  if (m) {
    return `${m[1].padStart(4, '0')}-${m[2].padStart(8, '0')}`;
  }
  return cleaned;
}

export function isValidArcaInvoiceNumber(input: string | null | undefined): boolean {
  if (input == null) return false;
  return ARCA_INVOICE_NUMBER_REGEX.test(normalizeArcaInvoiceNumber(input));
}
export type AccountType = typeof ACCOUNT_TYPES[number];

// Financial account types (for bank accounts, investments, etc.)
export const FINANCIAL_ACCOUNT_TYPES = ['cash', 'bank', 'wallet', 'credit_card', 'investment', 'broker', 'crypto', 'fintech', 'fixed_term', 'other', 'other_investment'] as const;
export type FinancialAccountType = typeof FINANCIAL_ACCOUNT_TYPES[number];

export const FINANCIAL_ACCOUNT_TYPE_CONFIG: Record<FinancialAccountType, { label: string; icon: string; color: string; bgColor: string; group: string; category: 'operative' | 'investment' }> = {
  'bank': { label: 'Cuenta Bancaria', icon: 'Building2', color: 'text-blue-600', bgColor: 'bg-blue-100', group: 'Cuentas Bancarias', category: 'operative' },
  'cash': { label: 'Caja / Efectivo', icon: 'Wallet', color: 'text-green-600', bgColor: 'bg-green-100', group: 'Cajas y Efectivo', category: 'operative' },
  'wallet': { label: 'Billetera Digital', icon: 'Smartphone', color: 'text-purple-600', bgColor: 'bg-purple-100', group: 'Billeteras Digitales', category: 'operative' },
  'credit_card': { label: 'Tarjeta de Crédito', icon: 'CreditCard', color: 'text-orange-600', bgColor: 'bg-orange-100', group: 'Tarjetas de Crédito', category: 'operative' },
  'investment': { label: 'Inversiones', icon: 'TrendingUp', color: 'text-emerald-600', bgColor: 'bg-emerald-100', group: 'Inversiones', category: 'investment' },
  'broker': { label: 'Broker', icon: 'BarChart3', color: 'text-indigo-600', bgColor: 'bg-indigo-100', group: 'Brokers', category: 'investment' },
  'crypto': { label: 'Cripto', icon: 'Bitcoin', color: 'text-amber-600', bgColor: 'bg-amber-100', group: 'Cripto', category: 'investment' },
  'fintech': { label: 'Fintech', icon: 'Zap', color: 'text-cyan-600', bgColor: 'bg-cyan-100', group: 'Fintech', category: 'investment' },
  'fixed_term': { label: 'Plazo Fijo', icon: 'Lock', color: 'text-teal-600', bgColor: 'bg-teal-100', group: 'Plazos Fijos', category: 'investment' },
  'other': { label: 'Otro', icon: 'MoreHorizontal', color: 'text-gray-600', bgColor: 'bg-gray-100', group: 'Otras Cuentas', category: 'operative' },
  'other_investment': { label: 'Otro', icon: 'MoreHorizontal', color: 'text-gray-600', bgColor: 'bg-gray-100', group: 'Otras Inversiones', category: 'investment' },
};

export const OPERATIVE_ACCOUNT_TYPES = FINANCIAL_ACCOUNT_TYPES.filter(t => FINANCIAL_ACCOUNT_TYPE_CONFIG[t].category === 'operative');
export const INVESTMENT_ACCOUNT_TYPES = FINANCIAL_ACCOUNT_TYPES.filter(t => FINANCIAL_ACCOUNT_TYPE_CONFIG[t].category === 'investment');

// Organization types
export const ORGANIZATION_TYPES = ['personal', 'business'] as const;
export type OrganizationType = typeof ORGANIZATION_TYPES[number];

// Supported countries
export const COUNTRIES = ['AR', 'CO', 'MX', 'CL', 'PE', 'UY', 'BR', 'US', 'ES'] as const;
export type Country = typeof COUNTRIES[number];

export const COUNTRY_LABELS: Record<Country, string> = {
  'AR': 'Argentina',
  'CO': 'Colombia',
  'MX': 'México',
  'CL': 'Chile',
  'PE': 'Perú',
  'UY': 'Uruguay',
  'BR': 'Brasil',
  'US': 'Estados Unidos',
  'ES': 'España',
};

// Supported currencies (moved before organizations for use in insertOrganizationSchema)
export const CURRENCIES = ['ARS', 'COP', 'MXN', 'CLP', 'PEN', 'UYU', 'BRL', 'USD', 'USD_CASH', 'EUR'] as const;
export type Currency = typeof CURRENCIES[number];

export const CURRENCY_LABELS: Record<Currency, string> = {
  'ARS': 'Pesos Argentinos',
  'COP': 'Pesos Colombianos',
  'MXN': 'Pesos Mexicanos',
  'CLP': 'Pesos Chilenos',
  'PEN': 'Soles Peruanos',
  'UYU': 'Pesos Uruguayos',
  'BRL': 'Reales Brasileños',
  'USD': 'Dólares (Banco)',
  'USD_CASH': 'Dólares (Efectivo)',
  'EUR': 'Euros',
};

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  'ARS': 'AR$',
  'COP': 'COP$',
  'MXN': 'MX$',
  'CLP': 'CLP$',
  'PEN': 'S/',
  'UYU': 'UY$',
  'BRL': 'R$',
  'USD': 'US$',
  'USD_CASH': 'US$',
  'EUR': '€',
};

// Country to default currency mapping
export const COUNTRY_CURRENCY_MAP: Record<Country, Currency> = {
  'AR': 'ARS',
  'CO': 'COP',
  'MX': 'MXN',
  'CL': 'CLP',
  'PE': 'PEN',
  'UY': 'UYU',
  'BR': 'BRL',
  'US': 'USD',
  'ES': 'EUR',
};

// Users table
// Task #343 — `email` ya NO tiene un UNIQUE duro; se reemplazó por un índice
// único parcial `users_email_active_unique` definido más abajo, que sólo
// aplica a registros con `deleted_at IS NULL`. Esto permite que un usuario
// soft-deleted libere su email para que alguien pueda re-registrarse.
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  name: text("name").notNull(),
  password: text("password").notNull(),
  accountType: text("account_type").notNull().default('business'),
  profileImageUrl: text("profile_image_url"),
  profileIconKey: text("profile_icon_key"),
  mustChangePassword: boolean("must_change_password").default(false),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  mpSubscriptionId: text("mp_subscription_id"), // MercadoPago preapproval id
  isAdmin: boolean("is_admin").default(false),
  phoneNumber: text("phone_number"),
  phoneVerified: boolean("phone_verified").default(false),
  pendingPhoneNumber: text("pending_phone_number"),
  // Marca cuándo se cargó por última vez `phoneNumber` SIN verificar.
  // Lo usa el banner del dashboard (Task #219) para detectar usuarios que
  // dejaron el wizard de WhatsApp a la mitad: si pasó más de 24h con
  // phoneNumber cargado y phoneVerified=false, mostramos el recordatorio.
  // Se setea cuando se asigna un phoneNumber sin verificar (signup) y se
  // limpia (NULL) cuando el número se desvincula o se verifica con éxito.
  phoneNumberAddedAt: timestamp("phone_number_added_at"),
  lastActiveOrganizationId: varchar("last_active_organization_id"),
  // Organización predeterminada del bot de WhatsApp.
  // Es independiente de `lastActiveOrganizationId` (que es la última org
  // abierta en la web). Sólo el usuario la cambia desde Configuración →
  // Preferencias de WhatsApp; el bot NUNCA la sobrescribe automáticamente.
  // Si es null, el bot cae al fallback histórico (lastActiveOrganizationId).
  whatsappDefaultOrganizationId: varchar("whatsapp_default_organization_id"),
  // Marca si la default del bot ya fue inicializada (manual o por auto-assign).
  // Se setea a true en cualquier PUT explícito a /api/user/whatsapp-default-organization
  // (incluso cuando el valor es null) y también cuando el server hace auto-assign en
  // /api/whatsapp-preferences. El auto-assign sólo corre si este flag es false, así
  // un usuario que limpió explícitamente su default no vuelve a tener una asignada
  // silenciosamente al guardar preferencias.
  whatsappDefaultOrgInitialized: boolean("whatsapp_default_org_initialized").default(false),
  preferredName: text("preferred_name"),
  whatsappWelcomed: boolean("whatsapp_welcomed").default(false),
  // Última vez que el usuario nos mandó un mensaje por WhatsApp.
  // Persistido en DB (Task #211) para que el banner de org activa
  // (Task #209) no se vuelva a disparar después de cada reinicio del
  // server. Antes vivía en un Map en memoria en `whatsappSessionState`.
  lastWhatsappMessageAt: timestamp("last_whatsapp_message_at"),
  inactiveReminderSentAt: timestamp("inactive_reminder_sent_at"),
  // Constancia de aceptación de los Términos y Condiciones al registrarse.
  // Se completa con la fecha/hora en que el usuario tildó la casilla obligatoria
  // del formulario de registro. NULL para usuarios creados antes de esta política
  // o por flujos que no la exigen (p. ej. invitaciones de equipo).
  termsAcceptedAt: timestamp("terms_accepted_at"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Task #343 — único parcial case-insensitive sobre el email para usuarios
  // ACTIVOS. Permite re-registro con el mismo email después de un soft-delete
  // (deleted_at != null), preservando el registro viejo para auditoría.
  emailActiveUnique: uniqueIndex("users_email_active_unique")
    .on(sql`LOWER(${table.email})`)
    .where(sql`${table.deletedAt} IS NULL`),
}));

// Session logs for admin tracking (login/logout history)
export const sessionLogs = pgTable("session_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  action: text("action").notNull(), // 'login' | 'logout'
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSessionLogSchema = createInsertSchema(sessionLogs).omit({
  id: true,
  createdAt: true,
});
export type InsertSessionLog = z.infer<typeof insertSessionLogSchema>;
export type SessionLog = typeof sessionLogs.$inferSelect;

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Password reset tokens table
export const passwordResets = pgTable("password_resets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PasswordReset = typeof passwordResets.$inferSelect;

// Phone verification codes — Task #212. Stores the active 6-digit code
// (hashed) the user must enter to prove control of a WhatsApp number before
// the binding becomes effective. One row per user (the most recent send
// supersedes any previous one). The code itself is never persisted.
export const phoneVerificationCodes = pgTable("phone_verification_codes", {
  userId: varchar("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  normalizedPhone: text("normalized_phone").notNull(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  sendsInWindow: integer("sends_in_window").notNull().default(1),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PhoneVerificationCode = typeof phoneVerificationCodes.$inferSelect;

// Organizations table
export const organizations = pgTable("organizations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull().default('business'),
  country: text("country").notNull().default('AR'),
  defaultCurrency: text("default_currency").notNull().default('ARS'),
  logoUrl: text("logo_url"),
  iconKey: text("icon_key"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  // Preestablecido propio de los PDF de presupuestos (separado de la identidad de
  // la organización de arriba, que se usa en el resto de la app). Sirve como
  // valor por defecto para todos los presupuestos cuando no tienen datos propios.
  quotePdfLogoUrl: text("quote_pdf_logo_url"),
  quotePdfContactEmail: text("quote_pdf_contact_email"),
  quotePdfContactPhone: text("quote_pdf_contact_phone"),
  quotePdfCompanyName: text("quote_pdf_company_name"),
  quotePdfContactName: text("quote_pdf_contact_name"),
  transactionCounter: integer("transaction_counter").notNull().default(0),
  payrollPayDay: integer("payroll_pay_day"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrganizationSchema = createInsertSchema(organizations, {
  country: z.enum(COUNTRIES).default('AR'),
  defaultCurrency: z.enum(CURRENCIES).default('ARS'),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizations.$inferSelect;

// Role definitions
export const ROLES = ['owner', 'admin', 'specialist', 'operator', 'viewer'] as const;
export type Role = typeof ROLES[number];

export const ROLE_LABELS: Record<Role, string> = {
  'owner': 'Propietario',
  'admin': 'Administrador',
  'specialist': 'Especialista',
  'operator': 'Operador',
  'viewer': 'Veedor',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  'owner': 'Propietario de la organizacion con acceso total',
  'admin': 'Acceso total: puede configurar, crear usuarios y gestionar todo',
  'specialist': 'Puede gestionar movimientos, cuentas y exportar reportes',
  'operator': 'Solo puede gestionar movimientos y exportar reportes',
  'viewer': 'Solo lectura: puede ver pero no modificar nada',
};

// What each role CAN and CANNOT do, in plain Spanish (used in UI guides
// and in the "no tenés permiso" dialog).
export const ROLE_CAPABILITIES: Record<Role, { can: string[]; cannot: string[] }> = {
  'owner': {
    can: [
      'Hacer absolutamente todo en la organización',
      'Cambiar planes y datos de facturación',
      'Eliminar la organización',
    ],
    cannot: [],
  },
  'admin': {
    can: [
      'Crear, editar y eliminar movimientos y cuentas',
      'Invitar y gestionar miembros y roles',
      'Cambiar la configuración de la organización',
      'Exportar reportes',
    ],
    cannot: ['Eliminar la organización o cambiar el plan (eso lo hace el Propietario)'],
  },
  'specialist': {
    can: [
      'Crear, editar y eliminar movimientos',
      'Crear y editar cuentas',
      'Exportar reportes',
    ],
    cannot: [
      'Eliminar cuentas',
      'Invitar miembros o cambiar roles',
      'Cambiar la configuración de la organización',
    ],
  },
  'operator': {
    can: [
      'Crear y editar movimientos',
      'Exportar reportes',
    ],
    cannot: [
      'Eliminar movimientos',
      'Crear, editar o eliminar cuentas',
      'Invitar miembros o cambiar roles',
      'Cambiar la configuración de la organización',
    ],
  },
  'viewer': {
    can: ['Ver toda la información de la organización', 'Exportar reportes'],
    cannot: ['Crear, editar o eliminar nada'],
  },
};

// Permission definitions
export const PERMISSIONS = [
  'transactions:create',
  'transactions:edit',
  'transactions:delete',
  'accounts:create',
  'accounts:edit',
  'accounts:delete',
  'users:manage',
  'organization:settings',
  'reports:export',
] as const;
export type Permission = typeof PERMISSIONS[number];

// Human-readable label for each permission used in error dialogs.
export const PERMISSION_LABELS: Record<Permission, string> = {
  'transactions:create': 'crear movimientos',
  'transactions:edit': 'editar movimientos',
  'transactions:delete': 'eliminar movimientos',
  'accounts:create': 'crear cuentas',
  'accounts:edit': 'editar cuentas',
  'accounts:delete': 'eliminar cuentas',
  'users:manage': 'gestionar miembros del equipo',
  'organization:settings': 'cambiar la configuración de la organización',
  'reports:export': 'exportar reportes',
};

// Minimum role that grants each permission, used to suggest who to ask in
// the "no tenés permiso" dialog.
export const PERMISSION_MIN_ROLE: Record<Permission, Role> = {
  'transactions:create': 'operator',
  'transactions:edit': 'operator',
  'transactions:delete': 'specialist',
  'accounts:create': 'specialist',
  'accounts:edit': 'specialist',
  'accounts:delete': 'admin',
  'users:manage': 'admin',
  'organization:settings': 'admin',
  'reports:export': 'viewer',
};

// Role-permission mapping
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  'owner': [...PERMISSIONS],
  'admin': [...PERMISSIONS],
  'specialist': [
    'transactions:create',
    'transactions:edit',
    'transactions:delete',
    'accounts:create',
    'accounts:edit',
    'reports:export',
  ],
  'operator': [
    'transactions:create',
    'transactions:edit',
    'reports:export',
  ],
  'viewer': [
    'reports:export',
  ],
};

// Roles that can assign other roles (admin-like roles)
export const ADMIN_ROLES: Role[] = ['owner', 'admin'];

// Roles that can be assigned by admins (excludes owner)
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'specialist', 'operator', 'viewer'];

// Memberships (User-Organization relationship)
export const memberships = pgTable("memberships", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMembershipSchema = createInsertSchema(memberships, {
  role: z.enum(ROLES).default('operator'),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type Membership = typeof memberships.$inferSelect;

// Accounts table
export const accounts = pgTable("accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull(), // 'cash', 'bank', 'wallet', 'credit_card'
  customTypeLabel: text("custom_type_label"),
  currency: text("currency").notNull().default("ARS"), // 'ARS', 'USD', 'USD_CASH', 'EUR'
  balance: decimal("balance", { precision: 15, scale: 2 }).notNull().default("0"),
  initialInvestment: decimal("initial_investment", { precision: 15, scale: 2 }),
  maturityDate: timestamp("maturity_date"),
  interestRate: decimal("interest_rate", { precision: 8, scale: 4 }),
  interestFrequency: text("interest_frequency"),
  interestStartDate: timestamp("interest_start_date"),
  accountCategory: text("account_category").notNull().default("operative"),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const INTEREST_FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type InterestFrequency = typeof INTEREST_FREQUENCIES[number];
export const INTEREST_FREQUENCY_LABELS: Record<InterestFrequency, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  monthly: 'Mensual',
  yearly: 'Anual',
};

export const insertAccountSchema = createInsertSchema(accounts, {
  balance: z.string().or(z.number()).transform(val => String(val)),
  initialInvestment: z.string().or(z.number()).transform(val => val ? String(val) : null).optional().nullable(),
  maturityDate: z.string().or(z.date()).optional().nullable(),
  currency: z.enum(CURRENCIES).optional().default('ARS'),
  customTypeLabel: z.string().optional().nullable(),
  interestRate: z.string().or(z.number())
    .transform(val => val === '' || val === null || val === undefined ? null : String(val))
    .refine(
      (val) => {
        if (val === null) return true;
        const n = parseFloat(val);
        return !isNaN(n) && n >= 0 && n < 10000;
      },
      { message: 'La tasa de interés debe ser un número entre 0 y 9999,99' }
    )
    .optional().nullable(),
  interestFrequency: z.string().optional().nullable(),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accounts.$inferSelect;

// Transaction status types
export const TRANSACTION_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type TransactionStatus = typeof TRANSACTION_STATUSES[number];

// Asset types for AI classification
export const ASSET_TYPES = ['expense', 'asset_acquisition', 'investment', 'income'] as const;
export type AssetType = typeof ASSET_TYPES[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  'expense': 'Gasto Operativo',
  'asset_acquisition': 'Adquisición de Activo',
  'investment': 'Inversión',
  'income': 'Ingreso',
};

// Asset categories for capitalized assets
export const ASSET_CATEGORIES = [
  'real_estate',      // Inmuebles
  'vehicle',          // Vehículos
  'machinery',        // Maquinaria
  'equipment',        // Equipos
  'furniture',        // Mobiliario
  'technology',       // Tecnología (computadoras, etc.)
  'intangible',       // Intangibles (patentes, licencias)
  'investment',       // Inversiones financieras
  'other'             // Otros
] as const;
export type AssetCategory = typeof ASSET_CATEGORIES[number];

export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  'real_estate': 'Inmueble',
  'vehicle': 'Vehículo',
  'machinery': 'Maquinaria',
  'equipment': 'Equipo',
  'furniture': 'Mobiliario',
  'technology': 'Tecnología',
  'intangible': 'Intangible',
  'investment': 'Inversión Financiera',
  'other': 'Otro',
};

// Default useful life in months by asset category
export const ASSET_USEFUL_LIFE: Record<AssetCategory, number> = {
  'real_estate': 240,     // 20 years
  'vehicle': 60,          // 5 years
  'machinery': 120,       // 10 years
  'equipment': 60,        // 5 years
  'furniture': 60,        // 5 years
  'technology': 36,       // 3 years
  'intangible': 60,       // 5 years
  'investment': 0,        // No depreciation
  'other': 60,            // 5 years default
};

// Transactions table
export const transactions = pgTable("transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // 'income', 'expense', 'payable', 'receivable', 'transfer_out', 'transfer_in'
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  currency: text("currency").default("ARS"), // Currency code (ARS, USD, USD_CASH, etc.)
  description: text("description").notNull(),
  // Task #252: nullable so the API contract can express "movement without
  // category". Validated against `transactionCategories` on every write.
  category: text("category"),
  date: timestamp("date").notNull(), // Real transaction date / due date for scheduled
  imputationDate: timestamp("imputation_date").notNull(), // Accounting imputation date
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "set null" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  hasInvoice: boolean("has_invoice").notNull().default(false),
  invoiceType: text("invoice_type"),
  invoiceNumber: text("invoice_number"),
  invoiceTaxId: text("invoice_tax_id"),
  invoiceFileUrl: text("invoice_file_url"),
  status: text("status").notNull().default("completed"), // 'scheduled', 'completed', 'cancelled'
  // AI Classification fields
  assetType: text("asset_type"), // 'expense', 'asset_acquisition', 'investment', 'income'
  aiClassificationConfidence: decimal("ai_classification_confidence", { precision: 3, scale: 2 }), // 0.00 to 1.00
  classificationOverriddenBy: varchar("classification_overridden_by").references(() => users.id, { onDelete: "set null" }),
  classificationOverriddenAt: timestamp("classification_overridden_at"),
  // Relations to operational database
  clientId: varchar("client_id"),
  projectId: varchar("project_id"),
  supplierId: varchar("supplier_id"),
  productId: varchar("product_id"),
  productQuantity: decimal("product_quantity", { precision: 15, scale: 2 }), // Quantity if linked to product
  profitabilityCodeId: varchar("profitability_code_id"), // Optional profitability analysis code
  paymentMethodId: varchar("payment_method_id"), // Task #229: optional payment method that auto-generated this transaction's child costs (set on parent income/receivable; null on the auto-generated children)
  trackingNumber: text("tracking_number"), // For tracking shipments, orders, etc.
  transactionNumber: text("transaction_number"), // Human-readable number like MOV-0001-PEPS
  originalTransactionData: text("original_transaction_data"), // JSON data of cancelled transaction
  linkedTransactionId: varchar("linked_transaction_id"), // Link to parent transaction for traceability
  transferPairId: varchar("transfer_pair_id"), // Links transfer_out to its corresponding transfer_in
  isUniquePayment: boolean("is_unique_payment").default(false), // Distinguish unique payables from recurring
  isRecurring: boolean("is_recurring").default(false), // If this is a recurring transaction
  recurrenceFrequency: text("recurrence_frequency"), // 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'
  recurrenceSourceId: varchar("recurrence_source_id"), // ID of original transaction this was generated from
  // Task #353: optional closed-series counter. When `recurrenceTotalInstallments`
  // is null the series is infinite (legacy behavior). When it's an integer >= 1,
  // the recurrence stops once `recurrenceCurrentInstallment` reaches that total
  // (i.e. confirming the N-th installment does NOT generate the next one).
  recurrenceTotalInstallments: integer("recurrence_total_installments"),
  recurrenceCurrentInstallment: integer("recurrence_current_installment"),
  expenseSubtype: text("expense_subtype"),
  externalId: text("external_id"), // ID del pedido en plataforma externa (ej. Tiendanube)
  externalSource: text("external_source"), // 'tiendanube' | null
  createdVia: text("created_via").default("web"),
  invoiceNetAmount: decimal("invoice_net_amount", { precision: 15, scale: 2 }),
  invoiceIvaAmount: decimal("invoice_iva_amount", { precision: 15, scale: 2 }),
  invoiceIvaAliquot: decimal("invoice_iva_aliquot", { precision: 5, scale: 2 }),
  invoiceOtherTaxes: decimal("invoice_other_taxes", { precision: 15, scale: 2 }),
  completedBy: varchar("completed_by").references(() => users.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  autoAppliedByTransactionId: varchar("auto_applied_by_transaction_id"),
  originalAmount: text("original_amount"),
  // Facturita / e-invoicing tracking
  invoiceUuid: text("invoice_uuid"), // Facturita's external UUID for the emitted invoice
  invoiceVoucherId: text("invoice_voucher_id"), // AFIP voucher number (Comprobante Nro)
  invoiceCae: text("invoice_cae"), // CAE returned by AFIP
  invoiceCaeExpirationDate: timestamp("invoice_cae_expiration_date"),
  invoicePdfUrl: text("invoice_pdf_url"), // Public URL to the PDF on Facturita
  invoiceEnvironment: text("invoice_environment"), // 'sandbox' | 'production' at moment of emission
  invoiceEmissionStatus: text("invoice_emission_status"), // see INVOICE_EMISSION_STATUSES
  invoiceEmissionErrorMessage: text("invoice_emission_error_message"), // user-facing Spanish message of last failure (persisted so we can show it after modal close)
  invoiceEmissionErrorCode: text("invoice_emission_error_code"), // internal code for grouping (e.g. BAD_CREDENTIALS, NOT_ACTIVE, NETWORK)
  invoiceEmissionErrorAt: timestamp("invoice_emission_error_at"),
  invoiceEmittedAt: timestamp("invoice_emitted_at"),
  invoiceDocType: text("invoice_doc_type"), // see INVOICING_DOC_TYPES (FA, FB, FC, NCA, NCB, NCC)
  invoiceEmitterCuit: text("invoice_emitter_cuit"), // Snapshot of emitter CUIT at emission time
  invoiceCreditNoteUuid: text("invoice_credit_note_uuid"), // If a credit note was emitted to cancel this invoice
  invoiceCreditNotePdfUrl: text("invoice_credit_note_pdf_url"), // Public PDF URL of the emitted credit note (separate from the original invoice PDF)
  invoiceSimulated: boolean("invoice_simulated").default(false), // True when emitted via internal sandbox mock (no fiscal validity)
  // Email delivery tracking for the emitted invoice PDF
  invoiceEmailStatus: text("invoice_email_status"), // 'sent' | 'failed' | null (never attempted)
  invoiceEmailLastAttemptAt: timestamp("invoice_email_last_attempt_at"),
  invoiceEmailLastError: text("invoice_email_last_error"),
  invoiceEmailLastRecipients: text("invoice_email_last_recipients"), // JSON: { to: string[], cc: string[], bcc: string[], message?: string|null }
  invoiceEmailRetryCount: integer("invoice_email_retry_count").notNull().default(0), // # of automatic retries already attempted after the original send
  // Snapshot of receptor contact info at emission time (so the printed PDF
  // doesn't change if the client/supplier is later edited).
  invoiceAddress: text("invoice_address"),
  invoicePhone: text("invoice_phone"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Cancellation entries: when a completed transaction is "deleted", the
// system keeps it auditable by creating a mirror transaction with the
// inverse type and `status='completed'`. The mirror is identified by:
//   - description starts with `[CANCELACIÓN] `
//   - `originalTransactionData` is populated (JSON of the cancelled tx)
// These mirrors must NEVER count towards income/expense/cashflow totals
// in any report or in the calendar — they exist only for the audit trail.
// The original (now `status='cancelled'`) is already excluded by the
// status filter, so totals stay consistent.
export const CANCELLATION_PREFIX = '[CANCELACIÓN] ';

export function isCancellationEntry(tx: {
  description?: string | null;
  originalTransactionData?: string | null;
}): boolean {
  if (!tx) return false;
  const desc = tx.description || '';
  if (!desc.startsWith('[CANCELACIÓN]')) return false;
  // Defensive: legacy mirrors may be missing originalTransactionData; treat
  // the prefix alone as authoritative since users cannot type it (the
  // create endpoint blocks `[CANCELACIÓN]` descriptions).
  return true;
}

const parseLocalDate = (val: string | Date): Date => {
  if (val instanceof Date) return val;
  const parts = val.split('-');
  if (parts.length === 3) {
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0);
  }
  return new Date(val);
};

// Shared refinement so the manual invoice number always follows ARCA's
// PPPP-NNNNNNNN format. ARCA-emitted invoices populate `invoiceVoucherId`
// separately, so this guards manual entries (and any direct API call that
// bypasses the frontend wizard).
export const INVOICE_NUMBER_FORMAT_MESSAGE =
  'Número de comprobante inválido. Usá el formato 0001-00001234 (4 dígitos, guion, 8 dígitos).';

export function refineInvoiceNumberFormat(
  data: {
    hasInvoice?: boolean | null;
    invoiceNumber?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  // Note: ARCA-emitted invoices populate `invoiceVoucherId` server-side
  // through internal code paths (see `server/routes/invoicing.ts`), never
  // through the public POST/PATCH `/api/transactions` endpoints. The API
  // payload schema strips `invoiceVoucherId` (see `transactionValidation.ts`)
  // so a malicious client cannot forge that field to bypass this check.
  if (!data.hasInvoice) return;
  const raw = data.invoiceNumber;
  if (raw === null || raw === undefined || raw === '') return;
  // Strict check against the canonical ARCA format on the RAW value: no
  // trim, no normalization, no auto-pad. Shorthand like "1-1",
  // "0001 - 00001234" or "  0001-00001234  " must be rejected at the API
  // boundary so direct callers cannot bypass the frontend's normalization.
  if (typeof raw !== 'string' || !ARCA_INVOICE_NUMBER_REGEX.test(raw)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['invoiceNumber'],
      message: INVOICE_NUMBER_FORMAT_MESSAGE,
    });
  }
}

// Change-aware enforcement of the canonical ARCA invoice-number format shared by
// every server edit path (`PATCH /api/transactions/:id` and the inline fiscal
// edit `PATCH /api/taxes/transactions/:id`). The canonical format is enforced
// ONLY when the incoming value actually changes from the stored one: editing any
// other field re-sends the existing number, and movements created before the
// format was enforced (or ARCA-emitted ones that store the bare voucher number)
// carry non-canonical values — re-validating them blindly would make those
// movements un-editable. Returns the error message when the new value is invalid,
// or null when the update is allowed.
export function invoiceNumberChangeError(
  incoming: string | null | undefined,
  stored: string | null | undefined,
): string | null {
  if (
    incoming !== null &&
    incoming !== undefined &&
    incoming !== '' &&
    incoming !== stored &&
    !ARCA_INVOICE_NUMBER_REGEX.test(incoming)
  ) {
    return INVOICE_NUMBER_FORMAT_MESSAGE;
  }
  return null;
}

// Base ZodObject (no refinements) so callers can keep using `.omit`, `.extend`,
// etc. Always combine with `refineInvoiceNumberFormat` (or the pre-built
// `insertTransactionSchema` below) before parsing untrusted input.
export const insertTransactionBaseSchema = createInsertSchema(transactions, {
  amount: z.string().or(z.number()).transform(val => String(val)),
  date: z.string().or(z.date()).transform(val => parseLocalDate(val)),
  imputationDate: z.string().or(z.date()).transform(val => parseLocalDate(val)),
  productQuantity: z.string().or(z.number()).transform(val => val === null || val === undefined ? null : String(val)).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});

export const insertTransactionSchema = insertTransactionBaseSchema.superRefine(refineInvoiceNumberFormat);
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

// IVA conditions for tax profiles (emisor)
export const TAX_IVA_CONDITIONS = ['responsable_inscripto', 'monotributo', 'exento', 'consumidor_final'] as const;
export type TaxIvaCondition = typeof TAX_IVA_CONDITIONS[number];

export const TAX_IVA_CONDITION_LABELS: Record<TaxIvaCondition, string> = {
  'responsable_inscripto': 'Responsable Inscripto',
  'monotributo': 'Monotributista',
  'exento': 'IVA Exento',
  'consumidor_final': 'Consumidor Final',
};

export const MONOTRIBUTO_CATEGORIES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'] as const;
export type MonotributoCategory = typeof MONOTRIBUTO_CATEGORIES[number];

// Tax Profile - condiciones impositivas por organización (informativo, no para facturación)
export const taxProfiles = pgTable("tax_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  // IVA
  ivaCondition: text("iva_condition"), // see TAX_IVA_CONDITIONS
  monotributoCategory: text("monotributo_category"), // A..K si monotributista
  // Ingresos Brutos
  iibbInscribed: boolean("iibb_inscribed").notNull().default(false),
  iibbJurisdictions: text("iibb_jurisdictions"), // texto libre o lista separada por coma
  iibbNumber: text("iibb_number"),
  iibbAliquot: decimal("iibb_aliquot", { precision: 5, scale: 2 }), // % aplicable sobre ingresos
  // Ganancias
  gananciasInscribed: boolean("ganancias_inscribed").notNull().default(false),
  gananciasNumber: text("ganancias_number"),
  gananciasRegime: text("ganancias_regime"),
  // Otros tributos (texto libre)
  otherTaxes: text("other_taxes"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTaxProfileSchema = createInsertSchema(taxProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const upsertTaxProfileSchema = insertTaxProfileSchema.omit({ organizationId: true }).partial().extend({
  ivaCondition: z.enum(TAX_IVA_CONDITIONS).nullable().optional(),
  monotributoCategory: z.enum(MONOTRIBUTO_CATEGORIES).nullable().optional(),
});
export type InsertTaxProfile = z.infer<typeof insertTaxProfileSchema>;
export type TaxProfile = typeof taxProfiles.$inferSelect;

// Conversations table for AI chat
export const conversations = pgTable("conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;

// Messages table for AI chat
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' or 'assistant'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

// Recurring Templates table for automatic monthly transactions
export const recurringTemplates = pgTable("recurring_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'expense' or 'income'
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "set null" }),
  dayOfMonth: text("day_of_month").notNull(), // '1' to '31'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRecurringTemplateSchema = createInsertSchema(recurringTemplates, {
  amount: z.string().or(z.number()).transform(val => String(val)),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertRecurringTemplate = z.infer<typeof insertRecurringTemplateSchema>;
export type RecurringTemplate = typeof recurringTemplates.$inferSelect;

// Recurring Template Runs - tracks which months have been processed
export const recurringTemplateRuns = pgTable("recurring_template_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  templateId: varchar("template_id").notNull().references(() => recurringTemplates.id, { onDelete: "cascade" }),
  year: text("year").notNull(),
  month: text("month").notNull(), // '01' to '12'
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

export const insertRecurringTemplateRunSchema = createInsertSchema(recurringTemplateRuns).omit({
  id: true,
  processedAt: true,
});
export type InsertRecurringTemplateRun = z.infer<typeof insertRecurringTemplateRunSchema>;
export type RecurringTemplateRun = typeof recurringTemplateRuns.$inferSelect;

// ==========================================
// OPERATIONAL DATABASE: Clients, Suppliers, Products
// ==========================================

// Client statuses
export const CLIENT_STATUSES = ['active', 'potential', 'inactive'] as const;
export type ClientStatus = typeof CLIENT_STATUSES[number];
export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  'active': 'Activo',
  'potential': 'Potencial',
  'inactive': 'Inactivo',
};

// Clients table
// Suggested client types shown in the picker. The column is free-text so
// users can add arbitrary custom types; this list only seeds the suggestions
// and provides display labels for the well-known ones. The literal
// 'suscriptores' is RESERVED — server-side subscription billing
// (server/services/subscriptionBilling.ts) keys off this exact string, so
// don't rename it.
export const CLIENT_TYPES = ['mayorista', 'minorista', 'fijo', 'suscriptores', 'otro'] as const;
export type ClientType = typeof CLIENT_TYPES[number];
export const CLIENT_TYPE_LABELS: Record<ClientType, string> = {
  mayorista: 'Mayorista',
  minorista: 'Minorista',
  fijo: 'Fijo',
  suscriptores: 'Suscriptores',
  otro: 'Otro',
};

// Subscription plans (per organization) — used by clients of type 'suscriptores'
export const subscriptionPlans = pgTable("subscription_plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("ARS"),
  monthlyPrice: decimal("monthly_price", { precision: 15, scale: 2 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlans, {
  name: z.string().min(1, 'Tenés que ingresar el nombre del plan').max(120, 'El nombre no puede superar los 120 caracteres'),
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Elegí una moneda válida' }) }),
  monthlyPrice: z.string().or(z.number()).transform(v => String(v)).refine(v => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0;
  }, 'El precio mensual tiene que ser mayor a 0'),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;

export const updateSubscriptionPlanSchema = z.object({
  name: z.string().min(1, 'Tenés que ingresar el nombre del plan').max(120, 'El nombre no puede superar los 120 caracteres').optional(),
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Elegí una moneda válida' }) }).optional(),
  monthlyPrice: z.string().or(z.number()).transform(v => String(v)).refine(v => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0;
  }, 'El precio mensual tiene que ser mayor a 0').optional(),
  isActive: z.boolean().optional(),
}).strict();

export const clients = pgTable("clients", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  taxId: text("tax_id"),
  ivaCondition: text("iva_condition"), // 'responsable_inscripto' | 'monotributo' | 'exento' | 'consumidor_final' (used for invoice doc-type selection)
  notes: text("notes"),
  clientType: text("client_type"),
  externalId: text("external_id"), // ID en plataforma externa (ej. Tiendanube)
  externalSource: text("external_source"), // 'tiendanube' | null
  // Subscription fields (only relevant when clientType = 'suscriptores')
  subscriberPlanId: varchar("subscriber_plan_id"),
  subscriberQuantity: integer("subscriber_quantity"),
  subscriberUnitPriceOverride: decimal("subscriber_unit_price_override", { precision: 15, scale: 2 }),
  subscriberCurrencyOverride: text("subscriber_currency_override"),
  subscriberBillingDay: integer("subscriber_billing_day"), // 1-28, defaults to 1 when active
  subscriberStartMonth: text("subscriber_start_month"), // 'YYYY-MM' first month to bill
  subscriberLastBilledMonth: text("subscriber_last_billed_month"), // 'YYYY-MM'
  status: text("status").notNull().default("active"),
  isActive: boolean("is_active").notNull().default(true),
  archivedAt: timestamp("archived_at"), // Task #363: unificación archivar/eliminar
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertClientSchema = createInsertSchema(clients, {
  name: z.string().min(1, 'Tenés que ingresar el nombre del cliente').max(200, 'El nombre no puede superar los 200 caracteres'),
  clientType: z.string().trim().min(1).max(50, 'El tipo no puede superar los 50 caracteres').nullable().optional(),
  subscriberPlanId: z.string().uuid('Plan de suscripción inválido').nullable().optional(),
  subscriberQuantity: z.number({ invalid_type_error: 'La cantidad tiene que ser un número' }).int('La cantidad tiene que ser un número entero').positive('La cantidad tiene que ser mayor a 0').nullable().optional(),
  subscriberBillingDay: z.number({ invalid_type_error: 'El día de cobro tiene que ser un número' }).int('El día de cobro tiene que ser un número entero').min(1, 'El día de cobro tiene que ser entre 1 y 28').max(28, 'El día de cobro tiene que ser entre 1 y 28').nullable().optional(),
  subscriberStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido. Usá el formato AAAA-MM (ej: 2026-05)').nullable().optional(),
  subscriberCurrencyOverride: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Elegí una moneda válida' }) }).nullable().optional(),
  subscriberUnitPriceOverride: z.string().or(z.number()).transform(v => v == null ? v : String(v)).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clients.$inferSelect;

// Presupuestos (quotes): documento que se manda al cliente (PDF) y que, si la
// venta se concreta, se confirma como un movimiento (ingreso / a cobrar).
export const quotes = pgTable("quotes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  clientId: varchar("client_id"), // optional link to a client
  clientName: text("client_name"), // free-text fallback / snapshot for display
  amount: decimal("amount", { precision: 15, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("ARS"),
  date: timestamp("date").defaultNow().notNull(), // fecha del presupuesto
  validUntil: timestamp("valid_until"), // opcional: válido hasta
  notes: text("notes"),
  pdfUrl: text("pdf_url"), // objectPath del PDF subido a object storage
  pdfName: text("pdf_name"), // nombre original del archivo, para mostrar/descargar
  // Override del membrete del PDF SOLO para este presupuesto. Si quedan vacios, el
  // PDF cae al preset de presupuestos de la organizacion, luego a los datos de la
  // organizacion y finalmente a los del usuario que descarga.
  pdfLogoUrl: text("pdf_logo_url"), // objectPath del logo propio de este presupuesto
  pdfContactEmail: text("pdf_contact_email"),
  pdfContactPhone: text("pdf_contact_phone"),
  pdfCompanyName: text("pdf_company_name"), // nombre de la empresa en el membrete
  pdfContactName: text("pdf_contact_name"), // nombre de quien envía el presupuesto
  status: text("status").notNull().default("pending"), // 'pending' | 'won' | 'lost'
  linkedTransactionId: varchar("linked_transaction_id"), // movimiento generado al ganar
  wonAt: timestamp("won_at"),
  lostAt: timestamp("lost_at"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertQuoteSchema = createInsertSchema(quotes, {
  title: z.string().min(1, 'Tenés que ingresar un título o descripción').max(200, 'El título no puede superar los 200 caracteres'),
  amount: z.string().or(z.number()).transform(v => String(v)).refine(v => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0;
  }, 'El monto tiene que ser mayor a 0'),
  currency: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Elegí una moneda válida' }) }),
  clientId: z.string().uuid('Cliente inválido').nullable().optional(),
  clientName: z.string().max(200, 'El nombre no puede superar los 200 caracteres').nullable().optional(),
  date: z.coerce.date().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  notes: z.string().max(2000, 'Las notas no pueden superar los 2000 caracteres').nullable().optional(),
  pdfUrl: z.string().max(500).nullable().optional().refine(
    (v) => v == null || v.startsWith('/objects/'),
    'La URL del PDF no es válida',
  ),
  pdfName: z.string().max(255).nullable().optional(),
  pdfLogoUrl: z.string().max(500).nullable().optional().refine(
    (v) => v == null || v.startsWith('/objects/'),
    'La URL del logo no es válida',
  ),
  pdfContactEmail: z.string().max(255).nullable().optional(),
  pdfContactPhone: z.string().max(50).nullable().optional(),
  pdfCompanyName: z.string().max(200).nullable().optional(),
  pdfContactName: z.string().max(200).nullable().optional(),
  status: z.enum(['pending', 'won', 'lost']).optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  wonAt: true,
  lostAt: true,
  linkedTransactionId: true,
});
export type InsertQuote = z.infer<typeof insertQuoteSchema>;
export type Quote = typeof quotes.$inferSelect;

export const clientProjects = pgTable("client_projects", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertClientProjectSchema = createInsertSchema(clientProjects).omit({
  id: true,
  createdAt: true,
});
export type InsertClientProject = z.infer<typeof insertClientProjectSchema>;
export type ClientProject = typeof clientProjects.$inferSelect;

// Suppliers table
export const suppliers = pgTable("suppliers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  taxId: text("tax_id"),
  ivaCondition: text("iva_condition"), // 'responsable_inscripto' | 'monotributo' | 'exento' | 'consumidor_final' (used for invoice doc-type selection cuando emitimos comprobantes propios al proveedor)
  notes: text("notes"),
  supplierType: text("supplier_type"),
  isActive: boolean("is_active").notNull().default(true),
  archivedAt: timestamp("archived_at"), // Task #363: unificación archivar/eliminar
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSupplierSchema = createInsertSchema(suppliers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type Supplier = typeof suppliers.$inferSelect;

// Employee contract types
export const CONTRACT_TYPES = ['indefinite', 'temporary', 'freelance'] as const;
export type ContractType = typeof CONTRACT_TYPES[number];
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  'indefinite': 'Indefinido',
  'temporary': 'Temporal',
  'freelance': 'Freelance',
};

// Employee statuses
export const EMPLOYEE_STATUSES = ['active', 'inactive'] as const;
export type EmployeeStatus = typeof EMPLOYEE_STATUSES[number];

// Employees table
export const employees = pgTable("employees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  dni: text("dni"),
  phone: text("phone"),
  email: text("email"),
  birthDate: timestamp("birth_date"),
  startDate: timestamp("start_date"),
  contractType: text("contract_type").notNull().default("indefinite"),
  grossSalary: decimal("gross_salary", { precision: 15, scale: 2 }).notNull().default("0"),
  netSalary: decimal("net_salary", { precision: 15, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("ARS"),
  status: text("status").notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertEmployeeSchema = createInsertSchema(employees).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

export const createEmployeeSchema = z.object({
  fullName: z.string().min(1),
  dni: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal('')),
  birthDate: z.union([z.string(), z.date()]).nullable().optional().transform(val => val ? new Date(val) : null),
  startDate: z.union([z.string(), z.date()]).nullable().optional().transform(val => val ? new Date(val) : null),
  contractType: z.enum(CONTRACT_TYPES).default('indefinite'),
  grossSalary: z.string().or(z.number()).transform(val => String(val)).default('0'),
  netSalary: z.string().or(z.number()).transform(val => String(val)).default('0'),
  currency: z.enum(CURRENCIES).default('ARS'),
  status: z.enum(EMPLOYEE_STATUSES).default('active'),
  notes: z.string().nullable().optional(),
});

// Employee-Client allocation (salary % assigned to a client/project)
export const employeeClientAllocations = pgTable("employee_client_allocations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeId: varchar("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  clientId: varchar("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  projectId: varchar("project_id"),
  projectName: varchar("project_name", { length: 255 }).notNull().default(""),
  percentage: decimal("percentage", { precision: 5, scale: 2 }).notNull().default("0"),
  commissionRate: decimal("commission_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEmployeeClientAllocationSchema = createInsertSchema(employeeClientAllocations).omit({
  id: true,
  createdAt: true,
});
export type InsertEmployeeClientAllocation = z.infer<typeof insertEmployeeClientAllocationSchema>;
export type EmployeeClientAllocation = typeof employeeClientAllocations.$inferSelect;

// Products/Inventory table
export const PRODUCT_TYPES = ['product', 'service', 'asset'] as const;
// Task #502: alícuotas de IVA válidas para asignar a un producto (set estándar ARCA).
export const VALID_IVA_ALIQUOTS = ['0', '2.5', '5', '10.5', '21', '27'] as const;
export type ProductType = typeof PRODUCT_TYPES[number];
export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  'product': 'Producto',
  'service': 'Servicio',
  'asset': 'Activo',
};

export const products = pgTable("products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  productType: text("product_type").notNull().default("product"),
  sku: text("sku"),
  barcode: text("barcode"),
  category: text("category"),
  costPrice: decimal("cost_price", { precision: 15, scale: 2 }).notNull().default("0"),
  costCurrency: text("cost_currency").default("ARS"),
  salePrice: decimal("sale_price", { precision: 15, scale: 2 }).notNull().default("0"),
  stock: decimal("stock", { precision: 15, scale: 2 }).notNull().default("0"),
  minStock: decimal("min_stock", { precision: 15, scale: 2 }).default("0"),
  unit: text("unit").default("unidad"),
  ivaAliquot: decimal("iva_aliquot", { precision: 5, scale: 2 }).notNull().default("21"), // Alícuota de IVA por defecto del producto (21, 10.5, 0, etc.)
  defaultProfitabilityCodeId: varchar("default_profitability_code_id"), // Default profitability code applied when this product is used in a transaction
  purchaseDate: timestamp("purchase_date"),
  usefulLifeMonths: integer("useful_life_months"),
  currentValue: decimal("current_value", { precision: 15, scale: 2 }),
  imageUrl: text("image_url"), // URL de imagen/miniatura (ej. desde Tiendanube)
  externalId: text("external_id"), // ID en plataforma externa (ej. Tiendanube product/variant)
  externalSource: text("external_source"), // 'tiendanube' | null
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductSchema = createInsertSchema(products, {
  productType: z.enum(PRODUCT_TYPES).optional().default('product'),
  costPrice: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  costCurrency: z.string().optional().default("ARS"),
  salePrice: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  stock: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  minStock: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  ivaAliquot: z.string().or(z.number()).optional()
    .transform(val => (val !== undefined && val !== null && String(val) !== '') ? String(Number(val)) : "21")
    .refine(val => (VALID_IVA_ALIQUOTS as readonly string[]).includes(val), { message: 'Alícuota de IVA inválida (valores: 0, 2.5, 5, 10.5, 21, 27)' }),
  purchaseDate: z.union([z.string(), z.date()]).nullable().optional().transform((val, ctx) => {
    if (!val) return null;
    const d = typeof val === 'string' ? new Date(val) : val;
    if (isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de compra inválida' });
      return z.NEVER;
    }
    return d;
  }),
  usefulLifeMonths: z.union([z.number(), z.string()]).nullable().optional().transform((val, ctx) => {
    if (val === null || val === undefined || val === '') return null;
    const n = typeof val === 'string' ? parseInt(val) : val;
    if (isNaN(n) || n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'La vida útil debe ser un número positivo' });
      return z.NEVER;
    }
    return n;
  }),
  currentValue: z.string().or(z.number()).nullable().optional().transform(val => val ? String(val) : null),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// Stock movements table (entries and exits)
export const stockMovements = pgTable("stock_movements", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: varchar("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'entry' (entrada), 'exit' (salida), 'adjustment'
  quantity: decimal("quantity", { precision: 15, scale: 2 }).notNull(),
  previousStock: decimal("previous_stock", { precision: 15, scale: 2 }).notNull(),
  newStock: decimal("new_stock", { precision: 15, scale: 2 }).notNull(),
  reason: text("reason"), // Motivo del movimiento
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "set null" }), // Linked transaction
  profitabilityCodeId: varchar("profitability_code_id"), // Profitability code at moment of movement (preserves history)
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertStockMovementSchema = createInsertSchema(stockMovements, {
  quantity: z.string().or(z.number()).transform(val => String(val)),
  previousStock: z.string().or(z.number()).transform(val => String(val)),
  newStock: z.string().or(z.number()).transform(val => String(val)),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;
export type StockMovement = typeof stockMovements.$inferSelect;

// ==========================================
// TRANSACTION ITEMS: line items for multi-product transactions (Task #475).
// Source of truth when a single transaction carries 2+ distinct products.
// For 0 or 1 product, the legacy `transactions.productId`/`productQuantity`
// fields are used and no rows are written here (backward compatible).
// ==========================================
export const transactionItems = pgTable("transaction_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transactionId: varchar("transaction_id").notNull().references(() => transactions.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  productId: varchar("product_id").references(() => products.id, { onDelete: "set null" }),
  description: text("description"),
  quantity: decimal("quantity", { precision: 15, scale: 2 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 15, scale: 2 }).notNull(),
  profitabilityCodeId: varchar("profitability_code_id").references(() => profitabilityCodes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTransactionItemSchema = createInsertSchema(transactionItems, {
  quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
  unitPrice: z.union([z.string(), z.number()]).transform((v) => String(v)),
}).omit({ id: true, createdAt: true });
export type InsertTransactionItem = z.infer<typeof insertTransactionItemSchema>;
export type TransactionItem = typeof transactionItems.$inferSelect;

// ==========================================
// QUOTE ITEMS: line items (productos/servicios) for a quote (presupuesto).
// Mirror of transaction_items. `product_id` is nullable so a line can be a
// free-text service/description (sin producto del catálogo). When a quote has
// 0 line items it behaves as a legacy single-amount quote (amount + notes).
// ==========================================
export const quoteItems = pgTable("quote_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  quoteId: varchar("quote_id").notNull().references(() => quotes.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  productId: varchar("product_id").references(() => products.id, { onDelete: "set null" }),
  description: text("description"),
  quantity: decimal("quantity", { precision: 15, scale: 2 }).notNull(),
  unitPrice: decimal("unit_price", { precision: 15, scale: 2 }).notNull(),
  profitabilityCodeId: varchar("profitability_code_id").references(() => profitabilityCodes.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertQuoteItemSchema = createInsertSchema(quoteItems, {
  quantity: z.union([z.string(), z.number()]).transform((v) => String(v)),
  unitPrice: z.union([z.string(), z.number()]).transform((v) => String(v)),
}).omit({ id: true, createdAt: true });
export type InsertQuoteItem = z.infer<typeof insertQuoteItemSchema>;
export type QuoteItem = typeof quoteItems.$inferSelect;

// ==========================================
// PROFITABILITY CODES: Cross-cutting analysis codes for movements & products
// Independent from client_projects: a profitability code can be assigned to
// any transaction (income, expense, payable, receivable) and to any product,
// regardless of whether a client is involved. Used for grouping in Reports
// (Rentabilidad por código). Excluded from internal transfers on purpose
// because including them would double-count amounts.
// ==========================================
export const profitabilityCodes = pgTable("profitability_codes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(), // Short code, unique per org (case-insensitive)
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"), // Optional hex color (e.g. "#06b6d4") for UI badge
  isActive: boolean("is_active").notNull().default(true),
  archivedAt: timestamp("archived_at"), // Task #363: unificación archivar/eliminar
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // DB-level case-insensitive uniqueness per org. Closes the race-condition
  // window where two concurrent POSTs with the same code could both pass the
  // service-level check and be inserted.
  uniqueOrgCodeLower: uniqueIndex("profitability_codes_org_code_lower_unique")
    .on(table.organizationId, sql`lower(${table.code})`),
}));

export const insertProfitabilityCodeSchema = createInsertSchema(profitabilityCodes, {
  code: z.string().trim().min(1, 'El código es requerido').max(20, 'Máximo 20 caracteres'),
  name: z.string().trim().min(2, 'El nombre es requerido').max(100, 'Máximo 100 caracteres'),
  description: z.string().trim().max(500, 'Máximo 500 caracteres').nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color inválido (formato #rrggbb)').nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertProfitabilityCode = z.infer<typeof insertProfitabilityCodeSchema>;
export type ProfitabilityCode = typeof profitabilityCodes.$inferSelect;

// ==========================================
// PAYMENT METHODS (Task #229): "Medios de cobro" with associated cost concepts
// ==========================================
// A payment method is a labeled bundle of cost concepts (commissions, fixed
// fees, taxes, financing costs, etc.) that automatically apply to an income or
// receivable transaction. When the user records a $10.000 sale paid via
// "MercadoPago 6 cuotas" (which has comisión 2% + IIBB 4% + costo financiero
// 15% + costo fijo $100), the system creates the income for $10.000 PLUS one
// expense (or payable, if the parent is a receivable) per concept, all linked
// to the parent via `linkedTransactionId`.
//
// Maximum 10 concepts per method (UI/UX constraint, also enforced server-side).
// Percentages are always computed against the gross amount (no cascade).
export const paymentMethods = pgTable("payment_methods", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueOrgNameLower: uniqueIndex("payment_methods_org_name_lower_unique")
    .on(table.organizationId, sql`lower(${table.name})`),
}));

// Concepts attached to a payment method. Up to 10 per method.
// `kind` is 'percentage' (value is 0-100) or 'fixed' (value is a positive
// monetary amount in the transaction's currency at the moment of use).
// `expenseCategoryId` (optional) routes the auto-generated expense to a
// specific transaction category in reports; if null the auto-generated
// movement falls back to a "Costos de cobro" generic category.
export const paymentMethodConcepts = pgTable("payment_method_concepts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  paymentMethodId: varchar("payment_method_id").notNull().references(() => paymentMethods.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // 'percentage' | 'fixed'
  value: decimal("value", { precision: 15, scale: 4 }).notNull(),
  expenseCategoryId: varchar("expense_category_id"), // optional FK to transaction_categories.id (logical, not enforced to allow soft-delete)
  position: integer("position").notNull().default(0), // display order
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const PAYMENT_METHOD_CONCEPT_KINDS = ['percentage', 'fixed'] as const;
export const MAX_PAYMENT_METHOD_CONCEPTS = 10;

export const insertPaymentMethodSchema = createInsertSchema(paymentMethods, {
  name: z.string().trim().min(2, 'El nombre es requerido').max(80, 'Máximo 80 caracteres'),
  description: z.string().trim().max(500, 'Máximo 500 caracteres').nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertPaymentMethod = z.infer<typeof insertPaymentMethodSchema>;
export type PaymentMethod = typeof paymentMethods.$inferSelect;

export const insertPaymentMethodConceptSchema = createInsertSchema(paymentMethodConcepts, {
  name: z.string().trim().min(1, 'El nombre del concepto es requerido').max(80, 'Máximo 80 caracteres'),
  kind: z.enum(PAYMENT_METHOD_CONCEPT_KINDS, {
    errorMap: () => ({ message: "El tipo debe ser 'percentage' o 'fixed'" }),
  }),
  value: z.union([z.string(), z.number()]).transform((v) => String(v))
    .pipe(z.string().regex(/^\d+(\.\d{1,4})?$/, 'Valor inválido')),
  expenseCategoryId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).max(MAX_PAYMENT_METHOD_CONCEPTS - 1).optional(),
}).omit({
  id: true,
  createdAt: true,
});
export type InsertPaymentMethodConcept = z.infer<typeof insertPaymentMethodConceptSchema>;
export type PaymentMethodConcept = typeof paymentMethodConcepts.$inferSelect;

// Composite shape used by the API: a payment method plus its concepts.
export type PaymentMethodWithConcepts = PaymentMethod & {
  concepts: PaymentMethodConcept[];
};

// Audit log table for change history
export const auditLogs = pgTable("audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(), // 'transaction', 'account', 'client', 'supplier', 'product'
  entityId: varchar("entity_id").notNull(),
  action: text("action").notNull(), // 'create', 'update', 'delete'
  previousData: text("previous_data"), // JSON stringified
  newData: text("new_data"), // JSON stringified
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({
  id: true,
  createdAt: true,
});
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;

// ==========================================
// SYSTEM ERRORS: persistent log of serious system errors (admin panel)
// ==========================================
// Contraparte "historial" de las alertas por email. Se persisten sólo en
// producción (misma regla que el email) y con los datos sensibles ya redactados.
// Las repeticiones se agrupan por huella estable (fingerprint = origen + ruta
// normalizada + mensaje) incrementando un contador, sin crear filas duplicadas.
export const SYSTEM_ERROR_STATUSES = ['open', 'resolved', 'archived'] as const;

export const systemErrors = pgTable("system_errors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fingerprint: text("fingerprint").notNull(),
  source: text("source").notNull(), // 'http' | 'uncaughtException' | 'unhandledRejection'
  message: text("message").notNull(),
  stack: text("stack"),
  statusCode: integer("status_code"),
  method: text("method"),
  path: text("path"),
  userId: varchar("user_id"),
  userEmail: text("user_email"),
  organizationId: varchar("organization_id"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  status: text("status").notNull().default('open'), // 'open' | 'resolved' | 'archived'
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  resolvedBy: varchar("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
}, (table) => ({
  // Índice único PARCIAL: como mucho una fila "open" por huella. Habilita el
  // upsert atómico (INSERT ... ON CONFLICT) para agrupar repeticiones e
  // incrementar el contador sin crear duplicados, incluso bajo concurrencia.
  openFingerprintIdx: uniqueIndex("system_errors_open_fingerprint_idx")
    .on(table.fingerprint)
    .where(sql`status = 'open'`),
  statusLastSeenIdx: index("system_errors_status_last_seen_idx").on(table.status, table.lastSeenAt),
}));

export const insertSystemErrorSchema = createInsertSchema(systemErrors).omit({
  id: true,
  occurrenceCount: true,
  firstSeenAt: true,
  lastSeenAt: true,
  resolvedBy: true,
  resolvedAt: true,
});
export type InsertSystemError = z.infer<typeof insertSystemErrorSchema>;
export type SystemError = typeof systemErrors.$inferSelect;

// ==========================================
// ASSETS: Capitalized assets with depreciation
// ==========================================

export const assets = pgTable("assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "set null" }), // Origin transaction
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull(), // real_estate, vehicle, machinery, equipment, etc.
  acquisitionValue: decimal("acquisition_value", { precision: 15, scale: 2 }).notNull(),
  acquisitionDate: timestamp("acquisition_date").notNull(),
  currency: text("currency").notNull().default("ARS"),
  usefulLifeMonths: integer("useful_life_months").notNull(), // vida útil en meses
  residualValue: decimal("residual_value", { precision: 15, scale: 2 }).default("0"), // valor residual
  accumulatedDepreciation: decimal("accumulated_depreciation", { precision: 15, scale: 2 }).notNull().default("0"),
  lastDepreciatedAt: timestamp("last_depreciated_at"), // Último cálculo de depreciación
  isActive: boolean("is_active").notNull().default(true), // false if sold/disposed
  disposalDate: timestamp("disposal_date"),
  disposalValue: decimal("disposal_value", { precision: 15, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAssetSchema = createInsertSchema(assets, {
  acquisitionValue: z.string().or(z.number()).transform(val => String(val)),
  residualValue: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  accumulatedDepreciation: z.string().or(z.number()).optional().transform(val => val ? String(val) : "0"),
  acquisitionDate: z.string().or(z.date()).transform(val => val instanceof Date ? val : new Date(val)),
  category: z.enum(ASSET_CATEGORIES),
  currency: z.enum(CURRENCIES).optional().default('ARS'),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAsset = z.infer<typeof insertAssetSchema>;
export type Asset = typeof assets.$inferSelect;

// Investment positions for financial investments (stocks, bonds, etc.)
export const investments = pgTable("investments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "set null" }), // Origin transaction
  name: text("name").notNull(), // e.g., "AAPL", "Bono Soberano"
  description: text("description"),
  investmentType: text("investment_type").notNull(), // 'stock', 'bond', 'fund', 'crypto', 'other'
  quantity: decimal("quantity", { precision: 15, scale: 6 }).notNull(), // Can be fractional
  acquisitionPrice: decimal("acquisition_price", { precision: 15, scale: 2 }).notNull(), // Price per unit
  totalCost: decimal("total_cost", { precision: 15, scale: 2 }).notNull(), // Total invested
  currency: text("currency").notNull().default("USD"),
  acquisitionDate: timestamp("acquisition_date").notNull(),
  currentPrice: decimal("current_price", { precision: 15, scale: 2 }), // Latest valuation
  currentPriceDate: timestamp("current_price_date"), // When was current price updated
  isActive: boolean("is_active").notNull().default(true), // false if sold
  saleDate: timestamp("sale_date"),
  salePrice: decimal("sale_price", { precision: 15, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInvestmentSchema = createInsertSchema(investments, {
  quantity: z.string().or(z.number()).transform(val => String(val)),
  acquisitionPrice: z.string().or(z.number()).transform(val => String(val)),
  totalCost: z.string().or(z.number()).transform(val => String(val)),
  acquisitionDate: z.string().or(z.date()).transform(val => val instanceof Date ? val : new Date(val)),
  currency: z.enum(CURRENCIES).optional().default('USD'),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvestment = z.infer<typeof insertInvestmentSchema>;
export type Investment = typeof investments.$inferSelect;

// Session table for connect-pg-simple
export const sessions = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: text("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
});

// ============================================
// SUBSCRIPTION & TEAM MANAGEMENT
// ============================================

// Plan types
export const PLAN_TYPES = ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] as const;
export type PlanType = typeof PLAN_TYPES[number];

export const PLAN_LABELS: Record<PlanType, string> = {
  'personal': 'Personal',
  'personal_pro': 'Personal Pro',
  'solo': 'Solo',
  'team': 'Team',
  'business': 'Business',
  'enterprise': 'Enterprise',
};

export const PLAN_FEATURES_COMPARISON: Array<{
  key: string;
  label: string;
  description: string;
  plans: PlanType[];
  comingSoon?: boolean;
}> = [
  { key: 'dashboard', label: 'Foto y Película de tu empresa', description: 'Ves el dinero real hoy y cómo viene tu negocio', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'one_button', label: 'Un solo botón para todo', description: 'Ingreso, egreso, deuda o cobro en un click', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'ai_voice', label: 'IA: audio, foto de factura y extractos', description: 'Mandás un audio o una foto y Aike lo convierte en movimiento', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'financial_health', label: 'Salud financiera en tiempo real', description: 'Indicador visual si tu empresa está sana o en riesgo', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'multicurrency', label: 'Multimoneda nativa', description: 'Pesos, dólares y más con reportes consolidados', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'mobile', label: '100% manejable desde el celular', description: 'Diseñado mobile-first para controlar todo desde cualquier lugar', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'editable', label: 'Todo es editable, todo es tuyo', description: 'Conceptos, categorías, cajas y nombres se adaptan', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'export', label: 'Exportás todo en un click', description: 'Excel, PDF o WhatsApp para socios, contadores o inversores', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'recurring', label: 'Ingresos recurrentes automáticos', description: 'Abonos que se cargan solos y alimentan proyecciones', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'fixed_costs', label: 'Costos fijos y variables con alertas', description: 'Sabés qué tenés que pagar y si te va a alcanzar la caja', plans: ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'conciliation', label: 'Cuentas conciliadas en 1 click', description: 'Cruza pagos, cobros y deudas para que tus números cierren', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'office', label: 'Oficina: Clientes, Proveedores, Productos', description: 'Gestión completa de tu cartera comercial', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'ai_admin', label: 'IA que ordena tu administración', description: 'Detecta errores, evita duplicaciones y sugiere acciones', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'contador', label: 'Preparado para trabajar con tu contador', description: 'Reportes claros, exportables y compartibles', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'bw', label: 'Blanco y negro, sin mentirte', description: 'Caja blanca e informal con alertas inteligentes', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'multiorg', label: 'Multiempresa y finanzas personales', description: 'Varios negocios y tu economía personal en un solo lugar', plans: ['personal_pro', 'solo', 'team', 'business', 'enterprise'] },
  { key: 'team_mgmt', label: 'Gestión de equipo con roles', description: 'Operadores, especialistas y admins con permisos diferenciados', plans: ['solo', 'team', 'business', 'enterprise'] },
  { key: 'whatsapp', label: 'Integración con WhatsApp Business', description: 'Mensajes, ventas y movimientos conectados', plans: ['solo', 'team', 'business', 'enterprise'] },
  { key: 'orgchart', label: 'Organigrama vivo de tu empresa', description: 'Visualizás empleados, roles y costos de forma editable', plans: ['team', 'business', 'enterprise'] },
  { key: 'payroll', label: 'Gestión de nómina de empleados', description: 'Sueldos, honorarios y costos laborales centralizados', plans: ['team', 'business', 'enterprise'] },
  { key: 'project_assign', label: 'Asignación de empleados a proyectos', description: 'Asociás horas y costos a proyectos para medir rentabilidad', plans: ['team', 'business', 'enterprise'] },
  { key: 'valuation', label: 'Valuación automática de tu empresa', description: 'Calculamos cuánto vale tu negocio con datos reales', plans: ['business', 'enterprise'] },
  { key: 'import', label: 'Importás lo de tu sistema anterior', comingSoon: true, description: 'Migrás clientes, movimientos y más desde cualquier sistema', plans: ['solo', 'team', 'business', 'enterprise'] },
  { key: 'profitability', label: 'Análisis de rentabilidad por proyecto', comingSoon: true, description: 'Sabés qué proyectos ganan plata y cuáles te hacen perder', plans: ['team', 'business', 'enterprise'] },
  { key: 'crm', label: 'CRM integrado a tu administración', comingSoon: true, description: 'Leads, clientes y ventas conectados con ingresos', plans: ['business', 'enterprise'] },
];

export const PLAN_DETAILS: Record<PlanType, { 
  price: number; 
  maxOrgs: number; 
  maxMembersPerOrg: number; 
  isTeamPlan: boolean;
  features: string[];
  highlight?: string;
}> = {
  'personal': { 
    price: 8999, maxOrgs: 1, maxMembersPerOrg: 2, isTeamPlan: false,
    features: [
      '1 organización',
      '+1 invitado/a por organización',
      'Dashboard: Foto y Película',
      'Un solo botón para cargar movimientos',
      'IA: audio, fotos de facturas y extractos',
      'Salud financiera en tiempo real',
      'Multimoneda nativa',
      '100% mobile',
      'Costos fijos y variables con alertas',
      'Ingresos recurrentes automáticos',
      'Exportación CSV/PDF/WhatsApp',
      'Soporte por email'
    ]
  },
  'personal_pro': { 
    price: 11999, maxOrgs: 2, maxMembersPerOrg: 2, isTeamPlan: false,
    highlight: 'Más completo',
    features: [
      '2 organizaciones',
      '+1 invitado/a por organización',
      'Todo lo del plan Personal',
      'Oficina: Clientes, Proveedores, Productos',
      'Conciliación en 1 click',
      'IA que ordena tu administración',
      'Multiempresa y finanzas personales',
      'Blanco y negro con alertas',
      'Preparado para tu contador',
      'Soporte prioritario'
    ]
  },
  'solo': { 
    price: 16999, maxOrgs: 3, maxMembersPerOrg: 3, isTeamPlan: true,
    features: [
      '3 organizaciones',
      'Hasta 3 miembros por organización',
      'Todo lo del plan Personal Pro',
      'Gestión de equipo con roles y permisos',
      'Integración con WhatsApp Business',
      'Importación de datos (próx.)',
      'Soporte por email'
    ]
  },
  'team': { 
    price: 24999, maxOrgs: 3, maxMembersPerOrg: 5, isTeamPlan: true,
    highlight: 'Popular',
    features: [
      '3 organizaciones',
      'Hasta 5 miembros por organización',
      'Todo lo del plan Solo',
      'Organigrama vivo de tu empresa',
      'Gestión de nómina de empleados',
      'Asignación de empleados a proyectos',
      'Análisis de rentabilidad (próx.)',
      'Soporte prioritario'
    ]
  },
  'business': { 
    price: 49999, maxOrgs: 5, maxMembersPerOrg: 10, isTeamPlan: true,
    features: [
      '5 organizaciones',
      'Hasta 10 miembros por organización',
      'Todo lo del plan Team',
      'Valuación automática de tu empresa',
      'CRM integrado (próx.)',
      'Soporte dedicado'
    ]
  },
  'enterprise': { 
    price: 89999, maxOrgs: 15, maxMembersPerOrg: 50, isTeamPlan: true,
    features: [
      '15 organizaciones',
      'Hasta 50 miembros por organización',
      'Todas las funciones incluidas',
      'Valuación automática de tu empresa',
      'CRM integrado (próx.)',
      'Soporte 24/7',
      'Onboarding personalizado'
    ]
  },
};

// Subscription status
export const SUBSCRIPTION_STATUSES = ['active', 'cancelled', 'past_due', 'trialing', 'pending'] as const;
export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];

// Cancellation status for grace period tracking
export const CANCELLATION_STATUSES = ['active', 'pending_cancellation', 'cancelled'] as const;
export type CancellationStatus = typeof CANCELLATION_STATUSES[number];

// Subscriptions table - links user to their plan
export const subscriptions = pgTable("subscriptions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planType: text("plan_type").notNull(), // PlanType
  status: text("status").notNull().default('active'), // SubscriptionStatus
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripePriceId: text("stripe_price_id"),
  mpSubscriptionId: text("mp_subscription_id"), // MercadoPago preapproval id
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
  cancellationStatus: text("cancellation_status").default('active'), // 'active' | 'pending_cancellation' | 'cancelled'
  cancellationRequestedAt: timestamp("cancellation_requested_at"), // When user requested cancellation
  scheduledPlanType: text("scheduled_plan_type"), // Plan scheduled for next billing cycle (downgrades)
  scheduledChangeDate: timestamp("scheduled_change_date"), // When the scheduled change will apply
  paymentFailedAt: timestamp("payment_failed_at"), // When payment first failed (for grace period calculation)
  lastDataReminderSentAt: timestamp("last_data_reminder_sent_at"), // Last post-cancellation data reminder email sent
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Task #310 — Restricción única parcial sobre stripe_subscription_id.
  // Histórico: en producción había 32 pares duplicados con el mismo
  // stripe_subscription_id porque dos webhooks distintos
  // (checkout.session.completed y customer.subscription.created/updated)
  // llegaban casi simultáneamente y ambos terminaban llamando a
  // createSubscription cuando getSubscriptionByUserId todavía no veía la
  // fila recién insertada. El índice es parcial porque la columna admite
  // NULL (rows pre-checkout) y no queremos forzar unicidad sobre los nulos.
  // ANTES de aplicar esta migración hay que correr scripts/dedupe-subscriptions.ts
  // --commit en producción; si no, la migración falla por los duplicados existentes.
  stripeSubscriptionIdUniqueIdx: uniqueIndex("subscriptions_stripe_subscription_id_unique_idx")
    .on(t.stripeSubscriptionId)
    .where(sql`${t.stripeSubscriptionId} IS NOT NULL`),
}));

export const insertSubscriptionSchema = createInsertSchema(subscriptions, {
  planType: z.enum(PLAN_TYPES),
  status: z.enum(SUBSCRIPTION_STATUSES).default('active'),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptions.$inferSelect;

// Snapshots mensuales del MRR para graficar la evolución del negocio en /admin.
// Una fila por mes (snapshotMonth = 'YYYY-MM'); el job hace upsert para que el
// valor del mes en curso se mantenga fresco y, al cambiar de mes, quede fijado
// el último valor observado. Las cifras se guardan ya unificadas (ARS y su
// equivalente referencial en USD) junto al tipo de cambio usado.
export const mrrSnapshots = pgTable("mrr_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  snapshotMonth: text("snapshot_month").notNull().unique(), // 'YYYY-MM' (hora Argentina)
  mrrArs: doublePrecision("mrr_ars").notNull(),
  mrrUsd: doublePrecision("mrr_usd").notNull(),
  activeSubscriptions: integer("active_subscriptions").notNull(),
  usdArsRate: doublePrecision("usd_ars_rate").notNull(),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
});

export const insertMrrSnapshotSchema = createInsertSchema(mrrSnapshots).omit({
  id: true,
  capturedAt: true,
});
export type InsertMrrSnapshot = z.infer<typeof insertMrrSnapshotSchema>;
export type MrrSnapshot = typeof mrrSnapshots.$inferSelect;

// Motivos por los que el sistema elimina una cuenta automáticamente.
//  - 'non_payment': suscripción cancelada con pago fallido / mora previa
//    (el usuario dejó de pagar) y se cumplió la retención de 60 días.
//  - 'cancellation': suscripción cancelada voluntariamente por el usuario
//    (sin pago fallido) y se cumplió la retención de 60 días.
//  - 'inactivity': usuario sin suscripción ni membresía activa, soft-deleted
//    a los 30 días del registro.
export const ACCOUNT_DELETION_REASONS = ['non_payment', 'cancellation', 'inactivity'] as const;
export type AccountDeletionReason = typeof ACCOUNT_DELETION_REASONS[number];

// Registro de cuentas eliminadas por el sistema (limpiezas automáticas).
// IMPORTANTE: esta tabla NO tiene FK a users a propósito: la limpieza de
// cancelados hace HARD-delete de la fila de users, así que el log tiene que
// sobrevivir a esa eliminación. Guardamos los datos mínimos (email/nombre/
// motivo) para poder mostrar y contar las bajas en el panel admin aunque el
// usuario original ya no exista.
export const accountDeletions = pgTable("account_deletions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  // Referencia floja (sin FK) al usuario eliminado, sólo informativa.
  userId: varchar("user_id"),
  email: text("email").notNull(),
  name: text("name"),
  reason: text("reason").notNull(), // AccountDeletionReason
  // Estado de la suscripción al momento de la baja (si tenía), para auditoría.
  subscriptionStatus: text("subscription_status"),
  deletedAt: timestamp("deleted_at").defaultNow().notNull(),
});

export const insertAccountDeletionSchema = createInsertSchema(accountDeletions, {
  reason: z.enum(ACCOUNT_DELETION_REASONS),
}).omit({
  id: true,
  deletedAt: true,
});
export type InsertAccountDeletion = z.infer<typeof insertAccountDeletionSchema>;
export type AccountDeletion = typeof accountDeletions.$inferSelect;

// Team invitations - for team plans to invite members
export const teamInvitations = pgTable("team_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  invitedBy: varchar("invited_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default('operator'), // Role
  temporaryPassword: text("temporary_password"), // Hashed temp password (only for new users)
  status: text("status").notNull().default('pending'), // 'pending', 'accepted', 'expired'
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTeamInvitationSchema = createInsertSchema(teamInvitations, {
  role: z.enum(ROLES).default('operator'),
}).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
});
export type InsertTeamInvitation = z.infer<typeof insertTeamInvitationSchema>;
export type TeamInvitation = typeof teamInvitations.$inferSelect;

// Pending signups - stores registration data until payment is completed
export const pendingSignups = pgTable("pending_signups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  name: text("name").notNull(),
  hashedPassword: text("hashed_password").notNull(),
  accountType: text("account_type").notNull().default('business'),
  organizationName: text("organization_name"),
  country: text("country").notNull().default('AR'),
  profileIconKey: text("profile_icon_key"),
  phoneNumber: text("phone_number"),
  planType: text("plan_type").notNull(),
  priceId: text("price_id").notNull(),
  stripeSessionId: text("stripe_session_id"),
  status: text("status").notNull().default('pending'), // 'pending', 'completed', 'expired'
  // Constancia de aceptación de los Términos al registrarse. Se propaga al
  // usuario definitivo cuando se completa el alta tras el checkout de Stripe.
  termsAcceptedAt: timestamp("terms_accepted_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertPendingSignupSchema = createInsertSchema(pendingSignups).omit({
  id: true,
  createdAt: true,
});
export type InsertPendingSignup = z.infer<typeof insertPendingSignupSchema>;
export type PendingSignup = typeof pendingSignups.$inferSelect;

// ============================================
// TRANSACTION CATEGORIES (Organization-scoped)
// ============================================

export const CATEGORY_TYPES = ['income', 'expense'] as const;
export type CategoryType = typeof CATEGORY_TYPES[number];

export const EXPENSE_SUBTYPES = ['cost', 'expense'] as const;
export type ExpenseSubtype = typeof EXPENSE_SUBTYPES[number];

export const EXPENSE_SUBTYPE_LABELS: Record<ExpenseSubtype, string> = {
  'cost': 'Costo',
  'expense': 'Gasto',
};

export const DEFAULT_INCOME_CATEGORIES = [
  'Ventas',
  'Servicios',
  'Honorarios',
  'Alquileres',
  'Intereses',
  'Dividendos',
  'Otros ingresos'
] as const;

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Proveedores',
  'Sueldos',
  'Servicios públicos',
  'Alquiler',
  'Impuestos',
  'Seguros',
  'Mantenimiento',
  'Transporte',
  'Marketing',
  'Insumos',
  'Otros gastos'
] as const;

export const DEFAULT_COST_CATEGORIES: readonly string[] = [
  'Proveedores',
  'Insumos',
  'Transporte',
  'Materiales',
  'Producción',
  'Inventario',
];

export const transactionCategories = pgTable("transaction_categories", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  expenseSubtype: text("expense_subtype").default("expense"),
  isDefault: boolean("is_default").notNull().default(false),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at"), // Task #363: unificación archivar/eliminar
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTransactionCategorySchema = createInsertSchema(transactionCategories, {
  type: z.enum(CATEGORY_TYPES),
  expenseSubtype: z.enum(EXPENSE_SUBTYPES).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTransactionCategory = z.infer<typeof insertTransactionCategorySchema>;
export type TransactionCategory = typeof transactionCategories.$inferSelect;

// Update schemas for PATCH endpoints - only allow specific fields to be updated
export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  profileImageUrl: z.string().nullable().optional(),
  profileIconKey: z.string().nullable().optional(),
  password: z.string().min(6).optional(),
}).strict();

// Recorta y normaliza strings vacíos a null (preserva undefined para no tocar
// campos ausentes en el PATCH).
const trimToNull = z
  .string()
  .nullable()
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    const trimmed = val.trim();
    return trimmed === '' ? null : trimmed;
  });

// Normaliza strings vacíos a null sin recortar (para URLs/logos).
const emptyToNull = z
  .string()
  .nullable()
  .optional()
  .transform((val) => {
    if (val === undefined) return undefined;
    return val || null;
  });

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  logoUrl: z.string().nullable().optional(),
  iconKey: z.string().nullable().optional(),
  country: z.enum(COUNTRIES).optional(),
  defaultCurrency: z.enum(CURRENCIES).optional(),
  contactEmail: trimToNull,
  contactPhone: trimToNull,
  quotePdfLogoUrl: emptyToNull,
  quotePdfContactEmail: trimToNull,
  quotePdfContactPhone: trimToNull,
  quotePdfCompanyName: trimToNull,
  quotePdfContactName: trimToNull,
}).strict();

export const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.string().optional(),
  balance: z.string().or(z.number()).transform(val => String(val)).optional(),
  currency: z.enum(CURRENCIES).optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  accountCategory: z.string().optional(),
  customTypeLabel: z.string().nullable().optional(),
  initialInvestment: z.string().or(z.number()).transform(val => val != null ? String(val) : null).nullable().optional(),
  maturityDate: z.string().nullable().optional(),
  interestRate: z.string().or(z.number())
    .transform(val => val === '' || val === null || val === undefined ? null : String(val))
    .refine(
      (val) => {
        if (val === null) return true;
        const n = parseFloat(val);
        return !isNaN(n) && n >= 0 && n < 10000;
      },
      { message: 'La tasa de interés debe ser un número entre 0 y 9999,99' }
    )
    .nullable().optional(),
  interestFrequency: z.string().nullable().optional(),
}).strict();

export const updateTransactionSchema = z.object({
  type: z.string().optional(),
  amount: z.string().or(z.number()).transform(val => String(val)).optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  date: z.string().or(z.date()).transform(val => parseLocalDate(val)).optional(),
  imputationDate: z.string().or(z.date()).transform(val => parseLocalDate(val)).optional(),
  accountId: z.string().nullable().optional(),
  hasInvoice: z.boolean().optional(),
  invoiceType: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(),
  invoiceTaxId: z.string().nullable().optional(),
  invoiceAddress: z.string().nullable().optional(),
  invoicePhone: z.string().nullable().optional(),
  invoiceFileUrl: z.string().nullable().optional(),
  invoiceNetAmount: z.string().or(z.number()).transform(v => v === null || v === undefined ? null : String(v)).nullable().optional(),
  invoiceIvaAmount: z.string().or(z.number()).transform(v => v === null || v === undefined ? null : String(v)).nullable().optional(),
  invoiceIvaAliquot: z.string().or(z.number()).transform(v => v === null || v === undefined ? null : String(v)).nullable().optional(),
  invoiceOtherTaxes: z.string().or(z.number()).transform(v => v === null || v === undefined ? null : String(v)).nullable().optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  clientId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  productQuantity: z.string().or(z.number()).transform(val => val === null || val === undefined ? null : String(val)).nullable().optional(),
  assetType: z.string().nullable().optional(),
  expenseSubtype: z.enum(EXPENSE_SUBTYPES).nullable().optional(),
  projectId: z.string().nullable().optional(),
  profitabilityCodeId: z.string().nullable().optional(),
  isRecurring: z.boolean().optional(),
  recurrenceFrequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).nullable().optional(),
}).strict();
// Task #489: the invoice-number format is intentionally NOT enforced here.
// Movements created before the canonical PPPP-NNNNNNNN enforcement (and
// ARCA-emitted ones, which store the bare voucher number) carry non-canonical
// `invoiceNumber` values. Editing ANY other field re-sends the existing
// `invoiceNumber`, so a blind format check here would make those movements
// un-editable. The PATCH handler (`server/routes/transactions.ts`) instead
// enforces the canonical format only when `invoiceNumber` actually CHANGES
// from the stored value, so pre-existing values pass through untouched while
// newly entered numbers are still validated.

export const updateClientSchema = z.object({
  name: z.string().min(1, 'Tenés que ingresar el nombre del cliente').optional(),
  email: z.string().email('Email inválido').nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  clientType: z.string().trim().min(1).max(50, 'El tipo no puede superar los 50 caracteres').nullable().optional(),
  subscriberPlanId: z.string().uuid('Plan de suscripción inválido').nullable().optional(),
  subscriberQuantity: z.number({ invalid_type_error: 'La cantidad tiene que ser un número' }).int('La cantidad tiene que ser un número entero').positive('La cantidad tiene que ser mayor a 0').nullable().optional(),
  subscriberUnitPriceOverride: z.string().or(z.number()).transform(v => v == null ? v : String(v)).nullable().optional(),
  subscriberCurrencyOverride: z.enum(CURRENCIES, { errorMap: () => ({ message: 'Elegí una moneda válida' }) }).nullable().optional(),
  subscriberBillingDay: z.number({ invalid_type_error: 'El día de cobro tiene que ser un número' }).int('El día de cobro tiene que ser un número entero').min(1, 'El día de cobro tiene que ser entre 1 y 28').max(28, 'El día de cobro tiene que ser entre 1 y 28').nullable().optional(),
  subscriberStartMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido. Usá el formato AAAA-MM (ej: 2026-05)').nullable().optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  taxId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  supplierType: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateEmployeeSchema = z.object({
  fullName: z.string().min(1).optional(),
  dni: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  birthDate: z.union([z.string(), z.date()]).nullable().optional().transform(val => val ? new Date(val) : null),
  startDate: z.union([z.string(), z.date()]).nullable().optional().transform(val => val ? new Date(val) : null),
  contractType: z.enum(CONTRACT_TYPES).optional(),
  grossSalary: z.string().or(z.number()).transform(val => String(val)).optional(),
  netSalary: z.string().or(z.number()).transform(val => String(val)).optional(),
  currency: z.enum(CURRENCIES).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  notes: z.string().nullable().optional(),
}).strict();

export const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  productType: z.enum(PRODUCT_TYPES).optional(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  costPrice: z.string().or(z.number()).transform(val => String(val)).optional(),
  costCurrency: z.string().nullable().optional(),
  salePrice: z.string().or(z.number()).transform(val => String(val)).optional(),
  stock: z.string().or(z.number()).transform(val => String(val)).optional(),
  minStock: z.string().or(z.number()).transform(val => String(val)).optional(),
  ivaAliquot: z.string().or(z.number())
    .transform(val => String(Number(val)))
    .refine(val => (VALID_IVA_ALIQUOTS as readonly string[]).includes(val), { message: 'Alícuota de IVA inválida (valores: 0, 2.5, 5, 10.5, 21, 27)' })
    .optional(),
  unit: z.string().nullable().optional(),
  purchaseDate: z.union([z.string(), z.date()]).nullable().optional().transform((val, ctx) => {
    if (!val) return null;
    const d = typeof val === 'string' ? new Date(val) : val;
    if (isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de compra inválida' });
      return z.NEVER;
    }
    return d;
  }),
  usefulLifeMonths: z.union([z.number(), z.string()]).nullable().optional().transform((val, ctx) => {
    if (val === null || val === undefined || val === '') return null;
    const n = typeof val === 'string' ? parseInt(val) : val;
    if (isNaN(n) || n <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'La vida útil debe ser un número positivo' });
      return z.NEVER;
    }
    return n;
  }),
  currentValue: z.string().or(z.number()).nullable().optional().transform(val => val != null ? String(val) : null),
  isActive: z.boolean().optional(),
  defaultProfitabilityCodeId: z.string().nullable().optional(),
}).strict();

export const updateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  category: z.enum(ASSET_CATEGORIES).optional(),
  acquisitionValue: z.string().or(z.number()).transform(val => String(val)).optional(),
  currentValue: z.string().or(z.number()).transform(val => String(val)).optional(),
  depreciationMonths: z.number().optional(),
  usefulLifeMonths: z.number().optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateInvestmentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  investmentType: z.string().optional(),
  initialValue: z.string().or(z.number()).transform(val => String(val)).optional(),
  currentValue: z.string().or(z.number()).transform(val => String(val)).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const updateMembershipSchema = z.object({
  role: z.enum(ROLES).optional(),
}).strict();

export const updateCategorySchema = z.object({
  name: z.string().min(1).optional(),
}).strict();

// ============================================
// ACCESS DENIED EVENTS (For friendly messages when access is lost)
// ============================================

export const ACCESS_DENIED_REASONS = [
  'org_owner_deleted',    // Organization owner deleted their account
  'member_removed',       // Member was removed from the organization
  'org_deleted',          // Organization was deleted
] as const;
export type AccessDeniedReason = typeof ACCESS_DENIED_REASONS[number];

export const ACCESS_DENIED_REASON_LABELS: Record<AccessDeniedReason, string> = {
  'org_owner_deleted': 'El propietario de la organización eliminó su cuenta',
  'member_removed': 'Fuiste removido del equipo',
  'org_deleted': 'La organización fue eliminada',
};

// Table to store access denied events for showing friendly messages
export const accessDeniedEvents = pgTable("access_denied_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(), // Don't cascade - we need this after user deletion
  userEmail: text("user_email").notNull(), // Store email for lookup after user deletion
  organizationId: varchar("organization_id"), // May be null if org was deleted
  organizationName: text("organization_name").notNull(), // Store name before deletion
  reason: text("reason").notNull(), // AccessDeniedReason
  removedByUserId: varchar("removed_by_user_id"), // Who removed them (if applicable)
  removedByUserName: text("removed_by_user_name"), // Name of who removed them
  acknowledged: boolean("acknowledged").notNull().default(false), // User has seen the message
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAccessDeniedEventSchema = createInsertSchema(accessDeniedEvents).omit({
  id: true,
  createdAt: true,
});
export type InsertAccessDeniedEvent = z.infer<typeof insertAccessDeniedEventSchema>;
export type AccessDeniedEvent = typeof accessDeniedEvents.$inferSelect;

// ============================================
// CHAT MESSAGES (Persistent AI conversation history per organization)
// ============================================

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = typeof CHAT_ROLES[number];

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
});
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

// ============================================
// Notifications System
// ============================================

export const NOTIFICATION_TYPES = ['payment_due', 'payment_overdue', 'collection_due', 'collection_overdue', 'system', 'invoice_email_failed'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export const NOTIFICATION_PRIORITIES = ['info', 'warning', 'urgent'] as const;
export type NotificationPriority = typeof NOTIFICATION_PRIORITIES[number];

export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'payment_due' | 'payment_overdue' | 'collection_due' | 'collection_overdue' | 'system'
  priority: text("priority").notNull().default('info'), // 'info' | 'warning' | 'urgent'
  title: text("title").notNull(),
  message: text("message").notNull(),
  imageUrl: text("image_url"), // Optional image attachment
  attachmentUrl: text("attachment_url"), // Optional file attachment (PDF, etc.)
  attachmentName: text("attachment_name"), // Original filename of attachment
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "cascade" }),
  source: text("source").notNull().default('auto'), // 'auto' = generated automatically, 'user_click' = user clicked
  isRead: boolean("is_read").default(false).notNull(),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
  readAt: true,
});
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;

export const whatsappPreferences = pgTable("whatsapp_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  preferredAccountId: varchar("preferred_account_id").references(() => accounts.id, { onDelete: "set null" }),
  preferredCurrency: text("preferred_currency"),
  preferredExpenseCategory: text("preferred_expense_category"),
  preferredIncomeCategory: text("preferred_income_category"),
  defaultHasInvoice: boolean("default_has_invoice"),
  // Task #210 — Cada cuántas horas el bot vuelve a mostrar el banner
  // "Estás registrando movimientos en X" al inicio de una nueva conversación.
  //   - null  → usar default (DEFAULT_ORG_BANNER_INTERVAL_HOURS, 6h)
  //   - 0     → no mostrar nunca
  //   - >0    → cantidad de horas entre banners
  orgBannerIntervalHours: integer("org_banner_interval_hours"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWhatsappPreferencesSchema = createInsertSchema(whatsappPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWhatsappPreferences = z.infer<typeof insertWhatsappPreferencesSchema>;
export type WhatsappPreferences = typeof whatsappPreferences.$inferSelect;

export const dashboardPreferences = pgTable("dashboard_preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  preferredAccountId: varchar("preferred_account_id").references(() => accounts.id, { onDelete: "set null" }),
  preferredCurrency: text("preferred_currency"),
  preferredExpenseCategory: text("preferred_expense_category"),
  preferredIncomeCategory: text("preferred_income_category"),
  defaultHasInvoice: boolean("default_has_invoice"),
  lastEmitSendEmail: boolean("last_emit_send_email"),
  lastEmitSendSelfCopy: boolean("last_emit_send_self_copy"),
  lastEmitCcList: text("last_emit_cc_list").array(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDashboardPreferencesSchema = createInsertSchema(dashboardPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDashboardPreferences = z.infer<typeof insertDashboardPreferencesSchema>;
export type DashboardPreferences = typeof dashboardPreferences.$inferSelect;

// Per-client overrides for invoice-email sending preferences (CC list, BCC self).
// When emitting an invoice for a client, the wizard first looks up these overrides
// and falls back to organization-level defaults if none exist.
export const clientInvoiceEmailPrefs = pgTable("client_invoice_email_prefs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  clientId: varchar("client_id").notNull().unique().references(() => clients.id, { onDelete: "cascade" }),
  defaultCcEmails: text("default_cc_emails").array().notNull().default(sql`ARRAY[]::text[]`),
  sendCopyToSelf: boolean("send_copy_to_self").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertClientInvoiceEmailPrefsSchema = createInsertSchema(clientInvoiceEmailPrefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertClientInvoiceEmailPrefs = z.infer<typeof insertClientInvoiceEmailPrefsSchema>;
export type ClientInvoiceEmailPrefs = typeof clientInvoiceEmailPrefs.$inferSelect;

export const updateClientInvoiceEmailPrefsSchema = z.object({
  defaultCcEmails: z.array(z.string().email('Email inválido')).max(20, 'Máximo 20 CC').optional(),
  sendCopyToSelf: z.boolean().optional(),
});
export type UpdateClientInvoiceEmailPrefs = z.infer<typeof updateClientInvoiceEmailPrefsSchema>;

// Per-supplier overrides for invoice-email sending preferences (CC list, BCC self).
// Mirror of clientInvoiceEmailPrefs, used when the wizard emits a comprobante
// directed at a supplier (e.g. notas de crédito/débito propias).
export const supplierInvoiceEmailPrefs = pgTable("supplier_invoice_email_prefs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: varchar("supplier_id").notNull().unique().references(() => suppliers.id, { onDelete: "cascade" }),
  defaultCcEmails: text("default_cc_emails").array().notNull().default(sql`ARRAY[]::text[]`),
  sendCopyToSelf: boolean("send_copy_to_self").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSupplierInvoiceEmailPrefsSchema = createInsertSchema(supplierInvoiceEmailPrefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSupplierInvoiceEmailPrefs = z.infer<typeof insertSupplierInvoiceEmailPrefsSchema>;
export type SupplierInvoiceEmailPrefs = typeof supplierInvoiceEmailPrefs.$inferSelect;

export const updateSupplierInvoiceEmailPrefsSchema = z.object({
  defaultCcEmails: z.array(z.string().email('Email inválido')).max(20, 'Máximo 20 CC').optional(),
  sendCopyToSelf: z.boolean().optional(),
});
export type UpdateSupplierInvoiceEmailPrefs = z.infer<typeof updateSupplierInvoiceEmailPrefsSchema>;


// ============================================================================
// FACTURITA / E-INVOICING (ARCA - AFIP)
// ============================================================================
export const INVOICING_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type InvoicingEnvironment = typeof INVOICING_ENVIRONMENTS[number];

export const INVOICING_EMITTER_IVA_CONDITIONS = ['responsable_inscripto', 'monotributo', 'exento'] as const;
export type InvoicingEmitterIvaCondition = typeof INVOICING_EMITTER_IVA_CONDITIONS[number];

// AFIP/ARCA invoice document types (sale-side)
export const INVOICING_DOC_TYPES = [
  'FA', 'FB', 'FC',
  'NCA', 'NCB', 'NCC',
  'NDA', 'NDB', 'NDC',
] as const;
export type InvoicingDocType = typeof INVOICING_DOC_TYPES[number];

export const INVOICING_DOC_TYPE_LABELS: Record<InvoicingDocType, string> = {
  FA: 'Factura A',
  FB: 'Factura B',
  FC: 'Factura C',
  NCA: 'Nota de Crédito A',
  NCB: 'Nota de Crédito B',
  NCC: 'Nota de Crédito C',
  NDA: 'Nota de Débito A',
  NDB: 'Nota de Débito B',
  NDC: 'Nota de Débito C',
};

export const INVOICE_EMISSION_STATUSES = ['pending', 'emitted', 'failed', 'cancelled'] as const;
export type InvoiceEmissionStatus = typeof INVOICE_EMISSION_STATUSES[number];

// One Facturita configuration per organization
export const invoicingAccounts = pgTable("invoicing_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().unique().references(() => organizations.id, { onDelete: "cascade" }),
  cuit: text("cuit").notNull(),
  // For sociedades (CUIT 30/33) ARCA requires the personal CUIT of the
  // administrator (CUIT 20/23/24/27) to authenticate the signup. Stored so
  // we don't have to ask again on re-sync. Clave fiscal is NEVER persisted.
  adminCuit: text("admin_cuit"),
  razonSocial: text("razon_social"),
  ivaCondition: text("iva_condition").notNull(), // see INVOICING_EMITTER_IVA_CONDITIONS
  environment: text("environment").notNull().default('sandbox'), // 'sandbox' | 'production'
  defaultSellingPoint: integer("default_selling_point"), // e.g. 1, 2, 3
  // Optional emitter contact info shown on invoices (no fiscal validation)
  address: text("address"),
  phone: text("phone"),
  // Optional encrypted certificate material (AES-GCM via INVOICING_ENCRYPTION_KEY)
  // Stored as base64 of: 12-byte IV || ciphertext || 16-byte authTag
  encryptedCert: text("encrypted_cert"),
  encryptedKey: text("encrypted_key"),
  isActive: boolean("is_active").notNull().default(false),
  isSimulated: boolean("is_simulated").notNull().default(false), // Activated via internal sandbox mock (no fiscal validity)
  lastValidatedAt: timestamp("last_validated_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  notes: text("notes"),
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInvoicingAccountSchema = createInsertSchema(invoicingAccounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const upsertInvoicingAccountSchema = z.object({
  cuit: z.string().regex(/^\d{11}$/, 'El CUIT debe tener 11 dígitos numéricos'),
  razonSocial: z.string().min(1).max(200).nullable().optional(),
  ivaCondition: z.enum(INVOICING_EMITTER_IVA_CONDITIONS),
  environment: z.enum(INVOICING_ENVIRONMENTS).default('sandbox'),
  defaultSellingPoint: z.number().int().positive().nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type InsertInvoicingAccount = z.infer<typeof insertInvoicingAccountSchema>;
export type UpsertInvoicingAccount = z.infer<typeof upsertInvoicingAccountSchema>;
export type InvoicingAccount = typeof invoicingAccounts.$inferSelect;

// Per-organization selling points (puntos de venta) registered with AFIP
export const invoicingSellingPoints = pgTable("invoicing_selling_points", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  number: integer("number").notNull(), // e.g. 1, 2, 3 (max 99999)
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInvoicingSellingPointSchema = createInsertSchema(invoicingSellingPoints).omit({
  id: true,
  createdAt: true,
});
export type InsertInvoicingSellingPoint = z.infer<typeof insertInvoicingSellingPointSchema>;
export type InvoicingSellingPoint = typeof invoicingSellingPoints.$inferSelect;

// Task #282 — Persistencia del estado de la conversación de WhatsApp.
// Antes vivía en un Map in-memory (server/conversation-state.ts), lo que
// rompía en dos casos reales: (1) cualquier reinicio/deploy borraba el
// flujo en curso, así que un "sí" después del deploy quedaba mudo; (2)
// Autoscale con varias réplicas significa que cada réplica tenía su propio
// Map, así que el "1" caía en la réplica A y el "sí" en la B sin contexto.
// La PK es (organization_id, user_id): cada par tiene una única conversación
// activa. El TTL de 30 min se aplica leyendo last_activity_at en cada query.
// Tipos del payload de la conversación. Definidos acá (no en
// server/conversation-state.ts) para que la tabla pueda tiparlos vía
// `.$type<>()` y evitar `as any` en el data-access layer.
export type WhatsappSlotSource = 'auto' | 'explicit' | 'pattern' | 'preference';

export interface WhatsappTransactionSlots {
  type: 'income' | 'expense' | 'receivable' | 'payable' | null;
  amount: number | null;
  currency: string | null;
  accountId: string | null;
  accountName: string | null;
  description: string | null;
  category: string | null;
  hasInvoice: boolean | null;
  invoiceType: string | null;
  invoiceNumber: string | null;
  invoiceTaxId: string | null;
  invoiceFileUrl: string | null;
  date: string | null;
  allowNegativeBalance: boolean | null;
  lastNegativeWarning: { accountId: string; amount: number } | null;
  accountSource: WhatsappSlotSource | null;
  categorySource: WhatsappSlotSource | null;
  invoiceSource: WhatsappSlotSource | null;
  clientId: string | null;
  clientName: string | null;
  supplierId: string | null;
  supplierName: string | null;
}

export type WhatsappCurrentStep =
  | 'type' | 'amount' | 'currency' | 'account' | 'confirm_negative'
  | 'description' | 'category' | 'invoice' | 'invoice_type' | 'invoice_cuit'
  | 'invoice_number' | 'invoice_image' | 'confirm' | 'done';

export interface WhatsappPausedFlow {
  slots: WhatsappTransactionSlots;
  currentStep: WhatsappCurrentStep;
  suggestedAccounts: Array<{ id: string; name: string }> | null;
}

export type WhatsappAccountRef = { id: string; name: string };
export type WhatsappMessage = { role: 'user' | 'assistant'; content: string };

export const whatsappConversations = pgTable("whatsapp_conversations", {
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  currentStep: text("current_step").$type<WhatsappCurrentStep>().notNull().default('type'),
  slots: jsonb("slots").$type<WhatsappTransactionSlots>().notNull(),
  messages: jsonb("messages").$type<WhatsappMessage[]>().notNull().default(sql`'[]'::jsonb`),
  suggestedAccounts: jsonb("suggested_accounts").$type<WhatsappAccountRef[] | null>(),
  availableCategories: jsonb("available_categories").$type<WhatsappAccountRef[] | null>(),
  pausedFlow: jsonb("paused_flow").$type<WhatsappPausedFlow | null>(),
  justCompletedTransaction: boolean("just_completed_transaction").notNull().default(false),
  waitingForContinueDecision: boolean("waiting_for_continue_decision").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.organizationId, table.userId] }),
  userActivityIdx: index("idx_whatsapp_conv_user_activity").on(table.userId, table.lastActivityAt),
  activityIdx: index("idx_whatsapp_conv_activity").on(table.lastActivityAt),
}));

export type WhatsappConversationRow = typeof whatsappConversations.$inferSelect;
export type InsertWhatsappConversation = typeof whatsappConversations.$inferInsert;

// Task #464 — Candado por (org, user) con expiración automática (TTL) para
// serializar el procesamiento de mensajes simultáneos del bot de WhatsApp.
// Reemplaza al advisory lock de sesión (que sobre la conexión pooleada de Neon
// no se liberaba de forma confiable y dejaba el bot "tildado" por minutos). El
// candado se auto-libera por `locked_until` sin depender de que una conexión
// siga viva: si el handler muere o se cuelga, la fila vence y el próximo mensaje
// la reclama. `lock_token` identifica al propietario para que extender/liberar
// solo afecte a quien efectivamente tiene el candado.
export const whatsappLocks = pgTable("whatsapp_locks", {
  organizationId: varchar("organization_id").notNull(),
  userId: varchar("user_id").notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }).notNull(),
  lockToken: varchar("lock_token").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.organizationId, table.userId] }),
  lockedUntilIdx: index("idx_whatsapp_locks_locked_until").on(table.lockedUntil),
}));

export type WhatsappLockRow = typeof whatsappLocks.$inferSelect;

// -----------------------------------------------------------------------------
// WEEKLY DIGEST SENDS — idempotencia del resumen semanal
// -----------------------------------------------------------------------------
// Una fila por (user_id, week_start) que registra que ya se envió (o se está
// enviando) el resumen semanal de esa semana a ese usuario. El disparo real lo
// hace un Scheduled Deployment (ver script/sendWeeklyDigest.ts); esta tabla
// evita envíos duplicados si el job se reintenta o si por error corre más de
// una vez (claim-first con ON CONFLICT DO NOTHING). `week_start` es el lunes de
// la semana en formato YYYY-MM-DD.
export const weeklyDigestSends = pgTable("weekly_digest_sends", {
  userId: varchar("user_id").notNull(),
  weekStart: varchar("week_start").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.weekStart] }),
}));

export type WeeklyDigestSendRow = typeof weeklyDigestSends.$inferSelect;

// -----------------------------------------------------------------------------
// BUSINESS SETTINGS (singleton) — panel ADMIN
// -----------------------------------------------------------------------------
// Tabla de una sola fila (id fijo = 'global') que persiste los valores de
// negocio editables desde /admin: el tipo de cambio USD/ARS de referencia y las
// estimaciones de SaaS (CAC min/max, ratio LTV/CAC). Antes vivían fijos en
// shared/constants.ts y/o en la variable de entorno USD_ARS_RATE, lo que
// requería un deploy para cambiarlos. Los valores en esta tabla tienen
// prioridad sobre los defaults; ver server/routes/admin.ts.
export const BUSINESS_SETTINGS_SINGLETON_ID = 'global' as const;

export const businessSettings = pgTable("business_settings", {
  id: varchar("id").primaryKey().default(BUSINESS_SETTINGS_SINGLETON_ID),
  usdArsRate: doublePrecision("usd_ars_rate").notNull(),
  cacUsdMin: doublePrecision("cac_usd_min").notNull(),
  cacUsdMax: doublePrecision("cac_usd_max").notNull(),
  ltvCacRatio: doublePrecision("ltv_cac_ratio").notNull(),
  // Task #433: configuración para derivar el gasto de adquisición automáticamente
  // desde transacciones etiquetadas. Cuando está habilitado, el gasto por mes se
  // suma a partir de los gastos de `acquisitionOrgId` cuya cuenta / categoría /
  // código de análisis esté seleccionado. La carga manual de acquisition_spend
  // de un mes tiene prioridad sobre el derivado (no se duplica).
  acquisitionAutoEnabled: boolean("acquisition_auto_enabled").notNull().default(false),
  acquisitionOrgId: varchar("acquisition_org_id"),
  acquisitionAccountIds: text("acquisition_account_ids").array().notNull().default(sql`ARRAY[]::text[]`),
  acquisitionCategories: text("acquisition_categories").array().notNull().default(sql`ARRAY[]::text[]`),
  acquisitionProfitabilityCodeIds: text("acquisition_profitability_code_ids").array().notNull().default(sql`ARRAY[]::text[]`),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export type BusinessSettings = typeof businessSettings.$inferSelect;

export const updateBusinessSettingsSchema = z.object({
  usdArsRate: z.number().positive().max(100000000),
  cacUsdMin: z.number().min(0).max(100000000),
  cacUsdMax: z.number().min(0).max(100000000),
  ltvCacRatio: z.number().positive().max(100000),
}).refine((d) => d.cacUsdMax >= d.cacUsdMin, {
  message: "El CAC máximo debe ser mayor o igual al mínimo",
  path: ["cacUsdMax"],
});

export type UpdateBusinessSettings = z.infer<typeof updateBusinessSettingsSchema>;

// -----------------------------------------------------------------------------
// ACQUISITION SPEND (gasto de adquisición por mes) — panel ADMIN
// -----------------------------------------------------------------------------
// Task #424: registra cuánto se gastó en adquirir clientes (marketing/ventas)
// por mes calendario, para poder calcular el CAC real = gasto del período /
// altas del período (en lugar de la estimación fija de business_settings).
// Una fila por mes (clave 'YYYY-MM'). El monto se carga en ARS, como el resto
// de los importes del sistema; el equivalente en USD se deriva con el tipo de
// cambio de business_settings.
export const acquisitionSpend = pgTable("acquisition_spend", {
  // Mes calendario en formato 'YYYY-MM' (ej. '2026-06'). Clave primaria.
  month: varchar("month").primaryKey(),
  amountArs: doublePrecision("amount_ars").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export type AcquisitionSpend = typeof acquisitionSpend.$inferSelect;

export const upsertAcquisitionSpendSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "El mes debe tener el formato AAAA-MM"),
  amountArs: z.number().min(0).max(100000000000),
});

export type UpsertAcquisitionSpend = z.infer<typeof upsertAcquisitionSpendSchema>;

// Task #433: configuración de derivación automática del gasto de adquisición.
// Permite elegir la organización (libros propios) y qué cuentas / categorías /
// códigos de análisis cuentan como gasto de adquisición. El gasto por mes se
// deriva sumando esos gastos por mes calendario.
export const updateAcquisitionConfigSchema = z.object({
  acquisitionAutoEnabled: z.boolean(),
  acquisitionOrgId: z.string().uuid().nullable(),
  acquisitionAccountIds: z.array(z.string()).max(100),
  acquisitionCategories: z.array(z.string()).max(200),
  acquisitionProfitabilityCodeIds: z.array(z.string()).max(100),
}).refine(
  (d) => !d.acquisitionAutoEnabled || d.acquisitionOrgId != null,
  { message: "Elegí una organización para derivar el gasto automáticamente", path: ["acquisitionOrgId"] },
);

export type UpdateAcquisitionConfig = z.infer<typeof updateAcquisitionConfigSchema>;

// Forma del gasto de adquisición ya resuelto (mezcla de manual + derivado) que
// consume el cálculo del CAC.
export interface MonthlyAcquisitionSpend {
  month: string; // 'YYYY-MM'
  amountArs: number;
  source: 'manual' | 'auto';
}

// =============================================================================
// INTEGRACIÓN TIENDANUBE
// =============================================================================

export const TIENDANUBE_CONNECTION_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type TiendanubeConnectionStatus = typeof TIENDANUBE_CONNECTION_STATUSES[number];

// Conexión de una tienda Tiendanube por organización (1:1).
export const tiendanubeConnections = pgTable("tiendanube_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  storeId: text("store_id").notNull(), // id de la tienda en Tiendanube
  storeName: text("store_name"),
  storeUrl: text("store_url"),
  accessTokenEncrypted: text("access_token_encrypted").notNull(), // AES-GCM
  scope: text("scope"),
  status: text("status").notNull().default("connected"), // TiendanubeConnectionStatus
  connectedByUserId: varchar("connected_by_user_id").references(() => users.id, { onDelete: "set null" }),
  connectedAt: timestamp("connected_at").defaultNow(),
  lastSyncAt: timestamp("last_sync_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgUnique: uniqueIndex("tiendanube_connections_org_unique").on(t.organizationId),
}));

export const insertTiendanubeConnectionSchema = createInsertSchema(tiendanubeConnections).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertTiendanubeConnection = z.infer<typeof insertTiendanubeConnectionSchema>;
export type TiendanubeConnection = typeof tiendanubeConnections.$inferSelect;

// Mapeo de medios de pago de Tiendanube → cuenta destino en Aikestar.
export const tiendanubePaymentMappings = pgTable("tiendanube_payment_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull().references(() => tiendanubeConnections.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  gatewayName: text("gateway_name").notNull(), // nombre/id del medio de pago en Tiendanube
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "set null" }),
  paymentMethodId: varchar("payment_method_id").references(() => paymentMethods.id, { onDelete: "set null" }),
  autoDetected: boolean("auto_detected").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  connGatewayUnique: uniqueIndex("tiendanube_pm_conn_gateway_unique").on(t.connectionId, t.gatewayName),
}));

export const insertTiendanubePaymentMappingSchema = createInsertSchema(tiendanubePaymentMappings).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertTiendanubePaymentMapping = z.infer<typeof insertTiendanubePaymentMappingSchema>;
export type TiendanubePaymentMapping = typeof tiendanubePaymentMappings.$inferSelect;

export const TIENDANUBE_WEBHOOK_STATUSES = ['received', 'processed', 'failed', 'skipped'] as const;

// Eventos de webhook recibidos: idempotencia (unique conn+event+resource) + auditoría.
export const tiendanubeWebhookEvents = pgTable("tiendanube_webhook_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").references(() => tiendanubeConnections.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  event: text("event").notNull(), // 'order/paid' | 'order/created' | ...
  externalResourceId: text("external_resource_id").notNull(), // id del pedido/producto
  payloadHash: text("payload_hash"),
  status: text("status").notNull().default("received"),
  error: text("error"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (t) => ({
  dedupUnique: uniqueIndex("tiendanube_webhook_dedup_unique").on(t.connectionId, t.event, t.externalResourceId),
}));

export const insertTiendanubeWebhookEventSchema = createInsertSchema(tiendanubeWebhookEvents).omit({
  id: true, receivedAt: true,
});
export type InsertTiendanubeWebhookEvent = z.infer<typeof insertTiendanubeWebhookEventSchema>;
export type TiendanubeWebhookEvent = typeof tiendanubeWebhookEvents.$inferSelect;

// Trazabilidad pedido Tiendanube ↔ transacción/cliente Aikestar (unique conn+order).
export const tiendanubeOrderLinks = pgTable("tiendanube_order_links", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull().references(() => tiendanubeConnections.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  externalOrderId: text("external_order_id").notNull(),
  orderNumber: text("order_number"),
  transactionId: varchar("transaction_id").references(() => transactions.id, { onDelete: "set null" }),
  clientId: varchar("client_id").references(() => clients.id, { onDelete: "set null" }),
  status: text("status").notNull().default("synced"), // 'synced' | 'cancelled'
  totalAmount: decimal("total_amount", { precision: 15, scale: 2 }),
  currency: text("currency"),
  gateway: text("gateway"),
  rawSnapshot: jsonb("raw_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  connOrderUnique: uniqueIndex("tiendanube_order_conn_order_unique").on(t.connectionId, t.externalOrderId),
}));

export const insertTiendanubeOrderLinkSchema = createInsertSchema(tiendanubeOrderLinks).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertTiendanubeOrderLink = z.infer<typeof insertTiendanubeOrderLinkSchema>;
export type TiendanubeOrderLink = typeof tiendanubeOrderLinks.$inferSelect;

export const TIENDANUBE_MATCH_STATUSES = ['pending', 'auto_linked', 'approved', 'rejected'] as const;

// Cola de revisión de clientes (matching ambiguo) + historial de decisiones.
export const tiendanubeClientMatches = pgTable("tiendanube_client_matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull().references(() => tiendanubeConnections.id, { onDelete: "cascade" }),
  organizationId: varchar("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  externalCustomerId: text("external_customer_id").notNull(),
  externalData: jsonb("external_data"), // { name, email, doc, phone }
  candidateClientId: varchar("candidate_client_id").references(() => clients.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  resolvedClientId: varchar("resolved_client_id").references(() => clients.id, { onDelete: "set null" }),
  resolvedByUserId: varchar("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  connCustomerIdx: index("tiendanube_match_conn_customer_idx").on(t.connectionId, t.externalCustomerId),
}));

export const insertTiendanubeClientMatchSchema = createInsertSchema(tiendanubeClientMatches).omit({
  id: true, createdAt: true,
});
export type InsertTiendanubeClientMatch = z.infer<typeof insertTiendanubeClientMatchSchema>;
export type TiendanubeClientMatch = typeof tiendanubeClientMatches.$inferSelect;
