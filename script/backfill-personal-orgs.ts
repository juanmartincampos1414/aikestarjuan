import { db } from '../server/db';
import { users, organizations, memberships, categories } from '../shared/schema';
import { eq, and, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_CATEGORIES = [
  // Income categories
  { name: 'Ventas', type: 'income' as const, isDefault: true },
  { name: 'Servicios', type: 'income' as const, isDefault: true },
  { name: 'Comisiones', type: 'income' as const, isDefault: true },
  { name: 'Inversiones', type: 'income' as const, isDefault: true },
  { name: 'Otros ingresos', type: 'income' as const, isDefault: true },
  // Expense categories
  { name: 'Proveedores', type: 'expense' as const, isDefault: true },
  { name: 'Salarios', type: 'expense' as const, isDefault: true },
  { name: 'Alquiler', type: 'expense' as const, isDefault: true },
  { name: 'Servicios públicos', type: 'expense' as const, isDefault: true },
  { name: 'Marketing', type: 'expense' as const, isDefault: true },
  { name: 'Impuestos', type: 'expense' as const, isDefault: true },
  { name: 'Otros gastos', type: 'expense' as const, isDefault: true },
];

async function backfillPersonalOrgs() {
  console.log('Starting backfill of personal organizations...');
  
  // Find all business users without a personal org
  const businessUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.accountType, 'business'));
  
  console.log(`Found ${businessUsers.length} business users`);
  
  for (const user of businessUsers) {
    // Check if user already has a personal org
    const existingPersonalOrg = await db
      .select({ id: organizations.id })
      .from(organizations)
      .innerJoin(memberships, eq(organizations.id, memberships.organizationId))
      .where(and(
        eq(memberships.userId, user.id),
        eq(organizations.type, 'personal')
      ))
      .limit(1);
    
    if (existingPersonalOrg.length > 0) {
      console.log(`User ${user.email} already has personal org, skipping`);
      continue;
    }
    
    // Get user's country from their first business org
    const firstOrg = await db
      .select({ country: organizations.country, defaultCurrency: organizations.defaultCurrency })
      .from(organizations)
      .innerJoin(memberships, eq(organizations.id, memberships.organizationId))
      .where(eq(memberships.userId, user.id))
      .limit(1);
    
    const country = firstOrg[0]?.country || 'AR';
    const defaultCurrency = firstOrg[0]?.defaultCurrency || 'ARS';
    
    // Create personal org
    const orgId = uuidv4();
    await db.insert(organizations).values({
      id: orgId,
      name: `Finanzas de ${user.name}`,
      type: 'personal',
      country,
      defaultCurrency,
    });
    
    // Create membership
    await db.insert(memberships).values({
      id: uuidv4(),
      userId: user.id,
      organizationId: orgId,
      role: 'owner',
    });
    
    // Seed categories
    for (const cat of DEFAULT_CATEGORIES) {
      await db.insert(categories).values({
        id: uuidv4(),
        name: cat.name,
        type: cat.type,
        organizationId: orgId,
        createdBy: user.id,
        isDefault: cat.isDefault,
      });
    }
    
    console.log(`Created personal org for ${user.email}`);
  }
  
  console.log('Backfill complete!');
  process.exit(0);
}

backfillPersonalOrgs().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
