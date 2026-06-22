import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Task #209 — banner de organización activa al inicio de cada conversación
// de WhatsApp. Cubre el módulo `whatsappSessionState` que decide cuándo
// mostrar el banner ("nueva sesión" o gap > N horas) y los helpers de
// formato y detección de "qué org".
//
// Task #210 — el intervalo del banner pasó a ser configurable por usuario+org.
// Ver tests al final de este archivo.
//
// Task #211 — la "última actividad" ahora vive en DB
// (`users.lastWhatsappMessageAt`) en vez de un Map in-memory, así que
// `shouldShowOrgBanner` se volvió una función pura que recibe el
// timestamp persistido (Date | number | null | undefined).

const {
  shouldShowOrgBanner,
  buildOrgBannerMessage,
  detectShowCurrentOrgRequest,
  resolveOrgBannerGapMs,
  SESSION_GAP_MS,
  DEFAULT_SESSION_GAP_MS,
  DEFAULT_ORG_BANNER_INTERVAL_HOURS,
} = await import('../server/lib/whatsappSessionState');

describe('whatsappSessionState — banner de org activa', () => {
  it('shouldShowOrgBanner devuelve true cuando lastSeen es null/undefined', () => {
    assert.equal(shouldShowOrgBanner(null), true);
    assert.equal(shouldShowOrgBanner(undefined), true);
  });

  it('si lastSeen es ahora, no se muestra inmediatamente', () => {
    const now = 1_000_000_000_000;
    assert.equal(shouldShowOrgBanner(new Date(now), now), false);
    // 5 minutos después tampoco
    assert.equal(shouldShowOrgBanner(new Date(now), now + 5 * 60 * 1000), false);
  });

  it('vuelve a mostrar cuando pasa más de SESSION_GAP_MS desde el último mensaje', () => {
    const now = 1_000_000_000_000;
    const lastSeen = new Date(now);
    // Justo en el límite NO se muestra todavía…
    assert.equal(shouldShowOrgBanner(lastSeen, now + SESSION_GAP_MS), false);
    // …pero un milisegundo más tarde sí.
    assert.equal(shouldShowOrgBanner(lastSeen, now + SESSION_GAP_MS + 1), true);
  });

  it('acepta lastSeen como number (timestamp en ms) además de Date', () => {
    const now = 1_000_000_000_000;
    assert.equal(shouldShowOrgBanner(now, now), false);
    assert.equal(shouldShowOrgBanner(now, now + SESSION_GAP_MS + 1), true);
  });

  it('SESSION_GAP_MS es de varias horas (no minutos) para no ser molesto', () => {
    // Sanity check: si alguien lo baja a 1 minuto sin querer, esto rompe.
    assert.ok(SESSION_GAP_MS >= 60 * 60 * 1000, 'gap mínimo razonable: 1h');
  });

  it('DEFAULT_SESSION_GAP_MS y SESSION_GAP_MS están alineados con DEFAULT_ORG_BANNER_INTERVAL_HOURS', () => {
    assert.equal(SESSION_GAP_MS, DEFAULT_SESSION_GAP_MS);
    assert.equal(DEFAULT_ORG_BANNER_INTERVAL_HOURS, 6);
    assert.equal(DEFAULT_SESSION_GAP_MS, 6 * 60 * 60 * 1000);
  });
});

describe('buildOrgBannerMessage — formato del recordatorio', () => {
  it('incluye el nombre de la org y la pista de "cambiar org"', () => {
    const msg = buildOrgBannerMessage('JC Marketing');
    assert.match(msg, /JC Marketing/);
    assert.match(msg, /cambiar org/i);
  });
});

describe('detectShowCurrentOrgRequest — consulta de org actual', () => {
  it('reconoce variantes comunes en español', () => {
    const positives = [
      'qué org',
      'que org',
      'qué organización',
      'que organizacion',
      'cuál es mi org',
      'cual es mi org',
      'cuál es mi organización',
      'en qué org estoy',
      'en que org estoy',
      'qué org estoy usando',
      'que organizacion estoy usando',
      'qué empresa es la actual',
      'cuál es mi empresa actual',
      'org actual',
      'organización actual',
      'donde estoy registrando',
      'dónde estoy registrando',
      'qué org?',
    ];
    for (const msg of positives) {
      assert.equal(
        detectShowCurrentOrgRequest(msg),
        true,
        `debería detectar: "${msg}"`,
      );
    }
  });

  it('NO matchea pedidos de cambio o listado', () => {
    const negatives = [
      'cambiar org',
      'cambiar a JC',
      'mis organizaciones',
      'cambiar de organización',
      'gasto 500 en supermercado',
      'pagué 1000',
      'hola',
      'qué tal',
      'cuánto gasté',
    ];
    for (const msg of negatives) {
      assert.equal(
        detectShowCurrentOrgRequest(msg),
        false,
        `NO debería detectar: "${msg}"`,
      );
    }
  });
});

// Task #210 — Intervalo del recordatorio configurable por usuario+org.
describe('resolveOrgBannerGapMs — convierte la preferencia (en horas) a gap en ms', () => {
  it('null/undefined devuelven el default (6 h)', () => {
    assert.equal(resolveOrgBannerGapMs(null), DEFAULT_SESSION_GAP_MS);
    assert.equal(resolveOrgBannerGapMs(undefined), DEFAULT_SESSION_GAP_MS);
  });

  it('0 significa "no mostrar nunca" (devuelve null)', () => {
    assert.equal(resolveOrgBannerGapMs(0), null);
  });

  it('un entero positivo se convierte a horas en ms', () => {
    assert.equal(resolveOrgBannerGapMs(1), 60 * 60 * 1000);
    assert.equal(resolveOrgBannerGapMs(3), 3 * 60 * 60 * 1000);
    assert.equal(resolveOrgBannerGapMs(12), 12 * 60 * 60 * 1000);
    assert.equal(resolveOrgBannerGapMs(24), 24 * 60 * 60 * 1000);
  });

  it('valores negativos (defensivo) caen al default', () => {
    assert.equal(resolveOrgBannerGapMs(-5), DEFAULT_SESSION_GAP_MS);
  });
});

describe('shouldShowOrgBanner — respeta el gap configurado por org', () => {
  // Task #211: ahora `shouldShowOrgBanner` recibe `lastSeen` directamente,
  // así que los tests pasan el timestamp como argumento en vez de usar
  // un Map in-memory.
  const now = 1_700_000_000_000;

  it('con gap de 1h, vuelve a mostrar después de 1h y un ms', () => {
    const oneHour = 60 * 60 * 1000;
    const lastSeen = new Date(now);
    // Justo en el límite, todavía no.
    assert.equal(shouldShowOrgBanner(lastSeen, now + oneHour, oneHour), false);
    // Un ms más tarde, sí.
    assert.equal(shouldShowOrgBanner(lastSeen, now + oneHour + 1, oneHour), true);
    // Antes de la hora, claramente no.
    assert.equal(shouldShowOrgBanner(lastSeen, now + 30 * 60 * 1000, oneHour), false);
  });

  it('con gap de 24h, no vuelve a mostrar dentro del día', () => {
    const oneDay = 24 * 60 * 60 * 1000;
    const lastSeen = new Date(now);
    // 6h después: con default sí mostraría… pero con 24h NO.
    assert.equal(
      shouldShowOrgBanner(lastSeen, now + 6 * 60 * 60 * 1000 + 1, oneDay),
      false,
    );
    // 25h después: sí.
    assert.equal(shouldShowOrgBanner(lastSeen, now + oneDay + 1, oneDay), true);
  });

  it('con gap null ("nunca mostrar"), nunca devuelve true (ni siquiera para usuarios nuevos)', () => {
    // Usuario nunca visto: igual debe devolver false porque la pref dice "nunca".
    assert.equal(shouldShowOrgBanner(null, now, null), false);
    // Usuario visto hace mucho: tampoco.
    const veryOld = new Date(now - 30 * 24 * 60 * 60 * 1000);
    assert.equal(shouldShowOrgBanner(veryOld, now, null), false);
  });

  it('si no se pasa gap, usa el default (back-compat con Task #209)', () => {
    const lastSeen = new Date(now);
    assert.equal(shouldShowOrgBanner(lastSeen, now + DEFAULT_SESSION_GAP_MS), false);
    assert.equal(
      shouldShowOrgBanner(lastSeen, now + DEFAULT_SESSION_GAP_MS + 1),
      true,
    );
  });

  it('integración resolveOrgBannerGapMs + shouldShowOrgBanner', () => {
    const lastSeen = new Date(now);

    // Preferencia: cada 3h.
    const gap3h = resolveOrgBannerGapMs(3);
    assert.equal(shouldShowOrgBanner(lastSeen, now + 2 * 60 * 60 * 1000, gap3h), false);
    assert.equal(shouldShowOrgBanner(lastSeen, now + 3 * 60 * 60 * 1000 + 1, gap3h), true);

    // Preferencia: nunca.
    const gapNever = resolveOrgBannerGapMs(0);
    assert.equal(shouldShowOrgBanner(null, now, gapNever), false);
    assert.equal(shouldShowOrgBanner(lastSeen, now, gapNever), false);

    // Preferencia: default (null).
    const gapDefault = resolveOrgBannerGapMs(null);
    assert.equal(
      shouldShowOrgBanner(lastSeen, now + DEFAULT_SESSION_GAP_MS + 1, gapDefault),
      true,
    );
  });
});
