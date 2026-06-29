import type { Express } from "express";
import { type Server } from "http";
import { registerAuthRoutes } from "./routes/auth";
import { registerOrganizationRoutes } from "./routes/organizations";
import { registerTransactionRoutes } from "./routes/transactions";
import { registerAIRoutes } from "./routes/ai";
import { registerOperationRoutes } from "./routes/operations";
import { registerStripeRoutes } from "./routes/stripe";
import { registerMercadoPagoRoutes } from "./routes/mercadopago";
import { registerTiendanubeRoutes } from "./routes/tiendanube";
import { registerCrmRoutes } from "./routes/crm";
import { registerWorkOrderRoutes } from "./routes/workOrders";
import { registerRemitoRoutes } from "./routes/remitos";
import { registerInvestmentRoutes } from "./routes/investments";
import { registerAdminRoutes } from "./routes/admin";
import { registerWhatsAppRoutes } from "./routes/whatsapp";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerTaxRoutes } from "./routes/taxes";
import { registerInvoicingRoutes } from "./routes/invoicing";
import { registerProfitabilityCodesRoutes } from "./routes/profitabilityCodes";
import { registerPaymentMethodsRoutes } from "./routes/paymentMethods";
import { registerReportsRoutes } from "./routes/reports";
import { registerQuoteRoutes } from "./routes/quotes";
import { pool } from "./db";

declare module "express-session" {
  interface SessionData {
    userId: string;
    organizationId: string;
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Endpoint to fix subscriptions with missing stripe_subscription_id or wrong status
  app.post('/api/admin/fix-subscriptions', async (req, res) => {
    try {
      const authHeader = req.headers['x-admin-key'];
      const sessionSecret = process.env.SESSION_SECRET;
      
      if (!sessionSecret || authHeader !== sessionSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      console.log('[Admin] Running subscription fix...');
      
      const client = await pool.connect();
      try {
        // Find subscriptions with missing stripe_subscription_id or status='pending'
        const result = await client.query(`
          SELECT s.id, s.user_id, s.status, s.stripe_subscription_id, u.email, u.stripe_customer_id
          FROM subscriptions s
          JOIN users u ON s.user_id = u.id
          WHERE s.stripe_subscription_id IS NULL 
             OR s.stripe_subscription_id = ''
             OR s.status = 'pending'
        `);
        
        const fixes: any[] = [];
        const { default: Stripe } = await import('stripe');
        const stripeKey = process.env.NODE_ENV === 'production' 
          ? process.env.STRIPE_LIVE_SECRET_KEY 
          : process.env.STRIPE_SECRET_KEY;
        
        if (!stripeKey) {
          return res.status(500).json({ error: 'Stripe key not configured' });
        }
        
        const stripe = new Stripe(stripeKey);
        
        for (const row of result.rows) {
          try {
            // Try to find subscription in Stripe by customer
            if (row.stripe_customer_id) {
              const subs = await stripe.subscriptions.list({ 
                customer: row.stripe_customer_id, 
                limit: 1 
              });
              
              if (subs.data.length > 0) {
                const stripeSub = subs.data[0];
                const newStatus = stripeSub.status === 'trialing' ? 'trialing' : 
                                  stripeSub.status === 'active' ? 'active' : 
                                  stripeSub.status;
                
                await client.query(`
                  UPDATE subscriptions 
                  SET stripe_subscription_id = $1, status = $2 
                  WHERE id = $3
                `, [stripeSub.id, newStatus, row.id]);
                
                fixes.push({
                  email: row.email,
                  oldStatus: row.status,
                  newStatus,
                  stripeSubId: stripeSub.id
                });
              }
            }
          } catch (err: any) {
            console.error(`[Admin] Error fixing subscription for ${row.email}:`, err.message);
          }
        }
        
        res.json({
          success: true,
          subscriptionsChecked: result.rows.length,
          subscriptionsFixed: fixes.length,
          fixes
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error('[Admin] fix-subscriptions error:', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Diagnostic endpoint to check session table (works in production, read-only)
  app.get('/api/admin/session-status', async (req, res) => {
    try {
      const authHeader = req.headers['x-admin-key'];
      const sessionSecret = process.env.SESSION_SECRET;
      
      if (!sessionSecret || authHeader !== sessionSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const client = await pool.connect();
      try {
        const schemaResult = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns 
          WHERE table_name = 'session'
          ORDER BY ordinal_position
        `);
        
        const countResult = await client.query('SELECT COUNT(*) as count FROM session');
        
        // Check for sessions with userId
        let sessionsWithUser = 0;
        try {
          const userSessionResult = await client.query(`
            SELECT COUNT(*) as count FROM session 
            WHERE sess::jsonb ? 'userId'
          `);
          sessionsWithUser = parseInt(userSessionResult.rows[0]?.count || '0');
        } catch {
          // JSON query failed - likely TEXT column
          sessionsWithUser = -1;
        }
        
        const sessColumn = schemaResult.rows.find((r: any) => r.column_name === 'sess');
        
        res.json({
          environment: process.env.NODE_ENV,
          databaseHost: process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'unknown',
          sessionTableExists: schemaResult.rows.length > 0,
          columns: schemaResult.rows,
          sessColumnType: sessColumn?.data_type || 'NOT FOUND',
          isCorrectType: sessColumn?.data_type === 'json',
          sessionCount: countResult.rows[0]?.count || 0,
          sessionsWithUserId: sessionsWithUser,
          recommendation: sessColumn?.data_type !== 'json' 
            ? 'CRITICAL: sess column is not JSON type. Database migration may be needed.'
            : sessionsWithUser === 0 
              ? 'Schema is correct but no sessions have userId. Check login flow.'
              : 'Schema looks correct and sessions have userId.'
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  
  registerAuthRoutes(app);
  registerOrganizationRoutes(app);
  registerTransactionRoutes(app);
  registerAIRoutes(app);
  registerOperationRoutes(app);
  registerStripeRoutes(app);
  registerMercadoPagoRoutes(app);
  registerTiendanubeRoutes(app);
  registerCrmRoutes(app);
  registerWorkOrderRoutes(app);
  registerRemitoRoutes(app);
  registerInvestmentRoutes(app);
  registerAdminRoutes(app);
  registerWhatsAppRoutes(app);
  registerNotificationRoutes(app);
  registerTaxRoutes(app);
  registerInvoicingRoutes(app);
  registerProfitabilityCodesRoutes(app);
  registerPaymentMethodsRoutes(app);
  registerReportsRoutes(app);
  registerQuoteRoutes(app);

  return httpServer;
}
