// =============================================================================
// AIKESTAR - Completar el alta de un usuario tras confirmarse el pago
// =============================================================================
// Lógica provider-agnóstica: a partir de un pending_signup ya pagado, crea el
// usuario, sus organizaciones (personal y, si corresponde, business), las
// membresías, categorías/cuentas por defecto y el registro de suscripción.
// Reutilizado por el webhook de MercadoPago (espejo del flujo de Stripe en
// webhookHandlers.ts, sin tocarlo).
// =============================================================================
import { storage } from "../storage";
import {
  sendSubscriptionEmail,
  sendWelcomeEmail,
  sendNewRegistrationAdminEmail,
} from "../services/email";
import {
  PLAN_LABELS,
  PLAN_DETAILS,
  PLAN_TYPES,
  COUNTRIES,
  COUNTRY_CURRENCY_MAP,
  COUNTRY_LABELS,
  type PlanType,
  type Country,
} from "@shared/schema";

function getPlanLabel(planType: unknown): string | null {
  if (typeof planType === "string" && PLAN_TYPES.includes(planType as PlanType)) {
    return PLAN_LABELS[planType as PlanType] ?? null;
  }
  return null;
}

export interface CompleteSignupOptions {
  mpSubscriptionId?: string | null;
  status?: "active" | "trialing";
}

// Completa el alta para un pending_signup pagado. Idempotente: si ya está
// completado o el usuario ya existe, no duplica. Devuelve el id del usuario.
export async function completePendingSignup(
  pendingSignupId: string,
  opts: CompleteSignupOptions = {},
): Promise<string | null> {
  const pendingSignup = await storage.getPendingSignup(pendingSignupId);
  if (!pendingSignup) {
    console.log(`[Signup] Pending signup no encontrado: ${pendingSignupId}`);
    return null;
  }
  if (pendingSignup.status === "completed") {
    console.log(`[Signup] Pending signup ya procesado: ${pendingSignupId}`);
    const existing = await storage.getUserByEmail(pendingSignup.email);
    return existing?.id ?? null;
  }

  // Si el usuario ya existe (re-entrada), solo vinculamos la suscripción.
  const existingUser = await storage.getUserByEmail(pendingSignup.email);
  if (existingUser && !existingUser.deletedAt) {
    if (opts.mpSubscriptionId) {
      await storage.updateUser(existingUser.id, { mpSubscriptionId: opts.mpSubscriptionId });
    }
    await storage.updatePendingSignup(pendingSignupId, { status: "completed" });
    console.log(`[Signup] Usuario ya existía, vinculado: ${existingUser.id}`);
    return existingUser.id;
  }

  const status = opts.status ?? "trialing"; // los altas nuevas arrancan con prueba

  const user = await storage.createUser({
    email: pendingSignup.email,
    name: pendingSignup.name,
    password: pendingSignup.hashedPassword,
    accountType: pendingSignup.accountType as "personal" | "business",
    profileIconKey: pendingSignup.profileIconKey,
    pendingPhoneNumber: pendingSignup.phoneNumber || undefined,
    mpSubscriptionId: opts.mpSubscriptionId || undefined,
  });

  const validCountry: Country = COUNTRIES.includes(pendingSignup.country as Country)
    ? (pendingSignup.country as Country)
    : "AR";
  const defaultCurrency = COUNTRY_CURRENCY_MAP[validCountry] || "ARS";

  // 1. Organización personal (todos la tienen)
  const personalOrg = await storage.createOrganization({
    name: `Finanzas de ${pendingSignup.name}`,
    type: "personal",
    country: validCountry,
    defaultCurrency,
  });
  await storage.createMembership({ userId: user.id, organizationId: personalOrg.id, role: "owner" });
  await storage.seedDefaultCategories(personalOrg.id, user.id);
  await storage.seedDefaultAccount(personalOrg.id, defaultCurrency);

  // 2. Para cuentas business, además una organización de empresa
  if (pendingSignup.accountType === "business") {
    const businessOrgName = pendingSignup.organizationName || `${pendingSignup.name}'s Organization`;
    const businessOrg = await storage.createOrganization({
      name: businessOrgName,
      type: "business",
      country: validCountry,
      defaultCurrency,
    });
    await storage.createMembership({ userId: user.id, organizationId: businessOrg.id, role: "owner" });
    await storage.seedDefaultCategories(businessOrg.id, user.id);
    await storage.seedDefaultAccount(businessOrg.id, defaultCurrency);
  }

  // 3. Registro de suscripción
  await storage.createSubscription({
    userId: user.id,
    planType: pendingSignup.planType as PlanType,
    status,
    mpSubscriptionId: opts.mpSubscriptionId || null,
    stripeSubscriptionId: null,
  });

  await storage.updatePendingSignup(pendingSignupId, { status: "completed" });

  // 4. Emails (no bloqueantes)
  sendWelcomeEmail(user.email, user.name).catch((err) =>
    console.error("[Signup] Error email bienvenida:", err),
  );
  const planLabel = getPlanLabel(pendingSignup.planType);
  if (planLabel) {
    const isTeamPlan = PLAN_DETAILS[pendingSignup.planType as PlanType]?.isTeamPlan || false;
    sendSubscriptionEmail(
      user.email,
      user.name,
      planLabel,
      isTeamPlan ? "business" : "personal",
    ).catch((err) => console.error("[Signup] Error email suscripción:", err));
  }
  storage.getAdminEmails().then((adminEmails) => {
    const orgName =
      pendingSignup.accountType === "business"
        ? pendingSignup.organizationName || `${pendingSignup.name}'s Organization`
        : `Finanzas de ${pendingSignup.name}`;
    const countryLabel = COUNTRY_LABELS[validCountry as keyof typeof COUNTRY_LABELS] || validCountry;
    sendNewRegistrationAdminEmail(adminEmails, {
      name: pendingSignup.name,
      email: pendingSignup.email,
      planType: planLabel || pendingSignup.planType || "N/A",
      accountType: pendingSignup.accountType === "business" ? "business" : "personal",
      organizationName: orgName,
      country: countryLabel,
      phoneNumber: pendingSignup.phoneNumber || undefined,
    }).catch((err) => console.error("[Signup] Error email admin:", err));
  }).catch(() => {});

  console.log(`[Signup] Usuario creado vía MercadoPago: ${user.id}, plan: ${pendingSignup.planType}`);
  return user.id;
}
