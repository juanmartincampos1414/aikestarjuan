import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { PLAN_TYPES, PLAN_DETAILS, PLAN_LABELS, type PlanType, COUNTRIES, COUNTRY_CURRENCY_MAP } from "@shared/schema";
import { normalizePhoneInput, formatArgentineMobilePretty, maskPhoneForDisplay } from "@shared/phone";
import bcrypt from "bcryptjs";
import { sendWelcomeEmail, sendPasswordChangeEmail, sendPasswordResetEmail, sendPhoneLinkedConfirmationEmail } from "../services/email";
import { requireAuth, requireAuthOnly, sanitizeError } from "./middleware";
import { getUncachableStripeClient } from "../stripeClient";
import { isMercadoPagoEnabled, createSubscription as createMpSubscription } from "../lib/mercadopago";

import rateLimit from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Demasiados intentos. Esperá 15 minutos antes de intentar de nuevo.' },
  // We run behind Replit's autoscale proxy chain, so app.set('trust proxy', true)
  // is enabled in server/index.ts. express-rate-limit v8 considers this
  // "permissive" and throws ERR_ERL_PERMISSIVE_TRUST_PROXY inside its default
  // keyGenerator, which causes the limiter to incorrectly count every request
  // as a hit and immediately return 429. We disable that validation because we
  // intentionally trust Replit's proxy and Express's req.ip is correct.
  validate: { trustProxy: false, xForwardedForHeader: false },
});

export function registerAuthRoutes(app: Express): void {
  // New registration flow: creates a pending signup and redirects to Stripe checkout
  // The actual user/org/membership is created only after successful payment
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      const { name, password, organizationName, accountType, country, profileIconKey, priceId, phoneNumber, acceptTerms } = req.body;
      const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : req.body.email;
      
      if (!email || !name || !password) {
        return res.status(400).json({ message: 'Email, nombre y contraseña son requeridos' });
      }
      
      if (acceptTerms !== true) {
        return res.status(400).json({ message: 'Debes aceptar los Términos y Condiciones para registrarte' });
      }

      // ── Flujo MercadoPago (suscripción recurrente) ──────────────────────────
      // Si MercadoPago está configurado, es la pasarela activa: creamos un
      // pending_signup y una suscripción (preapproval) de MP, y devolvemos el
      // init_point al que el cliente redirige. El alta se completa por webhook.
      if (isMercadoPagoEnabled()) {
        const planType = req.body.planType as PlanType | undefined;
        if (!planType || !PLAN_TYPES.includes(planType)) {
          return res.status(400).json({ message: 'Debes seleccionar un plan válido' });
        }

        const type = accountType === 'personal' ? 'personal' : 'business';
        const personalPlans: PlanType[] = ['personal', 'personal_pro'];
        const businessPlans: PlanType[] = ['solo', 'team', 'business', 'enterprise'];
        if (type === 'personal' && !personalPlans.includes(planType)) {
          return res.status(400).json({ message: 'Este plan no está disponible para cuentas personales' });
        }
        if (type === 'business' && !businessPlans.includes(planType)) {
          return res.status(400).json({ message: 'Este plan no está disponible para cuentas de empresa' });
        }

        const existing = await storage.getUserByEmail(email);
        if (existing && !existing.deletedAt) {
          return res.status(400).json({ message: 'Ya existe una cuenta con este email' });
        }
        const existingPending = await storage.getPendingSignupByEmail(email);
        if (existingPending) {
          await storage.deletePendingSignup(existingPending.id);
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const validCountry = COUNTRIES.includes(country) ? country : 'AR';

        const pendingSignup = await storage.createPendingSignup({
          email,
          name,
          hashedPassword,
          accountType: type,
          organizationName: organizationName || null,
          country: validCountry,
          profileIconKey: profileIconKey || null,
          phoneNumber: phoneNumber || null,
          planType,
          priceId: `mp:${planType}`,
          status: 'pending',
          termsAcceptedAt: new Date(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        try {
          const sub = await createMpSubscription({
            planType,
            amount: PLAN_DETAILS[planType].price,
            payerEmail: email,
            externalReference: pendingSignup.id,
            reason: `Aikestar - Plan ${PLAN_LABELS[planType]}`,
            freeTrialDays: 30,
          });
          await storage.updatePendingSignup(pendingSignup.id, { stripeSessionId: sub.id });
          return res.json({ checkoutUrl: sub.initPoint, pendingSignupId: pendingSignup.id });
        } catch (mpErr: any) {
          console.error('[Register/MP] Error creando suscripción:', mpErr?.message || mpErr);
          await storage.deletePendingSignup(pendingSignup.id).catch(() => {});
          return res.status(502).json({ message: 'No se pudo iniciar el pago con MercadoPago. Intentá de nuevo.' });
        }
      }

      if (!priceId) {
        return res.status(400).json({ message: 'Debes seleccionar un plan' });
      }
      
      // Check if email already exists as a user
      // Task #343 — tratamos a un usuario soft-deleted como "no existe" para
      // permitir re-registrarse con el mismo email después de cancelar.
      // El record viejo queda intacto con deleted_at != null para auditoría;
      // el índice único parcial (WHERE deleted_at IS NULL) permite el insert
      // del nuevo usuario sin chocar con el constraint.
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser && !existingUser.deletedAt) {
        return res.status(400).json({ message: 'Ya existe una cuenta con este email' });
      }
      
      // Check if there's already a pending signup for this email
      const existingPending = await storage.getPendingSignupByEmail(email);
      if (existingPending) {
        // Delete old pending signup to allow a new one
        await storage.deletePendingSignup(existingPending.id);
      }
      
      const hashedPassword = await bcrypt.hash(password, 10);
      const type = accountType === 'personal' ? 'personal' : 'business';
      const validCountry = COUNTRIES.includes(country) ? country : 'AR';
      
      // Validate priceId against Stripe and verify plan compatibility
      const stripe = await getUncachableStripeClient();
      let price;
      try {
        price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
      } catch {
        return res.status(400).json({ message: 'Precio no válido' });
      }
      
      // Verify price is active
      if (!price.active) {
        return res.status(400).json({ message: 'Este precio ya no está disponible' });
      }
      
      const product = price.product as any;
      const planType = product?.metadata?.planType as PlanType;
      
      if (!planType || !PLAN_TYPES.includes(planType)) {
        return res.status(400).json({ message: 'Precio no válido' });
      }
      
      // Enforce account-type-to-plan compatibility
      // Personal plans: personal, personal_pro
      // Business plans: solo, team, business, enterprise
      const personalPlans: PlanType[] = ['personal', 'personal_pro'];
      const businessPlans: PlanType[] = ['solo', 'team', 'business', 'enterprise'];
      
      if (type === 'personal' && !personalPlans.includes(planType)) {
        return res.status(400).json({ message: 'Este plan no está disponible para cuentas personales' });
      }
      
      if (type === 'business' && !businessPlans.includes(planType)) {
        return res.status(400).json({ message: 'Este plan no está disponible para cuentas de empresa' });
      }
      
      // Create pending signup (expires in 1 hour)
      const pendingSignup = await storage.createPendingSignup({
        email,
        name,
        hashedPassword,
        accountType: type,
        organizationName: organizationName || null,
        country: validCountry,
        profileIconKey: profileIconKey || null,
        phoneNumber: phoneNumber || null,
        planType,
        priceId,
        status: 'pending',
        termsAcceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      
      // Create Stripe customer and checkout session
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: { pendingSignupId: pendingSignup.id },
      });
      
      const baseUrl = process.env.NODE_ENV === 'development'
        ? `https://${process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(',')[0]}`
        : 'https://app.aikestar.com';
      
      const session = await stripe.checkout.sessions.create({
        customer: customer.id,
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'subscription',
        success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/register?cancelled=true`,
        metadata: {
          pendingSignupId: pendingSignup.id,
          planType: planType,
        },
        subscription_data: {
          trial_period_days: 30,
          metadata: {
            pendingSignupId: pendingSignup.id,
            planType: planType,
          }
        }
      });
      
      await storage.updatePendingSignup(pendingSignup.id, {
        stripeSessionId: session.id,
      });
      
      res.json({
        checkoutUrl: session.url,
        pendingSignupId: pendingSignup.id,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) || 'Error en el registro' });
    }
  });
  
  // Validate Stripe session and establish user session after successful payment
  // This handles both new signups (pendingSignupId) and plan changes (isPlanChange)
  app.post('/api/auth/validate-checkout', async (req, res) => {
    try {
      const { sessionId } = req.body;
      
      if (!sessionId) {
        return res.status(400).json({ message: 'Session ID requerido' });
      }
      
      const stripe = await getUncachableStripeClient();
      
      // Verify the session with Stripe
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      // Accept both 'paid' (normal) and 'no_payment_required' (free trial)
      if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
        return res.status(400).json({ message: 'El pago no fue completado' });
      }
      
      const pendingSignupId = session.metadata?.pendingSignupId;
      const isPlanChange = session.metadata?.isPlanChange === 'true';
      const planChangeUserId = session.metadata?.userId;
      
      // Handle plan change for existing users
      if (isPlanChange && planChangeUserId) {
        const user = await storage.getUser(planChangeUserId);
        
        if (!user) {
          return res.status(400).json({ message: 'Usuario no encontrado' });
        }
        
        // Get user's organization
        const orgs = await storage.getOrganizationsByUser(user.id);
        const organization = orgs[0];
        
        // Establish session for existing user
        req.session.userId = user.id;
        req.session.organizationId = organization?.id;
        
        return req.session.save((saveErr) => {
          if (saveErr) {
            return res.status(500).json({ message: 'Error al guardar la sesión' });
          }
          
          res.json({
            success: true,
            isPlanChange: true,
            user: { id: user.id, email: user.email, name: user.name, accountType: user.accountType },
            organization,
          });
        });
      }
      
      if (!pendingSignupId) {
        return res.status(400).json({ message: 'Sesión de checkout inválida' });
      }
      
      // Get the pending signup to find the email
      const pendingSignup = await storage.getPendingSignup(pendingSignupId);
      
      if (!pendingSignup) {
        return res.status(400).json({ message: 'Registro pendiente no encontrado' });
      }
      
      // The webhook should have created the user by now
      // Wait a bit and retry if user doesn't exist yet (webhook might be processing)
      // Task #343 — usar getUserByActiveEmail: el pendingSignup es para
      // crear un user nuevo; si hay uno soft-deleted con el mismo email
      // debemos ignorarlo y dejar que se cree el nuevo más abajo.
      let user = await storage.getUserByActiveEmail(pendingSignup.email);
      
      if (!user) {
        // Wait up to 3 seconds for webhook to process
        for (let i = 0; i < 3; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          user = await storage.getUserByActiveEmail(pendingSignup.email);
          if (user) break;
        }
      }
      
      if (!user) {
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;
        const planType = session.metadata?.planType || pendingSignup.planType || 'personal';
        
        // Create user with the password from pending signup
        const isBusinessPlan = planType && ['solo', 'team', 'business', 'enterprise'].includes(planType);
        const accountType = isBusinessPlan ? 'business' : 'personal';
        
        // Task #221: phone number from the signup form is informational only
        // until the user verifies it through the Settings → WhatsApp wizard
        // (Tasks #212/#217). We store it on pending_phone_number so the wizard
        // can pre-fill the input, but never on phone_number.
        user = await storage.createUser({
          email: pendingSignup.email,
          name: pendingSignup.name,
          password: pendingSignup.hashedPassword, // Already hashed
          accountType: accountType,
          profileIconKey: pendingSignup.profileIconKey,
          pendingPhoneNumber: pendingSignup.phoneNumber || undefined,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          termsAcceptedAt: pendingSignup.termsAcceptedAt || new Date(),
        });
        
        const orgName = accountType === 'personal'
          ? `Finanzas de ${user.name}`
          : `${user.name}'s Organization`;
        
        const validCountry = (COUNTRIES.includes(pendingSignup.country as any) ? pendingSignup.country : 'AR') as 'AR' | 'CO' | 'MX' | 'CL' | 'PE' | 'UY' | 'BR' | 'US' | 'ES';
        const organization = await storage.createOrganization({
          name: orgName,
          type: accountType,
          country: validCountry,
          defaultCurrency: COUNTRY_CURRENCY_MAP[validCountry] || 'ARS',
        });
        
        await storage.createMembership({
          userId: user.id,
          organizationId: organization.id,
          role: 'owner',
        });
        
        await storage.seedDefaultCategories(organization.id, user.id);
        await storage.seedDefaultAccount(organization.id, COUNTRY_CURRENCY_MAP[validCountry] || 'ARS');
        
        // Create subscription record
        if (planType) {
          // Get real subscription status from Stripe
          let subStatus: 'active' | 'trialing' = 'active';
          try {
            const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
            if (stripeSub.status === 'trialing') {
              subStatus = 'trialing';
            }
          } catch (e) {
            console.log('[ValidateCheckout] Could not retrieve subscription status, defaulting to active');
          }
          
          await storage.createSubscription({
            userId: user.id,
            planType: planType as 'personal' | 'personal_pro' | 'solo' | 'team' | 'business' | 'enterprise',
            status: subStatus,
            stripeSubscriptionId: subscriptionId,
          });
        }
        
        await storage.updatePendingSignup(pendingSignupId, { status: 'completed' });
        
        sendWelcomeEmail(user.email, user.name).catch(() => {});
      }
      
      // Get user's organization
      const orgs = await storage.getOrganizationsByUser(user.id);
      const organization = orgs[0];
      
      // Establish session
      req.session.userId = user.id;
      req.session.organizationId = organization?.id;
      
      // Explicitly save session to ensure cookie is set before responding
      // This is critical for mobile browsers where cookies may not persist otherwise
      req.session.save((saveErr) => {
        if (saveErr) {
          return res.status(500).json({ message: 'Error al guardar la sesión' });
        }
        
        res.json({
          success: true,
          user: { id: user.id, email: user.email, name: user.name, accountType: user.accountType },
          organization,
        });
      });
    } catch (error: any) {
      console.error('[ValidateCheckout] Error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Recover session endpoint for mobile browsers where cookies fail
  // Uses a one-time recovery token (NOT the session ID) for security
  app.post('/api/auth/recover-session', async (req, res) => {
    try {
      const { recoveryToken } = req.body;
      
      if (!recoveryToken) {
        return res.status(400).json({ message: 'Recovery token requerido' });
      }
      
      console.log('[RecoverSession] Attempting to recover session with token:', recoveryToken.substring(0, 8) + '...');
      console.log('[RecoverSession] Current session ID:', (req as any).sessionID);
      console.log('[RecoverSession] Incoming cookie header:', req.headers.cookie || 'NONE');
      
      // Look up sessions that have this recovery token
      const pool = await import('../db').then(m => m.pool);
      const result = await pool.query(
        `SELECT sid, sess FROM session 
         WHERE expire > NOW() 
         AND sess->>'recoveryToken' = $1`,
        [recoveryToken]
      );
      
      if (result.rows.length === 0) {
        console.log('[RecoverSession] No session found with this recovery token');
        return res.status(401).json({ message: 'Token de recuperación inválido' });
      }
      
      const sessionRow = result.rows[0];
      const storedSession = sessionRow.sess;
      const originalSessionId = sessionRow.sid;
      
      // Verify token hasn't expired
      const tokenExpires = storedSession?.recoveryTokenExpires;
      if (tokenExpires && Date.now() > tokenExpires) {
        console.log('[RecoverSession] Recovery token has expired');
        return res.status(401).json({ message: 'Token de recuperación expirado' });
      }
      
      if (!storedSession?.userId) {
        console.log('[RecoverSession] Session has no userId');
        return res.status(401).json({ message: 'Sesión inválida' });
      }
      
      const userId = storedSession.userId;
      const organizationId = storedSession.organizationId;

      const recoveredUser = await storage.getUser(userId);
      if (recoveredUser?.deletedAt) {
        return res.status(403).json({
          message: 'Tu cuenta fue eliminada por inactividad. Contactanos a ai@aikestar.com si querés reactivarla.',
          code: 'ACCOUNT_DELETED',
        });
      }
      
      console.log('[RecoverSession] Found valid session for user:', userId);
      
      // IMPORTANT: Invalidate the recovery token (one-time use)
      // Update the original session to remove the recovery token
      const updatedSession = { ...storedSession };
      delete updatedSession.recoveryToken;
      delete updatedSession.recoveryTokenExpires;
      
      await pool.query(
        'UPDATE session SET sess = $1 WHERE sid = $2',
        [JSON.stringify(updatedSession), originalSessionId]
      );
      console.log('[RecoverSession] Recovery token invalidated (one-time use)');
      
      // Get the user to return in response
      const user = await storage.getUser(userId);
      if (!user) {
        console.log('[RecoverSession] User not found');
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      // Get the organization
      const organization = await storage.getOrganization(organizationId);
      
      // Clear old cookies first (same logic as login).
      // Only clear with Domain=.app.aikestar.com in REAL production deployments — in dev
      // the browser is on *.picard.replit.dev and a domain-scoped clear is a no-op
      // that adds noise to the response (and previously confused the browser).
      const isProductionDeployment = process.env.NODE_ENV === 'production' && !!process.env.APP_DOMAIN;
      const appDomain = isProductionDeployment ? process.env.APP_DOMAIN : undefined;
      const cookieNames = ['aikestarsid', 'connect.sid'];
      for (const cookieName of cookieNames) {
        res.clearCookie(cookieName, { path: '/' });
        res.clearCookie(cookieName, { path: '/', secure: true, sameSite: 'lax' as const });
        res.clearCookie(cookieName, { path: '/', secure: false, sameSite: 'lax' as const });
        if (appDomain) {
          res.clearCookie(cookieName, { path: '/', domain: appDomain });
          res.clearCookie(cookieName, { path: '/', domain: appDomain, secure: true, sameSite: 'lax' as const });
        }
      }
      
      // Set session data using the recovered session info
      (req as any).session.userId = userId;
      (req as any).session.organizationId = organizationId;
      
      await new Promise<void>((resolve, reject) => {
        (req as any).session.save((err: any) => {
          if (err) {
            console.error('[RecoverSession] Session save error:', err);
            reject(err);
          } else {
            console.log('[RecoverSession] Session recovered and saved, new ID:', (req as any).sessionID);
            resolve();
          }
        });
      });
      
      console.log('[RecoverSession] Response Set-Cookie headers:', res.getHeaders()['set-cookie'] || 'NONE');
      
      res.json({
        success: true,
        user: { id: user.id, email: user.email, name: user.name, accountType: user.accountType },
        organization,
      });
    } catch (error: any) {
      console.error('[RecoverSession] Error:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
      const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : req.body.email;
      
      if (!email) {
        return res.status(400).json({ message: 'Email es requerido' });
      }
      
      // Task #343 — no enviar reset emails a cuentas soft-deleted.
      const user = await storage.getUserByActiveEmail(email);
      if (!user) {
        return res.json({ message: 'Si el email existe, recibirás instrucciones para restablecer tu contraseña' });
      }
      
      const token = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      
      await storage.createPasswordReset({
        userId: user.id,
        token: await bcrypt.hash(token, 10),
        expiresAt,
      });
      
      sendPasswordResetEmail(user.email, user.name, token).catch(() => {});
      
      res.json({ message: 'Si el email existe, recibirás instrucciones para restablecer tu contraseña' });
    } catch (error: any) {
      console.error('[ForgotPassword] Exception:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.get('/api/auth/reset-redirect', async (req, res) => {
    const { email, token } = req.query;
    
    if (!email || !token) {
      return res.status(400).send('Link inválido');
    }
    
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Restablecer Contraseña - Aikestar</title>
  <style>
    body { background: #0f172a; color: white; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .loader { text-align: center; }
    .spinner { width: 40px; height: 40px; border: 3px solid rgba(0,212,255,0.3); border-top-color: #00d4ff; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <p>Preparando el formulario...</p>
  </div>
  <script>
    (function() {
      var resetData = {
        email: ${JSON.stringify(email)},
        token: ${JSON.stringify(token)},
        ts: Date.now()
      };
      sessionStorage.setItem('passwordResetData', JSON.stringify(resetData));
      localStorage.setItem('passwordResetData', JSON.stringify({ ...resetData, timestamp: Date.now() }));
      console.log('[ResetRedirect] Stored reset data, redirecting...');
      window.location.href = '/reset-password';
    })();
  </script>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(html);
  });
  
  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, newPassword } = req.body;
      const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : req.body.email;
      
      if (!email || !token || !newPassword) {
        return res.status(400).json({ message: 'Email, token y nueva contraseña son requeridos' });
      }
      
      if (newPassword.length < 5) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 5 caracteres' });
      }
      
      // Task #343 — no permitir reset de contraseña en cuentas soft-deleted.
      const user = await storage.getUserByActiveEmail(email);
      if (!user) {
        return res.status(400).json({ message: 'Token inválido o expirado' });
      }
      
      const resetTokens = await storage.getPasswordResets(user.id);
      
      let foundValidReset: typeof resetTokens[0] | null = null;
      for (const reset of resetTokens) {
        if (reset.used) continue;
        if (new Date(reset.expiresAt) < new Date()) continue;
        
        const matches = await bcrypt.compare(token, reset.token);
        if (matches) {
          foundValidReset = reset;
          break;
        }
      }
      
      if (!foundValidReset) {
        return res.status(400).json({ message: 'Token inválido o expirado' });
      }
      
      await storage.markPasswordResetUsed(foundValidReset.id);
      
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { password: hashedPassword });
      
      res.json({ message: 'Contraseña actualizada exitosamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Check for access denied events (shown before login if member was removed or org deleted)
  app.get('/api/auth/access-denied-check', async (req, res) => {
    try {
      const { email } = req.query;
      
      if (!email || typeof email !== 'string') {
        return res.json({ hasEvent: false });
      }
      
      const event = await storage.getAccessDeniedEventByEmail(email);
      if (event) {
        return res.json({
          hasEvent: true,
          event: {
            id: event.id,
            reason: event.reason,
            organizationName: event.organizationName,
            removedByUserName: event.removedByUserName,
            createdAt: event.createdAt,
          }
        });
      }
      
      res.json({ hasEvent: false });
    } catch (error: any) {
      res.json({ hasEvent: false });
    }
  });
  
  // Acknowledge access denied event (after user has seen the message)
  app.post('/api/auth/access-denied-acknowledge', async (req, res) => {
    try {
      const { eventId } = req.body;
      
      if (!eventId) {
        return res.status(400).json({ message: 'Event ID es requerido' });
      }
      
      await storage.acknowledgeAccessDeniedEvent(eventId);
      res.json({ message: 'Evento reconocido' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { password } = req.body;
      const email = typeof req.body.email === 'string' ? req.body.email.toLowerCase().trim() : '';
      
      if (!email || !password) {
        return res.status(400).json({ message: 'Email y contraseña son requeridos' });
      }
      
      const accessDeniedEvent = await storage.getAccessDeniedEventByEmail(email);
      
      let user = await storage.getUserByEmail(email);
      let organization;

      if (user?.deletedAt) {
        return res.status(403).json({
          message: 'Tu cuenta fue eliminada por inactividad. Contactanos a ai@aikestar.com si querés reactivarla.',
          code: 'ACCOUNT_DELETED',
        });
      }
      
      if (!user) {
        // For new users, still check access denied event before allowing invitation login
        if (accessDeniedEvent) {
          return res.status(403).json({
            message: 'Tu acceso ha cambiado',
            code: accessDeniedEvent.reason === 'org_owner_deleted' ? 'ORG_OWNER_DELETED' : 'MEMBER_REMOVED',
            eventId: accessDeniedEvent.id,
            organizationName: accessDeniedEvent.organizationName,
            removedByUserName: accessDeniedEvent.removedByUserName,
          });
        }
        
        const invitation = await storage.getTeamInvitationByEmail(email);
        
        if (!invitation || !invitation.temporaryPassword) {
          return res.status(401).json({ message: 'Email o contraseña incorrectos' });
        }
        
        const validTempPassword = await bcrypt.compare(password, invitation.temporaryPassword);
        if (!validTempPassword) {
          return res.status(401).json({ message: 'Email o contraseña incorrectos' });
        }
        
        const namePart = email.split('@')[0];
        user = await storage.createUser({
          email,
          name: namePart,
          password: invitation.temporaryPassword,
          accountType: 'business',
          mustChangePassword: true,
        });
        
        await storage.createMembership({
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role as 'owner' | 'admin' | 'specialist' | 'operator' | 'viewer',
        });
        
        await storage.updateTeamInvitation(invitation.id, {
          status: 'accepted',
          acceptedAt: new Date(),
        } as any);
        
        organization = await storage.getOrganization(invitation.organizationId);
      } else {
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
          return res.status(401).json({ message: 'Email o contraseña incorrectos' });
        }
        
        const organizations = await storage.getOrganizationsByUser(user.id);
        
        // If user has other organizations, acknowledge the access denied event and let them in
        if (organizations.length > 0) {
          if (accessDeniedEvent) {
            // Acknowledge the event since user has other orgs to access
            await storage.acknowledgeAccessDeniedEvent(accessDeniedEvent.id);
            console.log(`[Login] Acknowledged access denied event for ${email} - user has ${organizations.length} other org(s)`);
          }
          organization = organizations[0];
        } else {
          // No organizations available - check if there's an access denied event to show
          if (accessDeniedEvent) {
            return res.status(403).json({
              message: 'Tu acceso ha cambiado',
              code: accessDeniedEvent.reason === 'org_owner_deleted' ? 'ORG_OWNER_DELETED' : 'MEMBER_REMOVED',
              eventId: accessDeniedEvent.id,
              organizationName: accessDeniedEvent.organizationName,
              removedByUserName: accessDeniedEvent.removedByUserName,
            });
          }
          return res.status(400).json({ message: 'No organization found' });
        }
        
        // Auto-promote platform owner to admin
        const PLATFORM_OWNER_EMAIL = 'eparedes@ssitechnologiesgroup.com';
        if (user.email === PLATFORM_OWNER_EMAIL && !user.isAdmin) {
          try {
            await storage.updateUser(user.id, { isAdmin: true });
            console.log('[Login] Auto-promoted platform owner to admin:', user.email);
          } catch (err) {
            console.error('[Login] Error auto-promoting to admin:', err);
          }
        }
        
        // Reconciliation: Link Stripe subscription if missing
        // (se omite para usuarios de MercadoPago: no tienen datos en Stripe)
        if (!user.stripeSubscriptionId && !user.mpSubscriptionId && user.email) {
          try {
            const stripe = await getUncachableStripeClient();
            const customers = await stripe.customers.list({ email: user.email, limit: 1 });
            if (customers.data.length > 0) {
              const customer = customers.data[0];
              const subscriptions = await stripe.subscriptions.list({ 
                customer: customer.id, 
                status: 'active',
                limit: 1 
              });
              
              if (subscriptions.data.length > 0) {
                const sub = subscriptions.data[0];
                const priceId = sub.items.data[0]?.price?.id;
                
                // Update user with Stripe IDs
                await storage.updateUser(user.id, { 
                  stripeCustomerId: customer.id,
                  stripeSubscriptionId: sub.id,
                });
                
                // Derive planType from Stripe metadata
                let planType = sub.metadata?.planType as string;
                if (!planType && sub.items?.data?.[0]?.price?.product) {
                  try {
                    const productId = typeof sub.items.data[0].price.product === 'string'
                      ? sub.items.data[0].price.product
                      : (sub.items.data[0].price.product as any).id;
                    const product = await stripe.products.retrieve(productId);
                    planType = product.metadata?.planType || (user.accountType === 'business' ? 'solo' : 'personal');
                  } catch {
                    planType = user.accountType === 'business' ? 'solo' : 'personal';
                  }
                }
                if (!planType) planType = user.accountType === 'business' ? 'solo' : 'personal';
                
                // Update or create subscription record
                const localSub = await storage.getSubscriptionByUserId(user.id);
                if (localSub) {
                  await storage.updateSubscription(localSub.id, {
                    stripeSubscriptionId: sub.id,
                    stripePriceId: priceId,
                  });
                } else {
                  await storage.createSubscription({
                    userId: user.id,
                    planType: planType as any,
                    status: 'active',
                    stripeCustomerId: customer.id,
                    stripeSubscriptionId: sub.id,
                    stripePriceId: priceId,
                  });
                }
                
              }
            }
          } catch {
          }
        }
      }
      
      if (!organization) {
        return res.status(400).json({ message: 'No organization found' });
      }
      
      const userId = user.id;
      const orgId = organization.id;
      const userData = {
        id: user.id, 
        email: user.email, 
        name: user.name, 
        accountType: user.accountType,
        mustChangePassword: user.mustChangePassword || false,
      };
      
      console.log('[Login] Starting session creation for user:', userId);
      console.log('[Login] Old session ID:', req.sessionID);
      console.log('[Login] Incoming cookie header:', req.headers.cookie || 'NONE');
      
      // IMPORTANT: Must match the detection in server/index.ts:setupSessionMiddleware.
      // Previously used `STRIPE_LIVE_SECRET_KEY` as a signal which incorrectly flagged
      // the dev workspace as "production" (we keep live Stripe keys in dev for testing),
      // causing this endpoint to emit Set-Cookie headers with Domain=.app.aikestar.com while
      // the browser was on *.picard.replit.dev — those cookies were rejected and the
      // user got bounced back to /login after a successful login.
      const isProductionDeployment = process.env.NODE_ENV === 'production' && !!process.env.APP_DOMAIN;
      const appDomain = isProductionDeployment ? process.env.APP_DOMAIN : undefined;

      console.log('[Login] Cookie config:', { isProductionDeployment, appDomain });
      
      try {
        // Clear all possible variations of old cookies before regenerating
        // This ensures the browser doesn't keep using an old session ID
        // Cookie name is 'aikestarsid' now, but also clear old 'connect.sid' cookies
        const cookieNames = ['aikestarsid', 'connect.sid'];
        for (const cookieName of cookieNames) {
          // Clear with all possible configurations that might have been used
          res.clearCookie(cookieName, { path: '/' });
          res.clearCookie(cookieName, { path: '/', secure: true, sameSite: 'lax' as const });
          res.clearCookie(cookieName, { path: '/', secure: false, sameSite: 'lax' as const });
          res.clearCookie(cookieName, { path: '/', secure: true, sameSite: 'none' as const });
          res.clearCookie(cookieName, { path: '/', secure: false, sameSite: 'strict' as const });
          // Also clear with domain if it was set previously
          if (appDomain) {
            res.clearCookie(cookieName, { path: '/', domain: appDomain });
            res.clearCookie(cookieName, { path: '/', domain: appDomain, secure: true, sameSite: 'none' as const });
            res.clearCookie(cookieName, { path: '/', domain: appDomain, secure: true, sameSite: 'lax' as const });
          }
        }
        
        console.log('[Login] Old cookies cleared (all variations)');
        
        // Delete the old session from database directly using sessionStore
        // This ensures any stale session with this ID is removed before regenerate
        const oldSessionId = req.sessionID;
        if (oldSessionId && req.sessionStore) {
          await new Promise<void>((resolve) => {
            (req.sessionStore as any).destroy(oldSessionId, (err: any) => {
              if (err) {
                console.log('[Login] Old session destroy from store (may not exist):', oldSessionId);
              } else {
                console.log('[Login] Old session destroyed from store:', oldSessionId);
              }
              resolve();
            });
          });
        }
        
        // Regenerate session - this creates a completely new session ID
        // Note: regenerate() internally handles session cleanup
        await new Promise<void>((resolve, reject) => {
          req.session.regenerate((err: any) => {
            if (err) {
              console.error('[Login] Session regenerate ERROR:', err);
              reject(err);
            } else {
              console.log('[Login] Session regenerated, new ID:', req.sessionID);
              resolve();
            }
          });
        });
        
        // Set session data
        req.session.userId = userId;
        req.session.organizationId = orgId;
        
        console.log('[Login] Session data set, new cookie settings:', JSON.stringify(req.session?.cookie));
        
        // Generate tokens for authentication fallback
        const crypto = await import('crypto');
        
        // Generate a one-time recovery token (for immediate use after login)
        const recoveryToken = crypto.randomBytes(32).toString('hex');
        req.session.recoveryToken = recoveryToken;
        req.session.recoveryTokenExpires = Date.now() + (5 * 60 * 1000); // 5 minutes
        
        // Generate a persistent auth token (for Bearer authentication fallback)
        // This token is stored in localStorage and sent with every request
        // It's a fallback for when cookies don't work (mobile browsers, cross-origin issues)
        const authToken = crypto.randomBytes(48).toString('hex');
        req.session.authToken = authToken;
        
        // Explicitly save to database
        await new Promise<void>((resolve, reject) => {
          req.session.save((err: any) => {
            if (err) {
              console.error('[Login] Session save ERROR:', err);
              reject(err);
            } else {
              console.log('[Login] Session saved successfully to database, ID:', req.sessionID);
              resolve();
            }
          });
        });
        
        console.log('[Login] Login complete for user:', userId);
        console.log('[Login] Response Set-Cookie headers:', res.getHeaders()['set-cookie'] || 'NONE');
        
        // Log session for admin tracking
        try {
          await storage.createSessionLog({
            userId,
            action: 'login',
            ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
            userAgent: req.headers['user-agent'] || null,
          });
        } catch (logErr) {
          console.error('[Login] Error logging session:', logErr);
        }
        
        res.json({
          user: userData,
          organization,
          recoveryToken, // One-time use token for mobile recovery (NOT the session ID)
          authToken, // Persistent token for Bearer auth fallback when cookies fail
        });
      } catch (sessionError: any) {
        console.error('[Login] Session error:', sessionError);
        return res.status(500).json({ message: 'Error al iniciar sesión' });
      }
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.post('/api/auth/first-login-setup', requireAuth, async (req: any, res) => {
    try {
      const { name, newPassword, profileIconKey } = req.body;
      
      if (!newPassword) {
        return res.status(400).json({ message: 'Nueva contraseña es requerida' });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { 
        password: hashedPassword,
        mustChangePassword: false,
        name: name || user.name,
        profileIconKey: profileIconKey || user.profileIconKey,
      });
      
      res.json({ message: 'Cuenta configurada correctamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.post('/api/auth/change-password', requireAuth, async (req: any, res) => {
    try {
      const { newPassword } = req.body;
      
      if (!newPassword) {
        return res.status(400).json({ message: 'Nueva contraseña es requerida' });
      }
      
      if (newPassword.length < 5) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 5 caracteres' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { 
        password: hashedPassword,
        mustChangePassword: false,
      });
      
      sendPasswordChangeEmail(user.email, user.name).catch(() => {});
      
      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  // Force logout endpoint - clears cookies without requiring valid session
  // This is critical for users who have stale cookies pointing to deleted sessions
  app.post('/api/auth/force-logout', async (req: Request, res: Response) => {
    console.log('[Force Logout] Clearing all auth state');
    
    // Try to destroy session if it exists
    if (req.session) {
      req.session.destroy(() => {});
    }
    
    // Clear the cookie regardless of session state. Only clear with Domain in
    // real production deployments — see note in /api/auth/login about why.
    res.clearCookie('aikestarsid', { path: '/' });
    if (process.env.NODE_ENV === 'production' && process.env.APP_DOMAIN) {
      res.clearCookie('aikestarsid', { path: '/', domain: process.env.APP_DOMAIN });
    }
    
    res.json({ message: 'Force logged out' });
  });
  
  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    const sessionId = req.session?.id;
    const authToken = req.session?.authToken;
    const userId = req.session?.userId;
    
    console.log('[Logout] Destroying session:', sessionId);
    
    // Log session for admin tracking
    if (userId) {
      try {
        await storage.createSessionLog({
          userId,
          action: 'logout',
          ipAddress: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || null,
          userAgent: req.headers['user-agent'] || null,
        });
      } catch (logErr) {
        console.error('[Logout] Error logging session:', logErr);
      }
    }
    
    // First, explicitly delete the session from database to invalidate any Bearer tokens
    // This is critical for security - ensures the authToken can no longer be used
    if (authToken) {
      try {
        const { pool } = await import('../db');
        const result = await pool.query(
          `DELETE FROM session WHERE sess->>'authToken' = $1`,
          [authToken]
        );
        console.log('[Logout] Deleted sessions with authToken:', result.rowCount);
      } catch (err: any) {
        console.error('[Logout] Error deleting session by authToken:', err.message);
      }
    }
    
    // Also delete by session ID as backup
    if (sessionId) {
      try {
        const { pool } = await import('../db');
        await pool.query(`DELETE FROM session WHERE sid = $1`, [sessionId]);
        console.log('[Logout] Deleted session by sid:', sessionId);
      } catch (err: any) {
        console.error('[Logout] Error deleting session by sid:', err.message);
      }
    }
    
    req.session.destroy(() => {
      res.clearCookie('aikestarsid', { path: '/' });
      res.json({ message: 'Logged out' });
    });
  });
  
  app.get('/api/user/pending-subscription', requireAuthOnly, async (req: any, res) => {
    try {
      const subscription = await storage.getSubscriptionByUserId(req.userId);
      if (!subscription || subscription.status !== 'pending') {
        return res.json({ hasPending: false, planType: null });
      }
      res.json({ 
        hasPending: true, 
        planType: subscription.planType,
        subscriptionId: subscription.id
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.get('/api/user', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      
      const subscription = await storage.getSubscriptionByUserId(req.userId);
      
      res.json({ 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        accountType: user.accountType,
        profileImageUrl: user.profileImageUrl,
        profileIconKey: user.profileIconKey,
        mustChangePassword: user.mustChangePassword || false,
        planType: subscription?.planType || null,
        stripeCustomerId: user.stripeCustomerId || null,
        phoneNumber: user.phoneNumber || null,
        phoneVerified: user.phoneVerified || false,
        // Task #221: pending number captured at signup but not yet verified.
        // The Settings → WhatsApp wizard uses it to pre-fill the number input.
        pendingPhoneNumber: user.pendingPhoneNumber || null,
        // Task #219: surface the "abandoned wizard" timestamp so the
        // dashboard can decide whether to show the reminder banner
        // (only after >24h with phoneNumber set and !phoneVerified).
        phoneNumberAddedAt: user.phoneNumberAddedAt
          ? user.phoneNumberAddedAt.toISOString()
          : null,
        whatsappDefaultOrganizationId: user.whatsappDefaultOrganizationId || null,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // WhatsApp default organization — la org que el bot usa por defecto.
  // Independiente de `lastActiveOrganizationId` (que es para la web).
  // Sólo se cambia desde acá; el bot nunca la sobrescribe automáticamente.
  app.get('/api/user/whatsapp-default-organization', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user) return res.status(404).json({ message: 'User not found' });
      const orgId = user.whatsappDefaultOrganizationId || null;
      let valid = false;
      if (orgId) {
        const membership = await storage.getMembershipByUserAndOrg(req.userId, orgId);
        valid = !!membership;
      }
      res.json({ organizationId: orgId, valid });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.put('/api/user/whatsapp-default-organization', requireAuth, async (req: any, res) => {
    try {
      const { organizationId } = req.body || {};
      if (organizationId !== null && typeof organizationId !== 'string') {
        return res.status(400).json({ message: 'organizationId debe ser string o null' });
      }
      // Si se pasa null, limpiamos la default.
      // Marcamos `whatsappDefaultOrgInitialized: true` también, para que el
      // auto-assign de /api/whatsapp-preferences NO vuelva a setear una default
      // silenciosamente sobre una decisión explícita del usuario.
      if (organizationId === null || organizationId === '') {
        const user = await storage.updateUser(req.userId, {
          whatsappDefaultOrganizationId: null,
          whatsappDefaultOrgInitialized: true,
        });
        return res.json({ organizationId: user?.whatsappDefaultOrganizationId || null, valid: false });
      }
      // Validar que el usuario sea miembro confirmado de la org.
      const membership = await storage.getMembershipByUserAndOrg(req.userId, organizationId);
      if (!membership) {
        return res.status(403).json({ message: 'No sos miembro de esa organización' });
      }
      const user = await storage.updateUser(req.userId, {
        whatsappDefaultOrganizationId: organizationId,
        whatsappDefaultOrgInitialized: true,
      });
      res.json({ organizationId: user?.whatsappDefaultOrganizationId || null, valid: true });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
  
  app.patch('/api/user', requireAuth, async (req: any, res) => {
    try {
      const { updateUserSchema } = await import('@shared/schema');
      const parseResult = updateUserSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: 'Datos inválidos', errors: parseResult.error.errors });
      }
      const { name, email, profileImageUrl, profileIconKey } = parseResult.data;
      const user = await storage.updateUser(req.userId, { 
        name, 
        email,
        profileImageUrl: profileImageUrl !== undefined ? profileImageUrl : undefined,
        profileIconKey: profileIconKey !== undefined ? profileIconKey : undefined,
      });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json({ 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        accountType: user.accountType,
        profileImageUrl: user.profileImageUrl,
        profileIconKey: user.profileIconKey,
      });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // PUT /api/user/phone is RETIRED for *binding* a number — the only safe way
  // to attach a phone to an account is now the two-step verification flow
  // (POST /send-code + POST /verify-code). For backward compatibility we still
  // accept an explicit clear request (null / empty string), which behaves
  // exactly like DELETE /api/user/phone and unlinks the number. Any non-empty
  // value is rejected with 410 so old clients trying to bind get a clear
  // signal to migrate to the verification flow.
  app.put('/api/user/phone', requireAuth, async (req: any, res) => {
    try {
      const raw = req.body?.phoneNumber;
      const isClearRequest =
        raw === null ||
        raw === undefined ||
        (typeof raw === 'string' && raw.trim() === '');

      if (!isClearRequest) {
        return res.status(410).json({
          message: 'Este flujo fue reemplazado por la verificación de número con código.',
          code: 'phone_binding_requires_verification',
        });
      }

      const user = await storage.updateUser(req.userId, {
        phoneNumber: null,
        phoneVerified: false,
        // Task #219: clear the abandoned-wizard timestamp too, otherwise the
        // dashboard banner would keep firing for a number the user just
        // chose to unlink.
        phoneNumberAddedAt: null,
      });
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      return res.json({ message: 'Número desvinculado correctamente' });
    } catch (error: any) {
      console.error('Error clearing phone:', error);
      return res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Step 1 of the verification flow. Accepts a phone number, generates a
  // 6-digit code, sends it via WhatsApp, and persists the hash so step 2
  // can verify. Rate-limited per user inside the verification module
  // (3 sends / hour) and additionally per IP via authLimiter.
  app.post('/api/user/phone/send-code', requireAuth, authLimiter, async (req: any, res) => {
    try {
      const { phoneNumber } = req.body || {};
      if (!phoneNumber || typeof phoneNumber !== 'string') {
        return res.status(400).json({ message: 'El número de teléfono es requerido' });
      }

      const invalidMsg = 'Número inválido. Seleccioná tu país e ingresá tu número local.';
      const result = normalizePhoneInput(phoneNumber);
      if (!result.ok) {
        return res.status(400).json({ message: invalidMsg });
      }
      const normalizedPhone = result.phone;

      const { startVerification } = await import('../lib/phoneVerification');
      const startResult = await startVerification(req.userId, normalizedPhone);
      if (!startResult.ok) {
        if (startResult.reason === 'phone_taken') {
          return res.status(409).json({
            message: 'Este número ya está vinculado y verificado en otra cuenta.',
            code: 'phone_taken',
          });
        }
        if (startResult.reason === 'rate_limited') {
          const minutes = Math.max(1, Math.ceil((startResult.retryAfterMs ?? 0) / 60000));
          return res.status(429).json({
            message: `Demasiados códigos enviados. Probá de nuevo en ${minutes} minuto(s).`,
            code: 'rate_limited',
            retryAfterMs: startResult.retryAfterMs,
          });
        }
        return res.status(500).json({ message: 'No pudimos iniciar la verificación.' });
      }

      // Send the code via WhatsApp using the existing Twilio sender.
      const { sendWhatsAppMessage } = await import('./whatsapp');
      const pretty = result.isArMobile ? formatArgentineMobilePretty(normalizedPhone) : null;
      const displayPhone = pretty ?? normalizedPhone;
      const body =
        `🔐 Tu código de verificación de Aikestar es *${startResult.code}*.\n\n` +
        `Pegalo en la app para vincular este número (${displayPhone}). ` +
        `Vence en 10 minutos.\n\n` +
        `Si no fuiste vos, ignorá este mensaje.`;
      const sent = await sendWhatsAppMessage(`whatsapp:${normalizedPhone}`, body);
      if (!sent) {
        return res.status(502).json({
          message: 'No pudimos enviar el código por WhatsApp. Verificá el número e intentá de nuevo.',
          code: 'send_failed',
        });
      }

      res.json({
        ok: true,
        phoneNumber: normalizedPhone,
        displayPhone,
        expiresAt: startResult.expiresAt.toISOString(),
        message: `Te enviamos un código de 6 dígitos por WhatsApp a ${displayPhone}.`,
      });
    } catch (error: any) {
      console.error('Error sending phone verification code:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  // Step 2 of the verification flow. Validates the user-entered code; on
  // success, transfers any unverified binding away from squatters and
  // persists phoneNumber + phoneVerified=true on the current user.
  app.post('/api/user/phone/verify-code', requireAuth, authLimiter, async (req: any, res) => {
    try {
      const { code } = req.body || {};
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ message: 'El código es requerido' });
      }

      const { checkVerification, claimPhoneForUser } = await import('../lib/phoneVerification');
      const result = await checkVerification(req.userId, code);
      if (!result.ok) {
        if (result.reason === 'no_pending') {
          return res.status(400).json({
            message: 'No hay un código activo. Pedí uno nuevo.',
            code: 'no_pending',
          });
        }
        if (result.reason === 'expired') {
          return res.status(400).json({
            message: 'El código venció. Pedí uno nuevo.',
            code: 'expired',
          });
        }
        if (result.reason === 'too_many_attempts') {
          return res.status(429).json({
            message: 'Superaste el máximo de intentos. Pedí un código nuevo.',
            code: 'too_many_attempts',
          });
        }
        // mismatch
        return res.status(400).json({
          message: `Código incorrecto. Te quedan ${result.remainingAttempts} intento(s).`,
          code: 'mismatch',
          remainingAttempts: result.remainingAttempts,
        });
      }

      const claim = await claimPhoneForUser(req.userId, result.normalizedPhone);
      if (!claim.ok) {
        // Race: someone verified the same number between send and verify.
        return res.status(409).json({
          message: 'Este número ya está vinculado y verificado en otra cuenta.',
          code: 'phone_taken',
        });
      }

      const user = claim.user!;
      const norm = normalizePhoneInput(user.phoneNumber!);
      const pretty = norm.ok && norm.isArMobile ? formatArgentineMobilePretty(user.phoneNumber!) : null;
      const displayPhone = pretty ?? user.phoneNumber;

      // Task #225 — Best-effort: avisar al usuario por WhatsApp y por email
      // que la vinculación quedó hecha. NO bloqueamos la respuesta HTTP ni
      // propagamos errores: si Twilio o SendGrid fallan, el usuario igual
      // queda vinculado y los errores quedan registrados en logs.
      const linkedAt = new Date();
      const maskedPhone = maskPhoneForDisplay(user.phoneNumber);
      const waConfirmation =
        `¡Listo! Tu número quedó vinculado a Aikestar.\n\n` +
        `Ahora podés registrar movimientos escribiéndome directamente. ` +
        `Probá con algo como "gasté 5000 en nafta" o "cobré 25000 de Juan".\n\n` +
        `Si necesitás ayuda escribí "ayuda".`;

      void (async () => {
        console.log(`[PhoneVerify] Dispatching link-confirmation for user=${user.id} phone=${maskedPhone}`);
        try {
          const { sendWhatsAppMessage } = await import('./whatsapp');
          const results = await Promise.allSettled([
            sendWhatsAppMessage(`whatsapp:${user.phoneNumber}`, waConfirmation),
            sendPhoneLinkedConfirmationEmail(user.email, user.name ?? 'Hola', maskedPhone, linkedAt),
          ]);
          const [waRes, emailRes] = results;
          if (waRes.status === 'rejected') {
            console.error('[PhoneVerify] WhatsApp confirmation rejected:', waRes.reason);
          } else if (waRes.value === false) {
            console.warn(`[PhoneVerify] WhatsApp confirmation returned false (Twilio non-OK) user=${user.id}`);
          } else {
            console.log(`[PhoneVerify] WhatsApp confirmation sent user=${user.id}`);
          }
          if (emailRes.status === 'rejected') {
            console.error('[PhoneVerify] Email confirmation rejected:', emailRes.reason);
          } else if (emailRes.value === false) {
            console.warn(`[PhoneVerify] Email confirmation returned false (SendGrid non-OK) user=${user.id}`);
          } else {
            console.log(`[PhoneVerify] Email confirmation sent user=${user.id}`);
          }
        } catch (err) {
          console.error('[PhoneVerify] Confirmation dispatch failed:', err);
        }
      })();

      res.json({
        ok: true,
        phoneNumber: user.phoneNumber,
        phoneVerified: true,
        message: `Listo, vinculamos y verificamos tu número ${displayPhone}.`,
      });
    } catch (error: any) {
      console.error('Error verifying phone code:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/user/phone', requireAuth, async (req: any, res) => {
    try {
      const user = await storage.updateUser(req.userId, { 
        phoneNumber: null,
        phoneVerified: false,
        // Task #219: clear the abandoned-wizard timestamp on explicit unlink.
        phoneNumberAddedAt: null,
      });
      
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      res.json({ message: 'Número desvinculado correctamente' });
    } catch (error: any) {
      console.error('Error deleting phone:', error);
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.post('/api/user/change-password', requireAuth, async (req: any, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'Contraseña actual y nueva son requeridas' });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const validPassword = await bcrypt.compare(currentPassword, user.password);
      if (!validPassword) {
        return res.status(401).json({ message: 'Contraseña actual incorrecta' });
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      await storage.updateUser(user.id, { password: hashedPassword });
      
      sendPasswordChangeEmail(user.email, user.name).catch(() => {});
      
      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });

  app.delete('/api/user', requireAuth, async (req: any, res) => {
    try {
      const { password } = req.body;
      
      if (!password) {
        return res.status(400).json({ message: 'Ingresá tu contraseña para confirmar' });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(404).json({ message: 'Usuario no encontrado' });
      }
      
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ message: 'Contraseña incorrecta' });
      }
      
      const subscription = await storage.getSubscriptionByUserId(user.id);
      if (subscription?.stripeSubscriptionId) {
        try {
          const stripe = await getUncachableStripeClient();
          await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
        } catch {
          return res.status(500).json({ 
            message: 'Error al cancelar suscripción. No podemos eliminar tu cuenta hasta que se cancele. Intentá de nuevo más tarde.',
            code: 'STRIPE_ERROR'
          });
        }
      }
      
      const orgs = await storage.getOrganizationsByUser(user.id);
      for (const org of orgs) {
        const membership = await storage.getMembershipByUserAndOrg(user.id, org.id);
        if (membership?.role === 'owner' || membership?.role === 'admin') {
          // Before deleting organization, create access denied events for all other members
          const members = await storage.getMembersByOrganization(org.id);
          for (const member of members) {
            if (member.user.id !== user.id) {
              try {
                await storage.createAccessDeniedEvent({
                  userId: member.user.id,
                  userEmail: member.user.email,
                  organizationId: org.id,
                  organizationName: org.name,
                  reason: 'org_owner_deleted',
                  removedByUserId: user.id,
                  removedByUserName: user.name,
                  acknowledged: false,
                });
              } catch {
              }
            }
          }
          await storage.deleteOrganization(org.id);
        }
      }
      
      await storage.deleteUser(user.id);
      
      req.session.destroy(() => {});
      
      res.json({ message: 'Cuenta eliminada correctamente' });
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  });
}
