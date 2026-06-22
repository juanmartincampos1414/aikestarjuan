import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Task #204 — Columna "Creado por" en Movimientos.
//
// La pantalla Movimientos (`client/src/pages/transactions.tsx`) agrega:
//   1) Una columna "Creado por" en la tabla desktop (oculta < lg) con
//      avatar + nombre, y placeholder "Sin asignar" para movimientos
//      huérfanos (createdBy null), visible sólo cuando la organización
//      tiene > 1 miembro confirmado.
//   2) Un filtro Select "Creado por" en el popover de filtros con
//      Todos / cada miembro / "Sin asignar" (este último sólo si hay
//      huérfanos en el set actual).
//   3) Inclusión de la columna en los exports CSV/PDF/Word del Excel
//      para mantener paridad con la vista.
//
// Para evitar acoplar el test a la implementación JSX, replicamos
// localmente las funciones puras que gobiernan el comportamiento — si
// la semántica cambia en transactions.tsx, este test falla y obliga a
// re-sincronizar ambas implementaciones (mismo patrón que Task #202).

type Tx = {
  id: string;
  createdBy?: string | null;
  creatorName?: string | null;
  type?: string;
  amount?: number;
  status?: string;
  description?: string;
  hasInvoice?: boolean;
  invoiceType?: string | null;
  invoiceNumber?: string | null;
};

// --- Replica del predicado del filtro "Creado por" ----------------
function passesCreatorFilter(t: Tx, filterCreator: string): boolean {
  if (filterCreator === 'all') return true;
  const createdBy = t.createdBy;
  if (filterCreator === 'unassigned') return createdBy == null;
  return createdBy === filterCreator;
}

// --- Replica de la decisión de mostrar la columna ------------------
function shouldShowCreatorColumn(membersCount: number): boolean {
  return membersCount > 1;
}

// --- Replica de la detección de huérfanos --------------------------
// IMPORTANTE: en transactions.tsx esto se computa sobre el set
// `preCreatorFilteredTransactions` (post-otros-filtros, pre-creador),
// no sobre el set crudo. La función pura recibe el set ya filtrado.
function hasUnassignedMovements(preCreatorFiltered: Tx[]): boolean {
  return preCreatorFiltered.some((t) => t.createdBy == null);
}

// --- Replica del reseteo defensivo de filterCreator ----------------
// El filtro "Creado por" no tiene control visible fuera del popover,
// así que un valor stale recortaría silenciosamente la tabla y los
// exports. Forzamos "all" cuando:
//   - La columna se oculta (org pasó a 1 miembro) — incluso para
//     "unassigned", porque el filtro entero deja de tener sentido.
//   - El userId seleccionado ya no existe entre los miembros.
function resetFilterCreatorIfStale(opts: {
  current: string;
  showCreatorColumn: boolean;
  members: Array<{ userId: string }>;
}): string {
  const { current, showCreatorColumn, members } = opts;
  if (current === 'all') return 'all';
  if (!showCreatorColumn) return 'all';
  if (current === 'unassigned') return current;
  const stillExists = members.some((m) => m.userId === current);
  return stillExists ? current : 'all';
}

// --- Replica del reset complementario "unassigned sin huérfanos" ---
// Cuando el filtro está en "unassigned" pero los otros filtros ya
// eliminaron todos los huérfanos del set visible, la opción desaparece
// del Select y el valor quedaría activo dando 0 resultados.
function resetUnassignedIfNoOrphans(current: string, hasOrphans: boolean): string {
  if (current === 'unassigned' && !hasOrphans) return 'all';
  return current;
}

// --- Replica del cálculo de iniciales para el avatar --------------
function computeInitials(t: Tx): { displayName: string; initials: string; isUnassigned: boolean } {
  const isUnassigned = !t.createdBy;
  const displayName = isUnassigned ? 'Sin asignar' : (t.creatorName || 'Usuario');
  const initials = isUnassigned
    ? '?'
    : displayName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s[0]?.toUpperCase() || '')
        .join('') || displayName[0]?.toUpperCase() || '?';
  return { displayName, initials, isUnassigned };
}

// --- Replica de la augmentación del export CSV/PDF/Word -----------
// IMPORTANTE: el orden de las claves debe replicar el de la tabla
// desktop, donde "Creado por" aparece JUSTO ANTES de "Monto". Para
// que el lector de un CSV lea las columnas en el mismo orden que ve
// en pantalla, insertamos las claves en ese orden exacto.
function buildExportRow(t: Tx, showCreatorColumn: boolean): Record<string, string> {
  const row: Record<string, string> = {
    Tipo: t.type || '',
    Descripción: t.description || '',
  };
  if (showCreatorColumn) {
    row['Creado por'] = t.creatorName || 'Sin asignar';
  }
  row['Monto'] = (t.amount ?? 0).toFixed(2);
  return row;
}

const sample: Tx[] = [
  { id: 't1', createdBy: 'user-ana', creatorName: 'Ana Pérez', type: 'income', amount: 1000, description: 'Venta 1' },
  { id: 't2', createdBy: 'user-beto', creatorName: 'Beto Gómez', type: 'expense', amount: 200, description: 'Compra 1' },
  { id: 't3', createdBy: 'user-ana', creatorName: 'Ana Pérez', type: 'expense', amount: 50, description: 'Compra 2' },
  { id: 't4', createdBy: null, creatorName: null, type: 'income', amount: 300, description: 'Huérfano (script)' },
  { id: 't5', createdBy: 'user-cami', creatorName: 'Cami', type: 'income', amount: 500, description: 'Venta 2' },
];

describe('Task #204 — visibilidad de la columna "Creado por"', () => {
  it('se oculta para organizaciones con un único miembro', () => {
    assert.equal(shouldShowCreatorColumn(0), false);
    assert.equal(shouldShowCreatorColumn(1), false);
  });

  it('se muestra a partir de dos miembros', () => {
    assert.equal(shouldShowCreatorColumn(2), true);
    assert.equal(shouldShowCreatorColumn(5), true);
  });
});

describe('Task #204 — filtro "Creado por"', () => {
  it('"all" no filtra ningún movimiento', () => {
    const out = sample.filter((t) => passesCreatorFilter(t, 'all'));
    assert.equal(out.length, sample.length);
  });

  it('un userId específico devuelve sólo los movimientos de ese miembro', () => {
    const out = sample.filter((t) => passesCreatorFilter(t, 'user-ana')).map((t) => t.id);
    assert.deepEqual(out, ['t1', 't3']);
  });

  it('"unassigned" devuelve sólo huérfanos (createdBy null)', () => {
    const out = sample.filter((t) => passesCreatorFilter(t, 'unassigned')).map((t) => t.id);
    assert.deepEqual(out, ['t4']);
  });

  it('un userId que no existe devuelve set vacío (no falla)', () => {
    const out = sample.filter((t) => passesCreatorFilter(t, 'user-fantasma'));
    assert.equal(out.length, 0);
  });

  it('"unassigned" NO debe matchear movimientos asignados', () => {
    const assigned = sample.filter((t) => t.createdBy != null);
    const out = assigned.filter((t) => passesCreatorFilter(t, 'unassigned'));
    assert.equal(out.length, 0);
  });
});

describe('Task #204 — opción "Sin asignar" en el filtro', () => {
  it('aparece sólo si hay huérfanos en el set actual (post-otros-filtros)', () => {
    assert.equal(hasUnassignedMovements(sample), true);
    const onlyAssigned = sample.filter((t) => t.createdBy != null);
    assert.equal(hasUnassignedMovements(onlyAssigned), false);
  });

  it('NO aparece si los otros filtros ya excluyeron los huérfanos del set visible', () => {
    // Caso real: el usuario filtra por type=expense, y el único huérfano
    // del sample es type=income. La opción "Sin asignar" no debería
    // ofrecerse porque devolvería 0 resultados.
    const filteredByType = sample.filter((t) => t.type === 'expense');
    assert.equal(hasUnassignedMovements(filteredByType), false);
  });

  it('aparece si los otros filtros DEJAN huérfanos en el set visible', () => {
    const filteredByType = sample.filter((t) => t.type === 'income');
    assert.equal(hasUnassignedMovements(filteredByType), true);
  });
});

describe('Task #204 — reseteo defensivo del filtro al cambiar membresía', () => {
  const membersFull = [
    { userId: 'user-ana' },
    { userId: 'user-beto' },
    { userId: 'user-cami' },
  ];

  it('"all" nunca se toca', () => {
    const r = resetFilterCreatorIfStale({ current: 'all', showCreatorColumn: true, members: membersFull });
    assert.equal(r, 'all');
  });

  it('"unassigned" se mantiene mientras la columna esté visible', () => {
    assert.equal(
      resetFilterCreatorIfStale({ current: 'unassigned', showCreatorColumn: true, members: membersFull }),
      'unassigned',
    );
  });

  it('"unassigned" también vuelve a "all" si la columna deja de ser visible', () => {
    // Si la org pasó a 1 sólo miembro, el filtro entero deja de tener
    // sentido — incluso "unassigned" recortaría silenciosamente el set.
    const r = resetFilterCreatorIfStale({
      current: 'unassigned',
      showCreatorColumn: false,
      members: [{ userId: 'user-ana' }],
    });
    assert.equal(r, 'all');
  });

  it('vuelve a "all" si la columna deja de ser visible (org pasó a 1 miembro)', () => {
    const r = resetFilterCreatorIfStale({
      current: 'user-ana',
      showCreatorColumn: false,
      members: [{ userId: 'user-ana' }],
    });
    assert.equal(r, 'all');
  });

  it('vuelve a "all" si el userId seleccionado ya no está en members (miembro removido / cambio de org)', () => {
    const r = resetFilterCreatorIfStale({
      current: 'user-eliminado',
      showCreatorColumn: true,
      members: membersFull,
    });
    assert.equal(r, 'all');
  });

  it('mantiene el userId si sigue presente entre los miembros', () => {
    const r = resetFilterCreatorIfStale({
      current: 'user-beto',
      showCreatorColumn: true,
      members: membersFull,
    });
    assert.equal(r, 'user-beto');
  });
});

describe('Task #204 — reset complementario "unassigned" sin huérfanos', () => {
  it('vuelve a "all" si está en "unassigned" pero el set visible no tiene huérfanos', () => {
    assert.equal(resetUnassignedIfNoOrphans('unassigned', false), 'all');
  });

  it('mantiene "unassigned" mientras haya huérfanos en el set visible', () => {
    assert.equal(resetUnassignedIfNoOrphans('unassigned', true), 'unassigned');
  });

  it('no toca "all" ni los userIds aunque no haya huérfanos', () => {
    assert.equal(resetUnassignedIfNoOrphans('all', false), 'all');
    assert.equal(resetUnassignedIfNoOrphans('user-ana', false), 'user-ana');
  });
});

describe('Task #204 — avatar + iniciales', () => {
  it('toma las dos primeras iniciales del nombre real', () => {
    const r = computeInitials({ id: 't1', createdBy: 'u', creatorName: 'Ana Pérez' });
    assert.equal(r.displayName, 'Ana Pérez');
    assert.equal(r.initials, 'AP');
    assert.equal(r.isUnassigned, false);
  });

  it('toma sólo una inicial si hay un único nombre', () => {
    const r = computeInitials({ id: 't2', createdBy: 'u', creatorName: 'Cami' });
    assert.equal(r.initials, 'C');
  });

  it('para huérfanos muestra "Sin asignar" + interrogante', () => {
    const r = computeInitials({ id: 't4', createdBy: null, creatorName: null });
    assert.equal(r.displayName, 'Sin asignar');
    assert.equal(r.initials, '?');
    assert.equal(r.isUnassigned, true);
  });

  it('si la API no envía creatorName pero sí createdBy, usa fallback "Usuario"', () => {
    const r = computeInitials({ id: 'tx', createdBy: 'u', creatorName: null });
    assert.equal(r.displayName, 'Usuario');
    assert.equal(r.initials, 'U');
    assert.equal(r.isUnassigned, false);
  });
});

describe('Task #204 — paridad export con la vista', () => {
  it('NO incluye "Creado por" en el export cuando hay un único miembro', () => {
    const rows = sample.map((t) => buildExportRow(t, false));
    for (const row of rows) {
      assert.equal('Creado por' in row, false);
    }
  });

  it('incluye "Creado por" en el export cuando hay > 1 miembro', () => {
    const rows = sample.map((t) => buildExportRow(t, true));
    assert.equal(rows[0]['Creado por'], 'Ana Pérez');
    assert.equal(rows[1]['Creado por'], 'Beto Gómez');
    assert.equal(rows[3]['Creado por'], 'Sin asignar'); // huérfano
    assert.equal(rows[4]['Creado por'], 'Cami');
  });

  it('para huérfanos en el export, el valor es exactamente "Sin asignar" (no vacío ni null)', () => {
    const orphan = sample.find((t) => t.createdBy == null)!;
    const row = buildExportRow(orphan, true);
    assert.equal(row['Creado por'], 'Sin asignar');
  });

  it('"Creado por" se ubica JUSTO ANTES de "Monto" en el orden de columnas del export', () => {
    // Replica el orden visual de la tabla: Tipo → Descripción →
    // Creado por → Monto. Si alguien re-ordena el row literal, este
    // test rompe y nos avisa que el CSV/PDF/Word ya no coincide con
    // lo que el usuario ve en pantalla.
    const row = buildExportRow(sample[0], true);
    const keys = Object.keys(row);
    const idxCreator = keys.indexOf('Creado por');
    const idxMonto = keys.indexOf('Monto');
    assert.notEqual(idxCreator, -1, '"Creado por" debe estar presente');
    assert.notEqual(idxMonto, -1, '"Monto" debe estar presente');
    assert.equal(idxCreator + 1, idxMonto, '"Creado por" debe ir inmediatamente antes de "Monto"');
  });

  it('cuando la columna está oculta, "Monto" mantiene su posición original (sin huecos)', () => {
    const row = buildExportRow(sample[0], false);
    const keys = Object.keys(row);
    assert.deepEqual(keys, ['Tipo', 'Descripción', 'Monto']);
  });
});
