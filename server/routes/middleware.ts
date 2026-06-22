import { Request, Response, NextFunction } from "express";
import { storage } from "../storage";
import { ROLE_PERMISSIONS, type Role, type Permission, PLAN_TYPES, type PlanType, PLAN_DETAILS } from "@shared/schema";
import { type IStorage } from "../storage";

export function sanitizeError(error: any): string {
  const msg = error?.message || '';
  if (error?.name === 'ZodError' || msg.includes('Validation')) {
    return msg;
  }
  if (msg.includes('unique constraint') || msg.includes('duplicate key')) {
    return 'Ya existe un registro con esos datos';
  }
  if (msg.includes('foreign key') || msg.includes('violates foreign key')) {
    return 'No se puede completar la operación porque hay datos relacionados';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('connection') || msg.includes('terminating')) {
    return 'Error de conexión con la base de datos. Intentá de nuevo en unos segundos.';
  }
  if (msg.includes('numeric field overflow') || msg.includes('value out of range')) {
    return 'Algún valor numérico es demasiado grande. Revisá el monto, la tasa de interés u otros campos numéricos del formulario.';
  }
  if (msg.includes('invalid input syntax')) {
    return 'Algún campo tiene un formato inválido. Revisá los valores ingresados (montos, fechas, números).';
  }
  if (msg.includes('not found') || msg.includes('no encontr')) {
    return msg;
  }
  console.error('[ServerError]', msg);
  return 'Error interno del servidor';
}

declare module "express-session" {
  interface SessionData {
    userId: string;
    organizationId: string;
    recoveryToken?: string;
    recoveryTokenExpires?: number;
    authToken?: string; // Token for Bearer auth fallback
  }
}

export interface AuthenticatedRequest extends Request {
  userId: string;
  organizationId: string;
  membership?: any;
}

// Helper function to authenticate via Bearer token when cookies fail
async function authenticateViaToken(req: Request): Promise<{ userId: string; organizationId: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  if (!token || token.length < 32) {
    return null;
  }
  
  try {
    const { pool } = await import('../db');
    const result = await pool.query(
      `SELECT sess FROM session 
       WHERE expire > NOW() 
       AND sess->>'authToken' = $1`,
      [token]
    );
    
    if (result.rows.length > 0) {
      const sess = result.rows[0].sess;
      if (sess.userId && sess.organizationId) {
        return { userId: sess.userId, organizationId: sess.organizationId };
      }
    }
    
    return null;
  } catch (err: any) {
    console.error('[Auth] Bearer token auth error:', err.message);
    return null;
  }
}

// Middleware that only checks if user is logged in, without subscription validation
// Use this for checkout/pricing pages where user needs to pay first
export async function requireAuthOnly(req: Request, res: Response, next: NextFunction) {
  let userId = req.session?.userId;
  let orgId = req.session?.organizationId;
  
  if (!userId || !orgId) {
    const tokenAuth = await authenticateViaToken(req);
    if (tokenAuth) {
      userId = tokenAuth.userId;
      orgId = tokenAuth.organizationId;
    }
  }
  
  if (!userId || !orgId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  
  (req as any).userId = userId;
  (req as any).organizationId = orgId;
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  let userId = req.session?.userId;
  let orgId = req.session?.organizationId;
  
  if (!userId || !orgId) {
    const tokenAuth = await authenticateViaToken(req);
    if (tokenAuth) {
      userId = tokenAuth.userId;
      orgId = tokenAuth.organizationId;
    }
  }
  
  if (!userId || !orgId) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  
  // Verify user still exists in database (handles case where user was deleted but session still exists).
  // IMPORTANT: a single null read from getUser() used to destroy the session permanently,
  // which kicked paying users out on transient pool/replication hiccups. We now retry once
  // with a short backoff before destroying. The catch block already fails open on thrown errors.
  try {
    let user = await storage.getUser(userId);
    if (!user) {
      console.warn('[Auth] getUser returned null, retrying once before destroying session. userId:', userId);
      await new Promise(resolve => setTimeout(resolve, 150));
      try {
        user = await storage.getUser(userId);
      } catch (retryErr) {
        console.error('[Auth] getUser retry threw, failing open:', retryErr);
        // Fail open: treat as transient, keep session, continue.
        (req as any).userId = userId;
        (req as any).organizationId = orgId;
        return next();
      }
      if (!user) {
        console.log('[Auth] User confirmed missing after retry, destroying session:', userId);
        req.session.destroy(() => {});
        return res.status(401).json({ message: 'User no longer exists', code: 'USER_DELETED' });
      }
      console.log('[Auth] getUser recovered on retry, session preserved. userId:', userId);
    }
    if (user.deletedAt) {
      console.log('[Auth] Soft-deleted user attempted access, destroying session:', userId);
      req.session.destroy(() => {});
      return res.status(403).json({ message: 'Tu cuenta fue eliminada por inactividad.', code: 'ACCOUNT_DELETED' });
    }
  } catch (err) {
    console.error('[Auth] Error checking if user exists:', err);
    // Fail open on transient errors
  }
  
  // Verify subscription status - block access if cancelled or past_due
  // For team members, always check the organization owner's subscription as fallback
  // IMPORTANT: Fail open on transient errors to avoid blocking legitimate users
  try {
    const blockedStatuses = ['cancelled', 'past_due', 'unpaid', 'pending'];
    const activeStatuses = ['active', 'trialing'];
    let subscriptionCheckSucceeded = false;
    let hasActiveSubscription = false;
    let inactiveReason = '';
    
    // Grace period configuration (in days).
    // Task #340 — IMPORTANTE: el borrado real sucede en
    // `server/services/cancelledAccountCleanup.ts` (60 días desde el fin del
    // período) y NO desde `payment_failed_at`. Las cuentas en `past_due`
    // puro no son tocadas por ningún cron. Por eso este middleware ya NO
    // promete una eliminación que no va a pasar: sólo expone
    // `daysSinceFailure` (dato real) y la UI muestra "acceso bloqueado"
    // sin cuenta regresiva ficticia.
    const GRACE_PERIOD_DAYS = 7; // Days before blocking access

    let paymentBlockedInfo: { daysSinceFailure: number } | null = null;
    
    // First try user's own subscription
    try {
      const userSubscription = await storage.getSubscriptionByUserId(userId);
      subscriptionCheckSucceeded = true;
      
      if (userSubscription && activeStatuses.includes(userSubscription.status)) {
        hasActiveSubscription = true;
      } else if (
        userSubscription &&
        (userSubscription.status === 'past_due' ||
          // Task #318 — `cancelled` con `payment_failed_at` también es un
          // pago rechazado: el webhook de Stripe llegó a marcar la
          // suscripción cancelled por non-payment. Tratamos ese caso igual
          // que past_due para que el usuario vea la pantalla "Acceso
          // Bloqueado / Pagar ahora" y pueda abrir el billing portal con
          // su stripeCustomerId (que sigue existiendo en Stripe), en vez
          // de la pantalla genérica "Suscripción cancelada → elegir plan".
          (userSubscription.status === 'cancelled' && userSubscription.paymentFailedAt))
      ) {
        // Check grace period for past_due / payment-cancelled subscriptions
        if (userSubscription.paymentFailedAt) {
          const now = new Date();
          const daysSinceFailure = Math.floor((now.getTime() - new Date(userSubscription.paymentFailedAt).getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysSinceFailure < GRACE_PERIOD_DAYS) {
            hasActiveSubscription = true;
          } else {
            inactiveReason = 'payment_blocked';
            paymentBlockedInfo = { daysSinceFailure };
          }
        } else {
          // No paymentFailedAt date set - allow access (shouldn't happen, but fail open)
          hasActiveSubscription = true;
        }
      } else if (userSubscription && blockedStatuses.includes(userSubscription.status)) {
        inactiveReason = userSubscription.status;
      }
    } catch (err) {
      console.error('[Auth] Error fetching user subscription:', err);
    }
    
    // If user doesn't have an active personal subscription, check organization owner's subscription
    if (!hasActiveSubscription && subscriptionCheckSucceeded) {
      try {
        const owner = await storage.getOrganizationOwner(orgId);
        if (owner) {
          if (owner.id === userId) {
            // User IS the owner - their subscription check already happened above
            // If we got here, they have no active subscription
          } else {
            const ownerSubscription = await storage.getSubscriptionByUserId(owner.id);
            
            if (ownerSubscription && activeStatuses.includes(ownerSubscription.status)) {
              // Owner has active subscription - member inherits access
              hasActiveSubscription = true;
            } else if (ownerSubscription && blockedStatuses.includes(ownerSubscription.status)) {
              inactiveReason = ownerSubscription.status;
            }
          }
        }
      } catch (err) {
        console.error('[Auth] Error fetching org owner subscription:', err);
        // Fail open - don't block on transient errors
        subscriptionCheckSucceeded = false;
      }
    }
    
    // Only enforce subscription check if we successfully queried the database
    if (subscriptionCheckSucceeded) {
      if (!hasActiveSubscription) {
        if (inactiveReason) {
          
          // Special handling for payment blocked (after grace period)
          if (inactiveReason === 'payment_blocked' && paymentBlockedInfo) {
            // Don't destroy session - user needs to be able to update payment method
            return res.status(402).json({
              message: 'Tu acceso está bloqueado por falta de pago. Regularizá tu pago para recuperar el acceso.',
              code: 'PAYMENT_BLOCKED',
              status: 'payment_blocked',
              daysSinceFailure: paymentBlockedInfo.daysSinceFailure
            });
          }
          
          // Don't destroy session for pending or cancelled users
          // They need their session to complete payment or re-subscribe at /pricing
          return res.status(402).json({ 
            message: inactiveReason === 'pending' 
              ? 'Completá tu suscripción para acceder'
              : 'Tu suscripción ha sido cancelada o tiene pagos pendientes',
            code: inactiveReason === 'pending' ? 'SUBSCRIPTION_PENDING' : 'SUBSCRIPTION_INACTIVE',
            status: inactiveReason
          });
        } else {
          return res.status(402).json({ 
            message: 'Suscripción requerida',
            code: 'SUBSCRIPTION_REQUIRED'
          });
        }
      }
    } else {
      // Database error - fail open but log for monitoring
      console.warn('[Auth] Subscription check failed due to DB error, allowing access:', req.session.userId);
    }
    
  } catch (error) {
    console.error('[Auth] Unexpected error in subscription check:', error);
    // Fail open - don't block users due to unexpected errors
  }
  
  (req as any).userId = req.session.userId;
  (req as any).organizationId = req.session.organizationId;
  next();
}

export async function requireOwner(req: any, res: any, next: any) {
  try {
    const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
    if (!membership) {
      return res.status(403).json({
        message: 'No tienes acceso a esta organización',
        code: 'NO_ORG_ACCESS',
      });
    }
    if (membership.role !== 'owner') {
      return res.status(403).json({
        message: 'Solo el dueño de la organización puede realizar esta acción',
        code: 'FORBIDDEN_PERMISSION',
        userRole: membership.role,
        requiredRole: 'owner',
      });
    }
    req.membership = membership;
    next();
  } catch (error: any) {
    res.status(500).json({ message: sanitizeError(error) });
  }
}

export function requirePermission(...permissions: Permission[]) {
  return async (req: any, res: any, next: any) => {
    try {
      const membership = await storage.getMembershipByUserAndOrg(req.userId, req.organizationId);
      if (!membership) {
        return res.status(403).json({
          message: 'No tienes acceso a esta organización',
          code: 'NO_ORG_ACCESS',
        });
      }

      const role = membership.role as Role;
      const userPermissions = ROLE_PERMISSIONS[role] || [];

      const missing = permissions.filter(p => !userPermissions.includes(p));
      if (missing.length > 0) {
        return res.status(403).json({
          message: 'No tienes permiso para realizar esta acción',
          code: 'FORBIDDEN_PERMISSION',
          userRole: role,
          requiredPermission: missing[0],
          missingPermissions: missing,
        });
      }

      req.membership = membership;
      next();
    } catch (error: any) {
      res.status(500).json({ message: sanitizeError(error) });
    }
  };
}

export async function getUserPlanLimits(userId: string, storageInstance: IStorage) {
  const subscription = await storageInstance.getSubscriptionByUserId(userId);
  const user = await storageInstance.getUser(userId);
  
  let planType: PlanType = user?.accountType === 'personal' ? 'personal' : 'solo';
  if (subscription?.planType && PLAN_TYPES.includes(subscription.planType as PlanType)) {
    planType = subscription.planType as PlanType;
  }
  
  const limits = PLAN_DETAILS[planType];
  return { planType, ...limits };
}

export async function getOrganizationPlanLimits(organizationId: string, storageInstance: IStorage) {
  const owner = await storageInstance.getOrganizationOwner(organizationId);
  if (!owner) {
    return { planType: 'solo' as PlanType, ...PLAN_DETAILS['solo'] };
  }
  
  const subscription = await storageInstance.getSubscriptionByUserId(owner.id);
  
  if (subscription?.planType && PLAN_TYPES.includes(subscription.planType as PlanType)) {
    const planType = subscription.planType as PlanType;
    return { planType, ...PLAN_DETAILS[planType] };
  }
  
  const planType: PlanType = owner.accountType === 'personal' ? 'personal' : 'solo';
  const limits = PLAN_DETAILS[planType];
  return { planType, ...limits };
}
