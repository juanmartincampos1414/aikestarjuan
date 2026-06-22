import { db } from '../server/db';
import { users, subscriptions } from '../shared/schema';
import { eq, isNull, and, isNotNull } from 'drizzle-orm';
import Stripe from 'stripe';

async function backfillStripeSubscriptions() {
  console.log('[Backfill] Starting Stripe subscription sync...');
  
  const stripeSecretKey = process.env.STRIPE_LIVE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error('[Backfill] No Stripe secret key found');
    process.exit(1);
  }
  
  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2025-11-17.clover' });
  
  const usersWithoutStripeSubscriptionId = await db.select()
    .from(users)
    .where(isNull(users.stripeSubscriptionId));
  
  console.log(`[Backfill] Found ${usersWithoutStripeSubscriptionId.length} users without stripeSubscriptionId`);
  
  let linked = 0;
  let notFound = 0;
  let errors = 0;
  
  for (const user of usersWithoutStripeSubscriptionId) {
    try {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      
      if (customers.data.length === 0) {
        console.log(`[Backfill] No Stripe customer found for: ${user.email}`);
        notFound++;
        continue;
      }
      
      const customer = customers.data[0];
      const subs = await stripe.subscriptions.list({ 
        customer: customer.id, 
        status: 'active',
        limit: 1 
      });
      
      if (subs.data.length === 0) {
        console.log(`[Backfill] No active subscription for: ${user.email}`);
        notFound++;
        continue;
      }
      
      const sub = subs.data[0];
      const priceId = sub.items.data[0]?.price?.id;
      
      await db.update(users)
        .set({ 
          stripeCustomerId: customer.id,
          stripeSubscriptionId: sub.id,
        })
        .where(eq(users.id, user.id));
      
      const localSub = await db.select()
        .from(subscriptions)
        .where(eq(subscriptions.userId, user.id))
        .limit(1);
      
      // Derive planType from Stripe metadata
      let planType = sub.metadata?.planType as string | undefined;
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
      
      if (localSub.length > 0) {
        await db.update(subscriptions)
          .set({
            stripeSubscriptionId: sub.id,
            stripePriceId: priceId,
          })
          .where(eq(subscriptions.id, localSub[0].id));
        console.log(`[Backfill] Updated subscription for ${user.email} -> ${sub.id}`);
      } else {
        await db.insert(subscriptions).values({
          userId: user.id,
          planType,
          status: 'active',
          stripeCustomerId: customer.id,
          stripeSubscriptionId: sub.id,
          stripePriceId: priceId,
          currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end || false,
        });
        console.log(`[Backfill] Created subscription for ${user.email} -> ${sub.id} (${planType})`);
      }
      
      console.log(`[Backfill] Linked ${user.email} -> ${sub.id}`);
      linked++;
      
    } catch (error: any) {
      console.error(`[Backfill] Error for ${user.email}:`, error.message);
      errors++;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('\n[Backfill] Summary:');
  console.log(`  Linked: ${linked}`);
  console.log(`  Not found in Stripe: ${notFound}`);
  console.log(`  Errors: ${errors}`);
  console.log('[Backfill] Done!');
}

backfillStripeSubscriptions().catch(console.error);
