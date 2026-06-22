import type { Express } from "express";
import type Stripe from "stripe";
import { sanitizeError } from "./middleware";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { getUncachableStripeClient, getStripePublishableKey } from "../stripeClient";
import { storage } from "../storage";
import { sendWelcomeEmail } from "../services/email";
import { PLAN_TYPES, type PlanType } from "@shared/schema";
import { requireAuth, requireAuthOnly } from "./middleware";

function getBaseUrl(): string {
  if (process.env.NODE_ENV === 'development') {
    const devDomain = process.env.REPLIT_DEV_DOMAIN;
    if (devDomain) return `https://${devDomain}`;
    return `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
  }
  return 'https://app.aikestar.com';
}

export function registerStripeRoutes(app: Express): void {
  app.get('/api/stripe/publishable-key', async (req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      if (publishableKey && publishableKey.startsWith('sk_')) {
        console.error('[STRIPE SECURITY] publishable-key endpoint would expose a secret key! Blocking response.');
        return res.status(500).json({ message: 'Stripe configuration error' });
      }
      res.json({ publishableKey });
    } catch (error: any) {
      res.status(500).json({ message: 'Stripe not configured' });
    }
  });

  app.get('/api/stripe/products', async (req, res) => {
    // Helper function to fetch products directly from Stripe API
    const fetchFromStripeAPI = async () => {
      console.log('[Stripe] Fetching products from Stripe API...');
      const stripe = await getUncachableStripeClient();
      const stripeProducts = await stripe.products.list({ active: true, limit: 100 });
      const stripePrices = await stripe.prices.list({ active: true, limit: 100 });

      const productsWithPrices = stripeProducts.data
        .filter(product => product.metadata?.planType)
        .map(product => ({
          id: product.id,
          name: product.name,
          description: product.description,
          metadata: product.metadata,
          prices: stripePrices.data
            .filter(price => price.product === product.id)
            .map(price => ({
              id: price.id,
              unitAmount: price.unit_amount,
              currency: price.currency,
              recurring: price.recurring,
            }))
        }))
        .filter(product => product.prices.length > 0)
        .sort((a, b) => (a.prices[0]?.unitAmount || 0) - (b.prices[0]?.unitAmount || 0));

      return productsWithPrices;
    };

    try {
      const isProduction = process.env.NODE_ENV === 'production';
      console.log(`[Stripe Products] Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
      
      // In production, ALWAYS fetch directly from Stripe API (Live mode)
      // This avoids using cached Test mode product IDs from local DB
      if (isProduction) {
        console.log('[Stripe] Production mode: Fetching products directly from Stripe Live API');
        try {
          const products = await fetchFromStripeAPI();
          console.log(`[Stripe Products] Successfully fetched ${products.length} products`);
          return res.json(products);
        } catch (apiError: any) {
          console.error('[Stripe Products] API Error:', apiError.message);
          console.error('[Stripe Products] API Error Type:', apiError.type);
          console.error('[Stripe Products] API Error Code:', apiError.code);
          console.error('[Stripe Products] Full error:', JSON.stringify(apiError, null, 2));
          throw apiError;
        }
      }
      
      // In development, try local database first (StripeSync cache)
      let result;
      try {
        result = await db.execute(sql`
          SELECT 
            p.id as product_id,
            p.name as product_name,
            p.description as product_description,
            p.metadata as product_metadata,
            pr.id as price_id,
            pr.unit_amount,
            pr.currency,
            pr.recurring
          FROM stripe.products p
          LEFT JOIN stripe.prices pr ON pr.product = p.id AND pr.active = true
          WHERE p.active = true
          ORDER BY pr.unit_amount ASC
        `);
      } catch (dbError: any) {
        // Database query failed (table might not exist)
        console.log('[Stripe] Local DB query failed, falling back to Stripe API:', dbError.message);
        const products = await fetchFromStripeAPI();
        return res.json(products);
      }

      // If we have products in local DB, use them
      if (result.rows.length > 0) {
        const productsMap = new Map();
        for (const row of result.rows as any[]) {
          if (!productsMap.has(row.product_id)) {
            productsMap.set(row.product_id, {
              id: row.product_id,
              name: row.product_name,
              description: row.product_description,
              metadata: row.product_metadata,
              prices: []
            });
          }
          if (row.price_id) {
            productsMap.get(row.product_id).prices.push({
              id: row.price_id,
              unitAmount: row.unit_amount,
              currency: row.currency,
              recurring: row.recurring,
            });
          }
        }
        return res.json(Array.from(productsMap.values()));
      }

      // Fallback: fetch directly from Stripe API
      const products = await fetchFromStripeAPI();
      res.json(products);
    } catch (error: any) {
      console.error('[Stripe] Error fetching products:', error);
      res.status(500).json({ message: 'Error fetching products' });
    }
  });

  // Use requireAuthOnly to allow users with pending subscription to access checkout
  app.post('/api/stripe/create-checkout-session', requireAuthOnly, async (req: any, res) => {
    try {

      const { priceId } = req.body;
      
      if (!priceId) {
        return res.status(400).json({ message: 'Price ID required' });
      }

      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }

      const stripe = await getUncachableStripeClient();

      const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
      if (!price || !price.active) {
        return res.status(400).json({ message: 'Precio no válido o inactivo' });
      }

      const product = price.product as any;
      const planType = product?.metadata?.planType as PlanType;
      
      if (!planType || !PLAN_TYPES.includes(planType)) {
        return res.status(400).json({ message: 'Producto sin tipo de plan configurado' });
      }

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name,
          metadata: { userId: user.id },
        });
        await storage.updateUser(user.id, { stripeCustomerId: customer.id });
        customerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${getBaseUrl()}/payment-success?plan=${planType}`,
        cancel_url: `${getBaseUrl()}/settings?checkout=cancelled`,
        metadata: {
          userId: user.id,
          planType: planType,
          isPlanChange: 'true',
        },
        subscription_data: {
          trial_period_days: 30,
          metadata: {
            userId: user.id,
            planType: planType,
          }
        }
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (error: any) {
      console.error('[Stripe] Checkout error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error creating checkout session' });
    }
  });

  app.post('/api/stripe/create-portal-session', requireAuth, async (req: any, res) => {
    try {

      const user = await storage.getUser(req.userId);
      if (!user?.stripeCustomerId) {
        return res.status(400).json({ message: 'No tenés una suscripción activa' });
      }

      const stripe = await getUncachableStripeClient();

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${getBaseUrl()}/settings`,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error('[Stripe] Portal error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error creating portal session' });
    }
  });

  // Special endpoint for blocked users (past grace period) to access billing portal
  // Uses requireAuthOnly to bypass subscription check
  app.post('/api/stripe/create-portal-session-blocked', requireAuthOnly, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user?.stripeCustomerId) {
        // Task #343 — antes devolvíamos 400 acá y el frontend caía al catch
        // mandando a /settings (protegido → 402 → loop). Resolvemos el caso
        // de "usuario sin customer en Stripe" mandándolo a /pricing para que
        // elija un plan y se cree el customer en el checkout normal.
        return res.json({ url: `${getBaseUrl()}/pricing?recover=1`, mode: 'pricing' });
      }

      const stripe = await getUncachableStripeClient();

      // Intento 1: billing portal — funciona para clientes con suscripciones
      // vivas o aún recuperables del lado Stripe (past_due / unpaid).
      try {
        const session = await stripe.billingPortal.sessions.create({
          customer: user.stripeCustomerId,
          // Task #343 — return_url debe apuntar a una página NO protegida por
          // requireAuth con check de suscripción. Antes mandaba a "/" y al
          // volver del portal sin pagar el usuario caía en 402 → loop.
          return_url: `${getBaseUrl()}/pricing?recover=1`,
        });
        console.log('[Stripe] Created billing portal session for blocked user:', req.userId);
        return res.json({ url: session.url, mode: 'portal' });
      } catch (portalErr: any) {
        // Task #318 — Si el portal falla (típicamente porque la
        // suscripción ya fue eliminada en Stripe y el customer no tiene
        // nada que mostrar / o el portal está mal configurado en el dash
        // de Stripe), caemos a crear un checkout nuevo con el último plan
        // conocido. Eso le permite al usuario re-suscribirse con tarjeta
        // nueva sin tener que volver a /pricing y elegir manualmente.
        console.warn('[Stripe] Portal session failed for blocked user, trying checkout fallback:', portalErr?.message);

        let priceId: string | null = null;
        let planType: PlanType = 'personal';

        // Camino 1: si Stripe todavía tiene la suscripción (estado
        // unpaid/canceled pero no `deleted`), tomamos el priceId real.
        if (user.stripeSubscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            const item = sub.items?.data?.[0];
            if (item?.price?.id) {
              priceId = item.price.id;
              const productId = typeof item.price.product === 'string'
                ? item.price.product
                : item.price.product?.id;
              if (productId) {
                try {
                  const product = await stripe.products.retrieve(productId);
                  const raw = product.metadata?.planType;
                  if (raw && PLAN_TYPES.includes(raw as PlanType)) planType = raw as PlanType;
                } catch (prodErr) {
                  console.warn('[Stripe] Could not retrieve product for fallback checkout:', prodErr);
                }
              }
            }
          } catch (subErr: any) {
            console.warn('[Stripe] Could not retrieve subscription for fallback checkout:', subErr?.message);
          }
        }

        // Camino 2 (caso Tomy): la suscripción ya no existe en Stripe
        // (fue purgada después de cancelarse). Usamos el `planType` que
        // guardamos en nuestra tabla `subscriptions` para mapear contra
        // un producto activo de Stripe con `metadata.planType` que
        // coincida y elegir su price activo recurrente más barato.
        if (!priceId) {
          try {
            const localSub = await storage.getSubscriptionByUserId(req.userId);
            const localPlan = localSub?.planType;
            if (localPlan && (PLAN_TYPES as readonly string[]).includes(localPlan)) {
              planType = localPlan as PlanType;
              const products = await stripe.products.list({ active: true, limit: 100 });
              const matchingProduct = products.data.find(
                (p) => p.metadata?.planType === planType,
              );
              if (matchingProduct) {
                const prices = await stripe.prices.list({
                  active: true,
                  product: matchingProduct.id,
                  limit: 10,
                });
                const recurring = prices.data
                  .filter((p) => p.recurring && p.unit_amount != null)
                  .sort((a, b) => (a.unit_amount ?? 0) - (b.unit_amount ?? 0));
                if (recurring.length > 0) {
                  priceId = recurring[0].id;
                  console.log(`[Stripe] Resolved fallback priceId ${priceId} from local planType=${planType}`);
                }
              }
            }
          } catch (resolveErr: any) {
            console.warn('[Stripe] Could not resolve fallback price from local planType:', resolveErr?.message);
          }
        }

        if (priceId) {
          try {
            const checkout = await stripe.checkout.sessions.create({
              customer: user.stripeCustomerId,
              payment_method_types: ['card'],
              line_items: [{ price: priceId, quantity: 1 }],
              mode: 'subscription',
              success_url: `${getBaseUrl()}/payment-success?plan=${planType}`,
              // Task #343 — antes el cancel_url mandaba a /subscription-required
              // con reason=PAYMENT_BLOCKED, lo que para un usuario `cancelled`
              // mostraba el copy equivocado y dejaba la sensación de loop. /pricing
              // es seguro (autenticado sin plan) y le ofrece elegir uno nuevo.
              cancel_url: `${getBaseUrl()}/pricing?recover=1`,
              metadata: {
                userId: user.id,
                planType,
                isPlanChange: 'true',
                source: 'portal-fallback',
              },
              subscription_data: {
                metadata: { userId: user.id, planType },
              },
            });
            console.log('[Stripe] Created fallback checkout session for blocked user:', req.userId);
            return res.json({ url: checkout.url, mode: 'checkout' });
          } catch (checkoutErr: any) {
            console.error('[Stripe] Fallback checkout creation failed:', checkoutErr);
          }
        }

        // Última red de seguridad: mandamos al usuario a la página de
        // pricing para que elija un plan manualmente. La UI ya sabe
        // manejar este caso.
        return res.json({ url: `${getBaseUrl()}/pricing?recover=1`, mode: 'pricing' });
      }
    } catch (error: any) {
      console.error('[Stripe] Portal error for blocked user:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error creating portal session' });
    }
  });

  // Historial de pagos del usuario a Aikestar (Task #248).
  app.get('/api/stripe/payment-history', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);

      // Sólo el dueño de la suscripción ve su propio historial: requiere
      // stripeCustomerId Y stripeSubscriptionId propios (los miembros
      // invitados a un equipo heredan el plan del dueño y no tienen su
      // propia suscripción en Stripe).
      if (!user?.stripeCustomerId || !user?.stripeSubscriptionId) {
        return res.json({ payments: [], total: 0, hasMore: false });
      }

      const stripe = await getUncachableStripeClient();

      // `charge` y `payment_intent` siguen viniendo en la respuesta pero
      // en Stripe SDK v20 quedaron fuera del tipo `Invoice`, así que los
      // exponemos vía una intersección local con los campos que usamos.
      type ExpandedInvoice = Stripe.Invoice & {
        charge?: Stripe.Charge | string | null;
        payment_intent?: Stripe.PaymentIntent | string | null;
      };

      // Paginación: traemos un bloque de 24 facturas por request. El cliente
      // puede pedir el siguiente bloque pasando `starting_after` con el id
      // de la última factura recibida.
      const startingAfterParam =
        typeof req.query.starting_after === 'string' && req.query.starting_after.length > 0
          ? req.query.starting_after
          : undefined;

      const batch: Stripe.ApiList<Stripe.Invoice> = await stripe.invoices.list({
        customer: user.stripeCustomerId,
        limit: 24,
        expand: ['data.charge', 'data.payment_intent.payment_method'],
        ...(startingAfterParam ? { starting_after: startingAfterParam } : {}),
      });

      const allInvoices: ExpandedInvoice[] = batch.data as ExpandedInvoice[];
      const hasMore = Boolean(batch.has_more);

      const payments = allInvoices.map((inv) => {
        const charge =
          inv.charge && typeof inv.charge === 'object' ? inv.charge : null;
        const pi =
          inv.payment_intent && typeof inv.payment_intent === 'object'
            ? inv.payment_intent
            : null;
        const piPaymentMethod =
          pi?.payment_method && typeof pi.payment_method === 'object'
            ? (pi.payment_method as Stripe.PaymentMethod)
            : null;
        const card = charge?.payment_method_details?.card || piPaymentMethod?.card || null;

        const firstLine = inv.lines?.data?.[0] as
          | (Stripe.InvoiceLineItem & { price?: Stripe.Price | null })
          | undefined;
        const description =
          firstLine?.description ||
          firstLine?.price?.nickname ||
          inv.description ||
          null;

        // Monto a mostrar: si está pagada usamos lo cobrado; si no, el
        // total/adeudado para no mostrar $0 en facturas pendientes o
        // fallidas.
        const amount =
          inv.status === 'paid'
            ? (inv.amount_paid ?? inv.total ?? 0)
            : (inv.amount_due ?? inv.total ?? 0);

        return {
          id: inv.id,
          number: inv.number || null,
          created: inv.created,
          amount,
          currency: (inv.currency || 'ars').toUpperCase(),
          status: inv.status,
          description,
          card: card ? { brand: card.brand || null, last4: card.last4 || null } : null,
          invoicePdf: inv.invoice_pdf || null,
          hostedInvoiceUrl: inv.hosted_invoice_url || null,
        };
      });

      res.json({ payments, total: payments.length, hasMore });
    } catch (error: any) {
      console.error('[Stripe] payment-history error:', error);
      res.status(500).json({ message: sanitizeError(error) || 'Error fetching payment history' });
    }
  });

  app.get('/api/stripe/subscription', requireAuth, async (req: any, res) => {
    try {

      const user = await storage.getUser(req.userId);
      if (!user?.stripeSubscriptionId) {
        return res.json({ subscription: null });
      }

      const result = await db.execute(sql`
        SELECT * FROM stripe.subscriptions WHERE id = ${user.stripeSubscriptionId}
      `);

      res.json({ subscription: result.rows[0] || null });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Recovery endpoint for users who paid but webhook failed
  // This is a public endpoint that allows users to recover their account
  app.post('/api/stripe/recover-account', async (req, res) => {
    const { email } = req.body;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    try {
      // Check if user already exists
      // Task #343 — ignorar usuarios soft-deleted: si la cuenta vieja fue
      // borrada el usuario debe poder recuperar via re-registro, no via
      // "ya existe, hacé login".
      const existingUser = await storage.getUserByActiveEmail(normalizedEmail);
      if (existingUser) {
        return res.json({ 
          success: true, 
          message: 'Account already exists. You can login with your credentials.',
          accountExists: true 
        });
      }
      
      // Search for completed checkout sessions in Stripe
      const stripe = await getUncachableStripeClient();
      
      // Find customers with this email
      const customers = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
      
      if (customers.data.length === 0) {
        return res.status(404).json({ 
          error: 'No payment found for this email. Please complete the registration process.' 
        });
      }
      
      // Check each customer for active subscriptions
      let foundSubscription = null;
      let foundCustomer = null;
      
      for (const customer of customers.data) {
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'all',
          limit: 10,
        });
        
        // Find active or trialing subscription
        const activeSub = subscriptions.data.find(
          s => s.status === 'active' || s.status === 'trialing'
        );
        
        if (activeSub) {
          foundSubscription = activeSub;
          foundCustomer = customer;
          break;
        }
      }
      
      if (!foundSubscription || !foundCustomer) {
        return res.status(404).json({ 
          error: 'No active subscription found for this email. Please complete a new subscription.' 
        });
      }
      
      // Get product info to determine plan type
      if (!foundSubscription.items.data.length) {
        return res.status(500).json({ 
          error: 'Subscription data is incomplete. Please contact support.' 
        });
      }
      
      const product = await stripe.products.retrieve(
        foundSubscription.items.data[0].price.product as string
      );
      const rawPlanType = product.metadata?.planType;
      const planType: PlanType = rawPlanType && PLAN_TYPES.includes(rawPlanType as PlanType)
        ? (rawPlanType as PlanType)
        : 'personal';
      
      // Create user with temp password
      const bcrypt = await import('bcryptjs');
      const tempPassword = await bcrypt.hash(Math.random().toString(36).substring(2), 10);
      
      const isBusinessPlan = ['solo', 'team', 'business', 'enterprise'].includes(planType);
      const accountType = isBusinessPlan ? 'business' : 'personal';
      const userName = foundCustomer.name || normalizedEmail.split('@')[0];
      
      const user = await storage.createUser({
        email: normalizedEmail,
        name: userName,
        password: tempPassword,
        accountType: accountType,
        stripeCustomerId: foundCustomer.id,
        stripeSubscriptionId: foundSubscription.id,
        mustChangePassword: true,
      });
      
      // Create organization
      const orgName = accountType === 'personal'
        ? `Finanzas de ${user.name}`
        : `${user.name}'s Organization`;
      
      const organization = await storage.createOrganization({
        name: orgName,
        type: accountType,
        country: 'AR',
        defaultCurrency: 'ARS',
      });
      
      await storage.createMembership({
        userId: user.id,
        organizationId: organization.id,
        role: 'owner',
      });
      
      await storage.seedDefaultCategories(organization.id, user.id);
      await storage.seedDefaultAccount(organization.id, 'ARS');
      
      // Create subscription record
      await storage.createSubscription({
        userId: user.id,
        planType: planType,
        status: foundSubscription.status === 'trialing' ? 'trialing' : 'active',
        stripeSubscriptionId: foundSubscription.id,
      });
      
      // Send welcome email with password reset instructions
      sendWelcomeEmail(user.email, user.name).catch(() => {});
      
      return res.json({
        success: true,
        message: 'Account recovered successfully. Please use "Forgot Password" to set your password and login.',
        accountExists: false,
        recovered: true,
      });
      
    } catch (error: any) {
      return res.status(500).json({ 
        error: 'Failed to recover account. Please contact support.' 
      });
    }
  });
}
