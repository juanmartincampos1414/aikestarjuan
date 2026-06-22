// Tests de Órdenes de Trabajo (lógica pura). Import dinámico para no tocar la base.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const wo = (over: any = {}) => ({ id: Math.random().toString(36).slice(2), organizationId: 'org', title: 't', status: 'pendiente', priority: 'medium', scheduledDate: null, ...over });

test('isValidState: acepta estados válidos y rechaza inválidos', async () => {
  const { isValidState } = await import('./services/workOrderService');
  assert.equal(isValidState('pendiente'), true);
  assert.equal(isValidState('cobrado'), true);
  assert.equal(isValidState('en_ejecucion'), true);
  assert.equal(isValidState('inexistente'), false);
});

test('computeOpsMetrics: pendientes, hoy, en ejecución, finalizadas, a facturar', async () => {
  const { computeOpsMetrics } = await import('./services/workOrderService');
  const now = new Date('2026-06-22T12:00:00');
  const m = computeOpsMetrics([
    wo({ status: 'pendiente' }),
    wo({ status: 'programado', scheduledDate: '2026-06-22T15:00:00' }), // hoy
    wo({ status: 'esperando_materiales' }),
    wo({ status: 'en_ejecucion' }),
    wo({ status: 'finalizado' }),
    wo({ status: 'finalizado' }),
    wo({ status: 'cobrado' }),
  ] as any, now);
  assert.equal(m.pending, 3);          // pendiente + programado + esperando_materiales
  assert.equal(m.todayScheduled, 1);
  assert.equal(m.inProgress, 1);
  assert.equal(m.finished, 2);
  assert.equal(m.pendingInvoicing, 2); // finalizadas sin facturar
});
