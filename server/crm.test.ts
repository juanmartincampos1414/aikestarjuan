// Tests del CRM (lógica pura, sin Postgres). Import dinámico para no conectar a la base.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const opp = (over: any = {}) => ({
  id: over.id || Math.random().toString(36).slice(2), organizationId: 'org', title: 't',
  stage: 'consulta', status: 'open', estimatedValue: '0', nextFollowupAt: null, ...over,
});

test('statusForStage: aprobado→won, perdido→lost, resto→open', async () => {
  const { statusForStage } = await import('./services/crmService');
  assert.equal(statusForStage('aprobado'), 'won');
  assert.equal(statusForStage('perdido'), 'lost');
  assert.equal(statusForStage('consulta'), 'open');
  assert.equal(statusForStage('presupuesto_enviado'), 'open');
});

test('computeBoardColumns: 7 columnas con contador y total por etapa', async () => {
  const { computeBoardColumns } = await import('./services/crmService');
  const cols = computeBoardColumns([
    opp({ stage: 'consulta', estimatedValue: '1000' }),
    opp({ stage: 'consulta', estimatedValue: '500' }),
    opp({ stage: 'aprobado', estimatedValue: '9999', status: 'won' }),
  ] as any);
  assert.equal(cols.length, 7);
  const consulta = cols.find(c => c.stage === 'consulta')!;
  assert.equal(consulta.count, 2);
  assert.equal(consulta.total, 1500);
  const aprobado = cols.find(c => c.stage === 'aprobado')!;
  assert.equal(aprobado.count, 1);
  assert.equal(aprobado.total, 9999);
});

test('computeMetrics: pipeline, tasa de cierre y seguimientos vencidos', async () => {
  const { computeMetrics } = await import('./services/crmService');
  const now = new Date('2026-06-22T12:00:00Z');
  const m = computeMetrics([
    opp({ status: 'open', estimatedValue: '1000', nextFollowupAt: '2026-06-20T00:00:00Z' }), // vencido
    opp({ status: 'open', estimatedValue: '2000', nextFollowupAt: '2026-07-01T00:00:00Z' }), // futuro
    opp({ status: 'won', stage: 'aprobado' }),
    opp({ status: 'lost', stage: 'perdido' }),
    opp({ status: 'lost', stage: 'perdido' }),
  ] as any, now);
  assert.equal(m.activeOpportunities, 2);
  assert.equal(m.pipelineValue, 3000);
  assert.equal(m.won, 1);
  assert.equal(m.lost, 2);
  assert.equal(m.closeRate, 33); // 1/(1+2) ≈ 33%
  assert.equal(m.overdueFollowups, 1);
});
