// Task #513 — Tests de los crons de limpieza de cuentas (bajas automáticas).
//
// Los flujos de cancelación por falta de pago / inactividad registran cada baja
// en `account_deletions`. Estos tests verifican, SIN una Postgres ni un SendGrid
// reales (vía los seams __set*CleanupDepsForTesting):
//
//   (1) El motivo de la baja se calcula bien: 'non_payment' cuando hubo pago
//       fallido o la sub quedó en mora (past_due), 'cancellation' en el resto, y
//       'inactivity' en el cleanup de inactivos.
//   (2) Un fallo del REGISTRO de la baja NO bloquea el borrado/soft-delete real
//       (no queremos dejar datos del usuario por un error de log).
//   (3) Un fallo del BORRADO real de un usuario NO tira abajo el cron: el resto
//       de los usuarios se sigue procesando.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// db.ts crea un Pool al importarse (no conecta hasta una query). Le damos una URL
// dummy para que el import no falle sin DATABASE_URL. Los tests usan deps
// inyectadas, así que nunca se abre una conexión real.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';

const {
  processCancelledAccounts,
  computeCancelledReason,
  __setCancelledCleanupDepsForTesting,
} = await import('./services/cancelledAccountCleanup');
import type { CancelledCleanupTestDeps } from './services/cancelledAccountCleanup';

const {
  processInactiveAccounts,
  userHasActiveMembership,
  __setInactiveCleanupDepsForTesting,
} = await import('./services/inactiveAccountCleanup');
import type {
  InactiveCleanupTestDeps,
  MembershipCheckDeps,
} from './services/inactiveAccountCleanup';

const DAY_MS = 1000 * 60 * 60 * 24;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);

afterEach(() => {
  __setCancelledCleanupDepsForTesting(null);
  __setInactiveCleanupDepsForTesting(null);
});

// ---------------------------------------------------------------------------
// (A) Cálculo puro del motivo de baja por cancelación.
// ---------------------------------------------------------------------------

test('(1) computeCancelledReason: paymentFailedAt => non_payment', () => {
  assert.equal(computeCancelledReason({ paymentFailedAt: new Date(), status: 'active' }), 'non_payment');
});

test('(2) computeCancelledReason: status past_due => non_payment', () => {
  assert.equal(computeCancelledReason({ paymentFailedAt: null, status: 'past_due' }), 'non_payment');
});

test('(3) computeCancelledReason: sin pago fallido ni mora => cancellation', () => {
  assert.equal(computeCancelledReason({ paymentFailedAt: null, status: 'active' }), 'cancellation');
});

// ---------------------------------------------------------------------------
// Helper: arma deps de cancelación con una sub vencida hace 61 días (>60 de
// retención) para forzar el borrado, registrando lo que pasó.
// ---------------------------------------------------------------------------
function cancelledDepsFor(
  subs: Array<{ subscription: any; user: any }>,
  spy: {
    recorded?: any[];
    deletedOrgs?: string[];
    deletedUsers?: string[];
  },
  overrides: Partial<CancelledCleanupTestDeps> = {},
): CancelledCleanupTestDeps {
  return {
    loadCancelledSubs: async () => subs,
    recordAccountDeletion: async (d) => {
      spy.recorded?.push(d);
      return { ...d, id: 'del-1', deletedAt: new Date() } as any;
    },
    loadMemberships: async () => [{ organization_id: 'org-1', role: 'owner' }],
    deleteOrgData: async (orgId) => {
      spy.deletedOrgs?.push(orgId);
    },
    deleteMemberMembership: async () => {},
    deleteUserAndSubscription: async (userId) => {
      spy.deletedUsers?.push(userId);
    },
    sendReminderEmail: async () => true,
    markReminderSent: async () => {},
    ...overrides,
  };
}

function expiredSub(id: string, email: string, extra: Partial<any> = {}) {
  return {
    subscription: {
      id: `sub-${id}`,
      userId: id,
      currentPeriodEnd: daysAgo(61),
      updatedAt: daysAgo(61),
      paymentFailedAt: null,
      status: 'cancelled',
      lastDataReminderSentAt: null,
      ...extra,
    },
    user: { id, email, name: email, deletedAt: null },
  };
}

// ---------------------------------------------------------------------------
// (B) Integración: processCancelledAccounts registra con el motivo correcto.
// ---------------------------------------------------------------------------

test('(4) baja vencida con paymentFailedAt se registra como non_payment antes de borrar', async () => {
  const spy = { recorded: [] as any[], deletedOrgs: [] as string[], deletedUsers: [] as string[] };
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor([expiredSub('u1', 'pay@x.com', { paymentFailedAt: daysAgo(70) })], spy),
  );

  await processCancelledAccounts();

  assert.equal(spy.recorded.length, 1, 'se registró exactamente una baja');
  assert.equal(spy.recorded[0].reason, 'non_payment');
  assert.deepEqual(spy.deletedUsers, ['u1'], 'el usuario se borró tras registrar');
});

test('(5) baja vencida voluntaria (sin mora) se registra como cancellation', async () => {
  const spy = { recorded: [] as any[], deletedOrgs: [] as string[], deletedUsers: [] as string[] };
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor([expiredSub('u2', 'volu@x.com')], spy),
  );

  await processCancelledAccounts();

  assert.equal(spy.recorded[0].reason, 'cancellation');
  assert.deepEqual(spy.deletedUsers, ['u2']);
});

// ---------------------------------------------------------------------------
// (C) Robustez: un fallo del log NO frena el borrado.
// ---------------------------------------------------------------------------

test('(6) si recordAccountDeletion falla, el borrado real igual ocurre', async () => {
  const spy = { deletedOrgs: [] as string[], deletedUsers: [] as string[] };
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor([expiredSub('u3', 'logfail@x.com')], spy, {
      recordAccountDeletion: async () => {
        throw new Error('log DB caída');
      },
    }),
  );

  await processCancelledAccounts();

  assert.deepEqual(spy.deletedOrgs, ['org-1'], 'la org se borró aunque el log falló');
  assert.deepEqual(spy.deletedUsers, ['u3'], 'el usuario se borró aunque el log falló');
});

// ---------------------------------------------------------------------------
// (D) Robustez: un fallo del borrado de un usuario NO tira abajo el cron.
// ---------------------------------------------------------------------------

test('(7) si el borrado de un usuario lanza, el cron sigue con los demás', async () => {
  const spy = { recorded: [] as any[], deletedUsers: [] as string[] };
  const subs = [
    expiredSub('bad', 'bad@x.com'),
    expiredSub('good', 'good@x.com'),
  ];
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(subs, spy, {
      deleteUserAndSubscription: async (userId) => {
        if (userId === 'bad') throw new Error('delete falló');
        spy.deletedUsers!.push(userId);
      },
    }),
  );

  // No debe lanzar: el error queda contenido y el segundo usuario se procesa.
  await processCancelledAccounts();

  assert.ok(spy.deletedUsers!.includes('good'), 'el segundo usuario se borró pese al fallo del primero');
});

// ---------------------------------------------------------------------------
// (E) Inactivos: registro con reason 'inactivity' + robustez.
// ---------------------------------------------------------------------------

function inactiveUser(id: string, email: string, daysOld: number) {
  return {
    id,
    email,
    name: email,
    isAdmin: false,
    createdAt: daysAgo(daysOld),
    deletedAt: null,
    inactiveReminderSentAt: null,
  };
}

function inactiveDepsFor(
  users: any[],
  spy: { recorded?: any[]; softDeleted?: string[] },
  overrides: Partial<InactiveCleanupTestDeps> = {},
): InactiveCleanupTestDeps {
  return {
    loadActiveUsers: async () => users,
    getSubscriptionByUserId: async () => null,
    userHasActiveMembership: async () => false,
    recordAccountDeletion: async (d) => {
      spy.recorded?.push(d);
      return { ...d, id: 'del-1', deletedAt: new Date() } as any;
    },
    softDeleteUser: async (userId) => {
      spy.softDeleted?.push(userId);
    },
    sendReminderEmail: async () => true,
    markReminderSent: async () => {},
    ...overrides,
  };
}

test('(8) inactivo > 30 días se registra como inactivity y se soft-deletea', async () => {
  const spy = { recorded: [] as any[], softDeleted: [] as string[] };
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('i1', 'old@x.com', 45)], spy),
  );

  await processInactiveAccounts();

  assert.equal(spy.recorded.length, 1, 'se registró una baja por inactividad');
  assert.equal(spy.recorded[0].reason, 'inactivity');
  assert.deepEqual(spy.softDeleted, ['i1'], 'el usuario se soft-deleteó');
});

test('(9) inactivo: si el log falla, el soft-delete igual ocurre', async () => {
  const spy = { softDeleted: [] as string[] };
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('i2', 'logfail@x.com', 45)], spy, {
      recordAccountDeletion: async () => {
        throw new Error('log DB caída');
      },
    }),
  );

  await processInactiveAccounts();

  assert.deepEqual(spy.softDeleted, ['i2'], 'el soft-delete ocurre pese al fallo del log');
});

test('(10) inactivo: si el soft-delete de uno lanza, el cron sigue con los demás', async () => {
  const spy = { recorded: [] as any[], softDeleted: [] as string[] };
  const users = [
    inactiveUser('bad', 'bad@x.com', 45),
    inactiveUser('good', 'good@x.com', 45),
  ];
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor(users, spy, {
      softDeleteUser: async (userId) => {
        if (userId === 'bad') throw new Error('soft-delete falló');
        spy.softDeleted!.push(userId);
      },
    }),
  );

  await processInactiveAccounts();

  assert.ok(spy.softDeleted!.includes('good'), 'el segundo usuario se procesó pese al fallo del primero');
});

// ---------------------------------------------------------------------------
// (F) Task #514 — Timing de los avisos PREVIOS a la baja por cancelación.
//
// El cleanup, además de borrar a los 60 días, manda recordatorios en ventanas
// de 2 días alrededor de los días 15 / 45 / 55 desde el vencimiento
// (equivalentes a daysRemaining 45 / 15 / 5), con un anti-duplicado de 5 días
// vía lastDataReminderSentAt. Estos tests fijan en qué momento exacto se manda
// y cuándo NO, usando los seams sendReminderEmail / markReminderSent (sin
// SendGrid ni Postgres reales).
// ---------------------------------------------------------------------------

// Spy que captura los recordatorios enviados y las marcas de "ya enviado", sin
// disparar ningún borrado (el resto de los seams quedan como no-op).
function cancelledReminderSpy() {
  return {
    reminders: [] as Array<{ email: string; name: string | null; daysRemaining: number }>,
    marked: [] as Array<{ subscriptionId: string; when: Date }>,
    deletedUsers: [] as string[],
  };
}

function withReminderSpy(
  spy: ReturnType<typeof cancelledReminderSpy>,
): Partial<CancelledCleanupTestDeps> {
  return {
    sendReminderEmail: async (email, name, daysRemaining) => {
      spy.reminders.push({ email, name, daysRemaining });
      return true;
    },
    markReminderSent: async (subscriptionId, when) => {
      spy.marked.push({ subscriptionId, when });
    },
  };
}

// La ventana del día 15 corresponde a daysRemaining=45 (60-15). A daysSinceExpiry=15
// (vencido hace 15 días) el recordatorio debe salir y marcarse, sin borrar nada.
test('(11) cancelación: recordatorio SE manda dentro de la ventana (15 días vencido)', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('w1', 'win15@x.com', { currentPeriodEnd: daysAgo(15) })],
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 1, 'se manda exactamente un recordatorio');
  assert.equal(spy.reminders[0].daysRemaining, 45, 'daysRemaining=45 (ventana del día 15)');
  assert.equal(spy.marked.length, 1, 'se marca lastDataReminderSentAt');
  assert.equal(spy.deletedUsers.length, 0, 'no se borra: aún dentro de la retención');
});

// Las tres ventanas (15/45/55 desde el vencimiento) deben disparar el aviso.
for (const { daysSince, expected } of [
  { daysSince: 45, expected: 15 },
  { daysSince: 55, expected: 5 },
]) {
  test(`(11b) cancelación: recordatorio en la ventana de ${daysSince} días vencido (quedan ${expected})`, async () => {
    const spy = cancelledReminderSpy();
    __setCancelledCleanupDepsForTesting(
      cancelledDepsFor(
        [expiredSub(`w${daysSince}`, `win${daysSince}@x.com`, { currentPeriodEnd: daysAgo(daysSince) })],
        spy,
        withReminderSpy(spy),
      ),
    );

    await processCancelledAccounts();

    assert.equal(spy.reminders.length, 1, `se manda el recordatorio a ${daysSince} días`);
    assert.equal(spy.reminders[0].daysRemaining, expected);
    assert.equal(spy.deletedUsers.length, 0);
  });
}

// Día 30 vencido => daysRemaining=30, fuera de toda ventana: NO debe avisar.
test('(12) cancelación: NO se manda fuera de las ventanas (30 días vencido)', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('o1', 'out30@x.com', { currentPeriodEnd: daysAgo(30) })],
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 0, 'no hay recordatorio fuera de la ventana');
  assert.equal(spy.marked.length, 0);
  assert.equal(spy.deletedUsers.length, 0);
});

// Dentro de ventana (45 días) pero con un recordatorio enviado hace 2 días:
// el anti-duplicado (<5 días) debe evitar el reenvío.
test('(13) cancelación: NO se reenvía si lastDataReminderSentAt es reciente (<5 días)', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('d1', 'dedup@x.com', {
        currentPeriodEnd: daysAgo(45),
        lastDataReminderSentAt: daysAgo(2),
      })],
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 0, 'el dedup de 5 días bloquea el reenvío');
  assert.equal(spy.marked.length, 0);
});

// Mismo caso pero el último recordatorio fue hace 6 días (>=5): SÍ se reenvía.
test('(14) cancelación: SÍ se reenvía si lastDataReminderSentAt es viejo (>=5 días)', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('d2', 'resend@x.com', {
        currentPeriodEnd: daysAgo(45),
        lastDataReminderSentAt: daysAgo(6),
      })],
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 1, 'pasados 5 días se puede reenviar');
  assert.equal(spy.reminders[0].daysRemaining, 15);
  assert.equal(spy.marked.length, 1);
});

// Vencido hace 61 días (>60 de retención): NO se manda recordatorio, se borra.
test('(15) cancelación: pasada la retención NO se avisa, se borra', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('x1', 'gone@x.com')], // currentPeriodEnd = daysAgo(61) por defecto
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 0, 'ya no se avisa: corresponde el borrado');
  assert.deepEqual(spy.deletedUsers, ['x1'], 'se borra el usuario');
});

// ---------------------------------------------------------------------------
// (G) Task #514 — Timing del aviso PREVIO a la baja por inactividad.
//
// La cuenta sin suscripción ni membresía activa recibe UN aviso a partir del
// día 7 desde el registro y antes del día 30 (cuando se soft-deletea). El aviso
// es único: inactiveReminderSentAt evita el reenvío.
// ---------------------------------------------------------------------------

function inactiveReminderSpy() {
  return {
    reminders: [] as Array<{ email: string; name: string | null; daysRemaining: number }>,
    marked: [] as Array<{ userId: string; when: Date }>,
    softDeleted: [] as string[],
  };
}

function withInactiveReminderSpy(
  spy: ReturnType<typeof inactiveReminderSpy>,
): Partial<InactiveCleanupTestDeps> {
  return {
    sendReminderEmail: async (email, name, daysRemaining) => {
      spy.reminders.push({ email, name, daysRemaining });
      return true;
    },
    markReminderSent: async (userId, when) => {
      spy.marked.push({ userId, when });
    },
  };
}

// Día 10 desde el registro (entre 7 y 30) sin aviso previo: SE manda una vez.
test('(16) inactividad: aviso SE manda entre el día 7 y el 30 (día 10)', async () => {
  const spy = inactiveReminderSpy();
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('a1', 'in10@x.com', 10)], spy, withInactiveReminderSpy(spy)),
  );

  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 1, 'se manda el aviso de inactividad');
  assert.equal(spy.reminders[0].daysRemaining, 20, 'quedan 20 días (30-10)');
  assert.equal(spy.marked.length, 1, 'se marca inactiveReminderSentAt');
  assert.equal(spy.softDeleted.length, 0, 'todavía no se borra');
});

// Día 5 (antes del umbral de 7): NO se avisa ni se borra.
test('(17) inactividad: NO se avisa antes del día 7 (día 5)', async () => {
  const spy = inactiveReminderSpy();
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('a2', 'in5@x.com', 5)], spy, withInactiveReminderSpy(spy)),
  );

  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 0, 'antes del día 7 no hay aviso');
  assert.equal(spy.softDeleted.length, 0);
});

// Día 10 pero con inactiveReminderSentAt ya seteado: el aviso es único, NO se reenvía.
test('(18) inactividad: el aviso es único (no se reenvía si ya se mandó)', async () => {
  const spy = inactiveReminderSpy();
  const user = inactiveUser('a3', 'sent@x.com', 10);
  user.inactiveReminderSentAt = daysAgo(3);
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([user], spy, withInactiveReminderSpy(spy)),
  );

  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 0, 'no se reenvía el aviso de inactividad');
  assert.equal(spy.marked.length, 0);
  assert.equal(spy.softDeleted.length, 0);
});

// Día 45 (>=30): corresponde el soft-delete, NO un aviso.
test('(19) inactividad: pasado el día 30 se borra y NO se avisa', async () => {
  const spy = inactiveReminderSpy();
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('a4', 'del45@x.com', 45)], spy, withInactiveReminderSpy(spy)),
  );

  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 0, 'pasado el día 30 ya no se avisa');
  assert.deepEqual(spy.softDeleted, ['a4'], 'se soft-deletea la cuenta');
});

// ---------------------------------------------------------------------------
// (H) Task #515 — userHasActiveMembership: un colaborador NO se borra si el
//     dueño de su equipo paga. Probamos la función real (con deps de membresía
//     inyectadas) y la integración del cron (que salta a esos colaboradores).
// ---------------------------------------------------------------------------

// Arma deps de membresía: el usuario es colaborador (no owner) de cada org en
// `userOrgs`; cada org tiene un owner; `ownerSubs` mapea ownerUserId -> sub.
function membershipDepsFor(
  userOrgs: Array<{ organizationId: string; role: string }>,
  orgOwners: Record<string, string | null>,
  ownerSubs: Record<string, any>,
): MembershipCheckDeps {
  return {
    loadUserMemberships: async () => userOrgs,
    loadOrgOwnerUserId: async (orgId) => orgOwners[orgId] ?? null,
    getSubscriptionByUserId: async (ownerId) => ownerSubs[ownerId] ?? null,
  };
}

test('(20) userHasActiveMembership: true si el dueño de la org tiene suscripción', async () => {
  const result = await userHasActiveMembership(
    'member-1',
    membershipDepsFor(
      [{ organizationId: 'org-1', role: 'member' }],
      { 'org-1': 'owner-1' },
      { 'owner-1': { id: 'sub-1', status: 'active' } },
    ),
  );
  assert.equal(result, true);
});

test('(21) userHasActiveMembership: false si el dueño de la org no tiene suscripción', async () => {
  const result = await userHasActiveMembership(
    'member-1',
    membershipDepsFor(
      [{ organizationId: 'org-1', role: 'member' }],
      { 'org-1': 'owner-1' },
      { 'owner-1': null },
    ),
  );
  assert.equal(result, false);
});

test('(22) userHasActiveMembership: las membresías propias (owner) no cuentan como equipo ajeno', async () => {
  // El usuario es owner de su propia org. No debe consultarse la sub de ningún
  // owner ajeno, así que el resultado es false (no tiene equipo pago de otro).
  let lookedUpOwner = false;
  const result = await userHasActiveMembership('owner-self', {
    loadUserMemberships: async () => [{ organizationId: 'org-own', role: 'owner' }],
    loadOrgOwnerUserId: async () => {
      lookedUpOwner = true;
      return 'owner-self';
    },
    getSubscriptionByUserId: async () => ({ id: 'sub-x', status: 'active' }),
  });
  assert.equal(result, false, 'ser owner de la propia org no cuenta como membresía protegida');
  assert.equal(lookedUpOwner, false, 'no se consulta el owner para membresías propias');
});

test('(23) userHasActiveMembership: true si al menos una de varias orgs tiene dueño pago', async () => {
  const result = await userHasActiveMembership(
    'member-multi',
    membershipDepsFor(
      [
        { organizationId: 'org-free', role: 'member' },
        { organizationId: 'org-paid', role: 'member' },
      ],
      { 'org-free': 'owner-free', 'org-paid': 'owner-paid' },
      { 'owner-free': null, 'owner-paid': { id: 'sub-2', status: 'active' } },
    ),
  );
  assert.equal(result, true);
});

test('(24) cron: un miembro de un equipo activo NO se soft-deletea aunque supere los 30 días', async () => {
  const spy = { recorded: [] as any[], softDeleted: [] as string[] };
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([inactiveUser('teammate', 'teammate@x.com', 90)], spy, {
      // El usuario no tiene sub propia, pero es miembro de un equipo cuyo dueño
      // sí paga: el cron debe saltearlo.
      getSubscriptionByUserId: async () => null,
      userHasActiveMembership: async () => true,
    }),
  );

  await processInactiveAccounts();

  assert.deepEqual(spy.softDeleted, [], 'el colaborador de un equipo pago no se soft-deletea');
  assert.equal(spy.recorded.length, 0, 'no se registra ninguna baja para el colaborador protegido');
});

// ---------------------------------------------------------------------------
// (I) Task #517 — Dos corridas CONSECUTIVAS del cron sobre la MISMA suscripción
// no duplican el aviso de baja.
//
// Las ventanas de aviso tienen 2 días de ancho (el aviso del día 15 también
// puede dispararse el día 16). Lo único que evita el doble envío cuando el cron
// corre dos días seguidos dentro de la misma ventana es el anti-duplicado de 5
// días (lastDataReminderSentAt para cancelación; el one-shot inactiveReminderSentAt
// para inactividad). Los tests anteriores prueban cada ventana de forma aislada
// con un dedup de valor fijo; estos simulan la SECUENCIA real: corrida del día
// 15, luego corrida del día 16 propagando lo que marcó la primera, y confirman
// que el recordatorio sale UNA sola vez en total.
// ---------------------------------------------------------------------------

// Control: confirma que SIN dedup la ventana del día 15 sigue abierta el día 16
// (vencido hace 16 días => daysRemaining=44, dentro de [44,45]). Si este control
// fallara, el test de no-duplicado de abajo pasaría trivialmente.
test('(25) cancelación: la ventana del día 15 sigue abierta el día 16 (sin dedup, SÍ avisaría)', async () => {
  const spy = cancelledReminderSpy();
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('ctl16', 'ctl16@x.com', { currentPeriodEnd: daysAgo(16), lastDataReminderSentAt: null })],
      spy,
      withReminderSpy(spy),
    ),
  );

  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 1, 'sin aviso previo, el día 16 todavía cae en la ventana');
  assert.equal(spy.reminders[0].daysRemaining, 44);
});

test('(26) cancelación: dos corridas consecutivas (día 15 y 16) NO duplican el aviso', async () => {
  const spy = cancelledReminderSpy();

  // Corrida 1 — día 15 (vencido hace 15 días), sin aviso previo.
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('consec', 'consec@x.com', { currentPeriodEnd: daysAgo(15), lastDataReminderSentAt: null })],
      spy,
      withReminderSpy(spy),
    ),
  );
  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 1, 'día 15: se manda el aviso');
  assert.equal(spy.marked.length, 1, 'día 15: se marca lastDataReminderSentAt');
  const firstMarkedAt = spy.marked[0].when;

  // Corrida 2 — día 16 (vencido hace 16 días, la ventana sigue abierta),
  // propagando el lastDataReminderSentAt que dejó la primera corrida. El
  // anti-duplicado de 5 días (daysSinceLastReminder < 5) debe bloquear el reenvío.
  __setCancelledCleanupDepsForTesting(
    cancelledDepsFor(
      [expiredSub('consec', 'consec@x.com', { currentPeriodEnd: daysAgo(16), lastDataReminderSentAt: firstMarkedAt })],
      spy,
      withReminderSpy(spy),
    ),
  );
  await processCancelledAccounts();

  assert.equal(spy.reminders.length, 1, 'día 16: el dedup de 5 días evita el reenvío (sigue 1 en total)');
  assert.equal(spy.marked.length, 1, 'día 16: no se vuelve a marcar');
});

// Mismo patrón para inactividad: el aviso es one-shot vía inactiveReminderSentAt,
// pero confirmamos que dos corridas seguidas (día 10 y día 11) no reenvían.
test('(27) inactividad: dos corridas consecutivas (día 10 y 11) NO duplican el aviso', async () => {
  const spy = inactiveReminderSpy();

  // Corrida 1 — día 10 desde el registro, sin aviso previo.
  const u1 = inactiveUser('iconsec', 'iconsec@x.com', 10);
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([u1], spy, withInactiveReminderSpy(spy)),
  );
  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 1, 'día 10: se manda el aviso');
  assert.equal(spy.marked.length, 1, 'día 10: se marca inactiveReminderSentAt');
  const firstMarkedAt = spy.marked[0].when;

  // Corrida 2 — día 11, propagando el inactiveReminderSentAt de la primera. El
  // one-shot (!user.inactiveReminderSentAt) debe bloquear el reenvío.
  const u2 = inactiveUser('iconsec', 'iconsec@x.com', 11);
  u2.inactiveReminderSentAt = firstMarkedAt;
  __setInactiveCleanupDepsForTesting(
    inactiveDepsFor([u2], spy, withInactiveReminderSpy(spy)),
  );
  await processInactiveAccounts();

  assert.equal(spy.reminders.length, 1, 'día 11: el one-shot evita el reenvío (sigue 1 en total)');
  assert.equal(spy.marked.length, 1, 'día 11: no se vuelve a marcar');
});
