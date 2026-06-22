import Stripe from 'stripe';
import { PLAN_DETAILS, PLAN_LABELS, type PlanType } from '../shared/schema';
import { getStripeSecretKey } from '../server/stripeClient';

async function createStripeProducts() {
  const stripeSecretKey = await getStripeSecretKey();

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2025-01-27.acacia' as any,
  });

  const plans: PlanType[] = ['personal', 'personal_pro', 'solo', 'team', 'business', 'enterprise'];

  console.log('Creating Stripe products and prices...\n');

  for (const planType of plans) {
    const details = PLAN_DETAILS[planType];
    const label = PLAN_LABELS[planType];
    
    try {
      const existingProducts = await stripe.products.search({
        query: `metadata['planType']:'${planType}'`,
      });

      if (existingProducts.data.length > 0) {
        console.log(`✓ Product for ${label} already exists (${existingProducts.data[0].id})`);
        continue;
      }

      const product = await stripe.products.create({
        name: `Aikestar ${label}`,
        description: details.features.slice(0, 3).join('. '),
        metadata: {
          planType: planType,
        },
      });

      console.log(`✓ Created product: ${product.name} (${product.id})`);

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: details.price * 100,
        currency: 'ars',
        recurring: {
          interval: 'month',
        },
        metadata: {
          planType: planType,
        },
      });

      console.log(`  ✓ Created price: ${price.id} - $${details.price}/mes\n`);

    } catch (error: any) {
      console.error(`✗ Error creating ${label}:`, error.message);
    }
  }

  console.log('\nDone! Products created successfully.');
  console.log('Restarting the app will sync products to local database.');
}

createStripeProducts().catch(console.error);
