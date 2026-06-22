import { getStripeSync, getUncachableStripeClient } from './stripeClient';
import { storage } from './storage';
import { sendSubscriptionEmail, sendCancellationEmail, sendRenewalEmail, sendPaymentFailedEmail, sendWelcomeEmail, sendPaymentReceiptEmail, sendPlanChangeEmail, sendNewRegistrationAdminEmail } from './services/email';
import { PLAN_LABELS, PLAN_DETAILS, PLAN_TYPES, type PlanType, type SubscriptionStatus, COUNTRIES, COUNTRY_CURRENCY_MAP, COUNTRY_LABELS, type Country } from '@shared/schema';

function isValidPlanType(value: unknown): value is PlanType {
  return typeof value === 'string' && PLAN_TYPES.includes(value as PlanType);
}

function getPlanLabel(planType: unknown): string | null {
  if (!isValidPlanType(planType)) return null;
  return PLAN_LABELS[planType] ?? null;
}

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    const isProduction = process.env.NODE_ENV === 'production';
    console.log(`[Stripe Webhook] Received webhook - Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'Received type: ' + typeof payload + '. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).'
      );
    }

    // Only use stripe-replit-sync in development
    // In production, we skip sync.processWebhook and use our manual handlers directly
    if (!isProduction) {
      try {
        const sync = await getStripeSync();
        await sync.processWebhook(payload, signature);
      } catch (syncError: any) {
        console.log('[Stripe Webhook] Sync processing skipped:', syncError.message);
      }
    }

    // Try both webhook secrets - Live first if Live credentials are configured
    // This handles the case where Live webhooks are received in any environment
    const liveWebhookSecret = process.env.STRIPE_LIVE_WEBHOOK_SECRET?.trim();
    const testWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    const hasLiveCredentials = !!process.env.STRIPE_LIVE_SECRET_KEY;
    
    if (!liveWebhookSecret && !testWebhookSecret) {
      console.error('[Stripe Webhook] CRITICAL: No webhook secrets configured');
      throw new Error('No webhook secrets configured - webhook signature verification is required');
    }
    
    const stripe = await getUncachableStripeClient();
    let event: any;
    let usedSecret = '';
    
    // Try Live secret first if we have Live credentials (webhooks might be from Live mode)
    const secretsToTry = hasLiveCredentials 
      ? [{ secret: liveWebhookSecret, name: 'LIVE' }, { secret: testWebhookSecret, name: 'TEST' }]
      : [{ secret: testWebhookSecret, name: 'TEST' }, { secret: liveWebhookSecret, name: 'LIVE' }];
    
    for (const { secret, name } of secretsToTry) {
      if (!secret) continue;
      try {
        event = stripe.webhooks.constructEvent(payload, signature, secret);
        usedSecret = name;
        break;
      } catch (err: any) {
        console.log(`[Stripe Webhook] ${name} secret verification failed: ${err.message}`);
      }
    }
    
    if (!event) {
      throw new Error('Webhook signature verification failed with all available secrets');
    }

    console.log(`[Stripe Webhook] Signature verified successfully with ${usedSecret} secret for event: ${event.id}`);
    await WebhookHandlers.handleEvent(event);
  }

  static async handleEvent(event: any): Promise<void> {
    console.log(`[Stripe Webhook] Processing event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await WebhookHandlers.handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await WebhookHandlers.handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await WebhookHandlers.handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.paid':
        await WebhookHandlers.handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        await WebhookHandlers.handleInvoicePaymentFailed(event.data.object);
        break;
      default:
        console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }
  }

  static async handleCheckoutCompleted(session: any): Promise<void> {
    const pendingSignupId = session.metadata?.pendingSignupId;
    const userId = session.metadata?.userId;
    const planType = session.metadata?.planType as PlanType;
    const customerId = session.customer;
    const subscriptionId = session.subscription;
    const paymentStatus = session.payment_status;
    
    console.log(`[Stripe Webhook] checkout.session.completed - payment_status: ${paymentStatus}, subscriptionId: ${subscriptionId}, customerId: ${customerId}`);

    // Handle NEW signup (pending signup flow)
    if (pendingSignupId) {
      console.log(`[Stripe Webhook] Processing new signup from pending: ${pendingSignupId}, payment_status: ${paymentStatus}`);
      
      const pendingSignup = await storage.getPendingSignup(pendingSignupId);
      if (!pendingSignup) {
        console.log(`[Stripe Webhook] Pending signup not found: ${pendingSignupId} - attempting recovery from Stripe customer data`);
        
        // Try to recover by creating user from Stripe customer data
        // This handles the case where pending_signup expired before checkout completed
        try {
          const stripe = await getUncachableStripeClient();
          const customer = await stripe.customers.retrieve(customerId) as any;
          
          if (customer && !customer.deleted && customer.email) {
            // Check if user already exists
            // Task #343 — soft-deleted users no cuentan: el flujo de re-registro
            // crea un user nuevo con UUID nuevo y el viejo queda para auditoría.
            const existingUser = await storage.getUserByEmail(customer.email);
            if (existingUser && !existingUser.deletedAt) {
              // Orphan-customer guard: if this user is already linked to a
              // DIFFERENT Stripe customer, this checkout almost certainly
              // belongs to a stale duplicate customer. Do not overwrite their
              // existing linkage or subscription — log and bail.
              if (existingUser.stripeCustomerId && existingUser.stripeCustomerId !== customerId) {
                console.log(`[Stripe Webhook] IGNORED checkout recovery: customer ${customerId} is an orphan for user ${existingUser.id} (already linked to ${existingUser.stripeCustomerId}). Skipping.`);
                return;
              }

              console.log(`[Stripe Webhook] User already exists for email: ${customer.email}, linking subscription`);
              await storage.updateUser(existingUser.id, {
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
              });
              
              // Get real subscription status from Stripe
              let subStatus: 'active' | 'trialing' = 'active';
              try {
                const stripe = await getUncachableStripeClient();
                const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
                if (stripeSub.status === 'trialing') {
                  subStatus = 'trialing';
                }
              } catch (e) {
                console.log('[Webhook] Could not retrieve subscription status, defaulting to active');
              }
              
              // Task #310 — upsert keyed por stripe_subscription_id para
              // que no se inserte un duplicado si otro webhook ya creó la fila.
              // Fallback cuando no hay subscriptionId (edge en trials sin
              // subscription todavía adjunta): update por userId o create
              // placeholder, igual que el comportamiento original.
              const existingSub = await storage.getSubscriptionByUserId(existingUser.id);
              if (subscriptionId) {
                if (existingSub || planType) {
                  await storage.upsertSubscriptionByStripeId(subscriptionId, existingUser.id, {
                    planType: planType || (existingSub?.planType as PlanType | undefined),
                    status: subStatus,
                  });
                }
              } else if (existingSub) {
                await storage.updateSubscription(existingSub.id, {
                  status: subStatus,
                  planType: planType || (existingSub.planType as PlanType),
                });
              } else if (planType) {
                await storage.createSubscription({
                  userId: existingUser.id,
                  planType: planType,
                  status: subStatus,
                  stripeSubscriptionId: null,
                });
              }
              return;
            }
            
            // User doesn't exist - create from Stripe data with temp password (requires password reset)
            console.log(`[Stripe Webhook] Creating user from Stripe customer data: ${customer.email}`);
            const bcrypt = await import('bcryptjs');
            const tempPassword = await bcrypt.hash(Math.random().toString(36).substring(2), 10);
            
            const validatedPlanType = isValidPlanType(planType) ? planType : null;
            const isBusinessPlan = validatedPlanType && ['solo', 'team', 'business', 'enterprise'].includes(validatedPlanType);
            const accountType = isBusinessPlan ? 'business' : 'personal';
            
            const metadataCountry = session.metadata?.country;
            const recoveryCountry: Country = COUNTRIES.includes(metadataCountry as Country) ? (metadataCountry as Country) : 'AR';
            const recoveryCurrency = COUNTRY_CURRENCY_MAP[recoveryCountry] || 'ARS';
            
            const user = await storage.createUser({
              email: customer.email,
              name: customer.name || customer.email.split('@')[0],
              password: tempPassword,
              accountType: accountType,
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              mustChangePassword: true,
            });
            
            // ALL users get a personal organization by default
            const personalOrg = await storage.createOrganization({
              name: `Finanzas de ${user.name}`,
              type: 'personal',
              country: recoveryCountry,
              defaultCurrency: recoveryCurrency,
            });
            
            await storage.createMembership({
              userId: user.id,
              organizationId: personalOrg.id,
              role: 'owner',
            });
            
            await storage.seedDefaultCategories(personalOrg.id, user.id);
            await storage.seedDefaultAccount(personalOrg.id, recoveryCurrency);
            
            // For business accounts, also create a business organization
            let organization = personalOrg;
            if (accountType === 'business') {
              const businessOrg = await storage.createOrganization({
                name: `${user.name}'s Organization`,
                type: 'business',
                country: recoveryCountry,
                defaultCurrency: recoveryCurrency,
              });
              
              await storage.createMembership({
                userId: user.id,
                organizationId: businessOrg.id,
                role: 'owner',
              });
              
              await storage.seedDefaultCategories(businessOrg.id, user.id);
              await storage.seedDefaultAccount(businessOrg.id, recoveryCurrency);
              organization = businessOrg;
            }
            
            if (validatedPlanType) {
              let recoverySubStatus: 'active' | 'trialing' = 'active';
              try {
                const stripe = await getUncachableStripeClient();
                const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
                if (stripeSub.status === 'trialing') {
                  recoverySubStatus = 'trialing';
                }
              } catch (e) {
                console.log('[Webhook] Could not retrieve subscription status in recovery, defaulting to active');
              }
              
              // Task #310 — upsert para evitar duplicados si otro webhook gana la carrera.
              if (subscriptionId) {
                await storage.upsertSubscriptionByStripeId(subscriptionId, user.id, {
                  planType: validatedPlanType,
                  status: recoverySubStatus,
                });
              } else {
                await storage.createSubscription({
                  userId: user.id,
                  planType: validatedPlanType,
                  status: recoverySubStatus,
                  stripeSubscriptionId: null,
                });
              }
            }
            
            // Send welcome email with password reset link
            sendWelcomeEmail(user.email, user.name).catch(err =>
              console.error('[Webhook] Failed to send welcome email:', err)
            );
            
            storage.getAdminEmails().then(adminEmails => {
              const recoveryOrgName = accountType === 'business'
                ? `${user.name}'s Organization`
                : `Finanzas de ${user.name}`;
              const recoveryCountryLabel = COUNTRY_LABELS[recoveryCountry as keyof typeof COUNTRY_LABELS] || recoveryCountry;
              const recoveryPlanLabel = validatedPlanType ? (PLAN_LABELS[validatedPlanType] || validatedPlanType) : 'N/A';
              sendNewRegistrationAdminEmail(adminEmails, {
                name: user.name,
                email: user.email,
                planType: recoveryPlanLabel,
                accountType: accountType as 'personal' | 'business',
                organizationName: recoveryOrgName,
                country: recoveryCountryLabel,
              }).catch(err => console.error('[Webhook] Failed to send admin registration email (recovery):', err));
            }).catch(err => console.error('[Webhook] Failed to notify admins of new registration (recovery):', err));
            
            console.log(`[Stripe Webhook] User created from Stripe recovery: ${user.id}, email: ${user.email}`);
            return;
          }
        } catch (recoveryError: any) {
          console.error(`[Stripe Webhook] Failed to recover from Stripe customer: ${recoveryError.message}`);
        }
        
        return;
      }
      
      if (pendingSignup.status === 'completed') {
        console.log(`[Stripe Webhook] Pending signup already processed: ${pendingSignupId}`);
        return;
      }
      
      // Check if user was already created (idempotency)
      // Task #343 — ignorar usuarios soft-deleted: en re-registros con el mismo
      // email el pending signup va a crear un user nuevo (UUID nuevo).
      const existingUser = await storage.getUserByEmail(pendingSignup.email);
      if (existingUser && !existingUser.deletedAt) {
        console.log(`[Stripe Webhook] User already exists for email: ${pendingSignup.email}, linking Stripe IDs...`);
        
        // Update existing user with Stripe IDs
        await storage.updateUser(existingUser.id, {
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
        });
        
        // Get real subscription status from Stripe
        let existingUserSubStatus: 'active' | 'trialing' = 'active';
        try {
          const stripe = await getUncachableStripeClient();
          const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
          if (stripeSub.status === 'trialing') {
            existingUserSubStatus = 'trialing';
          }
        } catch (e) {
          console.log('[Webhook] Could not retrieve subscription status, defaulting to active');
        }
        
        // Task #310 — upsert keyed por stripe_subscription_id para evitar
        // duplicados cuando este handler y customer.subscription.created corren
        // casi en paralelo.
        if (subscriptionId) {
          await storage.upsertSubscriptionByStripeId(subscriptionId, existingUser.id, {
            planType: pendingSignup.planType as PlanType,
            status: existingUserSubStatus,
          });
          console.log(`[Stripe Webhook] Upserted subscription for existing user: ${existingUser.id}`);
        } else {
          const existingSubscription = await storage.getSubscriptionByUserId(existingUser.id);
          if (existingSubscription) {
            await storage.updateSubscription(existingSubscription.id, {
              planType: pendingSignup.planType as PlanType,
              status: existingUserSubStatus,
              stripeSubscriptionId: null,
            });
          } else {
            await storage.createSubscription({
              userId: existingUser.id,
              planType: pendingSignup.planType as PlanType,
              status: existingUserSubStatus,
              stripeSubscriptionId: null,
            });
          }
        }
        
        await storage.updatePendingSignup(pendingSignupId, { status: 'completed' });
        console.log(`[Stripe Webhook] Linked Stripe subscription ${subscriptionId} to existing user: ${existingUser.id}`);
        return;
      }
      
      // Create user with the hashed password from pending signup.
      // Task #221: the phone number captured on the signup form is NOT written
      // to users.phone_number anymore. It's stored on pending_phone_number as
      // a pre-fill suggestion for the Settings → WhatsApp wizard. Only the
      // verified-by-code flow (Task #212) is allowed to populate phone_number.
      const user = await storage.createUser({
        email: pendingSignup.email,
        name: pendingSignup.name,
        password: pendingSignup.hashedPassword,
        accountType: pendingSignup.accountType as 'personal' | 'business',
        profileIconKey: pendingSignup.profileIconKey,
        pendingPhoneNumber: pendingSignup.phoneNumber || undefined,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
      });
      
      // Create organizations - ALL users get a personal organization by default
      const validCountry: Country = COUNTRIES.includes(pendingSignup.country as Country) ? (pendingSignup.country as Country) : 'AR';
      const defaultCurrency = COUNTRY_CURRENCY_MAP[validCountry] || 'ARS';
      
      // 1. Always create personal organization first
      const personalOrg = await storage.createOrganization({
        name: `Finanzas de ${pendingSignup.name}`,
        type: 'personal',
        country: validCountry,
        defaultCurrency,
      });
      
      await storage.createMembership({
        userId: user.id,
        organizationId: personalOrg.id,
        role: 'owner',
      });
      
      await storage.seedDefaultCategories(personalOrg.id, user.id);
      await storage.seedDefaultAccount(personalOrg.id, defaultCurrency);
      
      // 2. For business accounts, also create a business organization
      let activeOrganization = personalOrg;
      if (pendingSignup.accountType === 'business') {
        const businessOrgName = pendingSignup.organizationName || `${pendingSignup.name}'s Organization`;
        const businessOrg = await storage.createOrganization({
          name: businessOrgName,
          type: 'business',
          country: validCountry,
          defaultCurrency,
        });
        
        await storage.createMembership({
          userId: user.id,
          organizationId: businessOrg.id,
          role: 'owner',
        });
        
        await storage.seedDefaultCategories(businessOrg.id, user.id);
        await storage.seedDefaultAccount(businessOrg.id, defaultCurrency);
        
        // Business accounts start with the business org as active
        activeOrganization = businessOrg;
      }
      
      // Use activeOrganization for any further operations
      const organization = activeOrganization;
      
      // Create subscription with Stripe IDs (trialing status for new signups with trial)
      // Get subscription status from Stripe to determine if it's in trial
      let subscriptionStatus: 'active' | 'trialing' = 'active';
      let finalSubscriptionId = subscriptionId;
      
      // If subscriptionId is missing, try to get it from customer's subscriptions
      // This can happen with trials where checkout.session.completed fires before subscription is attached
      if (!finalSubscriptionId && customerId) {
        try {
          const stripe = await getUncachableStripeClient();
          // Get active or trialing subscriptions, sorted by creation date (newest first)
          const subscriptions = await stripe.subscriptions.list({ 
            customer: customerId, 
            status: 'all',
            limit: 5 
          });
          // Prefer trialing or active subscriptions
          const validSub = subscriptions.data.find(s => s.status === 'trialing' || s.status === 'active')
            || subscriptions.data[0]; // Fallback to most recent
          if (validSub) {
            finalSubscriptionId = validSub.id;
            console.log(`[Webhook] Retrieved subscriptionId from customer: ${finalSubscriptionId}, status: ${validSub.status}`);
            // Update user record with the recovered subscription ID
            await storage.updateUser(user.id, { stripeSubscriptionId: finalSubscriptionId });
            console.log(`[Webhook] Updated user ${user.id} with stripeSubscriptionId: ${finalSubscriptionId}`);
          }
        } catch (e: any) {
          console.log(`[Webhook] Could not retrieve subscription from customer: ${e.message}`);
        }
      }
      
      // Get subscription status from Stripe
      if (finalSubscriptionId) {
        try {
          const stripe = await getUncachableStripeClient();
          const stripeSub = await stripe.subscriptions.retrieve(finalSubscriptionId);
          if (stripeSub.status === 'trialing') {
            subscriptionStatus = 'trialing';
          }
          console.log(`[Webhook] Stripe subscription status: ${stripeSub.status}, local status: ${subscriptionStatus}`);
        } catch (e: any) {
          console.log(`[Webhook] Could not retrieve subscription status: ${e.message}, defaulting to active`);
        }
      } else {
        // No subscriptionId available - for free trials, set to trialing
        if (paymentStatus === 'no_payment_required') {
          subscriptionStatus = 'trialing';
          console.log('[Webhook] No subscriptionId but payment_status=no_payment_required, setting status to trialing');
        }
      }
      
      // Task #310 — upsert si tenemos stripe_subscription_id; si no, insert
      // plano (caso edge cuando el trial no expone subscription todavía).
      if (finalSubscriptionId) {
        await storage.upsertSubscriptionByStripeId(finalSubscriptionId, user.id, {
          planType: pendingSignup.planType as PlanType,
          status: subscriptionStatus,
        });
      } else {
        await storage.createSubscription({
          userId: user.id,
          planType: pendingSignup.planType as PlanType,
          status: subscriptionStatus,
          stripeSubscriptionId: null,
        });
      }
      
      // Mark pending signup as completed
      await storage.updatePendingSignup(pendingSignupId, { status: 'completed' });
      
      // Send welcome email
      sendWelcomeEmail(user.email, user.name).catch(err =>
        console.error('[Webhook] Failed to send welcome email:', err)
      );
      
      const signupPlanLabel = getPlanLabel(pendingSignup.planType);
      if (signupPlanLabel) {
        const isTeamPlan = PLAN_DETAILS[pendingSignup.planType as PlanType]?.isTeamPlan || false;
        sendSubscriptionEmail(user.email, user.name, signupPlanLabel, isTeamPlan ? 'business' : 'personal').catch(err =>
          console.error('[Webhook] Failed to send subscription email:', err)
        );
      }
      
      storage.getAdminEmails().then(adminEmails => {
        const orgName = pendingSignup.accountType === 'business'
          ? (pendingSignup.organizationName || `${pendingSignup.name}'s Organization`)
          : `Finanzas de ${pendingSignup.name}`;
        const countryLabel = COUNTRY_LABELS[validCountry as keyof typeof COUNTRY_LABELS] || validCountry;
        const acctType: 'business' | 'personal' = pendingSignup.accountType === 'business' ? 'business' : 'personal';
        sendNewRegistrationAdminEmail(adminEmails, {
          name: pendingSignup.name,
          email: pendingSignup.email,
          planType: signupPlanLabel || pendingSignup.planType || 'N/A',
          accountType: acctType,
          organizationName: orgName,
          country: countryLabel,
          phoneNumber: pendingSignup.phoneNumber || undefined,
        }).catch(err => console.error('[Webhook] Failed to send admin registration email:', err));
      }).catch(err => console.error('[Webhook] Failed to notify admins of new registration:', err));
      
      console.log(`[Stripe Webhook] New user created from pending signup: ${user.id}, plan: ${pendingSignup.planType}`);
      return;
    }

    // Handle EXISTING user checkout (plan upgrade/change)
    if (!userId || !customerId) {
      console.log('[Stripe Webhook] Missing userId or customerId in session');
      return;
    }

    const user = await storage.getUser(userId);
    if (!user) {
      console.log(`[Stripe Webhook] User not found: ${userId}`);
      return;
    }

    // Check if this is a plan change (upgrade or downgrade) - cancel the previous subscription
    const isPlanChange = session.metadata?.isPlanChange === 'true' || session.metadata?.isUpgrade === 'true';
    const previousSubscriptionId = session.metadata?.previousSubscriptionId;
    const previousPlanType = session.metadata?.previousPlanType;
    
    if (isPlanChange && previousSubscriptionId) {
      try {
        const stripe = await getUncachableStripeClient();
        // Cancel the previous subscription immediately since user has paid for new one
        await stripe.subscriptions.cancel(previousSubscriptionId);
        console.log(`[Stripe Webhook] Cancelled previous subscription: ${previousSubscriptionId} (was: ${previousPlanType})`);
      } catch (cancelError: any) {
        // Log but don't fail - the old subscription might already be cancelled
        console.log(`[Stripe Webhook] Could not cancel previous subscription: ${cancelError.message}`);
      }
    }

    await storage.updateUser(userId, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
    });

    if (planType) {
      const subscription = await storage.getSubscriptionByUserId(userId);
      const oldPlanType = subscription?.planType as PlanType | undefined;
      
      // Task #310 — upsert keyed por stripe_subscription_id.
      if (subscriptionId) {
        await storage.upsertSubscriptionByStripeId(subscriptionId, userId, {
          planType: planType,
          status: 'active',
          scheduledPlanType: null,
          scheduledChangeDate: null,
        });
      } else if (subscription) {
        await storage.updateSubscription(subscription.id, {
          planType: planType,
          status: 'active',
          stripeSubscriptionId: null,
          scheduledPlanType: null,
          scheduledChangeDate: null,
        });
      } else {
        await storage.createSubscription({
          userId: userId,
          planType: planType,
          status: 'active',
          stripeSubscriptionId: null,
        });
      }
      
      // Update user's account type if needed
      const newAccountType = (planType === 'personal' || planType === 'personal_pro') ? 'personal' : 'business';
      if (user.accountType !== newAccountType) {
        await storage.updateUser(userId, { accountType: newAccountType });
      }
      
      const checkoutPlanLabel = getPlanLabel(planType);
      if (user.email && checkoutPlanLabel) {
        const isTeamPlan = PLAN_DETAILS[planType]?.isTeamPlan || false;
        
        if (isPlanChange && (oldPlanType || previousPlanType)) {
          const oldPlanToCheck = previousPlanType || oldPlanType;
          const oldPlanLabel = getPlanLabel(oldPlanToCheck);
          if (oldPlanLabel) {
            const oldPrice = PLAN_DETAILS[oldPlanToCheck as PlanType]?.price || 0;
            const newPrice = PLAN_DETAILS[planType]?.price || 0;
            const isUpgrade = newPrice > oldPrice;
            sendPlanChangeEmail(user.email, user.name, oldPlanLabel, checkoutPlanLabel, isUpgrade)
              .catch(err => console.error('[Webhook] Failed to send plan change email:', err));
          }
        } else {
          await sendSubscriptionEmail(user.email, user.name, checkoutPlanLabel, isTeamPlan ? 'business' : 'personal');
        }
      }
    }

    console.log(`[Stripe Webhook] Checkout completed for user ${userId}, plan: ${planType}, isPlanChange: ${isPlanChange}`);
  }

  static async handleSubscriptionUpdated(stripeSubscription: any): Promise<void> {
    const customerId = stripeSubscription.customer;
    const subscriptionId = stripeSubscription.id;
    const status = stripeSubscription.status;
    const priceId = stripeSubscription.items?.data?.[0]?.price?.id;

    // PAYMENT-GATED: Only process subscription updates for active/trialing subscriptions
    // Ignore incomplete/unpaid subscriptions to prevent plan changes without payment
    if (status !== 'active' && status !== 'trialing' && status !== 'past_due' && status !== 'canceled') {
      console.log(`[Stripe Webhook] Ignoring subscription update with status: ${status} (waiting for payment)`);
      return;
    }

    let user = await storage.getUserByStripeCustomerId(customerId);

    // Fallback: If user not found by customerId, try to find by customer email,
    // BUT only link the customer if the user has no Stripe customer linked yet.
    // If the user already has a DIFFERENT customerId, this event belongs to an
    // orphan/old Stripe customer (e.g. from a previous subscription) and must
    // be ignored to avoid silently overwriting their current plan.
    if (!user && customerId) {
      try {
        const stripe = await getUncachableStripeClient();
        const customer = await stripe.customers.retrieve(customerId) as any;
        if (customer && !customer.deleted && customer.email) {
          const candidate = await storage.getUserByEmail(customer.email);
          // Task #343 — un user soft-deleted no debe recibir actualizaciones
          // de subscription de Stripe (la cuenta nueva, si existe, tendrá su
          // propio customer). Tratamos al candidato como no encontrado.
          if (candidate && !candidate.deletedAt) {
            if (!candidate.stripeCustomerId) {
              await storage.updateUser(candidate.id, { stripeCustomerId: customerId });
              user = candidate;
              console.log(`[Stripe Webhook] Linked customer ${customerId} to user ${candidate.id} via email (first link)`);
            } else if (candidate.stripeCustomerId === customerId) {
              user = candidate;
            } else {
              console.log(`[Stripe Webhook] IGNORED subscription.updated: customer ${customerId} is an orphan for user ${candidate.id} (already linked to ${candidate.stripeCustomerId}). Skipping plan update and email.`);
              return;
            }
          }
        }
      } catch (error: any) {
        console.log(`[Stripe Webhook] Could not retrieve customer: ${error.message}`);
      }
    }

    if (!user) {
      console.log(`[Stripe Webhook] User not found for customer: ${customerId}`);
      return;
    }

    // Extra guard: if the user is linked to a different customerId than the
    // one in this event (e.g. a stale duplicate), ignore the event entirely.
    if (user.stripeCustomerId && user.stripeCustomerId !== customerId) {
      console.log(`[Stripe Webhook] IGNORED subscription.updated: event customer ${customerId} does not match user ${user.id}'s linked customer ${user.stripeCustomerId}. Skipping.`);
      return;
    }

    let planType = stripeSubscription.metadata?.planType as PlanType;
    
    if (!planType && stripeSubscription.items?.data?.[0]?.price?.product) {
      try {
        const stripe = await getUncachableStripeClient();
        const productId = typeof stripeSubscription.items.data[0].price.product === 'string' 
          ? stripeSubscription.items.data[0].price.product 
          : stripeSubscription.items.data[0].price.product.id;
        const product = await stripe.products.retrieve(productId);
        planType = product.metadata?.planType as PlanType;
      } catch (error) {
        console.log('[Stripe Webhook] Could not retrieve product for planType');
      }
    }

    // Get existing subscription to compare
    const existingSubscription = await storage.getSubscriptionByUserId(user.id);
    const existingStripeSubId = existingSubscription?.stripeSubscriptionId;
    
    // PAYMENT-GATED: Only update stripeSubscriptionId if:
    // 1. This is a new subscription (user doesn't have one linked)
    // 2. This is the same subscription being updated
    // 3. This subscription is active AND the old one is no longer active (verified upgrade completion)
    const shouldUpdateSubscriptionId = 
      !existingStripeSubId || 
      existingStripeSubId === subscriptionId ||
      (status === 'active' || status === 'trialing');
    
    if (shouldUpdateSubscriptionId) {
      await storage.updateUser(user.id, {
        stripeSubscriptionId: subscriptionId,
      });
    }

    if (planType) {
      const subscription = await storage.getSubscriptionByUserId(user.id);
      const subscriptionStatus = status === 'trialing' ? 'trialing' :
                                  status === 'active' ? 'active' : 
                                  status === 'past_due' ? 'past_due' : 
                                  status === 'canceled' ? 'cancelled' : 'active';
      
      if (subscription) {
        const oldPlanType = subscription.planType as PlanType;
        const isPlanChange = oldPlanType && oldPlanType !== planType;
        
        // PAYMENT-GATED: Only update plan type if subscription is actually active
        // This prevents plan changes from incomplete checkout sessions
        const shouldUpdatePlanType = (status === 'active' || status === 'trialing') || 
                                      (subscriptionId === existingStripeSubId);
        
        if (!shouldUpdatePlanType && isPlanChange) {
          console.log(`[Stripe Webhook] Skipping plan change (${oldPlanType} -> ${planType}) - subscription not active (status: ${status})`);
          return;
        }
        
        // Check if this is a scheduled plan change being applied
        const isScheduledChange = subscription.scheduledPlanType === planType;
        
        // Task #310 — upsert keyed por stripe_subscription_id (en lugar de
        // update por id) para que si la fila canónica de Stripe es otra
        // (caso de subs viejas no migradas) no terminemos pisando datos.
        await storage.upsertSubscriptionByStripeId(subscriptionId, user.id, {
          planType: planType,
          status: subscriptionStatus,
          stripePriceId: priceId,
          // Clear scheduled change fields if this was a scheduled downgrade being applied
          scheduledPlanType: isScheduledChange ? null : subscription.scheduledPlanType,
          scheduledChangeDate: isScheduledChange ? null : subscription.scheduledChangeDate,
        });
        
        if (isPlanChange && user.email) {
          const oldPlanLabel = getPlanLabel(oldPlanType);
          const newPlanLabel = getPlanLabel(planType);
          
          if (oldPlanLabel && newPlanLabel) {
            const planOrder: PlanType[] = ['personal', 'solo', 'personal_pro', 'team', 'business', 'enterprise'];
            const oldIndex = planOrder.indexOf(oldPlanType);
            const newIndex = planOrder.indexOf(planType);
            const isUpgrade = newIndex > oldIndex;
            
            sendPlanChangeEmail(user.email, user.name, oldPlanLabel, newPlanLabel, isUpgrade)
              .catch(err => console.error('[Webhook] Failed to send plan change email:', err));
            
            console.log(`[Stripe Webhook] Plan changed: ${oldPlanType} -> ${planType} (${isUpgrade ? 'upgrade' : 'downgrade'})`);
          }
        }
        
        if (isScheduledChange) {
          console.log(`[Stripe Webhook] Scheduled plan change applied: ${subscription.planType} -> ${planType}`);
        }
      } else {
        // Task #310 — upsert para evitar duplicados.
        await storage.upsertSubscriptionByStripeId(subscriptionId, user.id, {
          planType: planType,
          status: subscriptionStatus,
          stripePriceId: priceId,
        });
      }
    }

    console.log(`[Stripe Webhook] Subscription updated for user ${user.id}, plan: ${planType}, status: ${status}`);
  }

  static async handleSubscriptionDeleted(stripeSubscription: any): Promise<void> {
    const customerId = stripeSubscription.customer;
    const deletedSubscriptionId = stripeSubscription.id;
    const planType = stripeSubscription.metadata?.planType as PlanType;

    console.log(`[Stripe Webhook] subscription.deleted received for subscription: ${deletedSubscriptionId}, customer: ${customerId}`);

    const user = await storage.getUserByStripeCustomerId(customerId);
    if (!user) {
      console.log(`[Stripe Webhook] User not found for customer: ${customerId}`);
      return;
    }

    // CRITICAL: Check if this is a plan change (user has another active subscription in Stripe)
    // When users change plans, Stripe creates a new subscription and deletes the old one
    // We must NOT take any destructive action if there's another active subscription
    try {
      const stripe = await getUncachableStripeClient();
      const activeSubscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all', // Get all to check for active/trialing
        limit: 10,
      });
      
      // Filter for active or trialing subscriptions that are NOT the one being deleted
      const otherActiveSubscriptions = activeSubscriptions.data.filter(sub => 
        sub.id !== deletedSubscriptionId && 
        (sub.status === 'active' || sub.status === 'trialing')
      );
      
      if (otherActiveSubscriptions.length > 0) {
        console.log(`[Stripe Webhook] PLAN CHANGE DETECTED: User ${user.id} has ${otherActiveSubscriptions.length} other active subscription(s). Ignoring deletion of ${deletedSubscriptionId}`);
        console.log(`[Stripe Webhook] Active subscriptions: ${otherActiveSubscriptions.map(s => `${s.id} (${s.status}, created: ${s.created})`).join(', ')}`);
        
        // Select the most recently created subscription (highest created timestamp)
        const newActiveSub = otherActiveSubscriptions.sort((a, b) => b.created - a.created)[0];
        await storage.updateUser(user.id, {
          stripeSubscriptionId: newActiveSub.id,
        });
        
        // Task #310 — en plan-change: actualizar la fila CANÓNICA del
        // nuevo stripe_id (si existe) y marcar la fila vieja como
        // cancelled (sin reasignarle el stripe_id del nuevo, lo cual
        // generaría un duplicado o violación del unique index).
        // Resolver el nuevo planType del producto Stripe.
        let newPlanType: PlanType | undefined;
        try {
          const productId = typeof newActiveSub.items?.data?.[0]?.price?.product === 'string'
            ? newActiveSub.items.data[0].price.product
            : newActiveSub.items?.data?.[0]?.price?.product?.id;
          if (productId) {
            const product = await stripe.products.retrieve(productId);
            if (product.metadata?.planType) {
              newPlanType = product.metadata.planType as PlanType;
            }
          }
        } catch (productError: any) {
          console.log(`[Stripe Webhook] Could not retrieve product for new plan type: ${productError.message}`);
        }

        const oldLocal = await storage.getSubscriptionByStripeId(deletedSubscriptionId);
        const fallbackPlanType: PlanType = (newPlanType ?? oldLocal?.planType ?? 'personal') as PlanType;
        const newStatus: SubscriptionStatus = newActiveSub.status === 'trialing' ? 'trialing' : 'active';

        // Upsert sobre el stripe_id NUEVO: si la fila ya existe la
        // actualiza, si no la crea reclamando la vieja como placeholder
        // sólo si no hay otra del usuario. Es el camino seguro frente
        // al unique index.
        const newLocal = await storage.upsertSubscriptionByStripeId(newActiveSub.id, user.id, {
          planType: fallbackPlanType,
          status: newStatus,
          stripePriceId: newActiveSub.items?.data?.[0]?.price?.id || oldLocal?.stripePriceId,
          cancellationStatus: 'active',
          scheduledPlanType: null,
          scheduledChangeDate: null,
        });
        console.log(`[Stripe Webhook] Plan-change canonical row ${newLocal.id} now points to ${newActiveSub.id} (planType: ${fallbackPlanType}, status: ${newStatus})`);

        // Si la fila vieja existe y es distinta de la nueva, marcarla
        // como cancelled sin tocar su stripe_id (preserva historial).
        if (oldLocal && oldLocal.id !== newLocal.id) {
          await storage.updateSubscription(oldLocal.id, {
            status: 'cancelled',
          });
          console.log(`[Stripe Webhook] Marked old subscription row ${oldLocal.id} (stripe ${deletedSubscriptionId}) as cancelled`);
        }
        
        console.log(`[Stripe Webhook] Updated user ${user.id} to new subscription: ${newActiveSub.id}`);
        
        // DO NOT delete any data, DO NOT send cancellation email
        return;
      }
      
      console.log(`[Stripe Webhook] No other active subscriptions found for user ${user.id}. This is a real cancellation.`);
    } catch (stripeError: any) {
      console.error(`[Stripe Webhook] Error checking for other subscriptions: ${stripeError.message}`);
      // On API error, process cancellation BUT do NOT delete user data
      // Just mark as cancelled - manual review can clean up later if needed
      console.log(`[Stripe Webhook] SAFETY: Processing cancellation without destructive actions due to Stripe API error`);
      
      await storage.updateUser(user.id, {
        stripeSubscriptionId: null,
      });
      
      // Task #310 — actualizar la fila keyed por el stripe_id borrado.
      const subscription = (await storage.getSubscriptionByStripeId(deletedSubscriptionId))
        ?? (await storage.getSubscriptionByUserId(user.id));
      if (subscription) {
        await storage.updateSubscription(subscription.id, {
          status: 'cancelled',
        });
      }
      
      console.log(`[Stripe Webhook] Marked subscription as cancelled for user ${user.id} (safe mode due to API error)`);
      return;
    }

    // Task #310 — actualizar la fila keyed por el stripe_id borrado, no
    // por user_id (evita cancelar la fila equivocada en multi-sub history).
    const subscription = (await storage.getSubscriptionByStripeId(deletedSubscriptionId))
      ?? (await storage.getSubscriptionByUserId(user.id));
    const deletedPlanLabel = getPlanLabel(planType) || getPlanLabel(subscription?.planType) || 'Tu plan';
    
    // Mark subscription as cancelled (data retained for 60 days, handled by cancelledAccountCleanup cron)
    await storage.updateUser(user.id, {
      stripeSubscriptionId: null,
    });

    if (subscription) {
      await storage.updateSubscription(subscription.id, {
        status: 'cancelled',
        cancellationStatus: 'cancelled',
      });
    }

    if (user.email) {
      await sendCancellationEmail(user.email, user.name, deletedPlanLabel);
    }

    console.log(`[Stripe Webhook] Subscription cancelled for user ${user.id}. Data retained for 60-day grace period.`);
  }

  static async handleInvoicePaid(invoice: any): Promise<void> {
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;
    const billingReason = invoice.billing_reason;
    const amountPaid = invoice.total || invoice.amount_paid || 0;
    const currency = invoice.currency || 'ars';
    const invoiceId = invoice.id || '';
    const invoiceUrl = invoice.hosted_invoice_url || '';

    if (!subscriptionId) return;

    const user = await storage.getUserByStripeCustomerId(customerId);
    if (!user) return;

    const subscription = await storage.getSubscriptionByUserId(user.id);
    const invoicePlanLabel = getPlanLabel(subscription?.planType) || 'Suscripción';

    // If payment succeeds, clear any payment failure status
    if (subscription && subscription.paymentFailedAt) {
      await storage.updateSubscription(subscription.id, {
        status: 'active',
        paymentFailedAt: null,
      });
      console.log(`[Stripe Webhook] Cleared payment failure status for user ${user.id}`);
    }

    if (billingReason === 'subscription_cycle') {
      if (subscription) {
        await storage.updateSubscription(subscription.id, {
          status: 'active',
        });
      }

      if (user.email) {
        await sendRenewalEmail(user.email, user.name, invoicePlanLabel, 
          amountPaid > 0 ? { amountPaid, currency, invoiceId, invoiceUrl } : undefined
        );
      }

      console.log(`[Stripe Webhook] Subscription renewed for user ${user.id}`);
    } else {
      if (user.email && amountPaid > 0) {
        sendPaymentReceiptEmail(
          user.email,
          user.name,
          invoicePlanLabel,
          amountPaid,
          currency,
          invoiceId,
          invoiceUrl
        ).catch(err => console.error('[Webhook] Failed to send payment receipt:', err));
      }
      console.log(`[Stripe Webhook] Invoice paid for user ${user.id}, reason: ${billingReason}`);
    }
  }

  static async handleInvoicePaymentFailed(invoice: any): Promise<void> {
    const customerId = invoice.customer;
    const subscriptionId = invoice.subscription;

    if (!subscriptionId) return;

    const user = await storage.getUserByStripeCustomerId(customerId);
    if (!user) return;

    const subscription = await storage.getSubscriptionByUserId(user.id);
    if (subscription) {
      // Only set paymentFailedAt if this is the first failure (not already set)
      const updateData: any = {
        status: 'past_due',
      };
      
      if (!subscription.paymentFailedAt) {
        updateData.paymentFailedAt = new Date();
        console.log(`[Stripe Webhook] First payment failure for user ${user.id}, starting grace period`);
      }
      
      await storage.updateSubscription(subscription.id, updateData);

      const failedPlanLabel = getPlanLabel(subscription.planType);
      if (user.email && failedPlanLabel) {
        // Pass the paymentFailedAt date for calculating days remaining
        const paymentFailedAt = subscription.paymentFailedAt || new Date();
        await sendPaymentFailedEmail(user.email, user.name, failedPlanLabel, paymentFailedAt);
      }
    }

    console.log(`[Stripe Webhook] Payment failed for user ${user.id}`);
  }
}
