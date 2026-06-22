// Task #318 — Regression guard sobre la cadena de fallback de
// `POST /api/stripe/create-portal-session-blocked` en
// `server/routes/stripe.ts`.
//
// Contrato que cubre este test (estático sobre la fuente, igual que
// `fetchWithAuthEndpointPrefix.test.ts` y `sessionStabilityApi.test.ts`):
//
//   portal → checkout(priceId de Stripe sub.retrieve)
//          → checkout(priceId resuelto desde planType local)
//          → /pricing?recover=1
//
// Un test de integración HTTP real requeriría stubear el SDK de Stripe a
// nivel módulo (no funciona limpio en ESM) y stubear el storage, lo cual
// vuelve frágil el test ante refactors menores. La cadena de fallback es
// una secuencia de bloques `try/catch` muy específicos en una sola
// función — un test estructural sobre la fuente la fija exactamente igual
// y rompe si alguien rompe el orden o saca un escalón.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STRIPE_FILE = join(process.cwd(), 'server', 'routes', 'stripe.ts');
const source = readFileSync(STRIPE_FILE, 'utf8');

function blockBody(start: string, end: string): string {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `No se encontró "${start}" en stripe.ts`);
  const j = source.indexOf(end, i);
  assert.ok(j > i, `No se encontró fin "${end}" después de "${start}"`);
  return source.slice(i, j);
}

describe('/api/stripe/create-portal-session-blocked — fallback chain (Task #318)', () => {
  const endpoint = '/api/stripe/create-portal-session-blocked';

  it('el endpoint existe y usa requireAuthOnly (bypasea el check de suscripción)', () => {
    const re = new RegExp(`['"\`]${endpoint.replace(/\//g, '\\/')}['"\`]\\s*,\\s*requireAuthOnly`);
    assert.ok(re.test(source), `Falta el endpoint ${endpoint} con requireAuthOnly`);
  });

  // Aislamos el body del handler para los chequeos siguientes.
  const handlerBody = (() => {
    const i = source.indexOf("'/api/stripe/create-portal-session-blocked'");
    assert.ok(i >= 0);
    // Tomamos hasta el siguiente `app.` (próxima ruta) o ~5000 chars.
    const j = source.indexOf('  app.', i + 50);
    return source.slice(i, j > 0 ? j : i + 5000);
  })();

  it('paso 1: intenta `billingPortal.sessions.create` y responde mode=portal', () => {
    assert.match(
      handlerBody,
      /billingPortal\.sessions\.create\([\s\S]*?return_url[\s\S]*?mode:\s*['"`]portal['"`]/,
      'Falta el intento de billing portal o no responde mode=portal',
    );
  });

  it('paso 2: en el catch del portal, intenta `subscriptions.retrieve` para extraer priceId', () => {
    assert.match(
      handlerBody,
      /catch[\s\S]*?subscriptions\.retrieve\(\s*user\.stripeSubscriptionId\s*\)[\s\S]*?priceId\s*=\s*item\.price\.id/,
      'Falta el fallback que extrae priceId desde stripe.subscriptions.retrieve',
    );
  });

  it('paso 3 (caso Tomy): si priceId aún es null, resuelve desde planType local + products.list', () => {
    // El bloque crítico: `if (!priceId)` seguido por
    // `storage.getSubscriptionByUserId` y `products.list`.
    assert.match(
      handlerBody,
      /if\s*\(\s*!\s*priceId\s*\)[\s\S]*?storage\.getSubscriptionByUserId[\s\S]*?products\.list[\s\S]*?metadata\?\.planType\s*===\s*planType[\s\S]*?prices\.list/,
      'Falta el fallback que resuelve priceId desde el planType local cuando la suscripción ya no existe en Stripe',
    );
  });

  it('paso 4: si priceId quedó resuelto, crea `checkout.sessions.create` y responde mode=checkout', () => {
    assert.match(
      handlerBody,
      /if\s*\(\s*priceId\s*\)[\s\S]*?checkout\.sessions\.create[\s\S]*?mode:\s*['"`]checkout['"`]/,
      'Falta la creación del checkout con priceId fallback o el mode=checkout en la respuesta',
    );
  });

  it('paso 5: última red de seguridad → mode=pricing con url /pricing', () => {
    assert.match(
      handlerBody,
      /\/pricing[^'"`]*['"`]\s*,\s*mode:\s*['"`]pricing['"`]/,
      'Falta la red de seguridad que redirige al usuario a /pricing si no se pudo resolver ningún priceId',
    );
  });

  it('el orden de los pasos en la fuente es portal → retrieve → planType local → checkout → pricing', () => {
    const indices = {
      portal: handlerBody.indexOf('billingPortal.sessions.create'),
      retrieve: handlerBody.indexOf('subscriptions.retrieve'),
      planType: handlerBody.indexOf('getSubscriptionByUserId'),
      checkout: handlerBody.indexOf('checkout.sessions.create'),
      pricing: handlerBody.indexOf("mode: 'pricing'"),
    };
    for (const [name, idx] of Object.entries(indices)) {
      assert.ok(idx > 0, `Paso "${name}" no encontrado en el handler`);
    }
    assert.ok(indices.portal < indices.retrieve, 'portal debe ir antes de retrieve');
    assert.ok(indices.retrieve < indices.planType, 'retrieve debe ir antes del fallback por planType');
    assert.ok(indices.planType < indices.checkout, 'el fallback por planType debe ir antes del checkout.sessions.create');
    assert.ok(indices.checkout < indices.pricing, 'la creación del checkout debe ir antes de la red de seguridad /pricing');
  });
});
