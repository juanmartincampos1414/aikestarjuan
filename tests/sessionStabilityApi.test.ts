// Regression guard — client/src/lib/api.ts session-stability.
//
// Task #318 reviewer requirement: dashboard 4xx genérico (no 401, no
// USER_DELETED) NO debe limpiar sesión ni redirigir a /login. La regresión
// histórica fue: el handler de 401 hacía `window.location.href = '/login'`
// ante CUALQUIER 401, y el de 402 NO se ejecutaba para `skipAuthRedirect=true`.
// Resultado: usuarios con pago rechazado caían a /login en vez de a
// /subscription-required, y cualquier 4xx transitorio (DB hiccup, race tras
// session save) sacaba a usuarios pagos.
//
// Este test es un análisis estático sobre client/src/lib/api.ts y rompe si:
//   1. El handler de 401 vuelve a hacer un hard redirect a /login.
//   2. El handler de 402 vuelve a estar gated por `!skipAuthRedirect`.
//   3. Aparece un `window.location.href = '/login'` fuera del flujo
//      USER_DELETED documentado.
//   4. Hay una rama `if (response.status >= 400)` o similar que limpie
//      tokens / queryClient para todo 4xx.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_FILE = join(process.cwd(), 'client', 'src', 'lib', 'api.ts');
const source = readFileSync(API_FILE, 'utf8');

describe('api.ts — session-stability invariants (Task #318)', () => {
  it('el handler de 401 no hace hard redirect a /login (soft handling vía queryClient)', () => {
    // Localizamos el bloque "response.status === 401".
    const idx = source.indexOf('response.status === 401');
    assert.ok(idx >= 0, 'No se encontró el branch de 401 en api.ts');
    // Tomamos los siguientes ~1500 chars como cuerpo aproximado.
    const block = source.slice(idx, idx + 1500);
    assert.equal(
      /window\.location\.href\s*=\s*['"`]\/login/.test(block),
      false,
      'El handler de 401 no debe hacer hard redirect a /login (rompe sesión de usuarios pagos en 401 transitorios).',
    );
    // Debe invalidar la query de usuario en su lugar.
    assert.ok(
      /invalidateQueries[\s\S]*?\['user'\]/.test(block),
      'El handler de 401 debe invalidar la query [\'user\'] para que App.tsx re-chequee auth.',
    );
  });

  it('el handler de 402 NO está gated por skipAuthRedirect (siempre redirige a /subscription-required)', () => {
    // Buscamos el if del 402.
    const m = source.match(/if\s*\(\s*response\.status\s*===\s*402([^)]*)\)/);
    assert.ok(m, 'No se encontró el branch de 402 en api.ts');
    const condition = m[1];
    assert.equal(
      /skipAuthRedirect/.test(condition),
      false,
      'El branch de 402 no debe depender de skipAuthRedirect — el query de /api/user lo usa con skipAuthRedirect=true y de lo contrario el usuario bloqueado se queda en pantalla blanca.',
    );
  });

  it('el redirect a /subscription-required del 402 evita loop en la propia página', () => {
    const idx = source.indexOf('response.status === 402');
    const block = source.slice(idx, idx + 2000);
    assert.ok(
      /window\.location\.pathname\s*!==\s*['"`]\/subscription-required['"`]/.test(block),
      'El branch de 402 debe evitar navegar si ya estamos en /subscription-required (anti-loop).',
    );
  });

  it('no hay un branch genérico que limpie tokens/queryClient ante cualquier 4xx', () => {
    // Lista negra de patrones que indicarían un manejo demasiado agresivo
    // de errores 4xx genéricos.
    const offenders: string[] = [];

    // `response.status >= 400` seguido (cerca) por clearCSRFToken /
    // invalidateQueries / removeQueries / window.location.href.
    const range = />=\s*400[\s\S]{0,400}(clearCSRFToken|invalidateQueries|removeQueries|window\.location\.href)/;
    if (range.test(source)) {
      offenders.push('response.status >= 400 con cleanup global asociado');
    }

    // `response.status >= 400` que tire siempre throw genérico
    // borrando el body (no es lo mismo que el patrón de arriba, pero
    // también queremos que el cliente conserve el mensaje del server).
    // No es regresivo per se, sólo lo dejamos documentado.

    if (offenders.length > 0) {
      assert.fail(
        `api.ts tiene manejo demasiado agresivo de 4xx genérico — esto saca a usuarios pagos del sistema en errores transitorios:\n` +
          offenders.map((o) => `  - ${o}`).join('\n'),
      );
    }
  });

  it('no quedan window.location.href = "/login" en api.ts (regresión Task #309/#318)', () => {
    const matches = [...source.matchAll(/window\.location\.href\s*=\s*['"`]([^'"`]+)['"`]/g)];
    const loginRedirects = matches.filter((m) => m[1].startsWith('/login'));
    assert.equal(
      loginRedirects.length,
      0,
      `Se encontraron ${loginRedirects.length} redirect(s) duros a /login en api.ts: ` +
        loginRedirects.map((m) => m[1]).join(', ') +
        '. App.tsx ya redirige basado en el estado del query [\'user\'].',
    );
  });
});
