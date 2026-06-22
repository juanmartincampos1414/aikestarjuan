import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Task #315 — Tests del helper `tryGenerateCurrentMonthCharge`.
//
// Contexto:
//   Cuando el usuario crea o edita un cliente de tipo `suscriptores` desde
//   la página Clientes, esperamos que la cuenta a cobrar del mes corriente
//   se materialice en el acto (sin esperar al cron diario de las 02:15).
//
//   El servicio expone `tryGenerateCurrentMonthCharge(client)`, que envuelve
//   a `generateChargeForClient` con dos contratos extra:
//
//     1) Filtra de antemano clientes que claramente no califican (no son
//        suscriptores, están inactivos, no tienen cantidad, no tienen
//        plan ni precio override). En esos casos devuelve
//        `{ outcome: 'skipped', reason }` sin tocar la DB.
//     2) Es "best-effort": si la generación falla, devuelve
//        `{ outcome: 'error', error }` en lugar de tirar la excepción.
//        La operación primaria (crear/editar cliente) NO debe fallar
//        porque falló el side-effect de cobro.
//
//   Este archivo cubre el primer contrato — las early-returns — porque es
//   donde vive toda la lógica nueva. El segundo contrato (delegar a
//   `generateChargeForClient` cuando los gates pasan) está cubierto en los
//   tests existentes de `generateChargeForClient` y por verificación
//   manual del end-to-end con cliente real.

process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const { tryGenerateCurrentMonthCharge } = await import('../server/services/subscriptionBilling');
import type { Client } from '@shared/schema';

// Base mínima de un Client suscriptor "feliz" para que sólo tengamos que
// sobreescribir el campo que nos interesa en cada test. Tipamos como
// `Partial<Client>` para que TypeScript valide los nombres de campo y
// nos avise si el schema cambia.
type ClientStub = Partial<Client> & { id: string; organizationId: string; name: string };

function makeClient(overrides: Partial<ClientStub> = {}): Client {
  const base: ClientStub = {
    id: 'cli-1',
    organizationId: 'org-1',
    name: 'Cliente Suscriptor',
    clientType: 'suscriptores',
    isActive: true,
    status: 'active',
    subscriberPlanId: 'plan-1',
    subscriberQuantity: 10,
    subscriberUnitPriceOverride: null,
    subscriberCurrencyOverride: null,
    subscriberBillingDay: 3,
    subscriberStartMonth: '2020-01',
    subscriberLastBilledMonth: null,
    ...overrides,
  };
  return base as Client;
}

function skipReason(r: Awaited<ReturnType<typeof tryGenerateCurrentMonthCharge>>): string | null {
  return r.outcome === 'skipped' ? r.reason : null;
}

describe('tryGenerateCurrentMonthCharge — gating (Task #315)', () => {
  it('skip cuando el cliente no es de tipo suscriptores', async () => {
    const result = await tryGenerateCurrentMonthCharge(makeClient({ clientType: 'clientes' }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'not_subscriber');
  });

  it('skip cuando el cliente está marcado isActive=false', async () => {
    // Caso típico: el cliente está pausado/dado de baja. No queremos
    // generarle cobros aunque siga teniendo plan + cantidad cargados.
    const result = await tryGenerateCurrentMonthCharge(makeClient({ isActive: false }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'inactive_client');
  });

  it('skip cuando status === "inactive" explícitamente', async () => {
    // Criterio alineado con `getSubscriberClientsDue` (cron): sólo el status
    // exacto 'inactive' bloquea el cobro. Otros valores (incluyendo
    // 'potential') siguen calificando para que upsert y cron tengan el
    // mismo criterio. Si lo cambiamos en uno, hay que cambiarlo en el otro.
    const result = await tryGenerateCurrentMonthCharge(makeClient({ status: 'inactive' }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'inactive_client');
  });

  it('NO skipea cuando status no es "inactive" pero tampoco "active" (ej: "potential")', async () => {
    // Espejo del comportamiento del cron: si el cliente está en otro
    // estado (potential, etc) pero isActive=true, debe pasar los gates
    // y delegar al servicio.
    const result = await tryGenerateCurrentMonthCharge(makeClient({ status: 'potential' }));
    assert.notEqual(skipReason(result), 'inactive_client');
  });

  it('skip cuando no hay cantidad de suscriptores cargada', async () => {
    const result = await tryGenerateCurrentMonthCharge(makeClient({ subscriberQuantity: null }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'no_quantity');
  });

  it('skip cuando la cantidad es 0', async () => {
    const result = await tryGenerateCurrentMonthCharge(makeClient({ subscriberQuantity: 0 }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'no_quantity');
  });

  it('skip cuando no hay plan ni precio override', async () => {
    // Sin plan asignado y sin precio manual no podemos calcular el cobro.
    // El gate evita un round-trip a la DB para buscar un plan que no existe.
    const result = await tryGenerateCurrentMonthCharge(makeClient({
      subscriberPlanId: null,
      subscriberUnitPriceOverride: null,
    }));
    assert.equal(result.outcome, 'skipped');
    assert.equal(skipReason(result), 'no_price');
  });

  it('NO skipea cuando hay precio override sin plan (pasa al servicio)', async () => {
    // Con override de precio pero sin plan, los gates iniciales pasan y el
    // helper delega a `generateChargeForClient`. La delegación podrá fallar
    // por otras razones (sin DB, conexión, etc), pero el gate no es la que
    // bloquea. Acá basta verificar que NO sea uno de los motivos de skip
    // tempranos.
    const result = await tryGenerateCurrentMonthCharge(makeClient({
      subscriberPlanId: null,
      subscriberUnitPriceOverride: '8999.00',
    }));
    const reason = skipReason(result);
    if (reason !== null) {
      assert.ok(
        !['no_price', 'not_subscriber', 'inactive_client', 'no_quantity'].includes(reason),
        `gate temprano disparó indebidamente: ${reason}`,
      );
    }
  });
});
