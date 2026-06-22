import { getUncachableStripeClient } from '../server/stripeClient';

const AIKESTAR_PLANS = [
  {
    name: 'Personal',
    description: 'Para finanzas personales. 1 organización.',
    price: 899900,
    metadata: {
      planType: 'personal',
      maxOrgs: '1',
      maxMembersPerOrg: '1',
      isTeamPlan: 'false'
    }
  },
  {
    name: 'Personal Pro',
    description: 'Finanzas personales avanzadas. Hasta 3 organizaciones.',
    price: 1499900,
    metadata: {
      planType: 'personal_pro',
      maxOrgs: '3',
      maxMembersPerOrg: '1',
      isTeamPlan: 'false'
    }
  },
  {
    name: 'Solo',
    description: 'Para emprendedores. 1 organización, hasta 3 miembros.',
    price: 1299900,
    metadata: {
      planType: 'solo',
      maxOrgs: '1',
      maxMembersPerOrg: '3',
      isTeamPlan: 'true'
    }
  },
  {
    name: 'Team',
    description: 'Para equipos pequeños. 3 organizaciones, 5 miembros por org.',
    price: 2499900,
    metadata: {
      planType: 'team',
      maxOrgs: '3',
      maxMembersPerOrg: '5',
      isTeamPlan: 'true'
    }
  },
  {
    name: 'Business',
    description: 'Para empresas. 5 organizaciones, 10 miembros por org.',
    price: 4999900,
    metadata: {
      planType: 'business',
      maxOrgs: '5',
      maxMembersPerOrg: '10',
      isTeamPlan: 'true'
    }
  },
  {
    name: 'Enterprise',
    description: 'Para grandes empresas. 15 organizaciones, 50 miembros por org.',
    price: 8999900,
    metadata: {
      planType: 'enterprise',
      maxOrgs: '15',
      maxMembersPerOrg: '50',
      isTeamPlan: 'true'
    }
  }
];

async function seedProducts() {
  console.log('Starting Stripe products seed...');
  
  const stripe = await getUncachableStripeClient();
  
  for (const plan of AIKESTAR_PLANS) {
    try {
      const existingProducts = await stripe.products.search({
        query: `name:'${plan.name}' AND metadata['planType']:'${plan.metadata.planType}'`
      });

      if (existingProducts.data.length > 0) {
        console.log(`Plan "${plan.name}" already exists, skipping...`);
        continue;
      }

      const product = await stripe.products.create({
        name: plan.name,
        description: plan.description,
        metadata: plan.metadata,
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.price,
        currency: 'ars',
        recurring: { interval: 'month' },
        metadata: {
          planType: plan.metadata.planType
        }
      });

      console.log(`Created: ${plan.name} (${product.id}) - Price: ${price.id}`);
    } catch (error: any) {
      console.error(`Error creating ${plan.name}:`, error.message);
    }
  }

  console.log('Seed completed!');
}

seedProducts().catch(console.error);
