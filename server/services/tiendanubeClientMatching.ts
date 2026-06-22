// =============================================================================
// AIKESTAR - Matching de clientes de Tiendanube
// =============================================================================
// Resuelve el cliente de Aikestar para un cliente de Tiendanube:
//  - Si ya está vinculado (externalId) → lo usa.
//  - Si hay UN match por email/doc/teléfono → auto-vincula.
//  - Si NO hay match → crea un cliente nuevo.
//  - Si hay AMBIGÜEDAD (varios matches) → encola en la cola de revisión y deja
//    el pedido sin cliente hasta que un humano resuelva.
// =============================================================================
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { clients, type Client, type TiendanubeConnection } from '@shared/schema';
import { storage } from '../storage';
import { createClientMatch } from './tiendanubeStore';

export interface ExternalCustomer {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
}

export interface MatchResult {
  clientId: string | null;
  pendingMatchId?: string;
  created?: boolean;
  autoLinked?: boolean;
}

const norm = (v?: string | null) => (v || '').trim().toLowerCase();

export async function resolveClient(
  connection: TiendanubeConnection,
  customer: ExternalCustomer,
): Promise<MatchResult> {
  const orgId = connection.organizationId;
  const all = await storage.getClientsByOrganization(orgId);

  // 1) ¿Ya vinculado por externalId?
  const linked = all.find(
    (c) => c.externalSource === 'tiendanube' && c.externalId === customer.id,
  );
  if (linked) return { clientId: linked.id };

  // 2) Candidatos por email / doc / teléfono
  const email = norm(customer.email);
  const taxId = norm(customer.taxId);
  const phone = norm(customer.phone);
  const candidates = all.filter((c) => {
    return (
      (email && norm(c.email) === email) ||
      (taxId && norm(c.taxId) === taxId) ||
      (phone && norm(c.phone) === phone)
    );
  });
  const uniqueCandidates = dedupeById(candidates);

  if (uniqueCandidates.length === 1) {
    const target = uniqueCandidates[0];
    // Auto-vincula: marca externalId/externalSource si no estaba seteado.
    if (!target.externalId) {
      await db.update(clients)
        .set({ externalId: customer.id, externalSource: 'tiendanube', updatedAt: new Date() })
        .where(eq(clients.id, target.id));
    }
    return { clientId: target.id, autoLinked: true };
  }

  if (uniqueCandidates.length === 0) {
    // 3) Crear cliente nuevo
    const created = await storage.createClient({
      organizationId: orgId,
      name: customer.name || customer.email || 'Cliente Tiendanube',
      email: customer.email || null,
      phone: customer.phone || null,
      taxId: customer.taxId || null,
      externalId: customer.id,
      externalSource: 'tiendanube',
    } as any);
    return { clientId: created.id, created: true };
  }

  // 4) Ambigüedad → cola de revisión (deja el pedido sin cliente por ahora)
  const match = await createClientMatch({
    connectionId: connection.id,
    organizationId: orgId,
    externalCustomerId: customer.id,
    externalData: { name: customer.name, email: customer.email, phone: customer.phone, taxId: customer.taxId } as any,
    candidateClientId: uniqueCandidates[0].id,
    status: 'pending',
  });
  return { clientId: null, pendingMatchId: match.id };
}

function dedupeById(list: Client[]): Client[] {
  const seen = new Set<string>();
  const out: Client[] = [];
  for (const c of list) {
    if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}
