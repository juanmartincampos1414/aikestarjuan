// =============================================================================
// AIKESTAR - Agente IA del CRM (acciones por lenguaje natural)
// =============================================================================
// Loop de tool-use con el SDK oficial de Anthropic (claude-opus-4-8). Interpreta
// pedidos como "crear oportunidad para Juan por instalación eléctrica",
// "mover esta a presupuesto enviado", "agendar seguimiento el viernes" y ejecuta
// las acciones sobre el CRM. org/usuario se ligan server-side (no los infiere el modelo).
// =============================================================================
import { anthropic } from '../lib/claude';
import { CRM_STAGES, CRM_STAGE_LABELS, type CrmStage } from '@shared/schema';
import * as crm from './crmService';

interface Ctx { organizationId: string; userId: string | null; }

const tools = [
  {
    name: 'create_opportunity',
    description: 'Crea una nueva oportunidad comercial en el CRM.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Título de la oportunidad (ej. "Instalación eléctrica")' },
        contact_name: { type: 'string', description: 'Nombre del cliente o contacto' },
        phone: { type: 'string' },
        email: { type: 'string' },
        estimated_value: { type: 'number', description: 'Valor estimado en pesos' },
        stage: { type: 'string', enum: CRM_STAGES as unknown as string[], description: 'Etapa inicial (opcional)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'find_opportunity',
    description: 'Busca oportunidades por título o nombre de contacto. Úsalo antes de mover o agendar si no tenés el id.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Texto a buscar (título o contacto)' } },
      required: ['query'],
    },
  },
  {
    name: 'update_opportunity_stage',
    description: 'Mueve una oportunidad a otra etapa del pipeline.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Título o contacto de la oportunidad a mover' },
        stage: { type: 'string', enum: CRM_STAGES as unknown as string[] },
      },
      required: ['query', 'stage'],
    },
  },
  {
    name: 'schedule_activity',
    description: 'Registra/agenda una actividad (llamada, visita, seguimiento, etc.) en una oportunidad.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Título o contacto de la oportunidad' },
        type: { type: 'string', enum: ['call', 'whatsapp', 'email', 'meeting', 'visit', 'note'] },
        note: { type: 'string', description: 'Detalle de la actividad' },
        scheduled_at: { type: 'string', description: 'Fecha/hora ISO si es a futuro (opcional)' },
      },
      required: ['query', 'type'],
    },
  },
];

async function findOne(ctx: Ctx, query: string) {
  const list = await crm.listOpportunities(ctx.organizationId, { q: query });
  return list;
}

async function execTool(name: string, input: any, ctx: Ctx): Promise<any> {
  switch (name) {
    case 'create_opportunity': {
      const opp = await crm.createOpportunity({
        organizationId: ctx.organizationId, title: input.title,
        contactName: input.contact_name ?? null, phone: input.phone ?? null, email: input.email ?? null,
        estimatedValue: input.estimated_value != null ? String(input.estimated_value) : '0',
        stage: (CRM_STAGES.includes(input.stage) ? input.stage : 'consulta') as CrmStage,
        createdBy: ctx.userId,
      });
      return { ok: true, id: opp.id, title: opp.title, stage: opp.stage };
    }
    case 'find_opportunity': {
      const list = await findOne(ctx, input.query);
      return { count: list.length, results: list.slice(0, 5).map(o => ({ id: o.id, title: o.title, contact: o.contactName, stage: o.stage })) };
    }
    case 'update_opportunity_stage': {
      const list = await findOne(ctx, input.query);
      if (list.length === 0) return { ok: false, error: 'No se encontró ninguna oportunidad con ese criterio' };
      if (list.length > 1) return { ok: false, error: 'Hay varias coincidencias; pedile al usuario que aclare cuál', candidates: list.slice(0, 5).map(o => o.title) };
      const moved = await crm.moveStage(list[0].id, input.stage as CrmStage, ctx.userId);
      return { ok: true, id: list[0].id, title: list[0].title, stage: moved?.stage };
    }
    case 'schedule_activity': {
      const list = await findOne(ctx, input.query);
      if (list.length === 0) return { ok: false, error: 'No se encontró la oportunidad' };
      const act = await crm.addActivity({
        opportunityId: list[0].id, organizationId: ctx.organizationId,
        type: input.type, content: input.note ?? null,
        scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : null,
        createdByUserId: ctx.userId,
      });
      return { ok: true, opportunity: list[0].title, activityId: act.id };
    }
    default:
      return { ok: false, error: 'Acción desconocida' };
  }
}

export interface AgentResult { reply: string; actions: Array<{ tool: string; input: any; result: any }>; }

export async function runCrmCommand(text: string, ctx: Ctx): Promise<AgentResult> {
  const today = new Date().toISOString().slice(0, 10);
  const stageList = CRM_STAGES.map(s => `${s} (${CRM_STAGE_LABELS[s]})`).join(', ');
  const system = `Sos Aike, asistente del CRM de Aikestar para una PyME argentina. Hoy es ${today}.
Interpretás pedidos en español y ejecutás acciones usando las herramientas disponibles.
Etapas del pipeline: ${stageList}.
Cuando muevas o agendes sobre una oportunidad existente, primero buscala (find_opportunity) si no la tenés.
Respondé en español rioplatense, breve y concreto, confirmando lo que hiciste. Si falta info, preguntá.`;

  const messages: any[] = [{ role: 'user', content: text }];
  const actions: AgentResult['actions'] = [];
  let reply = '';

  for (let i = 0; i < 6; i++) {
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      tools: tools as any,
      messages,
    });

    const textOut = resp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    if (textOut) reply = textOut;

    if (resp.stop_reason !== 'tool_use') break;

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults: any[] = [];
    for (const block of resp.content as any[]) {
      if (block.type === 'tool_use') {
        let result: any;
        try { result = await execTool(block.name, block.input, ctx); }
        catch (e: any) { result = { ok: false, error: e?.message || 'error' }; }
        actions.push({ tool: block.name, input: block.input, result });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: reply || 'Listo.', actions };
}
