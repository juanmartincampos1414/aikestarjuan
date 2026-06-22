// Crea un usuario demo + organización + membership + suscripción activa,
// saltando el flujo de Stripe, para poder entrar al dashboard localmente.
import bcrypt from 'bcryptjs';
import { storage } from './server/storage.ts';

const EMAIL = 'demo@aikestar.local';
const PASSWORD = 'Demo1234!';

const existing = await storage.getUserByEmail(EMAIL);
if (existing) {
  console.log('Ya existe el usuario demo:', EMAIL);
  process.exit(0);
}

const hashed = await bcrypt.hash(PASSWORD, 10);
const user = await storage.createUser({
  email: EMAIL,
  name: 'Usuario Demo',
  password: hashed,
  accountType: 'business',
  country: 'AR',
  // dummy para que el login NO intente reconciliar con Stripe
  stripeSubscriptionId: 'sub_demo_local',
  stripeCustomerId: 'cus_demo_local',
});
console.log('Usuario creado:', user.id);

const org = await storage.createOrganization({
  name: 'Empresa Demo SRL',
  ownerId: user.id,
  country: 'AR',
});
console.log('Organización creada:', org.id);

await storage.createMembership({
  userId: user.id,
  organizationId: org.id,
  role: 'owner',
});
console.log('Membership owner creada');

try {
  await storage.createSubscription({
    userId: user.id,
    planType: 'business',
    status: 'active',
    stripeCustomerId: 'cus_demo_local',
    stripeSubscriptionId: 'sub_demo_local',
    stripePriceId: 'price_demo_local',
    currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });
  console.log('Suscripción activa creada');
} catch (e) {
  console.log('Aviso suscripción:', e.message);
}

console.log('\n=== LISTO ===');
console.log('Email:', EMAIL);
console.log('Password:', PASSWORD);
process.exit(0);
