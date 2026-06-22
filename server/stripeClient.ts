import Stripe from 'stripe';

interface StripeCredentials {
  publishableKey: string;
  secretKey: string;
  isLiveMode: boolean;
}

let connectionSettings: any;
let cachedCredentials: StripeCredentials | null = null;

export function invalidateStripeCache() {
  console.log('[Stripe] Invalidating credentials cache');
  cachedCredentials = null;
}

async function getCredentials(options?: { forceLiveMode?: boolean; forceTestMode?: boolean }) {
  const isProduction = process.env.NODE_ENV === 'production';
  const forceLive = options?.forceLiveMode === true;
  const forceTest = options?.forceTestMode === true;
  
  // Validate: can't force both modes simultaneously
  if (forceLive && forceTest) {
    throw new Error('[Stripe] Cannot force both Live and Test mode simultaneously');
  }
  
  // Check for Live mode keys
  const liveSecretKey = process.env.STRIPE_LIVE_SECRET_KEY?.trim();
  const livePublishableKey = process.env.STRIPE_LIVE_PUBLISHABLE_KEY?.trim();
  
  // If forceLiveMode is true and we don't have live keys, that's an error
  if (forceLive && (!liveSecretKey || !livePublishableKey)) {
    throw new Error('[Stripe] Live mode requested but STRIPE_LIVE_SECRET_KEY/STRIPE_LIVE_PUBLISHABLE_KEY not configured');
  }
  
  // If forceTestMode is true, skip Live credentials and use Replit connector
  if (forceTest) {
    console.log('[Stripe] Test mode explicitly requested - skipping Live credentials');
    // Fall through to Replit connector logic below
  } else if (liveSecretKey && livePublishableKey) {
    // Use Live credentials when available (and not forcing test mode)
    // In production, require webhook secret too (prefer STRIPE_LIVE_WEBHOOK_SECRET)
    if (isProduction) {
      const webhookSecret = process.env.STRIPE_LIVE_WEBHOOK_SECRET?.trim() || process.env.STRIPE_WEBHOOK_SECRET?.trim();
      if (!webhookSecret) {
        console.error('[STRIPE PRODUCTION ERROR] Missing STRIPE_LIVE_WEBHOOK_SECRET');
        throw new Error('Missing STRIPE_LIVE_WEBHOOK_SECRET for production');
      }
    }
    
    console.log('[Stripe] Using Live mode credentials from environment (key starts with:', liveSecretKey.substring(0, 10) + '...)');
    return {
      publishableKey: livePublishableKey,
      secretKey: liveSecretKey,
      isLiveMode: true,
    };
  }
  
  // In production, Live keys are required
  if (isProduction) {
    const errorMsg = `[STRIPE PRODUCTION ERROR] Missing required Live mode credentials. ` +
      'Payments will NOT work until STRIPE_LIVE_SECRET_KEY and STRIPE_LIVE_PUBLISHABLE_KEY are configured.';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // In development without Live keys, use Replit connector (Test mode)
  if (cachedCredentials) {
    return cachedCredentials;
  }

  // Fallback to Replit connector
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  const connectorName = 'stripe';
  const targetEnvironment = isProduction ? 'production' : 'development';

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set('include_secrets', 'true');
  url.searchParams.set('connector_names', connectorName);
  url.searchParams.set('environment', targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X_REPLIT_TOKEN': xReplitToken
    }
  });

  const data = await response.json();
  
  connectionSettings = data.items?.[0];

  if (!connectionSettings || (!connectionSettings.settings.publishable || !connectionSettings.settings.secret)) {
    throw new Error(`Stripe ${targetEnvironment} connection not found`);
  }

  cachedCredentials = {
    publishableKey: connectionSettings.settings.publishable,
    secretKey: connectionSettings.settings.secret,
    isLiveMode: false,
  };
  
  console.log('[Stripe] Using Test mode credentials from Replit connector');
  return cachedCredentials;
}

export async function getUncachableStripeClient(options?: { forceLiveMode?: boolean; forceTestMode?: boolean }) {
  const creds = await getCredentials(options);
  console.log('[Stripe] Creating Stripe client - isLiveMode:', creds.isLiveMode);
  return new Stripe(creds.secretKey);
}

export async function getLiveStripeClient() {
  return getUncachableStripeClient({ forceLiveMode: true });
}

export async function getStripePublishableKey() {
  const { publishableKey } = await getCredentials();
  return publishableKey;
}

export async function getStripeSecretKey() {
  const { secretKey } = await getCredentials();
  return secretKey;
}

let stripeSync: any = null;

// Only used in development - in production we skip stripe-replit-sync
export async function getStripeSync() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    throw new Error('getStripeSync should not be called in production');
  }
  
  if (!stripeSync) {
    const { StripeSync } = await import('stripe-replit-sync');
    const secretKey = await getStripeSecretKey();

    stripeSync = new StripeSync({
      poolConfig: {
        connectionString: process.env.DATABASE_URL!,
        max: 2,
      },
      stripeSecretKey: secretKey,
    });
  }
  return stripeSync;
}
