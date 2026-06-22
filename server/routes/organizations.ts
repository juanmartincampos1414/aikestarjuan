import type { Express } from "express";
import { storage } from "../storage";
import { sanitizeError } from "./middleware";
import { ASSIGNABLE_ROLES, ADMIN_ROLES, ROLE_PERMISSIONS, type Role, PLAN_TYPES, type PlanType, PLAN_DETAILS, PLAN_LABELS, subscriptions, updateOrganizationSchema } from "@shared/schema";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { sendSubscriptionEmail, sendTeamInvitationEmail, sendTeamAddedEmail, sendCancellationEmail, sendReactivationEmail, sendCancellationAdminEmail } from "../services/email";
import { requireAuth, requirePermission, requireOwner, getUserPlanLimits, getOrganizationPlanLimits } from "./middleware";
import { getUncachableStripeClient } from "../stripeClient";
import { db } from "../db";
import { sql, eq } from "drizzle-orm";

function generateTemporaryPassword(length: number = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function tryLinkStripeSubscription(userId: string, email: string): Promise<{ success: boolean; subscriptionId?: string; customerId?: string; priceId?: string; planType?: string }> {
  try {
    const stripe = await getUncachableStripeClient();
    
    const allCustomers: any[] = [];
    for await (const customer of stripe.customers.list({ email, limit: 100 })) {
      allCustomers.push(customer);
    }
    
    if (allCustomers.length === 0) {
      return { success: false };
    }
    
    const liveCustomers = allCustomers.filter(c => c.livemode === true);
    const testCustomers = allCustomers.filter(c => c.livemode === false);
    const customersToSearch = [...liveCustomers, ...testCustomers];
    
    let foundCustomer: any = null;
    let foundSubscription: any = null;
    
    const validStatuses = ['active', 'trialing', 'past_due'];
    
    for (const customer of customersToSearch) {
      const subscriptions = await stripe.subscriptions.list({ 
        customer: customer.id, 
        limit: 10 
      });
      
      for (const subscription of subscriptions.data) {
        if (validStatuses.includes(subscription.status) && subscription.livemode === customer.livemode) {
          foundCustomer = customer;
          foundSubscription = subscription;
          break;
        }
      }
      
      if (foundSubscription) break;
    }
    
    if (!foundCustomer || !foundSubscription) {
      return { success: false };
    }
    
    const priceId = foundSubscription.items.data[0]?.price?.id;
    
    // Try to get planType from subscription metadata first, then from product metadata
    let stripePlanType = foundSubscription.metadata?.planType;
    if (!stripePlanType && priceId) {
      try {
        const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
        const product = price.product as any;
        stripePlanType = product?.metadata?.planType;
      } catch {
      }
    }
    
    // Update user with Stripe customer ID
    await storage.updateUser(userId, { stripeCustomerId: foundCustomer.id });
    
    // Update subscription record with Stripe IDs
    const existingSub = await storage.getSubscriptionByUserId(userId);
    if (existingSub) {
      const updateData: any = {
        stripeSubscriptionId: foundSubscription.id,
        stripeCustomerId: foundCustomer.id,
        stripePriceId: priceId,
        currentPeriodStart: new Date(foundSubscription.current_period_start * 1000),
        currentPeriodEnd: new Date(foundSubscription.current_period_end * 1000),
      };
      if (stripePlanType && PLAN_TYPES.includes(stripePlanType as any)) {
        updateData.planType = stripePlanType;
      }
      await storage.updateSubscription(existingSub.id, updateData);
    }
    
    const finalPlanType = stripePlanType || existingSub?.planType || 'personal';
    return { 
      success: true, 
      subscriptionId: foundSubscription.id, 
      customerId: foundCustomer.id,
      priceId,
      planType: finalPlanType
    };
  } catch {
    return { success: false };
  }
}

export function registerOrganizationRoutes(app: Express): void {
  // Subscription routes
  
  // Get subscription status - shows if properly linked to Stripe
  app.get('/api/subscription/status', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const subscription = await storage.getSubscriptionByUserId(req.userId);
      
      const stripe = await getUncachableStripeClient();
      
      let stripeStatus: any = null;
      let stripeSubscriptionValid = false;
      let stripeLiveMode = false;
      let isTrialing = false;
      let trialEndsAt: string | null = null;
      let trialDaysRemaining: number | null = null;
      
      if (subscription?.stripeSubscriptionId) {
        try {
          const stripeSub = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
          const periodEnd = (stripeSub as any).current_period_end;
          const trialEnd = (stripeSub as any).trial_end;
          stripeStatus = {
            id: stripeSub.id,
            status: stripeSub.status,
            livemode: (stripeSub as any).livemode,
            currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          };
          stripeSubscriptionValid = stripeSub.status === 'active' || stripeSub.status === 'trialing';
          stripeLiveMode = (stripeSub as any).livemode;
          isTrialing = stripeSub.status === 'trialing';
          if (trialEnd) {
            trialEndsAt = new Date(trialEnd * 1000).toISOString();
            const now = new Date();
            const endDate = new Date(trialEnd * 1000);
            trialDaysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
          }
          if (periodEnd && !subscription.currentPeriodEnd) {
            const periodEndDate = new Date(periodEnd * 1000);
            await db.update(subscriptions).set({ currentPeriodEnd: periodEndDate }).where(eq(subscriptions.id, subscription.id));
            subscription.currentPeriodEnd = periodEndDate;
          }
        } catch (err: any) {
          stripeStatus = { error: err.message, errorType: 'stripe_api_error', status: null };
        }
      }
      
      const result = {
        hasLocalSubscription: !!subscription,
        hasSubscription: !!subscription,
        hasStripeSubscriptionId: !!subscription?.stripeSubscriptionId,
        stripeSubscriptionValid,
        stripeLiveMode,
        localPlanType: subscription?.planType || null,
        planType: subscription?.planType || null,
        planLabel: subscription?.planType ? (PLAN_LABELS[subscription.planType as PlanType] || subscription.planType) : null,
        status: subscription?.status || null,
        stripeStatus,
        needsSync: !subscription?.stripeSubscriptionId || !stripeSubscriptionValid,
        cancellationStatus: subscription?.cancellationStatus || 'active',
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd || false,
        accessEndsAt: subscription?.currentPeriodEnd?.toISOString() || null,
        cancellationRequestedAt: subscription?.cancellationRequestedAt?.toISOString() || null,
        isTrialing,
        trialEndsAt,
        trialDaysRemaining,
      };
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) || 'Error al obtener el estado de suscripción' });
    }
  });
  
  // Manual sync - force link Stripe subscription
  app.post('/api/subscription/sync', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const linkResult = await tryLinkStripeSubscription(req.userId, user.email);
      
      if (linkResult.success) {
        // Also update user's planType if we found it from Stripe
        if (linkResult.planType && PLAN_TYPES.includes(linkResult.planType as any)) {
          const newAccountType = (linkResult.planType === 'personal' || linkResult.planType === 'personal_pro') ? 'personal' : 'business';
          await storage.updateUser(req.userId, { accountType: newAccountType });
        }
        
        res.json({
          success: true,
          message: 'Suscripción sincronizada correctamente',
          subscriptionId: linkResult.subscriptionId,
          planType: linkResult.planType,
        });
      } else {
        res.status(404).json({
          success: false,
          message: 'No se encontró una suscripción activa en Stripe para tu email. Si pagaste recientemente, puede tardar unos minutos en aparecer.',
        });
      }
    } catch (error: any) {
      res.status(500).json({ 
        success: false,
        message: 'Error al sincronizar: ' + error.message 
      });
    }
  });
  
  // Debug endpoint - shows minimal diagnostic info (secured with secret key)
  app.get('/api/subscription/debug', requireAuth, async (req: any, res) => {
    try {
      // Require debug key for security
      const debugKey = req.query.key;
      if (debugKey !== 'aikestar-debug-2026') {
        return res.status(403).json({ message: 'Acceso denegado' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const stripe = await getUncachableStripeClient();
      
      // Minimal diagnostic info - no raw IDs exposed
      const debugInfo: any = {
        stripeMode: process.env.STRIPE_LIVE_SECRET_KEY ? 'LIVE' : 'TEST',
        customersFound: 0,
        subscriptionsFound: 0,
        subscriptionStatuses: [] as string[],
        validSubscriptionsFound: 0,
        diagnosis: '',
      };
      
      // Count customers
      let customerCount = 0;
      const customerIds: string[] = [];
      for await (const customer of stripe.customers.list({ email: user.email, limit: 100 })) {
        customerCount++;
        customerIds.push(customer.id);
      }
      debugInfo.customersFound = customerCount;
      
      // Check subscriptions
      const allStatuses: string[] = [];
      let validCount = 0;
      
      for (const customerId of customerIds) {
        const subscriptions = await stripe.subscriptions.list({ 
          customer: customerId, 
          limit: 10 
        });
        
        for (const sub of subscriptions.data) {
          debugInfo.subscriptionsFound++;
          allStatuses.push(sub.status);
          if (['active', 'trialing', 'past_due'].includes(sub.status)) {
            validCount++;
          }
        }
      }
      
      debugInfo.subscriptionStatuses = allStatuses;
      debugInfo.validSubscriptionsFound = validCount;
      
      // Provide diagnosis
      if (customerCount === 0) {
        debugInfo.diagnosis = 'No se encontraron clientes en Stripe con este email. Verifica que el email sea exactamente igual.';
      } else if (debugInfo.subscriptionsFound === 0) {
        debugInfo.diagnosis = 'Se encontraron clientes pero sin suscripciones. El pago puede no haberse completado.';
      } else if (validCount === 0) {
        debugInfo.diagnosis = `Se encontraron suscripciones pero ninguna con status válido. Status encontrados: ${allStatuses.join(', ')}`;
      } else {
        debugInfo.diagnosis = 'Hay suscripciones válidas. La sincronización debería funcionar. Intenta nuevamente.';
      }
      
      res.json(debugInfo);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
  
  app.post('/api/subscription/preview-change', requireAuth, async (req: any, res) => {
    try {
      const { planType } = req.body;
      
      if (!planType || !PLAN_TYPES.includes(planType)) {
        return res.status(400).json({ message: 'Tipo de plan inválido' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      let existingSubscription = await storage.getSubscriptionByUserId(req.userId);
      
      if (!existingSubscription?.stripeSubscriptionId) {
        const linkResult = await tryLinkStripeSubscription(req.userId, user.email);
        if (linkResult.success) {
          existingSubscription = await storage.getSubscriptionByUserId(req.userId);
        }
      }
      
      if (!existingSubscription?.stripeSubscriptionId) {
        return res.status(400).json({ 
          message: 'No encontramos una suscripción activa de Stripe vinculada a tu cuenta. Por favor contactá a soporte.',
          code: 'SUBSCRIPTION_NOT_LINKED'
        });
      }
      
      const currentPlanType = existingSubscription.planType as PlanType;
      if (currentPlanType === planType) {
        return res.status(400).json({ message: 'Ya tenés este plan' });
      }
      
      const newPlanDetails = PLAN_DETAILS[planType as PlanType];
      const currentPrice = PLAN_DETAILS[currentPlanType]?.price || 0;
      const newPrice = newPlanDetails.price;
      const isUpgrade = newPrice > currentPrice;
      
      const stripe = await getUncachableStripeClient();
      const products = await stripe.products.list({ active: true, limit: 100 });
      const prices = await stripe.prices.list({ active: true, limit: 100 });
      
      const productsWithPlanType = products.data.filter(p => p.metadata?.planType);
      
      const targetProduct = products.data.find(p => p.metadata?.planType === planType);
      if (!targetProduct) {
        return res.status(400).json({ 
          message: 'Plan no encontrado en Stripe',
          code: 'PRODUCT_NOT_FOUND',
          availablePlans: productsWithPlanType.map(p => p.metadata?.planType)
        });
      }
      
      const productPrices = prices.data.filter(p => p.product === targetProduct.id && p.active);
      
      let targetPrice = productPrices.find(p => 
        p.currency === 'ars' && 
        p.type === 'recurring' && 
        p.recurring?.interval === 'month'
      );
      if (!targetPrice) {
        targetPrice = productPrices.find(p => p.type === 'recurring');
      }
      if (!targetPrice) {
        targetPrice = productPrices[0];
      }
      
      if (!targetPrice) {
        return res.status(400).json({ 
          message: 'Precio del plan no encontrado',
          code: 'PRICE_NOT_FOUND'
        });
      }
      
      let stripeSubscription: any;
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(existingSubscription.stripeSubscriptionId);
        
        if (stripeSubscription.status === 'canceled' || stripeSubscription.status === 'incomplete_expired') {
          const linkResult = await tryLinkStripeSubscription(req.userId, user.email);
          if (linkResult.success) {
            existingSubscription = await storage.getSubscriptionByUserId(req.userId);
            if (existingSubscription?.stripeSubscriptionId) {
              stripeSubscription = await stripe.subscriptions.retrieve(existingSubscription.stripeSubscriptionId);
            }
          }
          
          if (!existingSubscription?.stripeSubscriptionId || stripeSubscription.status !== 'active') {
            return res.status(400).json({ 
              message: 'Tu suscripción anterior fue cancelada. Por favor creá una nueva suscripción.',
              code: 'SUBSCRIPTION_NOT_LINKED'
            });
          }
        }
      } catch (retrieveError: any) {
        const linkResult = await tryLinkStripeSubscription(req.userId, user.email);
        if (linkResult.success) {
          existingSubscription = await storage.getSubscriptionByUserId(req.userId);
          if (existingSubscription?.stripeSubscriptionId) {
            stripeSubscription = await stripe.subscriptions.retrieve(existingSubscription.stripeSubscriptionId);
          }
        }
        
        if (!stripeSubscription) {
          return res.status(400).json({ 
            message: 'No se encontró una suscripción activa. Por favor creá una nueva suscripción.',
            code: 'SUBSCRIPTION_NOT_LINKED'
          });
        }
      }
      
      if (!stripeSubscription?.current_period_end || !stripeSubscription?.current_period_start) {
        return res.status(400).json({ 
          message: 'No se pudo obtener información completa de la suscripción. Por favor intentá más tarde.',
          code: 'SUBSCRIPTION_DATA_INCOMPLETE'
        });
      }
      
      if (isUpgrade) {
        
        let prorationTotal = 0;
        let invoiceCurrency = 'ars';
        
        try {
          // Validate subscription items exist
          if (!stripeSubscription.items?.data?.[0]?.id) {
            throw new Error('Subscription items not found');
          }
          
          // Use retrieveUpcoming which is more broadly compatible across Stripe API versions
          const upcomingInvoice = await (stripe.invoices as any).retrieveUpcoming({
            customer: stripeSubscription.customer as string,
            subscription: existingSubscription!.stripeSubscriptionId,
            subscription_items: [{
              id: stripeSubscription.items.data[0].id,
              price: targetPrice.id,
            }],
            subscription_proration_behavior: 'create_prorations',
          });
          
          // Find the proration line items
          const prorationItems = upcomingInvoice.lines.data.filter((line: any) => line.proration);
          prorationTotal = prorationItems.reduce((sum: number, item: any) => sum + item.amount, 0);
          invoiceCurrency = upcomingInvoice.currency || 'ars';
        } catch (invoiceError: any) {
          
          const now = Math.floor(Date.now() / 1000);
          const periodEnd = stripeSubscription.current_period_end;
          const periodStart = stripeSubscription.current_period_start;
          const totalPeriod = periodEnd - periodStart;
          const remainingPeriod = periodEnd - now;
          const remainingRatio = totalPeriod > 0 ? remainingPeriod / totalPeriod : 0;
          
          // Calculate credit from current plan and cost of new plan for remaining period
          const currentPeriodCredit = Math.round(currentPrice * 100 * remainingRatio);
          const newPeriodCost = Math.round(newPrice * 100 * remainingRatio);
          prorationTotal = newPeriodCost - currentPeriodCredit;
          invoiceCurrency = 'ars';
        }
        
        // PLAN_DETAILS prices are in ARS (e.g., 8999 = $8,999)
        // Stripe returns amounts in centavos (e.g., 899900 = $8,999)
        // Convert PLAN_DETAILS prices to centavos for consistency with frontend formatting
        const currentPriceInCentavos = currentPrice * 100;
        const newPriceInCentavos = newPrice * 100;
        
        res.json({
          isUpgrade: true,
          currentPlan: PLAN_LABELS[currentPlanType],
          newPlan: PLAN_LABELS[planType as PlanType],
          currentPrice: currentPriceInCentavos,
          newPrice: newPriceInCentavos,
          prorationAmount: prorationTotal, // Already in centavos from Stripe
          currency: invoiceCurrency,
          immediateCharge: prorationTotal > 0,
          message: prorationTotal > 0 
            ? `Se cobrará ${(prorationTotal / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' })} ahora por el prorrateo.`
            : 'El cambio se aplicará sin cargo adicional inmediato.',
          nextBillingDate: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
          nextBillingAmount: newPriceInCentavos,
        });
      } else {
        // For downgrades, show when the change will take effect
        const periodEnd = new Date(stripeSubscription.current_period_end * 1000);
        
        // Convert PLAN_DETAILS prices to centavos for consistency
        const currentPriceInCentavos = currentPrice * 100;
        const newPriceInCentavos = newPrice * 100;
        
        res.json({
          isUpgrade: false,
          currentPlan: PLAN_LABELS[currentPlanType],
          newPlan: PLAN_LABELS[planType as PlanType],
          currentPrice: currentPriceInCentavos,
          newPrice: newPriceInCentavos,
          prorationAmount: 0,
          currency: 'ars',
          immediateCharge: false,
          message: `El cambio se aplicará el ${periodEnd.toLocaleDateString('es-AR')}. Hasta entonces mantendrás tu plan actual.`,
          nextBillingDate: periodEnd.toISOString(),
          nextBillingAmount: newPriceInCentavos,
        });
      }
    } catch (error: any) {
      res.status(500).json({ 
        message: 'Error al calcular el cambio de plan'
      });
    }
  });
  
  app.post('/api/subscription/change-plan', requireAuth, async (req: any, res) => {
    try {
      const { planType } = req.body;
      
      if (!planType || !PLAN_TYPES.includes(planType)) {
        return res.status(400).json({ message: 'Tipo de plan inválido' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const newPlanDetails = PLAN_DETAILS[planType as PlanType];
      // Count only owned organizations (not ones where user is invited member)
      const ownedOrgsCount = await storage.countOwnedOrganizationsByUser(req.userId);
      
      if (ownedOrgsCount > newPlanDetails.maxOrgs) {
        const excess = ownedOrgsCount - newPlanDetails.maxOrgs;
        return res.status(403).json({ 
          message: `Para cambiar a ${PLAN_LABELS[planType as PlanType]}, primero eliminá ${excess} organización${excess > 1 ? 'es' : ''} propia${excess > 1 ? 's' : ''}. Tenés ${ownedOrgsCount} y el plan permite ${newPlanDetails.maxOrgs}.`,
          code: 'EXCEEDS_ORG_LIMIT',
          current: ownedOrgsCount,
          allowed: newPlanDetails.maxOrgs,
          excess
        });
      }
      
      // Only check member limits for organizations where user is owner
      // For orgs where user is invited member, the owner's plan defines member limits
      const userOrgs = await storage.getOrganizationsByUser(req.userId);
      for (const org of userOrgs) {
        const membership = await storage.getMembershipByUserAndOrg(req.userId, org.id);
        if (membership?.role !== 'owner') continue; // Skip orgs where user is not owner
        
        const memberCount = await storage.countMembersByOrganization(org.id);
        const pendingCount = await storage.countPendingInvitationsByOrganization(org.id);
        const totalMembers = memberCount + pendingCount;
        
        if (totalMembers > newPlanDetails.maxMembersPerOrg) {
          const excess = totalMembers - newPlanDetails.maxMembersPerOrg;
          return res.status(403).json({ 
            message: `La organización "${org.name}" tiene ${totalMembers} miembros pero ${PLAN_LABELS[planType as PlanType]} permite ${newPlanDetails.maxMembersPerOrg}. Eliminá ${excess} miembro${excess > 1 ? 's' : ''} primero.`,
            code: 'EXCEEDS_MEMBER_LIMIT',
            organizationName: org.name,
            current: totalMembers,
            allowed: newPlanDetails.maxMembersPerOrg,
            excess
          });
        }
      }
      
      let existingSubscription = await storage.getSubscriptionByUserId(req.userId);
      
      if (!existingSubscription?.stripeSubscriptionId) {
        const linkResult = await tryLinkStripeSubscription(req.userId, user.email);
        if (linkResult.success) {
          existingSubscription = await storage.getSubscriptionByUserId(req.userId);
        }
      }
      
      let newPriceId: string | null = null;
      
      if (existingSubscription?.stripeSubscriptionId) {
        try {
          const hasLiveCredentials = !!process.env.STRIPE_LIVE_SECRET_KEY;
          
          const stripe = hasLiveCredentials 
            ? await getUncachableStripeClient({ forceLiveMode: true })
            : await getUncachableStripeClient();
          
          let stripeSubscription: any;
          
          try {
            stripeSubscription = await stripe.subscriptions.retrieve(existingSubscription.stripeSubscriptionId);
          } catch (retrieveError: any) {
            return res.status(400).json({ 
              message: 'No se pudo verificar tu suscripción. Por favor contactá a soporte.',
              code: 'SUBSCRIPTION_NOT_FOUND'
            });
          }
          
          const isLiveMode = hasLiveCredentials;
          
          if (isLiveMode) {
            const products = await stripe.products.list({ active: true, limit: 100 });
            const prices = await stripe.prices.list({ active: true, limit: 100 });
            
            const targetProduct = products.data.find(p => p.metadata?.planType === planType);
            if (targetProduct) {
              const productPrices = prices.data.filter(p => p.product === targetProduct.id && p.active);
              let targetPrice = productPrices.find(p => 
                p.currency === 'ars' && 
                p.type === 'recurring' && 
                p.recurring?.interval === 'month'
              );
              if (!targetPrice) {
                targetPrice = productPrices.find(p => p.type === 'recurring');
              }
              if (!targetPrice) {
                targetPrice = productPrices[0];
              }
              newPriceId = targetPrice?.id || null;
            }
          } else {
            const priceResult = await db.execute(sql`
              SELECT pr.id as price_id 
              FROM stripe.products p
              JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
              WHERE p.metadata->>'planType' = ${planType}
              LIMIT 1
            `);
            newPriceId = (priceResult.rows[0] as any)?.price_id || null;
          }
          
          if (!newPriceId) {
            return res.status(400).json({ message: 'Plan no disponible para suscripción' });
          }
          
          const baseUrl = process.env.NODE_ENV === 'development'
            ? `https://${process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0]}`
            : 'https://app.aikestar.com';
          
          // Create Checkout session for the new plan - user must pay before plan changes
          const checkoutSession = await stripe.checkout.sessions.create({
            customer: stripeSubscription.customer as string,
            payment_method_types: ['card'],
            line_items: [{ price: newPriceId, quantity: 1 }],
            mode: 'subscription',
            success_url: `${baseUrl}/payment-success?plan=${planType}&changed=true`,
            cancel_url: `${baseUrl}/settings?checkout=cancelled`,
            metadata: {
              userId: req.userId,
              planType: planType,
              isPlanChange: 'true',
              previousSubscriptionId: existingSubscription.stripeSubscriptionId,
              previousPlanType: existingSubscription.planType,
            },
            subscription_data: {
              metadata: {
                userId: req.userId,
                planType: planType,
              }
            }
          });
          
          return res.json({ 
            url: checkoutSession.url,
            sessionId: checkoutSession.id,
            requiresPayment: true,
            message: 'Redirigiendo al pago...'
          });
        } catch (stripeError: any) {
          if (stripeError.message?.includes('No such subscription') || stripeError.code === 'resource_missing') {
            return res.status(400).json({ 
              message: 'Tu suscripción no se pudo verificar. Por favor contactá a soporte.',
              code: 'SUBSCRIPTION_MODE_MISMATCH'
            });
          }
          
          return res.status(500).json({ 
            message: 'Error al procesar el cambio de plan. Intentá más tarde.',
            code: 'STRIPE_ERROR'
          });
        }
      } else if (existingSubscription) {
        // User has local subscription but no Stripe subscription
        // This means their subscription is not properly linked to Stripe
        // Do NOT allow free plan changes - require proper payment via checkout
        return res.status(400).json({ 
          message: 'Tu suscripción requiere atención. Por favor contactá a soporte o iniciá una nueva suscripción.',
          code: 'SUBSCRIPTION_NOT_LINKED'
        });
      } else {
        return res.status(400).json({ 
          message: 'No tenés una suscripción activa. Por favor iniciá sesión nuevamente o contactá a soporte.',
          code: 'NO_SUBSCRIPTION'
        });
      }
    } catch (error: any) {
      res.status(500).json({ 
        message: 'Error al cambiar el plan',
        code: error.code || 'UNKNOWN_ERROR'
      });
    }
  });

  // Soft cancel: Cancel subscription at period end, user keeps access until then
  app.post('/api/subscription/cancel', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }

      const subscription = await storage.getSubscriptionByUserId(req.userId);
      if (!subscription?.stripeSubscriptionId) {
        return res.status(400).json({ 
          message: 'No tenés una suscripción activa para cancelar.',
          code: 'NO_SUBSCRIPTION'
        });
      }

      // Already pending cancellation?
      if (subscription.cancellationStatus === 'pending_cancellation') {
        return res.status(400).json({ 
          message: 'Tu suscripción ya está programada para cancelarse.',
          code: 'ALREADY_PENDING'
        });
      }

      // Cancel in Stripe at period end (not immediately)
      try {
        const stripe = await getUncachableStripeClient();
        const stripeSubscription = await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          cancel_at_period_end: true
        });

        const periodEnd = (stripeSubscription as any).current_period_end as number | undefined;
        const validPeriodEnd = periodEnd ? new Date(periodEnd * 1000) : null;
        const accessEndsAt = validPeriodEnd && !isNaN(validPeriodEnd.getTime())
          ? validPeriodEnd.toISOString()
          : null;

        await db.update(subscriptions)
          .set({
            cancelAtPeriodEnd: true,
            cancellationStatus: 'pending_cancellation' as const,
            cancellationRequestedAt: new Date(),
            updatedAt: new Date(),
            ...(accessEndsAt ? { currentPeriodEnd: validPeriodEnd! } : {}),
          })
          .where(eq(subscriptions.id, subscription.id));

        const planLabel = PLAN_LABELS[subscription.planType as PlanType] || subscription.planType;
        
        sendCancellationEmail(user.email, user.name, planLabel, accessEndsAt).catch(() => {});
        
        storage.getAdminEmails().then(adminEmails => {
          if (adminEmails.length > 0) {
            sendCancellationAdminEmail(adminEmails, {
              name: user.name,
              email: user.email,
              planType: planLabel,
              phoneNumber: user.phoneNumber || undefined,
              accessEndsAt,
            }).catch(err => console.error('[Cancel] Admin notification failed:', err));
          }
        }).catch(() => {});
        
        res.json({ 
          success: true, 
          message: 'Suscripción cancelada',
          accessEndsAt,
          planLabel
        });
      } catch (cancelError: any) {
        console.error('[Cancel Subscription] Error:', cancelError?.message || cancelError, cancelError?.stack);
        return res.status(500).json({ 
          message: 'Error al cancelar la suscripción. Por favor intentá de nuevo.',
          code: 'CANCEL_ERROR'
        });
      }
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Resume subscription: Undo pending cancellation
  app.post('/api/subscription/resume', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }

      const subscription = await storage.getSubscriptionByUserId(req.userId);
      if (!subscription?.stripeSubscriptionId) {
        return res.status(400).json({ 
          message: 'No tenés una suscripción para reactivar.',
          code: 'NO_SUBSCRIPTION'
        });
      }

      // Only allow resuming if pending cancellation
      if (subscription.cancellationStatus !== 'pending_cancellation') {
        return res.status(400).json({ 
          message: 'Tu suscripción no está pendiente de cancelación.',
          code: 'NOT_PENDING'
        });
      }

      // Resume in Stripe (remove cancel_at_period_end)
      try {
        const stripe = await getUncachableStripeClient();
        await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          cancel_at_period_end: false
        });

        await db.update(subscriptions)
          .set({
            cancelAtPeriodEnd: false,
            cancellationStatus: 'active',
            cancellationRequestedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.id, subscription.id));

        const planLabel = PLAN_LABELS[subscription.planType as PlanType] || subscription.planType;
        
        sendReactivationEmail(user.email, user.name, planLabel).catch(() => {});
        
        res.json({ 
          success: true, 
          message: 'Suscripción reactivada',
          planLabel
        });
      } catch (resumeError: any) {
        console.error('[Resume Subscription] Error:', resumeError?.message || resumeError, resumeError?.stack);
        return res.status(500).json({ 
          message: 'Error al reactivar la suscripción. Por favor intentá de nuevo.',
          code: 'RESUME_ERROR'
        });
      }
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Hard delete: Delete account and all data immediately
  app.post('/api/account/delete', requireAuth, async (req: any, res) => {
    try {
      const { confirmDeletion } = req.body || {};
      
      if (!confirmDeletion) {
        return res.status(400).json({ message: 'Se requiere confirmación de eliminación' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }

      const subscription = await storage.getSubscriptionByUserId(req.userId);
      const planLabel = subscription?.planType 
        ? (PLAN_LABELS[subscription.planType as PlanType] || subscription.planType)
        : 'Tu plan';

      // Get organizations where user is OWNER (only these will be deleted)
      const membershipResult = await db.execute(sql`
        SELECT organization_id, role FROM memberships WHERE user_id = ${req.userId}
      `);
      const allMemberships = membershipResult.rows as Array<{organization_id: string, role: string}>;
      const ownedOrgIds = allMemberships.filter(m => m.role === 'owner').map(m => m.organization_id);
      const memberOnlyOrgIds = allMemberships.filter(m => m.role !== 'owner').map(m => m.organization_id);

      // If user doesn't own any org but is member of others, they can't delete - they need to leave first
      if (ownedOrgIds.length === 0 && memberOnlyOrgIds.length > 0) {
        return res.status(400).json({ 
          message: 'No podés eliminar tu cuenta mientras seas miembro de organizaciones. Primero dejá las organizaciones a las que pertenecés.',
          code: 'MEMBER_OF_ORGS'
        });
      }

      // Cancel in Stripe immediately - this is a HARD requirement
      if (subscription?.stripeSubscriptionId) {
        try {
          const stripe = await getUncachableStripeClient();
          await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
        } catch (stripeError: any) {
          return res.status(500).json({ 
            message: 'Error al cancelar la suscripción en el sistema de pagos. Por favor intentá de nuevo.',
            code: 'STRIPE_ERROR'
          });
        }
      }

      for (const orgId of ownedOrgIds) {
        try {
          await db.execute(sql`DELETE FROM transactions WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM accounts WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM clients WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM suppliers WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM products WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM assets WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM investments WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM categories WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM audit_logs WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM team_invitations WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM memberships WHERE organization_id = ${orgId}`);
          await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
        } catch (deleteError: any) {
        }
      }

      // Remove user from any orgs they're just a member of (not owner)
      for (const orgId of memberOnlyOrgIds) {
        await db.execute(sql`DELETE FROM memberships WHERE user_id = ${req.userId} AND organization_id = ${orgId}`);
      }

      // Delete subscription
      if (subscription) {
        await db.execute(sql`DELETE FROM subscriptions WHERE user_id = ${req.userId}`);
      }

      await db.execute(sql`DELETE FROM users WHERE id = ${req.userId}`);
      sendCancellationEmail(user.email, user.name, planLabel).catch(() => {});

      // Destroy session
      if (req.session) {
        req.session.destroy(() => {});
      }

      res.json({ success: true, message: 'Cuenta eliminada exitosamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/subscription/limits', requireAuth, async (req: any, res) => {
    try {
      const userPlanLimits = await getUserPlanLimits(req.userId, storage);
      const orgPlanLimits = await getOrganizationPlanLimits(req.organizationId, storage);
      
      const orgsCount = await storage.countOrganizationsByUser(req.userId);
      const membersCount = await storage.countMembersByOrganization(req.organizationId);
      const pendingCount = await storage.countPendingInvitationsByOrganization(req.organizationId);
      
      res.json({
        planType: userPlanLimits.planType,
        planLabel: PLAN_LABELS[userPlanLimits.planType],
        limits: {
          maxOrgs: userPlanLimits.maxOrgs,
          maxMembersPerOrg: orgPlanLimits.maxMembersPerOrg,
        },
        usage: {
          organizations: orgsCount,
          members: membersCount + pendingCount,
        },
        isTeamPlan: userPlanLimits.isTeamPlan,
        orgPlanType: orgPlanLimits.planType,
        orgPlanLabel: PLAN_LABELS[orgPlanLimits.planType],
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Organization routes
  app.get('/api/organizations', requireAuth, async (req: any, res) => {
    try {
      const orgs = await storage.getOrganizationsByUser(req.userId);
      const enriched = await Promise.all(orgs.map(async (org) => {
        if (org.type === 'personal' && org.membershipRole !== 'owner') {
          const owner = await storage.getOrganizationOwner(org.id);
          const ownerName = owner?.preferredName || owner?.name?.split(' ')[0] || '';
          return { ...org, ownerFirstName: ownerName };
        }
        return org;
      }));
      res.json(enriched);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/organizations/switch', requireAuth, async (req: any, res) => {
    try {
      const { organizationId } = req.body;
      
      const membership = await storage.getMembershipByUserAndOrg(req.userId, organizationId);
      if (!membership) {
        return res.status(403).json({ message: 'No access to this organization' });
      }
      
      req.session.organizationId = organizationId;
      
      // Update user's lastActiveOrganizationId for WhatsApp context
      await storage.updateUser(req.userId, { lastActiveOrganizationId: organizationId });
      
      // Explicitly save session to ensure organizationId change persists
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: any) => {
          if (err) {
            console.error('[Session] Error saving session after org switch:', err);
            reject(err);
          } else {
            console.log('[Session] Session saved after org switch, new orgId:', organizationId);
            resolve();
          }
        });
      });
      
      const org = await storage.getOrganization(organizationId);
      res.json(org);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/organizations', requireAuth, async (req: any, res) => {
    try {
      const { name, iconKey, logoUrl } = req.body;
      
      const userOrgs = await storage.getOrganizationsByUser(req.userId);
      
      // Count only organizations where user is owner (not invited member)
      // Organizations where user is invited don't count against their plan limit
      let ownedOrgsCount = 0;
      for (const org of userOrgs) {
        const membership = await storage.getMembershipByUserAndOrg(req.userId, org.id);
        if (membership?.role === 'owner') {
          ownedOrgsCount++;
        }
      }
      
      if (ownedOrgsCount === 0) {
        return res.status(403).json({ message: 'Solo los propietarios pueden crear nuevas organizaciones' });
      }
      
      const planLimits = await getUserPlanLimits(req.userId, storage);
      if (ownedOrgsCount >= planLimits.maxOrgs) {
        return res.status(403).json({ 
          message: `Alcanzaste el límite de organizaciones de tu plan ${PLAN_LABELS[planLimits.planType]} (${ownedOrgsCount}/${planLimits.maxOrgs})` 
        });
      }
      
      const org = await storage.createOrganization({ 
        name, 
        type: 'business',
        country: 'AR',
        defaultCurrency: 'ARS',
        iconKey: logoUrl ? null : (iconKey || null),
        logoUrl: logoUrl || null,
      });
      
      await storage.createMembership({
        userId: req.userId,
        organizationId: org.id,
        role: 'owner',
      });
      
      await storage.seedDefaultCategories(org.id, req.userId);
      await storage.seedDefaultAccount(org.id, 'ARS');
      
      res.json(org);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/organization', requireAuth, async (req: any, res) => {
    try {
      const org = await storage.getOrganization(req.organizationId);
      if (!org) {
        return res.status(404).json({ message: 'Organization not found' });
      }
      if (org.type === 'personal') {
        const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
        if (membership && membership.role !== 'owner') {
          const owner = await storage.getOrganizationOwner(org.id);
          const ownerName = owner?.preferredName || owner?.name?.split(' ')[0] || '';
          return res.json({ ...org, ownerFirstName: ownerName });
        }
      }
      res.json(org);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.patch('/api/organization', requireAuth, async (req: any, res) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership || membership.role !== 'owner') {
        return res.status(403).json({ message: 'Solo el propietario puede editar la organización' });
      }
      
      const { name } = req.body;
      const org = await storage.updateOrganization(req.organizationId, { name });
      if (!org) {
        return res.status(404).json({ message: 'Organization not found' });
      }
      res.json(org);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/organizations/:id', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;

      const membership = await storage.getMembershipByUserAndOrg(req.userId, id);
      if (!membership) {
        return res.status(403).json({ message: 'No tienes acceso a esta organización' });
      }
      
      if (membership.role !== 'owner') {
        return res.status(403).json({ message: 'Solo el propietario puede editar la organización' });
      }

      const parsed = updateOrganizationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.flatten() });
      }

      // Solo persistir los campos efectivamente presentes en el body (los
      // ausentes quedan como undefined y se descartan).
      const updateData: Record<string, any> = {};
      for (const [key, value] of Object.entries(parsed.data)) {
        if (value !== undefined) updateData[key] = value;
      }

      const org = await storage.updateOrganization(id, updateData);
      if (!org) {
        return res.status(404).json({ message: 'Organización no encontrada' });
      }
      res.json(org);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/organizations/:id', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const membership = await storage.getMembershipByUserAndOrg(req.userId, id);
      if (!membership) {
        return res.status(403).json({ message: 'No tienes acceso a esta organización' });
      }
      
      if (membership.role !== 'owner') {
        return res.status(403).json({ message: 'Solo el propietario puede eliminar la organización' });
      }
      
      const userOrgs = await storage.getOrganizationsByUser(req.userId);
      if (userOrgs.length <= 1) {
        return res.status(400).json({ message: 'No puedes eliminar tu única organización' });
      }
      
      const org = await storage.getOrganization(id);
      if (org?.type === 'personal') {
        return res.status(400).json({ message: 'No puedes eliminar tu organización personal' });
      }
      
      // Remember if we need to switch orgs after deletion
      const needsOrgSwitch = req.organizationId === id;
      const otherOrg = needsOrgSwitch ? userOrgs.find(o => o.id !== id) : null;
      
      // First, attempt to delete the organization
      const deleted = await storage.deleteOrganization(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Organización no encontrada' });
      }
      
      // Only after successful deletion, switch session to another org if needed
      if (needsOrgSwitch && otherOrg) {
        req.session.organizationId = otherOrg.id;
        // Explicitly save session to persist the organization change
        await new Promise<void>((resolve, reject) => {
          req.session.save((err: any) => {
            if (err) {
              console.error('[Session] Error saving session after org delete switch:', err);
              // Don't reject - deletion succeeded, just log the session error
              resolve();
            } else {
              console.log('[Session] Session saved after org delete switch, new orgId:', otherOrg.id);
              resolve();
            }
          });
        });
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Transaction categories routes
  app.get('/api/organization/categories', requireAuth, async (req: any, res) => {
    try {
      const { type } = req.query;
      const includeArchived = req.query.includeArchived === 'true'; // Task #363
      const categories = await storage.getTransactionCategoriesByOrganization(
        req.organizationId, 
        type as 'income' | 'expense' | undefined,
        includeArchived
      );
      res.json(categories);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363: archivar / desarchivar categoría
  app.post('/api/organization/categories/:id/archive', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getTransactionCategory(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Categoría no encontrada' });
      }
      const archived = await storage.archiveTransactionCategory(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'transaction_category', entityId: req.params.id, action: 'archived',
        previousData: JSON.stringify(existing),
        newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
      });
      res.json({ success: true, category: archived });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  app.post('/api/organization/categories/:id/unarchive', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const existing = await storage.getTransactionCategory(req.params.id);
      if (!existing || existing.organizationId !== req.organizationId) {
        return res.status(404).json({ message: 'Categoría no encontrada' });
      }
      const restored = await storage.unarchiveTransactionCategory(req.params.id);
      await storage.createAuditLog({
        organizationId: req.organizationId, userId: req.userId,
        entityType: 'transaction_category', entityId: req.params.id, action: 'unarchived',
        previousData: JSON.stringify(existing),
        newData: restored ? JSON.stringify({ archivedAt: null }) : null,
      });
      res.json({ success: true, category: restored });
    } catch (error: any) { res.status(500).json({ message: sanitizeError(error) }); }
  });

  app.post('/api/organization/categories', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const { name, type, expenseSubtype } = req.body;
      if (!name || !type) {
        return res.status(400).json({ message: 'Nombre y tipo son requeridos' });
      }
      if (!['income', 'expense'].includes(type)) {
        return res.status(400).json({ message: 'Tipo debe ser income o expense' });
      }
      const category = await storage.createTransactionCategory({
        organizationId: req.organizationId,
        name,
        type,
        expenseSubtype: type === 'expense' ? (expenseSubtype || 'expense') : null,
        isDefault: false,
        createdBy: req.userId,
      });
      res.json(category);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.patch('/api/organization/categories/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const { name, expenseSubtype, applyToExisting } = req.body;
      
      const existing = await storage.getTransactionCategory(id);
      if (!existing) {
        return res.status(404).json({ message: 'Categoría no encontrada' });
      }
      if (existing.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta categoría' });
      }
      
      const updateData: Partial<{ name: string; expenseSubtype: 'expense' | 'cost' }> = {};
      if (name) updateData.name = name;
      if (expenseSubtype && existing.type === 'expense' && (expenseSubtype === 'cost' || expenseSubtype === 'expense')) {
        updateData.expenseSubtype = expenseSubtype;
      }
      const category = await storage.updateTransactionCategory(id, updateData);

      let updatedCount = 0;
      if (applyToExisting && expenseSubtype && existing.type === 'expense' && ['cost', 'expense'].includes(expenseSubtype)) {
        const result = await db.execute(sql`
          UPDATE transactions 
          SET expense_subtype = ${expenseSubtype}
          WHERE organization_id = ${req.organizationId}
            AND category = ${existing.name}
            AND (type = 'expense' OR type = 'payable')
        `);
        updatedCount = (result as any).rowCount || 0;
      }

      res.json({ ...category, updatedCount });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/organization/categories/:id/usage', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const existing = await storage.getTransactionCategory(id);
      if (!existing) {
        return res.status(404).json({ message: 'Categoría no encontrada' });
      }
      if (existing.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta categoría' });
      }
      const typeFilter = existing.type === 'income'
        ? sql`AND (type = 'income' OR type = 'receivable')`
        : sql`AND (type = 'expense' OR type = 'payable')`;
      const result: any = await db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM transactions
        WHERE organization_id = ${req.organizationId}
          AND category = ${existing.name}
          ${typeFilter}
      `);
      const count = result?.rows?.[0]?.count ?? 0;
      res.json({ count, name: existing.name, type: existing.type });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.get('/api/organization/categories/ghosts', requireAuth, async (req: any, res) => {
    try {
      const categories = await storage.getTransactionCategoriesByOrganization(req.organizationId);
      const result: any = await db.execute(sql`
        SELECT category, type, COUNT(*)::int AS count
        FROM transactions
        WHERE organization_id = ${req.organizationId}
          AND category IS NOT NULL
          AND category <> ''
        GROUP BY category, type
      `);
      const rows = (result?.rows ?? []) as Array<{ category: string; type: string; count: number }>;
      const incomeTypes = new Set(['income', 'receivable']);
      const knownByType: Record<'income' | 'expense', Set<string>> = {
        income: new Set(categories.filter(c => c.type === 'income').map(c => c.name)),
        expense: new Set(categories.filter(c => c.type === 'expense').map(c => c.name)),
      };
      const ghostsMap = new Map<string, { name: string; type: 'income' | 'expense'; count: number }>();
      for (const row of rows) {
        const bucket: 'income' | 'expense' = incomeTypes.has(row.type) ? 'income' : 'expense';
        if (knownByType[bucket].has(row.category)) continue;
        const key = `${bucket}::${row.category}`;
        const prev = ghostsMap.get(key);
        if (prev) prev.count += row.count;
        else ghostsMap.set(key, { name: row.category, type: bucket, count: row.count });
      }
      res.json(Array.from(ghostsMap.values()));
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/organization/categories/reassign', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const schema = z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(['income', 'expense']).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parsed.error.errors });
      }
      const { from, to, type } = parsed.data;
      if (from === to) {
        return res.status(400).json({ message: 'La categoría de origen y destino son iguales' });
      }
      // Verify target exists in the org (and matches type when provided).
      const all = await storage.getTransactionCategoriesByOrganization(req.organizationId);
      const target = all.find(c => c.name === to && (!type || c.type === type));
      if (!target) {
        return res.status(400).json({ message: 'La categoría de destino no existe en la organización' });
      }
      const typeFilter = target.type === 'income'
        ? sql`AND (type = 'income' OR type = 'receivable')`
        : sql`AND (type = 'expense' OR type = 'payable')`;
      const result: any = await db.execute(sql`
        UPDATE transactions
        SET category = ${to}
        WHERE organization_id = ${req.organizationId}
          AND category = ${from}
          ${typeFilter}
      `);
      const updatedCount = result?.rowCount || 0;
      res.json({ success: true, updatedCount });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Task #363: delete con reasignación opcional; sin reasign + categoría usada → archiva.
  // force=true (owner/admin): elimina o falla 409 si tiene historia.
  app.delete('/api/organization/categories/:id', requireAuth, requirePermission('organization:settings'), async (req: any, res) => {
    try {
      const { id } = req.params;
      const reassignTo = typeof req.body?.reassignTo === 'string' && req.body.reassignTo.trim().length > 0
        ? req.body.reassignTo.trim()
        : null;
      const force = req.query.force === 'true' || req.query.force === true;
      if (force) {
        const role = (req as any).membership?.role as string | undefined;
        if (role !== 'owner' && role !== 'admin') {
          return res.status(403).json({ message: 'Solo propietarios y administradores pueden eliminar definitivamente' });
        }
      }

      const existing = await storage.getTransactionCategory(id);
      if (!existing) {
        return res.status(404).json({ message: 'Categoría no encontrada' });
      }
      if (existing.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta categoría' });
      }

      let reassignedCount = 0;
      if (reassignTo) {
        if (reassignTo === existing.name) {
          return res.status(400).json({ message: 'La categoría de reasignación es la misma que la que estás eliminando' });
        }
        const all = await storage.getTransactionCategoriesByOrganization(req.organizationId);
        const target = all.find(c => c.name === reassignTo && c.type === existing.type);
        if (!target) {
          return res.status(400).json({ message: 'La categoría de reasignación no existe' });
        }
        const typeFilter = existing.type === 'income'
          ? sql`AND (type = 'income' OR type = 'receivable')`
          : sql`AND (type = 'expense' OR type = 'payable')`;
        const result: any = await db.execute(sql`
          UPDATE transactions
          SET category = ${reassignTo}
          WHERE organization_id = ${req.organizationId}
            AND category = ${existing.name}
            ${typeFilter}
        `);
        reassignedCount = result?.rowCount || 0;
      }

      // Si no se reasignó, comprobamos uso. Si tiene movimientos asociados → archivar (a menos que force).
      let inUse = false;
      if (!reassignTo) {
        const typeFilter = existing.type === 'income'
          ? sql`AND (type = 'income' OR type = 'receivable')`
          : sql`AND (type = 'expense' OR type = 'payable')`;
        const usageResult: any = await db.execute(sql`
          SELECT COUNT(*)::int AS count FROM transactions
          WHERE organization_id = ${req.organizationId}
            AND category = ${existing.name}
            ${typeFilter}
        `);
        inUse = (usageResult?.rows?.[0]?.count ?? 0) > 0;
      }

      if (inUse && !force) {
        const archived = await storage.archiveTransactionCategory(id);
        await storage.createAuditLog({
          organizationId: req.organizationId, userId: req.userId,
          entityType: 'transaction_category', entityId: id, action: 'archived',
          previousData: JSON.stringify(existing),
          newData: archived ? JSON.stringify({ archivedAt: archived.archivedAt }) : null,
        });
        return res.json({ success: true, archived: true });
      }
      if (inUse && force) {
        return res.status(409).json({ message: 'No se puede eliminar definitivamente: la categoría está usada por movimientos' });
      }

      const deleted = await storage.deleteTransactionCategory(id);
      if (deleted) {
        await storage.createAuditLog({
          organizationId: req.organizationId, userId: req.userId,
          entityType: 'transaction_category', entityId: id,
          action: force ? 'hard_deleted' : 'delete',
          previousData: JSON.stringify(existing),
          newData: force ? JSON.stringify({ forced: true }) : null,
        });
      }
      res.json({ success: deleted, deleted: true, reassignedCount });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Organization members routes
  app.get('/api/organization/members', requireAuth, async (req: any, res) => {
    try {
      const members = await storage.getMembersByOrganization(req.organizationId);
      const sanitized = members.map(m => ({
        id: m.membership.id,
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        role: m.membership.role,
        createdAt: m.membership.createdAt,
      }));
      res.json(sanitized);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const addMemberSchema = z.object({
    email: z.string().email(),
    role: z.enum(['admin', 'specialist', 'operator', 'viewer']).optional().default('operator'),
  });

  app.post('/api/organization/members', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const parsed = addMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Datos invalidos', errors: parsed.error.errors });
      }
      const { email, role } = parsed.data;
      
      const currentMembership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!currentMembership || !ADMIN_ROLES.includes(currentMembership.role as Role)) {
        return res.status(403).json({ message: 'Solo administradores pueden agregar miembros' });
      }
      
      // Task #343 — soft-deleted users no son invitables (la cuenta ya no
      // existe operativamente). Pedimos que el invitado se registre de nuevo.
      const user = await storage.getUserByEmail(email);
      if (!user || user.deletedAt) {
        return res.status(404).json({ message: 'Usuario no encontrado. Debe registrarse primero.' });
      }
      
      const existingMembership = await storage.getMembershipByUserAndOrg(user.id, req.organizationId);
      if (existingMembership) {
        return res.status(400).json({ message: 'Este usuario ya es miembro de la organizacion' });
      }
      
      const membership = await storage.createMembership({
        userId: user.id,
        organizationId: req.organizationId,
        role: role,
      });
      
      res.json({
        id: membership.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        role: membership.role,
        createdAt: membership.createdAt,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  const updateRoleSchema = z.object({
    role: z.enum(['admin', 'specialist', 'operator', 'viewer']),
  });

  app.patch('/api/organization/members/:id', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const parsed = updateRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: 'Rol no valido' });
      }
      const { role } = parsed.data;
      
      const currentMembership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!currentMembership || !ADMIN_ROLES.includes(currentMembership.role as Role)) {
        return res.status(403).json({ message: 'Solo administradores pueden cambiar roles' });
      }
      
      const membership = await storage.updateMembershipRole(id, role);
      if (!membership) {
        return res.status(404).json({ message: 'Miembro no encontrado' });
      }
      res.json(membership);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/organization/members/:id', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const currentMembership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!currentMembership || !ADMIN_ROLES.includes(currentMembership.role as Role)) {
        return res.status(403).json({ message: 'Solo administradores pueden eliminar miembros' });
      }
      
      // Get member info and organization info before deleting for the access denied event
      const members = await storage.getMembersByOrganization(req.organizationId);
      const memberToRemove = members.find(m => m.membership.id === id);
      const organization = await storage.getOrganization(req.organizationId);
      const remover = await storage.getUser(req.userId);
      
      if (!memberToRemove || !organization) {
        return res.status(404).json({ message: 'Miembro no encontrado' });
      }
      
      // Create access denied event before deleting membership
      try {
        await storage.createAccessDeniedEvent({
          userId: memberToRemove.user.id,
          userEmail: memberToRemove.user.email,
          organizationId: organization.id,
          organizationName: organization.name,
          reason: 'member_removed',
          removedByUserId: req.userId,
          removedByUserName: remover?.name || 'Administrador',
          acknowledged: false,
        });
      } catch (err) {
      }
      
      const deleted = await storage.deleteMembership(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Miembro no encontrado' });
      }
      res.json({ message: 'Miembro eliminado' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Leave organization - for invited members to leave a team
  app.post('/api/organizations/:id/leave', requireAuth, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      // Check if user is a member of this organization
      const membership = await storage.getMembershipByUserAndOrg(req.userId, id);
      if (!membership) {
        return res.status(404).json({ message: 'No sos miembro de esta organización' });
      }
      
      // Owners cannot leave their own organization, they must delete it
      if (membership.role === 'owner') {
        return res.status(403).json({ message: 'No podés abandonar una organización de la que sos propietario. Debés eliminarla o transferir la propiedad primero.' });
      }
      
      const organization = await storage.getOrganization(id);
      const user = await storage.getUser(req.userId);
      
      // Create access denied event for the user leaving
      try {
        await storage.createAccessDeniedEvent({
          userId: req.userId,
          userEmail: user?.email || '',
          organizationId: id,
          organizationName: organization?.name || '',
          reason: 'member_left',
          removedByUserId: req.userId,
          removedByUserName: user?.name || 'Usuario',
          acknowledged: false,
        });
      } catch (err) {
      }
      
      // Delete the membership
      const deleted = await storage.deleteMembership(membership.id);
      if (!deleted) {
        return res.status(500).json({ message: 'No se pudo abandonar la organización' });
      }
      
      res.json({ message: 'Has abandonado la organización exitosamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Current user membership info
  app.get('/api/user/membership', requireAuth, async (req: any, res) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership) {
        return res.status(404).json({ message: 'Membership not found' });
      }
      res.json(membership);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Check if email exists in system (for team invite flow)
  app.get('/api/team/check-email', requireAuth, async (req: any, res) => {
    try {
      const { email } = req.query;
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ message: 'Email es requerido' });
      }
      
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership || !ADMIN_ROLES.includes(membership.role as Role)) {
        return res.status(403).json({ message: 'Solo administradores pueden verificar emails' });
      }
      
      // Task #343 — tratamos al soft-deleted como inexistente para el chequeo
      // del invitador: así pueden invitar con ese email y el flujo va a pedirle
      // al destinatario que se registre como cuenta nueva.
      const user = await storage.getUserByEmail(email);
      if (user && !user.deletedAt) {
        const existingMembership = await storage.getMembershipByUserAndOrg(user.id, req.organizationId);
        return res.json({ 
          exists: true, 
          name: user.name,
          alreadyMember: !!existingMembership
        });
      }
      
      res.json({ exists: false });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Team invitation routes
  app.get('/api/team/invitations', requireAuth, requireOwner, async (req: any, res) => {
    try {
      
      const invitations = await storage.getTeamInvitationsByOrganization(req.organizationId, 'pending');
      res.json(invitations);
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/team/invite', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const { role, organizationId, password } = req.body;
      const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : req.body.email;
      
      if (!email || !role) {
        return res.status(400).json({ message: 'Email y rol son requeridos' });
      }
      
      if (!ASSIGNABLE_ROLES.includes(role)) {
        return res.status(400).json({ message: 'Rol no válido' });
      }
      
      const targetOrgId = organizationId || req.organizationId;
      
      const planLimits = await getOrganizationPlanLimits(targetOrgId, storage);
      
      if (planLimits.maxMembersPerOrg <= 1) {
        return res.status(403).json({ 
          message: 'Tu plan no permite agregar miembros. Actualizá tu plan para invitar colaboradores.' 
        });
      }
      const memberCount = await storage.countMembersByOrganization(targetOrgId);
      const pendingCount = await storage.countPendingInvitationsByOrganization(targetOrgId);
      const totalMembers = memberCount + pendingCount;

      if (totalMembers >= planLimits.maxMembersPerOrg) {
        return res.status(403).json({ 
          message: `Alcanzaste el límite de miembros del plan ${PLAN_LABELS[planLimits.planType]} (${totalMembers}/${planLimits.maxMembersPerOrg})` 
        });
      }
      
      // Task #343 — un user soft-deleted no puede ser agregado a una org:
      // forzamos el flujo de invitación por email para que se registre nuevo.
      const existingUserRaw = await storage.getUserByEmail(email);
      const existingUser = existingUserRaw && !existingUserRaw.deletedAt ? existingUserRaw : null;
      
      if (existingUser) {
        const existingMembership = await storage.getMembershipByUserAndOrg(existingUser.id, targetOrgId);
        if (existingMembership) {
          return res.status(400).json({ message: 'Este usuario ya es miembro de esta organización' });
        }
        
        const newMembership = await storage.createMembership({
          userId: existingUser.id,
          organizationId: targetOrgId,
          role: role,
        });
        
        const organization = await storage.getOrganization(targetOrgId);
        const inviter = await storage.getUser(req.userId);
        
        if (organization && inviter) {
          sendTeamAddedEmail(existingUser.email, existingUser.name, organization.name, inviter.name).catch(() => {});
          
          storage.createNotification({
            userId: existingUser.id,
            organizationId: targetOrgId,
            type: 'system',
            priority: 'info',
            title: `Te agregaron a ${organization.name}`,
            message: `${inviter.name} te agregó al equipo de ${organization.name}. Ya podés acceder desde el menú de organizaciones.`,
            source: 'auto',
          }).catch(() => {});
        }
        
        return res.json({
          type: 'existing_user',
          email: existingUser.email,
          name: existingUser.name,
          membershipId: newMembership.id,
          message: 'Usuario agregado a la organización'
        });
      }
      
      const temporaryPassword = password || generateTemporaryPassword(8);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
      
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      
      const invitation = await storage.createTeamInvitation({
        organizationId: targetOrgId,
        invitedBy: req.userId,
        email,
        role,
        temporaryPassword: hashedPassword,
        status: 'pending',
        expiresAt,
      });
      
      const organization = await storage.getOrganization(targetOrgId);
      const inviter = await storage.getUser(req.userId);
      if (organization && inviter) {
        sendTeamInvitationEmail(email, organization.name, inviter.name, temporaryPassword).catch(() => {});
      }
      
      res.json({
        type: 'new_invitation',
        email: invitation.email,
        temporaryPassword,
        invitationId: invitation.id,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/team/regenerate-password/:invitationId', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const { invitationId } = req.params;
      
      const invitation = await storage.getTeamInvitation(invitationId);
      if (!invitation) {
        return res.status(404).json({ message: 'Invitación no encontrada' });
      }
      
      if (invitation.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta invitación' });
      }
      
      if (invitation.status !== 'pending') {
        return res.status(400).json({ message: 'Solo se puede regenerar la contraseña de invitaciones pendientes' });
      }
      
      const temporaryPassword = generateTemporaryPassword(8);
      const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
      
      await storage.updateTeamInvitation(invitationId, {
        temporaryPassword: hashedPassword,
      });
      
      res.json({
        email: invitation.email,
        temporaryPassword,
        invitationId: invitation.id,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/team/invitations/:id', requireAuth, requireOwner, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const invitation = await storage.getTeamInvitation(id);
      if (!invitation) {
        return res.status(404).json({ message: 'Invitación no encontrada' });
      }
      
      if (invitation.organizationId !== req.organizationId) {
        return res.status(403).json({ message: 'No tienes acceso a esta invitación' });
      }
      
      const deleted = await storage.deleteTeamInvitation(id);
      if (!deleted) {
        return res.status(404).json({ message: 'Invitación no encontrada' });
      }
      
      res.json({ message: 'Invitación cancelada' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
