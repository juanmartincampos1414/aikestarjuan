import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveWhatsappOrgId } from '../server/lib/resolveWhatsappOrgId';

// Task #207 — El bot de WhatsApp debe usar `whatsappDefaultOrganizationId`
// (preferencia explícita del usuario) y NO `lastActiveOrganizationId` (la
// última org abierta en la web). Si la default no está seteada o ya no es
// válida, cae al fallback histórico para no romper a usuarios actuales.

describe('resolveWhatsappOrgId — prioridad de organizaciones', () => {
  const orgs = [
    { id: 'org-jc' },
    { id: 'org-personal' },
    { id: 'org-otro' },
  ];

  it('prioriza whatsappDefaultOrganizationId cuando es válida', () => {
    const user = {
      whatsappDefaultOrganizationId: 'org-personal',
      lastActiveOrganizationId: 'org-jc',
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-personal');
  });

  it('cae a lastActiveOrganizationId si no hay default', () => {
    const user = {
      whatsappDefaultOrganizationId: null,
      lastActiveOrganizationId: 'org-jc',
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-jc');
  });

  it('ignora una default inválida (org en la que ya no es miembro) y cae al fallback', () => {
    const user = {
      whatsappDefaultOrganizationId: 'org-borrada',
      lastActiveOrganizationId: 'org-jc',
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-jc');
  });

  it('ignora un lastActive inválido y cae a la primera organización', () => {
    const user = {
      whatsappDefaultOrganizationId: null,
      lastActiveOrganizationId: 'org-vieja',
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-jc');
  });

  it('cae a la primera org cuando ambos campos son null', () => {
    const user = {
      whatsappDefaultOrganizationId: null,
      lastActiveOrganizationId: null,
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-jc');
  });

  it('cae a la primera org cuando ambos campos son undefined', () => {
    const user = {};
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-jc');
  });

  it('reproduce el bug original: web abierta en JC, default = Personal → bot usa Personal', () => {
    // Escenario reportado por Juan Campos: tiene 2 orgs y desde el navegador
    // venía abriendo JC Marketing (lastActiveOrganizationId = 'org-jc').
    // Configuró Personal como org del bot. El bot debe registrar en Personal.
    const user = {
      whatsappDefaultOrganizationId: 'org-personal',
      lastActiveOrganizationId: 'org-jc',
    };
    assert.equal(resolveWhatsappOrgId(user, orgs), 'org-personal');
  });

  it('lanza si no hay organizaciones', () => {
    assert.throws(() => resolveWhatsappOrgId({}, []));
  });
});
