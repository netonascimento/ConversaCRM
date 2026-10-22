import Anthropic from '@anthropic-ai/sdk';
import { all, get, run, now } from '../db.js';
import { getCompany, anthropicKeyFor, aiModelFor } from './company.js';
import { recordUsage } from './ai-usage.js';
import { aiAllowed } from './plans.js';
import { handToHuman } from './assignment.js';
import { getContact, updateContact, changeStage, logActivity, formatMoney, firstName, saveCustomFields } from './crm.js';
import { createTask } from './tasks.js';
import { hasProfessionals, listProfessionals } from './professionals.js';
import { sendMessage } from './messaging.js';
import { availableSlots, nextAvailableSlots, createAppointment, listAppointments, updateAppointment } from './scheduling.js';
import { createCharge } from './billing.js';
import { zonedParts, formatLocal, formatDateBR, WEEKDAYS, zonedToUtc, addDays, friendlyDeadline } from './time.js';

const clients = new Map();
let clientFactory = (apiKey) => new Anthropic({ apiKey });
// Permite substituir o cliente nos testes.
export function setClientFactory(fn) { clientFactory = fn; clients.clear(); }

function clientFor(company) {
  const key = anthropicKeyFor(company);
  if (!key) return null;
  if (!clients.has(key)) clients.set(key, clientFactory(key));
  return clients.get(key);
}

// Toda chamada à API passa por aqui para o consumo de tokens ficar registrado.
async function createMessage(company, client, params) {
  const response = await client.beta.messages.create(params);
  recordUsage(company, response, params.model);
  return response;
}

// Modelos que aceitam o fallback automático do servidor em caso de recusa.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

function requestOptions(company) {
  const model = aiModelFor(company);
  const opts = { model };
  if (FALLBACK_MODELS.has(model)) Object.assign(opts, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  if (!model.includes('haiku-4')) opts.output_config = { effort: 'low' };
  return opts;
}

const textOf = (response) => response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

// ---- Comportamento configurável ----------------------------------------------
//
// A IA é montada a partir de blocos: objetivo da conversa, modo de cada capacidade
// (agenda, preço, cobrança), perguntas de triagem e regras. O modo define quais
// ferramentas ela recebe — no modo "sem agenda", por exemplo, ela nem tem como agendar.

export const OBJECTIVES = [
  { id: 'agendar', label: 'Agendar um atendimento', prompt: 'Seu objetivo principal é agendar um atendimento para o cliente.' },
  { id: 'vender', label: 'Vender produtos', prompt: 'Seu objetivo principal é conduzir o cliente até a compra.' },
  { id: 'qualificar', label: 'Fazer a triagem e passar para a equipe', prompt: 'Seu objetivo principal é entender a necessidade do cliente, fazer as perguntas da triagem e encaminhar para a equipe (agendando quando possível).' },
  { id: 'orcamento', label: 'Coletar pedido de orçamento', prompt: 'Seu objetivo principal é coletar as informações necessárias para um orçamento e registrar o pedido para a equipe.' },
  { id: 'duvidas', label: 'Tirar dúvidas', prompt: 'Seu objetivo principal é tirar dúvidas com base nas informações da empresa. Quando o cliente quiser avançar, encaminhe para a equipe.' },
];

export const SCHEDULING_MODES = [
  { id: 'auto', label: 'Automático: a IA agenda nos horários livres' },
  { id: 'confirm', label: 'Com confirmação: a IA reserva e a equipe confirma' },
  { id: 'request', label: 'Sem agenda: a IA anota a preferência e a equipe retorna com horários' },
  { id: 'link', label: 'Link externo: a IA envia o link de agendamento' },
  { id: 'off', label: 'Não agenda' },
];

export const PRICE_MODES = [
  { id: 'show', label: 'Informa o preço' },
  { id: 'from', label: 'Informa "a partir de"' },
  { id: 'describe', label: 'Só descreve, sem preço' },
  { id: 'hide', label: 'Não fala de valores' },
];

export const CHARGE_MODES = [
  { id: 'auto', label: 'A IA gera e envia a cobrança' },
  { id: 'approval', label: 'A IA pede, a equipe aprova' },
  { id: 'never', label: 'A IA não cobra' },
];

const PRICE_RULES = {
  show: 'Pode informar os preços do catálogo.',
  from: 'Ao falar de preço, diga sempre "a partir de" o valor do catálogo e explique que o valor final depende da avaliação.',
  describe: 'Não informe preços. Explique o serviço e diga que os valores são passados pela equipe ou no atendimento.',
  hide: 'Nunca fale de valores, preços ou honorários, nem por aproximação. Diga que isso é tratado diretamente com a equipe.',
};

const SCHEDULING_RULES = {
  auto: 'Para agendar: consulte os horários, ofereça 2 ou 3 opções e só chame "agendar" depois que o cliente escolher. Depois confirme data, hora e serviço.',
  confirm: 'Para agendar: consulte os horários, ofereça 2 ou 3 opções e, quando o cliente escolher, chame "agendar". O horário fica reservado, mas a equipe ainda precisa confirmar: deixe isso claro e diga que o cliente recebe a confirmação por aqui.',
  request: 'Você NÃO tem acesso à agenda. Quando o cliente quiser marcar, pergunte os dias e turnos de preferência e chame "solicitar_horario". Depois diga que a equipe retorna com os horários disponíveis até o prazo informado pela ferramenta. Nunca ofereça nem invente horários.',
  link: 'Quando o cliente quiser marcar, envie o link de agendamento: {link}. Você não tem acesso à agenda; nunca ofereça horários específicos.',
  off: 'A empresa não faz agendamentos por aqui. Se o cliente pedir, encaminhe para a equipe.',
};

function behavior(company) {
  const ai = company.settings.ai;
  const objective = OBJECTIVES.find((o) => o.id === ai.objective) || OBJECTIVES[0];
  const schedulingMode = SCHEDULING_MODES.some((m) => m.id === ai.scheduling_mode) ? ai.scheduling_mode : 'auto';
  // Modo link sem link cadastrado vira "sem agenda", para nunca prometer algo que não existe.
  const effectiveScheduling = schedulingMode === 'link' && !ai.external_booking_link ? 'request' : schedulingMode;
  return {
    objective,
    scheduling: effectiveScheduling,
    price: PRICE_RULES[ai.price_mode] ? ai.price_mode : 'show',
    charge: CHARGE_MODES.some((m) => m.id === ai.charge_mode) ? ai.charge_mode : 'auto',
    deposit: Math.min(100, Math.max(0, Math.round(Number(ai.deposit_percent) || 0))),
    intake: (ai.intake_questions || []).filter((q) => q.key && q.question),
  };
}

// ---- Ferramentas do agente ---------------------------------------------------

const TOOL_DEFS = {
  listar_profissionais: {
    name: 'listar_profissionais',
    description: 'Lista os profissionais (ex.: advogados, dentistas) com a especialidade e os serviços de cada um. Use para indicar com quem o cliente será atendido.',
    input_schema: { type: 'object', properties: {} },
  },
  listar_produtos: {
    name: 'listar_produtos',
    description: 'Lista os produtos e serviços da empresa. Use antes de falar de opções.',
    input_schema: { type: 'object', properties: {} },
  },
  consultar_horarios: {
    name: 'consultar_horarios',
    description: 'Consulta horários livres na agenda. Sem "data", retorna os próximos dias com vagas. Sempre consulte antes de oferecer um horário.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data no formato AAAA-MM-DD (opcional)' },
        produto_id: { type: 'integer', description: 'ID do serviço, para usar a duração e os profissionais corretos (opcional)' },
        profissional_id: { type: 'integer', description: 'ID do profissional, se o cliente tiver preferência (opcional)' },
      },
    },
  },
  agendar: {
    name: 'agendar',
    description: 'Agenda (ou reserva, se a empresa confirma manualmente) um horário para o cliente desta conversa. Só use depois que o cliente escolheu data e horário.',
    input_schema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:MM (24h)' },
        produto_id: { type: 'integer', description: 'ID do serviço (opcional)' },
        profissional_id: { type: 'integer', description: 'ID do profissional (opcional; sem ele o sistema escolhe quem está livre)' },
        observacoes: { type: 'string' },
      },
      required: ['data', 'hora'],
    },
  },
  solicitar_horario: {
    name: 'solicitar_horario',
    description: 'Registra que o cliente quer marcar um horário, com as preferências dele, para a equipe retornar com as opções.',
    input_schema: {
      type: 'object',
      properties: {
        preferencia: { type: 'string', description: 'Dias e turnos que o cliente prefere, ex.: "terça ou quinta à tarde"' },
        servico: { type: 'string', description: 'O que o cliente quer agendar' },
        profissional: { type: 'string', description: 'Profissional de preferência, se houver' },
        observacoes: { type: 'string' },
      },
      required: ['preferencia'],
    },
  },
  meus_agendamentos: {
    name: 'meus_agendamentos',
    description: 'Lista os próximos agendamentos do cliente desta conversa.',
    input_schema: { type: 'object', properties: {} },
  },
  remarcar_agendamento: {
    name: 'remarcar_agendamento',
    description: 'Remarca um agendamento do cliente para nova data/hora (consulte horários antes).',
    input_schema: {
      type: 'object',
      properties: { agendamento_id: { type: 'integer' }, data: { type: 'string' }, hora: { type: 'string' } },
      required: ['agendamento_id', 'data', 'hora'],
    },
  },
  cancelar_agendamento: {
    name: 'cancelar_agendamento',
    description: 'Cancela um agendamento do cliente quando ele pedir.',
    input_schema: { type: 'object', properties: { agendamento_id: { type: 'integer' } }, required: ['agendamento_id'] },
  },
  solicitar_orcamento: {
    name: 'solicitar_orcamento',
    description: 'Registra um pedido de orçamento para a equipe, depois de coletar o que o cliente precisa.',
    input_schema: {
      type: 'object',
      properties: {
        descricao: { type: 'string', description: 'O que o cliente precisa, com os detalhes coletados' },
        endereco: { type: 'string' },
      },
      required: ['descricao'],
    },
  },
  gerar_cobranca: {
    name: 'gerar_cobranca',
    description: 'Gera a cobrança (Pix ou link) quando o cliente confirmar que quer comprar/pagar.',
    input_schema: {
      type: 'object',
      properties: {
        produto_id: { type: 'integer', description: 'ID do produto (usa nome e preço do catálogo)' },
        descricao: { type: 'string', description: 'Descrição, se não houver produto' },
        valor: { type: 'number', description: 'Valor em reais, se não houver produto' },
        vencimento: { type: 'string', description: 'AAAA-MM-DD (padrão: hoje)' },
      },
    },
  },
  transferir_para_humano: {
    name: 'transferir_para_humano',
    description: 'Passa a conversa para a equipe: pedido explícito, reclamação, caso urgente ou algo que você não sabe responder.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
        urgente: { type: 'boolean', description: 'true se for uma situação urgente pelas regras da empresa' },
      },
      required: ['motivo'],
    },
  },
};

function atualizarClienteTool(intake) {
  const properties = {
    nome: { type: 'string' },
    email: { type: 'string' },
    documento: { type: 'string', description: 'CPF ou CNPJ' },
    interesse: { type: 'string', description: 'Resumo do que o cliente quer' },
    etapa: { type: 'string', enum: ['qualificado', 'proposta', 'perdido'] },
    valor_estimado: { type: 'number', description: 'Valor potencial da venda em reais' },
  };
  if (intake.length) {
    properties.triagem = {
      type: 'object',
      description: 'Respostas das perguntas de triagem',
      properties: Object.fromEntries(intake.map((q) => [q.key, { type: 'string', description: q.question }])),
    };
  }
  return {
    name: 'atualizar_cliente',
    description: 'Salva no CRM o que o cliente informou (dados, interesse, respostas da triagem) e avança a etapa do funil.',
    input_schema: { type: 'object', properties },
  };
}

export function toolsFor(company) {
  const b = behavior(company);
  const names = ['listar_produtos'];
  if (['auto', 'confirm', 'request'].includes(b.scheduling) && hasProfessionals(company.id)) names.push('listar_profissionais');
  if (b.scheduling === 'auto') names.push('consultar_horarios', 'agendar', 'meus_agendamentos', 'remarcar_agendamento', 'cancelar_agendamento');
  if (b.scheduling === 'confirm') names.push('consultar_horarios', 'agendar', 'meus_agendamentos', 'remarcar_agendamento', 'cancelar_agendamento');
  if (b.scheduling === 'request') names.push('solicitar_horario', 'meus_agendamentos');
  if (b.objective.id === 'orcamento') names.push('solicitar_orcamento');
  if (b.charge !== 'never') names.push('gerar_cobranca');
  names.push('transferir_para_humano');
  return [...names.map((n) => TOOL_DEFS[n]), atualizarClienteTool(b.intake)];
}

function priceText(mode, cents) {
  if (mode === 'show') return ` — ${formatMoney(cents)}`;
  if (mode === 'from') return ` — a partir de ${formatMoney(cents)}`;
  return '';
}

export async function executeTool(name, input, ctx) {
  const { company, contactId } = ctx;
  const cid = company.id;
  const tz = company.timezone;
  const b = behavior(company);
  // Defesa extra: a IA só executa ferramentas liberadas para esta empresa.
  if (!toolsFor(company).some((t) => t.name === name)) return `A ferramenta "${name}" não está disponível para esta empresa.`;
  switch (name) {
    case 'listar_produtos': {
      const products = all('SELECT id, name, description, price_cents, kind, duration_min FROM products WHERE company_id = ? AND active = 1', cid);
      if (!products.length) return 'Nenhum produto cadastrado.';
      return products.map((p) => `#${p.id} ${p.name}${priceText(b.price, p.price_cents)}${p.duration_min ? ` (${p.duration_min} min)` : ''}${p.description ? `: ${p.description}` : ''}`).join('\n');
    }
    case 'listar_profissionais': {
      const products = Object.fromEntries(all('SELECT id, name FROM products WHERE company_id = ?', cid).map((p) => [p.id, p.name]));
      return listProfessionals(cid, { activeOnly: true })
        .map((p) => `#${p.id} ${p.name}${p.role ? ` — ${p.role}` : ''} · atende: ${p.services.length ? p.services.map((id) => products[id]).filter(Boolean).join(', ') : 'todos os serviços'}`)
        .join('\n') || 'Nenhum profissional cadastrado.';
    }
    case 'consultar_horarios': {
      const fmtSlot = (s) => (s.professionals ? `${s.time} (${s.professionals.map((p) => `${p.name} #${p.id}`).join(', ')})` : s.time);
      if (input.data) {
        const slots = availableSlots(cid, input.data, input.produto_id || null, input.profissional_id || null);
        return slots.length ? `Livres em ${formatDateBR(input.data)}: ${slots.map(fmtSlot).join(', ')}` : `Sem horários livres em ${formatDateBR(input.data)}.`;
      }
      const days = nextAvailableSlots(cid, { productId: input.produto_id || null, professionalId: input.profissional_id || null });
      if (!days.length) return 'Sem horários livres nos próximos 7 dias. Ofereça registrar a preferência do cliente para a equipe retornar, ou transfira para um humano.';
      return days.map((d) => `${WEEKDAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()]} ${formatDateBR(d.date)}: ${d.slots.map(fmtSlot).join(', ')}`).join('\n');
    }
    case 'agendar': {
      const pendingConfirmation = b.scheduling === 'confirm';
      const appt = createAppointment(cid, {
        contactId, productId: input.produto_id || null, professionalId: input.profissional_id || null, date: input.data, time: input.hora,
        notes: input.observacoes || '', createdBy: 'ai', status: pendingConfirmation ? 'solicitado' : 'agendado',
      });
      const when = `${formatLocal(appt.start_at, tz, { dateStyle: 'full', timeStyle: 'short' })}${appt.professional_name ? ` com ${appt.professional_name}` : ''}`;
      if (!pendingConfirmation) return `Agendado com sucesso: #${appt.id} ${appt.title} em ${when}.`;
      const task = await createTask(cid, { contactId, type: 'confirmar_agendamento', title: `Confirmar horário — ${appt.title}`, details: `Solicitado para ${when}`, payload: { appointment_id: appt.id }, createdBy: 'ai' });
      return `Horário #${appt.id} reservado para ${when}, AGUARDANDO confirmação da equipe (prazo: ${friendlyDeadline(task.due_at, tz)}). Diga ao cliente que ele recebe a confirmação por aqui.`;
    }
    case 'solicitar_horario': {
      const task = await createTask(cid, {
        contactId, type: 'horario',
        details: [`Preferência: ${input.preferencia}`, input.servico && `Serviço: ${input.servico}`, input.profissional && `Profissional: ${input.profissional}`, input.observacoes].filter(Boolean).join('\n'),
        createdBy: 'ai',
      });
      if (input.servico) updateContact(cid, contactId, { interest: input.servico });
      return `Pedido registrado para a equipe. Prazo para retornar com os horários: ${friendlyDeadline(task.due_at, tz)}. Informe esse prazo ao cliente.`;
    }
    case 'meus_agendamentos': {
      const list = listAppointments(cid, { contactId, from: now() }).filter((a) => a.status !== 'cancelado');
      return list.length ? list.map((a) => `#${a.id} ${a.title} — ${formatLocal(a.start_at, tz)} (${a.status === 'solicitado' ? 'aguardando confirmação' : a.status})`).join('\n') : 'O cliente não tem agendamentos futuros.';
    }
    case 'remarcar_agendamento':
    case 'cancelar_agendamento': {
      const appt = get('SELECT * FROM appointments WHERE id = ? AND company_id = ? AND contact_id = ?', input.agendamento_id, cid, contactId);
      if (!appt) return 'Agendamento não encontrado para este cliente.';
      if (name === 'cancelar_agendamento') {
        updateAppointment(cid, appt.id, { status: 'cancelado' });
        return `Agendamento #${appt.id} cancelado.`;
      }
      const local = zonedParts(zonedToUtc(input.data, input.hora, tz), tz);
      const free = availableSlots(cid, input.data, appt.product_id, appt.professional_id).some((s) => s.time === local.time);
      if (!free) return 'Esse horário não está disponível. Consulte os horários livres e ofereça outro.';
      const updated = updateAppointment(cid, appt.id, { start_at: zonedToUtc(input.data, input.hora, tz).toISOString() });
      return `Agendamento #${appt.id} remarcado para ${formatLocal(updated.start_at, tz, { dateStyle: 'full', timeStyle: 'short' })}${updated.status === 'solicitado' ? ' (aguardando confirmação da equipe)' : ''}.`;
    }
    case 'solicitar_orcamento': {
      const task = await createTask(cid, {
        contactId, type: 'orcamento',
        details: [input.descricao, input.endereco && `Endereço: ${input.endereco}`].filter(Boolean).join('\n'),
        createdBy: 'ai',
      });
      updateContact(cid, contactId, { interest: input.descricao.slice(0, 200) });
      changeStage(cid, contactId, 'qualificado', 'pedido de orçamento');
      return `Pedido de orçamento registrado. A equipe retorna até ${friendlyDeadline(task.due_at, tz)}. Informe esse prazo ao cliente.`;
    }
    case 'atualizar_cliente': {
      const patch = {};
      if (input.nome) patch.name = input.nome;
      if (input.email) patch.email = input.email;
      if (input.documento) patch.document = input.documento;
      if (input.interesse) patch.interest = input.interesse;
      if (input.valor_estimado) patch.value_cents = Math.round(input.valor_estimado * 100);
      updateContact(cid, contactId, patch);
      if (input.triagem) {
        const allowed = new Set(b.intake.map((q) => q.key));
        saveCustomFields(cid, contactId, Object.fromEntries(Object.entries(input.triagem).filter(([k]) => allowed.has(k))));
      }
      if (input.etapa) changeStage(cid, contactId, input.etapa, 'atualizado pela IA');
      return 'Dados salvos no CRM.';
    }
    case 'gerar_cobranca': {
      let description = input.descricao;
      let amountCents = input.valor ? Math.round(input.valor * 100) : 0;
      if (input.produto_id) {
        const p = get('SELECT * FROM products WHERE id = ? AND company_id = ?', input.produto_id, cid);
        if (!p) return 'Produto não encontrado.';
        description = description || p.name;
        amountCents = amountCents || p.price_cents;
      }
      if (!description || !(amountCents > 0)) return 'Informe o produto ou a descrição e o valor.';
      if (b.charge === 'approval') {
        const task = await createTask(cid, {
          contactId, type: 'aprovar_cobranca', title: `Aprovar cobrança — ${description}`,
          details: `${description} — ${formatMoney(amountCents)}`,
          payload: { product_id: input.produto_id || null, description, amount_cents: amountCents, due_date: input.vencimento || null },
          createdBy: 'ai',
        });
        changeStage(cid, contactId, 'proposta', 'cobrança solicitada');
        return `Pedido de cobrança enviado para aprovação da equipe (prazo: ${friendlyDeadline(task.due_at, tz)}). Diga ao cliente que ele recebe os dados de pagamento por aqui assim que a equipe aprovar.`;
      }
      const charge = await createCharge(cid, { contactId, productId: input.produto_id || null, description, amountCents, dueDate: input.vencimento, send: true });
      changeStage(cid, contactId, 'proposta', 'cobrança gerada pela IA');
      return `Cobrança #${charge.id} de ${formatMoney(charge.amount_cents)} criada e JÁ ENVIADA ao cliente em uma mensagem separada com os dados de pagamento. Apenas confirme brevemente.`;
    }
    case 'transferir_para_humano': {
      handToHuman(cid, contactId);
      logActivity(cid, contactId, 'ia', `IA transferiu para humano${input.urgente ? ' (URGENTE)' : ''}: ${input.motivo}`);
      await createTask(cid, { contactId, type: input.urgente ? 'urgente' : 'retorno', details: input.motivo, createdBy: 'ai' });
      return input.urgente
        ? 'Conversa transferida com prioridade: a equipe foi avisada agora. Tranquilize o cliente e diga que alguém responde em instantes.'
        : 'Conversa transferida. Avise o cliente que um atendente vai continuar o atendimento em breve.';
    }
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}

// ---- Prompt ------------------------------------------------------------------

export function stablePrompt(company) {
  const ai = company.settings.ai;
  const b = behavior(company);
  const sections = [
    `Você é ${ai.agent_name}, atendente virtual da empresa "${company.name}" no WhatsApp.`,
    `Sobre a empresa:\n${ai.business_description || '(sem descrição cadastrada — use o catálogo de produtos para entender o negócio)'}`,
    `Objetivo: ${b.objective.prompt}`,
    `Preços: ${PRICE_RULES[b.price]}`,
    `Agenda: ${SCHEDULING_RULES[b.scheduling].replace('{link}', ai.external_booking_link)}`,
  ];
  if (['auto', 'confirm', 'request'].includes(b.scheduling) && hasProfessionals(company.id)) {
    sections.push('Profissionais: a empresa tem vários profissionais, cada um com seus serviços e horários. Indique o profissional que atende o assunto do cliente (use "listar_profissionais"). Se o cliente não tiver preferência, não precisa escolher: o sistema marca com quem estiver livre.');
  }
  if (b.intake.length) {
    sections.push(`Triagem: ao longo da conversa, de forma natural e uma pergunta por vez, descubra:\n${b.intake.map((q) => `- ${q.label}: ${q.question}`).join('\n')}\nSalve cada resposta com "atualizar_cliente" (campo "triagem").`);
  }
  if (b.charge === 'approval') sections.push('Cobrança: quando o cliente quiser pagar, use "gerar_cobranca"; ela vai para aprovação da equipe antes de chegar ao cliente.');
  if (b.charge === 'auto') sections.push('Cobrança: quando o cliente quiser pagar ou fechar, use "gerar_cobranca".');
  // Sinal: só com cobrança ligada, agenda própria e preço que pode ser dito ao cliente.
  if (b.deposit && b.charge !== 'never' && ['auto', 'confirm'].includes(b.scheduling) && b.price !== 'hide') {
    sections.push(`Sinal: logo depois de agendar um serviço com preço no catálogo, explique que o horário fica garantido com um sinal de ${b.deposit}% do valor e use "gerar_cobranca" com descricao "Sinal - <nome do serviço>" e valor = ${b.deposit}% do preço (arredonde para centavos). O restante é pago no atendimento. Serviço sem preço no catálogo: não cobre sinal.`);
  }
  if (ai.urgency_rules.trim()) sections.push(`Situações urgentes (use "transferir_para_humano" com urgente=true imediatamente):\n${ai.urgency_rules.trim()}`);
  if (ai.never_say.trim()) sections.push(`Nunca faça isto:\n${ai.never_say.trim()}`);
  sections.push(`Instruções do dono da empresa:\n${ai.instructions}`);
  sections.push(`Regras gerais:
- Escreva como uma pessoa no WhatsApp: mensagens curtas, português do Brasil, no máximo 1 ou 2 emojis.
- Use as ferramentas para consultar produtos e agenda. Nunca invente preço, horário, endereço ou política que não esteja nestas instruções ou nos resultados das ferramentas.
- Quando o cliente disser nome, e-mail, documento ou o que procura, salve com "atualizar_cliente".
- Se o cliente pedir um humano, reclamar, ou se você não souber responder, use "transferir_para_humano".
- Nunca diga que é uma IA a menos que perguntem diretamente; se perguntarem, seja honesto.
- Responda apenas com o texto da mensagem para o cliente.`);
  return sections.join('\n\n');
}

function dynamicContext(company, contact) {
  const tz = company.timezone;
  const nowParts = zonedParts(new Date(), tz);
  const hours = Object.entries(company.settings.business_hours)
    .map(([d, r]) => `${d}: ${r.length ? r.map(([a, c]) => `${a}-${c}`).join(', ') : 'fechado'}`).join(' | ');
  const triagem = JSON.parse(contact.custom_fields || '{}');
  return `Agora: ${formatLocal(new Date().toISOString(), tz, { dateStyle: 'full', timeStyle: 'short' })} (hoje = ${nowParts.date}, amanhã = ${addDays(nowParts.date, 1)}).
Horário de funcionamento: ${hours}
Cliente: nome="${contact.name || 'não informado'}", telefone=${contact.phone || '-'}, e-mail=${contact.email || '-'}, documento=${contact.document ? 'informado' : 'não informado'}, etapa do funil=${contact.stage}, interesse="${contact.interest || '-'}".
Triagem já respondida: ${Object.keys(triagem).length ? JSON.stringify(triagem) : 'nada ainda'}.`;
}

function buildHistory(companyId, contactId) {
  const rows = all('SELECT direction, body FROM messages WHERE company_id = ? AND contact_id = ? ORDER BY id DESC LIMIT 40', companyId, contactId).reverse();
  const msgs = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += `\n${r.body}`;
    else msgs.push({ role, content: r.body });
  }
  if (msgs[0]?.role === 'assistant') msgs.unshift({ role: 'user', content: '[início da conversa]' });
  return msgs;
}

// ---- Resposta automática -----------------------------------------------------

/** Gera a resposta da IA para a conversa. Retorna o texto (ou null se não houver o que responder). */
export async function generateReply(companyId, contactId) {
  const company = getCompany(companyId);
  // Teste grátis: nenhuma resposta automática (nem as simples, sem chave).
  if (!aiAllowed(company)) return null;
  const contact = getContact(companyId, contactId);
  const messages = buildHistory(companyId, contactId);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;

  const client = clientFor(company);
  if (!client) return ruleBasedReply(company, contact, messages[messages.length - 1].content);

  const ctx = { company, contactId };
  const tools = toolsFor(company);
  for (let i = 0; i < 8; i++) {
    const response = await createMessage(company, client, {
      ...requestOptions(company),
      max_tokens: 4096,
      system: [
        { type: 'text', text: stablePrompt(company), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicContext(company, getContact(companyId, contactId)) },
      ],
      tools,
      messages,
    });
    if (response.stop_reason === 'refusal') return null;
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) return textOf(response) || null;

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const t of toolUses) {
      try {
        results.push({ type: 'tool_result', tool_use_id: t.id, content: await executeTool(t.name, t.input || {}, ctx) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: t.id, content: `Erro: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return null;
}

// ---- Respostas automáticas (sem chave de API) ----------------------------------
// Seguem os mesmos blocos de comportamento: triagem, urgência, modos de agenda e preço.

const STOPWORDS = new Set(['para', 'com', 'que', 'uma', 'por', 'dos', 'das', 'nos', 'nas', 'cliente', 'muito', 'mais', 'está', 'esta', 'sobre', 'quando']);
const plainText = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "audiência marcada; cliente preso, dor forte" -> palavras-chave principais de cada situação
function urgencyKeywords(rules) {
  return rules.split(/[\n;,.]|\bou\b/).map((item) => plainText(item).split(/[^a-z0-9]+/).find((w) => w.length >= 4 && !STOPWORDS.has(w))).filter(Boolean);
}

const WEEKDAY_WORDS = [['domingo'], ['segunda'], ['terca'], ['quarta'], ['quinta'], ['sexta'], ['sabado']];

// Lê uma escolha de horário: "10h", "às 14:30", "amanhã 9h", "quinta 15h", "22/10 às 10h"
export function parseTimeChoice(text, tz) {
  const t = plainText(text);
  // Só vale como horário com "h", ":" ou "às" antes (evita confundir "22/10" ou "2 dentes" com hora).
  const tm = [...t.matchAll(/\b([01]?\d|2[0-3])(?:[:h]([0-5]\d))?\s*(h|hs|horas)?(?![\d/])/g)]
    .find((m) => /[:h]/.test(m[0]) || /\bas\s*$/.test(t.slice(0, m.index)));
  if (!tm) return null;
  const time = `${tm[1].padStart(2, '0')}:${tm[2] || '00'}`;
  const today = zonedParts(new Date(), tz).date;
  let date = null;
  if (/\bhoje\b/.test(t)) date = today;
  else if (/\bamanha\b/.test(t)) date = addDays(today, 1);
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (dm) date = `${today.slice(0, 4)}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
  const wd = WEEKDAY_WORDS.findIndex(([w]) => t.includes(w));
  if (!date && wd >= 0) {
    for (let i = 0; i < 7; i++) if (new Date(`${addDays(today, i)}T12:00:00Z`).getUTCDay() === wd) { date = addDays(today, i); break; }
  }
  return { time, date };
}

// Descobre o serviço pelo que o cliente já disse (ex.: "trabalhista" -> "Consulta inicial — Trabalhista").
function guessService(companyId, texts) {
  const words = new Set(plainText(texts.join(' ')).split(/[^a-z0-9]+/).filter((w) => w.length >= 5));
  let best = null;
  for (const p of all("SELECT id, name, description FROM products WHERE company_id = ? AND active = 1 AND kind = 'servico'", companyId)) {
    const score = plainText(p.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && words.has(w)).length * 2
      + plainText(p.description || '').split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && words.has(w)).length;
    if (score && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id || null;
}

export async function ruleBasedReply(company, contact, text) {
  const t = plainText(text);
  const b = behavior(company);
  const tz = company.timezone;
  const nome = firstName(contact.name);
  const answers = JSON.parse(contact.custom_fields || '{}');
  const lastAi = get("SELECT body FROM messages WHERE contact_id = ? AND direction = 'out' AND author = 'ai' ORDER BY id DESC LIMIT 1", contact.id)?.body || '';
  const firstContact = !lastAi;
  const greet = `Olá${nome ? `, ${nome}` : ''}! Aqui é ${company.settings.ai.agent_name}, da ${company.name}. 😊`;
  const withGreet = (msg) => (firstContact ? `${greet}\n${msg}` : msg);
  const deadline = (task) => friendlyDeadline(task.due_at, tz);
  const recentInbound = all("SELECT body FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 6", contact.id).map((m) => m.body);
  const serviceId = () => guessService(company.id, [...Object.values(answers), contact.interest || '', text, ...recentInbound]);

  // 1. Pedido de humano
  if (/(humano|atendente|pessoa de verdade|reclama)/.test(t)) {
    handToHuman(company.id, contact.id);
    logActivity(company.id, contact.id, 'ia', 'Transferido para humano (pedido do cliente)');
    await createTask(company.id, { contactId: contact.id, type: 'retorno', details: 'Cliente pediu para falar com um atendente', createdBy: 'ai' });
    return 'Claro! Vou chamar um atendente para continuar com você. Só um instante. 🙏';
  }

  // 2. Urgência configurada
  const hit = urgencyKeywords(company.settings.ai.urgency_rules || '').find((w) => t.includes(w));
  if (hit) {
    handToHuman(company.id, contact.id);
    logActivity(company.id, contact.id, 'ia', `IA identificou urgência ("${hit}") e chamou a equipe`);
    await createTask(company.id, { contactId: contact.id, type: 'urgente', details: `Mensagem do cliente: "${text}"`, createdBy: 'ai' });
    return 'Entendi, isso é urgente. Já avisei a equipe e alguém vai falar com você em instantes. 🙏';
  }

  // 3. Resposta a uma pergunta de triagem feita na mensagem anterior
  const pendingQ = b.intake.find((q) => !answers[q.key] && lastAi.includes(q.question));
  if (pendingQ) {
    answers[pendingQ.key] = text.trim();
    saveCustomFields(company.id, contact.id, { [pendingQ.key]: text.trim() });
  }

  // 4. Resposta à pergunta de preferência de horário (modo sem agenda)
  if (lastAi.includes('dia ou turno de preferência')) {
    const task = get("SELECT * FROM tasks WHERE contact_id = ? AND type = 'horario' AND status = 'aberta' ORDER BY id DESC LIMIT 1", contact.id);
    if (task) run('UPDATE tasks SET details = ? WHERE id = ?', `${task.details}\nPreferência: ${text.trim()}`, task.id);
    return 'Anotado! Assim que a equipe verificar a agenda, te mando as opções por aqui. 😊';
  }

  // 5. Escolha de um horário oferecido
  if (['auto', 'confirm'].includes(b.scheduling) && lastAi.includes('horários livres')) {
    const choice = parseTimeChoice(text, tz);
    if (choice) {
      const dates = choice.date ? [choice.date] : Array.from({ length: 7 }, (_, i) => addDays(zonedParts(new Date(), tz).date, i));
      const productId = serviceId();
      const date = dates.find((d) => availableSlots(company.id, d, productId).some((s) => s.time === choice.time));
      if (date) {
        const confirm = b.scheduling === 'confirm';
        const appt = createAppointment(company.id, { contactId: contact.id, productId, date, time: choice.time, createdBy: 'ai', status: confirm ? 'solicitado' : 'agendado' });
        const when = `${formatLocal(appt.start_at, tz, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${appt.professional_name ? ` com ${appt.professional_name}` : ''}`;
        if (!confirm) return `Prontinho! Agendado para ${when}. Até lá! 😊`;
        const task = await createTask(company.id, { contactId: contact.id, type: 'confirmar_agendamento', title: `Confirmar horário — ${appt.title}`, details: `Solicitado para ${when}`, payload: { appointment_id: appt.id }, createdBy: 'ai' });
        return `Reservei ${when} para você! A equipe confirma até ${deadline(task)} e eu te aviso por aqui. 😊`;
      }
      return 'Esse horário não está livre. Quer escolher outro dos que te passei?';
    }
  }

  const nextQ = b.intake.find((q) => !answers[q.key]);
  const triageFirst = ['qualificar', 'orcamento'].includes(b.objective.id);

  // 6. Pergunta sobre preço
  if (/(preco|valor|quanto|custa|honorario)/.test(t) || (/(servico|produto|opcoes|trabalham)/.test(t) && !triageFirst)) {
    const products = all('SELECT name, price_cents FROM products WHERE company_id = ? AND active = 1 LIMIT 8', company.id);
    if (products.length) {
      const list = products.map((p) => `• ${p.name}${priceText(b.price, p.price_cents)}`).join('\n');
      const note = b.price === 'hide' || b.price === 'describe' ? '\n\nOs valores são passados diretamente pela nossa equipe.' : '';
      return withGreet(`Trabalhamos com:\n${list}${note}\n\n${nextQ && triageFirst ? nextQ.question : 'Quer saber mais de alguma ou marcar um horário?'}`);
    }
  }

  // 7. Triagem antes de avançar (quando o objetivo é qualificar ou orçar)
  if (nextQ && (triageFirst || pendingQ)) return withGreet(pendingQ ? `Obrigada! ${nextQ.question}` : nextQ.question);

  // 8. Orçamento com a triagem completa
  if (b.objective.id === 'orcamento' && (pendingQ || /(orcamento|preciso|quero)/.test(t))) {
    const summary = b.intake.map((q) => `${q.label}: ${answers[q.key] || '-'}`).join('\n');
    const task = await createTask(company.id, { contactId: contact.id, type: 'orcamento', details: summary || `Mensagem do cliente: "${text}"`, createdBy: 'ai' });
    return `Obrigada! Já passei tudo para a equipe e te enviamos o orçamento até ${deadline(task)}. 😊`;
  }

  // 9. Agendamento (pedido direto, ou próximo passo depois da triagem)
  const wantsSchedule = /(agend|horario|marcar|dispon|vaga|amanha|hoje|consulta|reuniao|atendimento)/.test(t);
  if (wantsSchedule || (pendingQ && !nextQ && b.objective.id !== 'duvidas')) {
    const lead = pendingQ && !nextQ ? 'Obrigada pelas informações! ' : '';
    if (b.scheduling === 'link') return withGreet(`${lead}Você pode escolher o melhor horário por aqui: ${company.settings.ai.external_booking_link}`);
    if (b.scheduling === 'off') {
      await createTask(company.id, { contactId: contact.id, type: 'retorno', details: `Mensagem do cliente: "${text}"`, createdBy: 'ai' });
      return withGreet(`${lead}Vou pedir para alguém da equipe falar com você, tudo bem?`);
    }
    if (b.scheduling === 'request') {
      const task = await createTask(company.id, { contactId: contact.id, type: 'horario', details: `Mensagem do cliente: "${text}"`, createdBy: 'ai' });
      return withGreet(`${lead}Vou verificar a agenda com a equipe e te retorno com os horários disponíveis até ${deadline(task)}. Tem algum dia ou turno de preferência?`);
    }
    const productId = serviceId();
    const days = nextAvailableSlots(company.id, { productId, days: 5, perDay: 3 });
    if (days.length) {
      const names = [...new Set(days.flatMap((d) => d.slots.flatMap((sl) => (sl.professionals || []).map((p) => p.name))))];
      const who = names.length ? `Quem atende o seu caso: ${names.join(' ou ')}. ` : '';
      return withGreet(`${lead}${who}Tenho estes horários livres:\n${days.slice(0, 3).map((d) => `• ${WEEKDAYS[new Date(`${d.date}T12:00:00Z`).getUTCDay()]} ${formatDateBR(d.date)}: ${d.times.join(', ')}`).join('\n')}\n\nQual fica melhor para você? É só responder com o dia e a hora (ex.: "amanhã às 10h").${b.scheduling === 'confirm' ? ' A equipe confirma o horário logo em seguida.' : ''}`);
    }
    const task = await createTask(company.id, { contactId: contact.id, type: 'horario', details: 'Sem horários livres nos próximos dias', createdBy: 'ai' });
    return withGreet(`${lead}A agenda dos próximos dias está cheia. Vou ver com a equipe e te retorno até ${deadline(task)}.`);
  }

  // 10. Triagem pendente em outros objetivos, ou saudação
  if (nextQ) return withGreet(nextQ.question);
  return withGreet('Como posso te ajudar? Posso te contar sobre nossos *serviços*, ver *horários* ou chamar um *atendente*.');
}

const pending = new Map();
const running = new Set();
export const AI_DEBOUNCE_MS = Number(process.env.AI_DEBOUNCE_MS || 2500);

/** Aguarda alguns segundos (o cliente costuma mandar várias mensagens seguidas) e responde uma vez. */
export function scheduleAiReply(companyId, contactId) {
  const key = `${companyId}:${contactId}`;
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    replyNow(companyId, contactId).catch((err) => console.error('[ia] erro ao responder:', err.message));
  }, AI_DEBOUNCE_MS));
}

export async function replyNow(companyId, contactId) {
  const key = `${companyId}:${contactId}`;
  if (running.has(key)) return scheduleAiReply(companyId, contactId);
  running.add(key);
  try {
    const contact = getContact(companyId, contactId);
    if (!contact?.ai_enabled) return null;
    let reply;
    try {
      reply = await generateReply(companyId, contactId);
    } catch (err) {
      console.error('[ia] falha na API, usando respostas automáticas:', err.message);
      logActivity(companyId, contactId, 'ia', `Falha na IA: ${err.message}`);
      const last = get("SELECT body FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", contactId);
      reply = await ruleBasedReply(getCompany(companyId), contact, last?.body || '');
    }
    if (!reply) return null;
    return await sendMessage(companyId, contactId, reply, 'ai');
  } finally {
    running.delete(key);
  }
}

// ---- Usos auxiliares ---------------------------------------------------------

/** Personaliza uma mensagem de follow-up com base na conversa. Retorna null se a IA não estiver disponível. */
export async function writeFollowup(company, contact, baseText, stepNumber) {
  if (!aiAllowed(company)) return null;
  const client = clientFor(company);
  if (!client) return null;
  const history = all('SELECT direction, body FROM messages WHERE contact_id = ? ORDER BY id DESC LIMIT 12', contact.id)
    .reverse().map((m) => `${m.direction === 'in' ? 'Cliente' : 'Empresa'}: ${m.body}`).join('\n');
  try {
    const response = await createMessage(company, client, {
      ...requestOptions(company),
      max_tokens: 2048,
      system: stablePrompt(company),
      messages: [{
        role: 'user',
        content: `Escreva a mensagem nº ${stepNumber} de follow-up para ${contact.name || 'o cliente'} (etapa: ${contact.stage}, interesse: ${contact.interest || 'não informado'}).
Use como base esta mensagem modelo, mantendo a intenção, mas personalize com o contexto da conversa:
"""${baseText}"""

Conversa recente:
${history || '(nenhuma mensagem ainda)'}

Responda somente com o texto final da mensagem, curto e natural.`,
      }],
    });
    return response.stop_reason === 'refusal' ? null : textOf(response) || null;
  } catch (err) {
    console.error('[ia] follow-up sem IA:', err.message);
    return null;
  }
}

/** Gera recomendações a partir das métricas do dashboard. */
export async function generateInsights(company, metrics) {
  const client = clientFor(company);
  if (!client) return ruleBasedInsights(metrics);
  const response = await createMessage(company, client, {
    ...requestOptions(company),
    max_tokens: 4096,
    system: 'Você é um consultor de vendas para pequenas empresas brasileiras. Seja direto e prático.',
    messages: [{
      role: 'user',
      content: `Estas são as métricas dos últimos ${metrics.period_days} dias da empresa "${company.name}":
${JSON.stringify(metrics, null, 2)}

Dê de 3 a 5 recomendações práticas e priorizadas para vender mais, atender melhor e receber em dia. Use tópicos curtos (máximo 2 linhas cada), citando os números.`,
    }],
  });
  return textOf(response);
}

export function ruleBasedInsights(m) {
  const tips = [];
  if (m.overdue_cents > 0) tips.push(`• Você tem ${formatMoney(m.overdue_cents)} em cobranças vencidas. Confira se a régua de cobrança está ativa e ofereça renegociação aos maiores devedores.`);
  if (m.leads_new > 0 && m.conversion_rate < 20) tips.push(`• Conversão de ${m.conversion_rate}%: crie um follow-up automático para leads em "Proposta" e responda rápido os novos contatos.`);
  if (m.stages?.novo > 5) tips.push(`• ${m.stages.novo} leads ainda estão em "Novo". Ative um follow-up de boas-vindas para eles.`);
  if (m.appointments_upcoming === 0) tips.push('• Nenhum agendamento futuro. Use a prospecção no Google Maps para encher a agenda.');
  if (m.ai_messages > 0) tips.push(`• A IA enviou ${m.ai_messages} mensagens no período, tempo que sua equipe economizou.`);
  if (!tips.length) tips.push('• Tudo em ordem! Continue prospectando e acompanhe o funil semanalmente.');
  return `${tips.join('\n')}\n\n(Configure a chave da API Anthropic em Configurações para insights personalizados por IA.)`;
}

/**
 * Resume uma intimação/publicação do Diário (processos de advocacia) em linguagem simples.
 * Retorna { summary, severity, deadline } ou null sem IA. Nunca afirma prazo final.
 */
export async function summarizeLegalEvent(company, { title, text, court, date }) {
  if (!aiAllowed(company)) return null;
  const client = clientFor(company);
  if (!client) return null;
  const response = await createMessage(company, client, {
    ...requestOptions(company),
    max_tokens: 1024,
    system: 'Você ajuda advogados brasileiros a entender publicações do Diário de Justiça. Responda só com JSON válido, sem texto fora dele.',
    messages: [{
      role: 'user',
      content: `Publicação (${title}, ${court}, disponibilizada em ${date}):
"""
${String(text || '').slice(0, 12000)}
"""

Devolva JSON com:
- "resumo": 1 ou 2 frases em português simples dizendo o que aconteceu e o que se pede ao advogado.
- "severidade": "alta" (sentença, decisão, intimação para se manifestar ou cumprir algo, audiência, penhora/bloqueio, citação), "media" ou "baixa" (mero expediente, juntada, remessa).
- "prazo": o prazo mencionado no texto como aparece (ex.: "15 dias úteis"), ou null se não houver. Não calcule a data final.`,
    }],
  });
  const raw = textOf(response).replace(/^```(?:json)?\s*|\s*```$/g, '');
  const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const severity = ['alta', 'media', 'baixa'].includes(data.severidade) ? data.severidade : null;
  return { summary: String(data.resumo || '').slice(0, 600) || null, severity, deadline: data.prazo ? String(data.prazo).slice(0, 80) : null };
}
