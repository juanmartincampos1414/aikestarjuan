import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { csrfSync } from "csrf-sync";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { pool, db } from "./db";
import { getStripeSync } from "./stripeClient";
import { WebhookHandlers } from "./webhookHandlers";
import { storage } from "./storage";
import { SESSION_MAX_AGE } from "@shared/constants";
import { startNotificationCron } from "./services/notificationCron";
import { startInvoiceEmailRetryCron } from "./services/invoiceEmailRetryCron";
import { startWeeklyDigestCron, startWeeklyDigestWakeTrigger } from "./services/weeklyDigest";
import { startInactiveAccountCleanup } from "./services/inactiveAccountCleanup";
import { startCancelledAccountCleanup } from "./services/cancelledAccountCleanup";
import { startSubscriptionBillingCron } from "./services/subscriptionBilling";
import { startMrrSnapshotCron } from "./services/mrrSnapshot";
import { startTiendanubeReconcileCron } from "./services/tiendanubeReconcileCron";
import { startCrmReminderCron } from "./services/crmReminderCron";
import { runOneTimeCleanup } from "./services/oneTimeCleanup";
import { reportSystemError } from "./services/errorAlerts";
// Note: stripe-replit-sync is imported dynamically only in development mode

process.on('unhandledRejection', (reason: any) => {
  console.error('[Process] Unhandled promise rejection:', reason?.message || reason);
  reportSystemError({
    source: 'unhandledRejection',
    message: reason?.message || String(reason),
    stack: reason?.stack || null,
  });
});

process.on('uncaughtException', (err: Error) => {
  console.error('[Process] Uncaught exception:', err.message);
  reportSystemError({
    source: 'uncaughtException',
    message: err.message,
    stack: err.stack || null,
  });
});


const app = express();
const httpServer = createServer(app);

// Trust proxy - required for secure cookies behind Replit's reverse proxy
// Use 'true' to trust the entire proxy chain (Replit autoscale uses multiple hops)
// Also enable when we have live Stripe keys (production deployment with NODE_ENV=development)
const hasLiveStripeKey = !!process.env.STRIPE_LIVE_SECRET_KEY;
if (process.env.NODE_ENV === "production" || hasLiveStripeKey) {
  app.set("trust proxy", true);
  console.log('[Server] Trust proxy enabled (production mode or live Stripe keys detected)');
}

// Alerta de errores del sistema: captura TODA respuesta con código 500+, incluidas
// las que se devuelven directamente con res.status(500) sin pasar por el manejador
// central de errores (por ejemplo el webhook de Stripe). Se registra temprano para
// envolver todas las rutas. El manejador central marca req.__errorAlerted cuando ya
// reportó (con stack), para no enviar una alerta duplicada por la misma respuesta.
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500 && !(req as any).__errorAlerted) {
      reportSystemError({
        source: 'http',
        statusCode: res.statusCode,
        message: `Respuesta ${res.statusCode} del servidor (sin excepción capturada)`,
        method: req.method,
        path: req.originalUrl,
        userId: (req as any).userId || (req as any).session?.userId || null,
        organizationId: (req as any).organizationId || (req as any).session?.organizationId || null,
        ip: req.ip || (req.headers['x-forwarded-for'] as string) || null,
        userAgent: req.headers['user-agent'] || null,
      });
    }
  });
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Canonical-domain redirect + robots policy (Task: blindar dominio app.aikestar.com)
//
// Why: the Replit deployment is hosted at app.aikestar.com (custom domain), but
// the deployment's *.replit.app URL AND the workspace preview's *.replit.dev
// URL also serve the exact same app from the same database. If a user lands
// on either of those instead of app.aikestar.com:
//   - Session cookies (scoped to .app.aikestar.com) silently fail to persist.
//   - Marketing pixels (Meta, GTM, Metricool) fire under the wrong hostname,
//     so conversions never get attributed in Ads Manager.
//   - The user sees a scary opaque subdomain in the address bar — for a
//     fintech app this kills trust and conversion.
//
// What this middleware does:
//   - In production (or when live Stripe keys are present, i.e. an actual
//     deployment), if APP_DOMAIN is configured AND the request's Host header
//     is a *.replit.dev or *.replit.app subdomain, respond with a 301
//     permanent redirect to https://<canonicalHost><originalUrl>.
//   - Health/webhook paths are NEVER redirected so Stripe/Twilio/etc don't
//     break: webhooks come in to the deployment URL, must answer 200.
//   - In local dev (no live keys, no APP_DOMAIN) the middleware is inert.
//
// /robots.txt is also handled here so it returns Disallow:/ on any non-canonical
// host (Replit already adds X-Robots-Tag: noindex on *.replit.dev/.app, but
// belt-and-suspenders + handles *.replit.app deployment URL too).
// ─────────────────────────────────────────────────────────────────────────────
const REPLIT_HOST_RE = /\.(replit\.dev|replit\.app|picard\.replit\.dev)$/i;
const REDIRECT_EXEMPT_PREFIXES = [
  '/api/stripe/webhook',          // Stripe must reach the deployment URL it was registered with
  '/api/whatsapp/webhook',        // Twilio webhook
  '/api/whatsapp/status',
  '/api/health',
  '/health',
];

function getCanonicalHost(): string | null {
  const raw = process.env.APP_DOMAIN; // e.g. ".app.aikestar.com"
  if (!raw) return null;
  // Strip leading dot used for cookie domain ("." prefix is a cookie-only convention).
  return raw.replace(/^\./, '').toLowerCase() || null;
}

function isCanonicalDeployment(): boolean {
  // Only enforce in REAL Replit deployments. Replit sets REPLIT_DEPLOYMENT=1
  // only inside the deployed runtime; in the dev workspace this var is empty,
  // even when live Stripe keys are present. We intentionally do NOT key off
  // NODE_ENV or hasLiveStripeKey here, because the dev workspace runs with
  // live Stripe keys for Stripe Sync to work — using those would redirect
  // away from the workspace preview URL and break local development.
  return process.env.REPLIT_DEPLOYMENT === '1';
}

app.use((req, res, next) => {
  const canonicalHost = getCanonicalHost();
  if (!canonicalHost || !isCanonicalDeployment()) return next();

  const hostHeader = (req.headers.host || '').toLowerCase().split(':')[0];
  if (!hostHeader) return next();

  // Already on canonical host (or a subdomain of it) → nothing to do.
  if (hostHeader === canonicalHost || hostHeader.endsWith(`.${canonicalHost}`)) {
    return next();
  }

  // Only redirect Replit-owned hosts. Other unknown hosts are passed through
  // (could be DNS misconfig in a partner's setup; we don't want to hijack).
  if (!REPLIT_HOST_RE.test(hostHeader)) return next();

  // Don't redirect webhook/health endpoints — they MUST keep working on the
  // deployment URL (Stripe/Twilio register to it).
  if (REDIRECT_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  const target = `https://${canonicalHost}${req.originalUrl}`;
  res.setHeader('X-Canonical-Redirect', '1');
  return res.redirect(301, target);
});

// /robots.txt — explicit Disallow:/ on non-canonical hosts.
app.get('/robots.txt', (req, res) => {
  const canonicalHost = getCanonicalHost();
  const hostHeader = (req.headers.host || '').toLowerCase().split(':')[0];
  const isCanonical =
    !canonicalHost ||
    hostHeader === canonicalHost ||
    hostHeader.endsWith(`.${canonicalHost}`);
  res.type('text/plain');
  if (isCanonical) {
    res.send(
      `User-agent: *\nAllow: /\n\n` +
        (canonicalHost ? `Sitemap: https://${canonicalHost}/sitemap.xml\n` : ''),
    );
  } else {
    res.send(`User-agent: *\nDisallow: /\n`);
  }
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Initialize Stripe schema and sync on startup (DEVELOPMENT ONLY)
// In production, we use direct Stripe API calls without stripe-replit-sync
async function initStripe() {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasLiveSecretKey = !!process.env.STRIPE_LIVE_SECRET_KEY;
  const hasLivePublishableKey = !!process.env.STRIPE_LIVE_PUBLISHABLE_KEY;
  const hasWebhookSecret = !!process.env.STRIPE_WEBHOOK_SECRET;
  const hasLiveWebhookSecret = !!process.env.STRIPE_LIVE_WEBHOOK_SECRET;
  
  console.log(`[Stripe] mode=${isProduction ? 'production' : 'development'}`);
  
  // Skip stripe-replit-sync in production - it causes bundling issues
  // and we don't need it since we use direct Stripe credentials
  if (isProduction) {
    console.log('[Stripe] Production mode: direct API');
    if (!hasLiveSecretKey || !hasLivePublishableKey) {
      console.error('[Stripe] WARNING: Live mode keys not configured!');
    }
    return;
  }
  
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('[Stripe] DATABASE_URL not found, skipping Stripe initialization');
    return;
  }

  try {
    console.log('[Stripe] Development mode: Initializing stripe-replit-sync...');
    const { runMigrations } = await import('stripe-replit-sync');
    await runMigrations({ databaseUrl });
    console.log('[Stripe] Schema ready');

    const stripeSync = await getStripeSync();

    console.log('[Stripe] Setting up managed webhook...');
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
    try {
      const result = await stripeSync.findOrCreateManagedWebhook(
        `${webhookBaseUrl}/api/stripe/webhook`
      );
      if (result?.webhook?.url) {
        console.log(`[Stripe] Webhook configured: ${result.webhook.url}`);
      } else {
        console.log('[Stripe] Webhook setup skipped (sandbox mode or already exists)');
      }
    } catch (webhookError: any) {
      console.log('[Stripe] Webhook setup skipped:', webhookError.message);
    }

    console.log('[Stripe] Syncing data...');
    stripeSync.syncBackfill()
      .then(() => console.log('[Stripe] Data synced'))
      .catch((err: any) => console.error('[Stripe] Sync error:', err));
  } catch (error) {
    console.error('[Stripe] Initialization error:', error);
  }
}

// Initialize Stripe (non-blocking)
initStripe();

// Cleanup expired pending signups every hour
setInterval(async () => {
  try {
    const deleted = await storage.deleteExpiredPendingSignups();
    if (deleted > 0) {
      console.log(`[Cleanup] Deleted ${deleted} expired pending signups`);
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning pending signups:', err);
  }
}, 60 * 60 * 1000); // Every hour

// Stripe webhook route - MUST be registered BEFORE express.json()
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error('[Stripe] Webhook body is not a Buffer');
        return res.status(500).json({ error: 'Webhook processing error' });
      }

      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('[Stripe] Webhook error:', error.message);
      res.status(400).json({ error: 'Webhook processing error' });
    }
  }
);

// Session configuration with PostgreSQL store
const PgStore = connectPgSimple(session);

// In production, require SESSION_SECRET - never use a fallback secret
const sessionSecret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === "production" && !sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required in production");
}

// Ensure session table has correct schema for connect-pg-simple
// This drops and recreates the table if the schema is incorrect
async function ensureSessionTableSchema() {
  const client = await pool.connect();
  try {
    const forceRecreate = process.env.FORCE_RECREATE_SESSION_TABLE === 'true';
    
    const schemaResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_name = 'session'
      ORDER BY ordinal_position
    `);
    
    if (schemaResult.rows.length > 0) {
      const sessColumn = schemaResult.rows.find(r => r.column_name === 'sess');
      const detectedType = sessColumn?.data_type;
      
      if (forceRecreate) {
        await recreateSessionTable(client);
      } else if (!sessColumn || detectedType !== 'json') {
        console.log('[Session] Schema mismatch, recreating table...');
        await recreateSessionTable(client);
      } else {
        console.log('[Session] Table schema OK');
      }
    } else {
      console.log('[Session] Creating session table...');
      await recreateSessionTable(client);
    }
  } catch (err) {
    console.error('[Session] Error checking/fixing session table:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function recreateSessionTable(client: any) {
  await client.query('DROP TABLE IF EXISTS session CASCADE');
  await client.query(`
    CREATE TABLE session (
      sid varchar NOT NULL COLLATE "default",
      sess json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS IDX_session_expire ON session(expire)');
  console.log('[Session] Session table recreated with correct schema');
}

// Session middleware setup function - MUST be called after ensureSessionTableSchema
function setupSessionMiddleware() {
  // Check if we're in production with custom domain
  // APP_DOMAIN env var should be set to '.app.aikestar.com' in production
  const isProduction = process.env.NODE_ENV === "production";
  const hasLiveStripe = !!process.env.STRIPE_LIVE_SECRET_KEY;
  const appDomain = process.env.APP_DOMAIN; // e.g., '.app.aikestar.com'
  
  const isProductionDeployment = isProduction && !!appDomain;

  // Cookie attributes:
  //   - Production (app.aikestar.com): Secure + SameSite=Lax. First-party only,
  //     better CSRF posture.
  //   - Dev workspace (*.picard.replit.dev): Secure + SameSite=None. The
  //     workspace renders our app inside a cross-origin iframe (replit.com
  //     → replit.dev), so cookies must be SameSite=None to be accepted and
  //     sent back. SameSite=None requires Secure, which works because the
  //     Replit preview is served over HTTPS (terminated by the proxy; we
  //     have `trust proxy` enabled so Express respects X-Forwarded-Proto).
  // LOCAL_HTTP=true → demo local sobre http://localhost (sin HTTPS). El browser
  // descarta cookies Secure en http, así que las desactivamos en este modo.
  const isLocalHttp = process.env.LOCAL_HTTP === 'true';
  const cookieSameSite: 'lax' | 'none' = (isProductionDeployment || isLocalHttp) ? 'lax' : 'none';
  const cookieSecure = isLocalHttp ? false : true; // both prod and dev preview are HTTPS

  console.log(`[Session] Cookie: secure=${cookieSecure}, sameSite=${cookieSameSite}`);

  app.use(
    session({
      store: new PgStore({
        pool,
        tableName: "session",
        createTableIfMissing: true,
      }),
      secret: sessionSecret || "aikestar-dev-only-insecure-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: cookieSecure,
        httpOnly: true,
        maxAge: SESSION_MAX_AGE,
        sameSite: cookieSameSite,
        path: "/",
        domain: undefined,
      },
      name: "aikestarsid",
    })
  );

  // CHIPS (Cookies Having Independent Partitioned State) shim.
  // In dev the app is rendered inside the Replit workspace iframe (replit.com
  // → replit.dev), which makes our session cookie "third-party". Modern Chrome
  // blocks third-party cookies entirely by default, so even Secure+SameSite=None
  // is not enough — the browser still refuses to send the cookie back.
  // The fix is the `Partitioned` attribute: it opts the cookie into per-top-
  // level-site storage, which Chrome treats as legitimate iframe usage and
  // does NOT block. express-session does not emit `Partitioned`, so we patch
  // the response Set-Cookie header here. Only applied in dev (in production
  // the cookie is first-party and Lax — Partitioned would be wrong there).
  if (!isProductionDeployment && !isLocalHttp) {
    app.use((req, res, next) => {
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = function (name: string, value: any) {
        if (name.toLowerCase() === 'set-cookie') {
          const addPartitioned = (cookieStr: string) => {
            if (!cookieStr.toLowerCase().includes('aikestarsid=')) return cookieStr;
            if (/;\s*partitioned/i.test(cookieStr)) return cookieStr;
            // Partitioned requires Secure + SameSite=None; our session cookie
            // already has both in dev (see cookieSecure / cookieSameSite above).
            return cookieStr + '; Partitioned';
          };
          if (Array.isArray(value)) {
            value = value.map(addPartitioned);
          } else if (typeof value === 'string') {
            value = addPartitioned(value);
          }
        }
        return origSetHeader(name, value);
      } as typeof res.setHeader;
      next();
    });
  }
}

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// CSRF Protection - MUST be set up AFTER session middleware
const { generateToken, csrfSynchronisedProtection } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Function to set up CSRF routes - called AFTER session middleware is configured
function setupCSRFRoutes() {
  app.get('/api/csrf-token', (req, res) => {
    try {
      const token = generateToken(req);
      res.json({ csrfToken: token });
    } catch (err: any) {
      console.error('[CSRF] Error generating token:', err.message);
      res.json({ csrfToken: '' });
    }
  });

  // Apply CSRF protection to all state-changing requests
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api')) {
      if (req.path === '/api/auth/login' || 
          req.path === '/api/auth/register' ||
          req.path === '/api/auth/forgot-password' ||
          req.path === '/api/auth/logout' ||
          req.path === '/api/auth/force-logout' ||
          req.path === '/api/auth/validate-checkout') {
        return next();
      }
      if (req.path.startsWith('/api/stripe/')) {
        return next();
      }
      if (req.path.startsWith('/api/mercadopago/')) {
        return next();
      }
      if (req.path === '/api/tiendanube/webhook') {
        return next();
      }
      if (req.path.startsWith('/api/whatsapp/')) {
        return next();
      }
      return csrfSynchronisedProtection(req, res, (err?: any) => {
        if (err) {
          return res.status(403).json({ 
            message: 'Token CSRF inválido. Por favor recargá la página.',
            code: 'EBADCSRFTOKEN'
          });
        }
        next();
      });
    }
    next();
  });
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  if (!path.startsWith("/api")) {
    return next();
  }

  res.on("finish", () => {
    const duration = Date.now() - start;
    log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
  });

  next();
});

(async () => {
  // CRITICAL: Must ensure session table schema is correct BEFORE setting up session middleware
  console.log('[Server] Starting server initialization...');
  await ensureSessionTableSchema();
  setupSessionMiddleware();
  setupCSRFRoutes(); // MUST be after session middleware
  
  registerObjectStorageRoutes(app);
  await registerRoutes(httpServer, app);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const rawMessage = err.message || "Internal Server Error";

    if (status >= 500) {
      console.error(`[Error] ${status}: ${rawMessage}`, err.stack);
      (req as any).__errorAlerted = true;
      reportSystemError({
        source: 'http',
        statusCode: status,
        message: rawMessage,
        stack: err.stack || null,
        method: req.method,
        path: req.originalUrl,
        userId: (req as any).userId || (req as any).session?.userId || null,
        organizationId: (req as any).organizationId || (req as any).session?.organizationId || null,
        ip: req.ip || (req.headers['x-forwarded-for'] as string) || null,
        userAgent: req.headers['user-agent'] || null,
      });
    }

    const safeMessage = status >= 500 ? 'Error interno del servidor' : rawMessage;
    res.status(status).json({ message: safeMessage });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const nativeExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      if (code === 1) {
        return undefined as never;
      }
      return nativeExit(code);
    }) as typeof process.exit;

    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  async function backfillExpenseSubtypes() {
    const { sql } = await import('drizzle-orm');
    const { DEFAULT_COST_CATEGORIES } = await import('@shared/schema');
    const costNames = DEFAULT_COST_CATEGORIES as readonly string[];
    const costList = costNames.map(n => `'${n}'`).join(',');
    
    const r0 = await db.execute(sql.raw(`
      UPDATE transaction_categories
      SET expense_subtype = 'cost'
      WHERE type = 'expense' AND name IN (${costList}) AND expense_subtype != 'cost'
    `));
    
    const r1a = await db.execute(sql`
      UPDATE transaction_categories
      SET expense_subtype = 'expense'
      WHERE type = 'expense' AND expense_subtype IS NULL
    `);
    
    const r1 = await db.execute(sql`
      UPDATE transactions t
      SET expense_subtype = COALESCE(
        (SELECT tc.expense_subtype FROM transaction_categories tc 
         WHERE tc.name = t.category AND tc.type = 'expense' AND tc.organization_id = t.organization_id
         LIMIT 1),
        'expense'
      )
      WHERE t.type IN ('expense', 'payable')
      AND t.expense_subtype IS NULL
    `);
    
    const r2 = await db.execute(sql.raw(`
      UPDATE transactions
      SET expense_subtype = 'cost'
      WHERE type IN ('expense', 'payable')
      AND category IN (${costList})
      AND expense_subtype != 'cost'
    `));
    
    const total = (r0.rowCount || 0) + (r1a.rowCount || 0) + (r1.rowCount || 0) + (r2.rowCount || 0);
    if (total > 0) {
      log(`[Backfill] Categories: ${r0.rowCount} cost, ${r1a.rowCount} expense defaults. Transactions: ${r1.rowCount} from category, ${r2.rowCount} reclassified to cost.`);
    }
  }

  // Run one-time data migrations
  const { normalizeEmailsToLowercase } = await import('./migrations/0001_normalize_emails_lowercase');
  await normalizeEmailsToLowercase();
  const { addInvoiceSimulatedColumns } = await import('./migrations/0002_invoice_simulated_columns');
  await addInvoiceSimulatedColumns();
  const { addDashboardEmitEmailPrefsColumns } = await import('./migrations/0003_dashboard_emit_email_prefs');
  await addDashboardEmitEmailPrefsColumns();
  const { addInvoiceEmailTrackingColumns } = await import('./migrations/0004_invoice_email_tracking_columns');
  await addInvoiceEmailTrackingColumns();
  const { addClientInvoiceEmailPrefsTable } = await import('./migrations/0005_client_invoice_email_prefs');
  await addClientInvoiceEmailPrefsTable();

  const { addInvoiceEmailRetryCountColumn } = await import('./migrations/0005_invoice_email_retry_count');
  await addInvoiceEmailRetryCountColumn();

  const { addSupplierInvoiceEmailPrefsTable } = await import('./migrations/0006_supplier_invoice_email_prefs');
  await addSupplierInvoiceEmailPrefsTable();

  const { addSupplierIvaConditionColumn } = await import('./migrations/0007_supplier_iva_condition');
  await addSupplierIvaConditionColumn();

  const { addInvoicingAddressPhoneColumns } = await import('./migrations/0008_invoicing_address_phone');
  await addInvoicingAddressPhoneColumns();

  const { addUsersWhatsappDefaultOrgColumn } = await import('./migrations/0009_users_whatsapp_default_org');
  await addUsersWhatsappDefaultOrgColumn();

  const { addPhoneVerificationCodesTable } = await import('./migrations/0010_phone_verification_codes');
  await addPhoneVerificationCodesTable();

  // Backfill: canonicalize legacy Argentine WhatsApp numbers stored as +54xx...
  // into the +549xx... canonical form. Idempotent (WHERE filters out already-canonical rows).
  // Task #190 — runs once at boot so the WhatsApp bot recognizes legacy users
  // without requiring them to re-link their number.
  //
  // IMPORTANT: this MUST run BEFORE migration 0011, because canonicalization can
  // collapse two legacy variants (+5411xxx and +549xxx) of the same logical
  // number into the same value, creating a duplicate. Migration 0011's dedup
  // step then deterministically resolves any conflicts before adding the
  // partial unique index.
  try {
    const { backfillCanonicalPhones } = await import('./jobs/backfillCanonicalPhones');
    await backfillCanonicalPhones();
  } catch (err: any) {
    console.error('[Backfill] WhatsApp phones error:', err?.message || err);
  }

  const { addUsersPhoneVerifiedUniqueIndex } = await import('./migrations/0011_users_phone_verified_unique');
  await addUsersPhoneVerifiedUniqueIndex();

  const { addUsersLastWhatsappMessageAtColumn } = await import('./migrations/0012_users_last_whatsapp_message_at');
  await addUsersLastWhatsappMessageAtColumn();

  const { addUsersPendingPhoneNumberColumn } = await import('./migrations/0013_users_pending_phone_number');
  await addUsersPendingPhoneNumberColumn();

  const { addWhatsappPreferencesOrgBannerIntervalColumn } = await import('./migrations/0014_whatsapp_preferences_org_banner_interval');
  await addWhatsappPreferencesOrgBannerIntervalColumn();

  const { addUsersPhoneNumberAddedAtColumn } = await import('./migrations/0015_users_phone_number_added_at');
  await addUsersPhoneNumberAddedAtColumn();

  const { addPaymentMethodsTables } = await import('./migrations/0016_payment_methods');
  await addPaymentMethodsTables();

  const { addInvoiceEmissionErrorColumns } = await import('./migrations/0017_invoice_emission_error');
  await addInvoiceEmissionErrorColumns();

  const { addInvoicingAdminCuitColumn } = await import('./migrations/0018_invoicing_admin_cuit');
  await addInvoicingAdminCuitColumn();

  const { addAccountsInterestStartDateColumn } = await import('./migrations/0019_accounts_interest_start_date');
  await addAccountsInterestStartDateColumn();

  const { addWhatsappConversationsTable } = await import('./migrations/0020_whatsapp_conversations');
  await addWhatsappConversationsTable();

  const { addUsersEmailPartialUniqueIndex } = await import('./migrations/0021_users_email_partial_unique');
  await addUsersEmailPartialUniqueIndex();

  const { addTransactionsRecurrenceInstallmentsColumns } = await import('./migrations/0022_transactions_recurrence_installments');
  await addTransactionsRecurrenceInstallmentsColumns();
  const { backfillRecurringIncomeExpenseNext } = await import('./migrations/0023_backfill_recurring_income_expense_next');
  await backfillRecurringIncomeExpenseNext();

  const { addArchivedAtColumns } = await import('./migrations/0024_archived_at_columns');
  await addArchivedAtColumns();

  const { createSystemErrorsTable } = await import('./migrations/0025_system_errors');
  await createSystemErrorsTable();

  const { createQuotesTable } = await import('./migrations/0026_quotes');
  await createQuotesTable();

  const { addOrganizationsContactFields } = await import('./migrations/0027_organizations_contact_fields');
  await addOrganizationsContactFields();

  const { addQuotePdfFields } = await import('./migrations/0028_quote_pdf_fields');
  await addQuotePdfFields();

  const { addQuotePdfCompanySenderFields } = await import('./migrations/0029_quote_pdf_company_sender');
  await addQuotePdfCompanySenderFields();

  const { createMrrSnapshotsTable } = await import('./migrations/0030_mrr_snapshots');
  await createMrrSnapshotsTable();

  const { createBusinessSettingsTable } = await import('./migrations/0031_business_settings');
  await createBusinessSettingsTable();

  const { createAcquisitionSpendTable } = await import('./migrations/0032_acquisition_spend');
  await createAcquisitionSpendTable();

  const { addAcquisitionSpendConfigColumns } = await import('./migrations/0033_acquisition_spend_config');
  await addAcquisitionSpendConfigColumns();

  const { createWhatsappLocksTable } = await import('./migrations/0034_whatsapp_locks');
  await createWhatsappLocksTable();

  const { createTransactionItemsTable } = await import('./migrations/0035_transaction_items');
  await createTransactionItemsTable();

  const { createQuoteItemsTable } = await import('./migrations/0036_quote_items');
  await createQuoteItemsTable();

  const { addTermsAcceptedAtColumns } = await import('./migrations/0037_terms_accepted_at');
  await addTermsAcceptedAtColumns();

  const { addProductIvaAliquotColumn } = await import('./migrations/0038_product_iva_aliquot');
  await addProductIvaAliquotColumn();

  const { createWeeklyDigestSendsTable } = await import('./migrations/0039_weekly_digest_sends');
  await createWeeklyDigestSendsTable();

  const { createAccountDeletionsTable } = await import('./migrations/0040_account_deletions');
  await createAccountDeletionsTable();

  const { addMpSubscriptionIdColumns } = await import('./migrations/0041_mp_subscription_id');
  await addMpSubscriptionIdColumns();

  const { createTiendanubeTables } = await import('./migrations/0042_tiendanube');
  await createTiendanubeTables();

  const { addProductsImageUrlColumn } = await import('./migrations/0043_products_image_url');
  await addProductsImageUrlColumn();

  const { createCrmTables } = await import('./migrations/0044_crm');
  await createCrmTables();

  const { createWorkOrderTables } = await import('./migrations/0045_work_orders');
  await createWorkOrderTables();

  // Task #282: barrer conversaciones vencidas (>30 min) cada 5 min para que
  // la tabla no crezca sin límite. El TTL ya se aplica en lecturas; esto
  // es solo limpieza física.
  const { startConversationStateCleanup } = await import('./conversation-state');
  startConversationStateCleanup();

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: process.platform !== "darwin",
    },
    () => {
      log(`serving on port ${port}`);
      startNotificationCron();
      startInvoiceEmailRetryCron();
      startWeeklyDigestCron();
      startWeeklyDigestWakeTrigger();
      startInactiveAccountCleanup();
      startCancelledAccountCleanup();
      startSubscriptionBillingCron();
      startMrrSnapshotCron();
      startTiendanubeReconcileCron();
      startCrmReminderCron();
      runOneTimeCleanup().catch(err => console.error('[Cleanup] Error:', err.message));
      backfillExpenseSubtypes().catch(err => console.error('[Backfill] Error:', err.message));
    },
  );
})();
