import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCompany } from './setup.js';

const { all, get, run } = await import('../src/db.js');
const { saveSettings, getCompany } = await import('../src/services/company.js');
const { createContact, getContact } = await import('../src/services/crm.js');
const { toolsFor, stablePrompt, replyNow, setClientFactory, ruleBasedReply, executeTool } = await import('../src/services/ai.js');
const { listTasks, processOverdueTasks } = await import('../src/services/tasks.js');
const { updateAppointment } = await import('../src/services/scheduling.js');
const { addBusinessHours } = await import('../src/services/time.js');
const { todayIn, addDays } = await import('../src/services/time.js');

after(() => setClientFactory(() => null));

const names = (company) => toolsFor(company).map((t) => t.name);

function scripted(steps) {
  const requests = [];
  setClientFactory(() => ({ beta: { messages: { create: async (req) => { requests.push(structuredClone(req)); return steps.shift(); } } } }));
  return requests;
}

test('o modo da agenda define quais ferramentas a IA recebe', () => {
  const cid = makeCompany();
  const set = (ai) => { saveSettings(cid, { ai }); return getCompany(cid); };
  assert.ok(names(set({ scheduling_mode: 'auto' })).includes('agendar'));
  const request = names(set({ scheduling_mode: 'request' }));
  assert.ok(request.includes('solicitar_horario'));
  assert.ok(!request.includes('agendar') && !request.includes('consultar_horarios'), 'sem agenda, a IA não tem como agendar');
  assert.ok(!names(set({ scheduling_mode: 'off' })).some((n) => ['agendar', 'solicitar_horario'].includes(n)));
  // Link sem endereço cadastrado vira "sem agenda".
  assert.ok(names(set({ scheduling_mode: 'link', external_booking_link: '' })).includes('solicitar_horario'));
  const link = set({ scheduling_mode: 'link', external_booking_link: 'https://cal.com/escritorio' });
  assert.ok(!names(link).includes('solicitar_horario'));
  assert.match(stablePrompt(link), /cal\.com\/escritorio/);
  assert.ok(!names(set({ charge_mode: 'never' })).includes('gerar_cobranca'));
  assert.ok(names(set({ objective: 'orcamento' })).includes('solicitar_orcamento'));
});

test('sinal: com cobrança ligada a IA pede o sinal depois de agendar; sem cobrança ou com preço oculto, não', () => {
  const cid = makeCompany();
  const prompt = (ai) => { saveSettings(cid, { ai }); return stablePrompt(getCompany(cid)); };
  assert.match(prompt({ scheduling_mode: 'auto', charge_mode: 'approval', price_mode: 'from', deposit_percent: 30 }), /sinal de 30%/);
  assert.doesNotMatch(prompt({ deposit_percent: 0 }), /Sinal:/);
  assert.doesNotMatch(prompt({ deposit_percent: 30, charge_mode: 'never' }), /Sinal:/);
  assert.doesNotMatch(prompt({ charge_mode: 'auto', price_mode: 'hide' }), /Sinal:/);
});

test('compatibilidade: configuração antiga sem cobrança pela IA vira charge_mode "never"', () => {
  const cid = makeCompany();
  run("UPDATE companies SET settings = json_remove(json_set(settings, '$.ai.can_create_charges', json('false')), '$.ai.charge_mode') WHERE id = ?", cid);
  assert.equal(getCompany(cid).settings.ai.charge_mode, 'never');
});

test('preço oculto: o catálogo chega à IA sem valores e o prompt proíbe falar de preço', async () => {
  const cid = makeCompany({ ai: { price_mode: 'hide' } });
  run("INSERT INTO products (company_id, name, price_cents) VALUES (?, 'Consulta inicial', 30000)", cid);
  const company = getCompany(cid);
  const c = createContact(cid, { name: 'Rui', phone: '11911112222' });
  const out = await executeTool('listar_produtos', {}, { company, contactId: c.id });
  assert.match(out, /Consulta inicial/);
  assert.doesNotMatch(out, /R\$/);
  assert.match(stablePrompt(company), /Nunca fale de valores/);
});

test('sem agenda (advocacia): IA registra a preferência, cria tarefa com prazo e salva a triagem', async () => {
  const cid = makeCompany({
    ai: {
      objective: 'qualificar', scheduling_mode: 'request', price_mode: 'hide',
      intake_questions: [{ key: 'area', label: 'Área do caso', question: 'É trabalhista, família ou outro?' }],
      urgency_rules: 'audiência nos próximos dias', never_say: 'dar parecer jurídico',
    },
    integrations: { anthropic_api_key: 'sk-teste' },
  });
  const c = createContact(cid, { name: 'Marta Silva', phone: '11922223333' });
  run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'in', 'contact', 'Fui demitida sem receber, quero uma consulta, pode ser terça de manhã')", cid, c.id);
  const requests = scripted([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 'a', name: 'atualizar_cliente', input: { triagem: { area: 'trabalhista', inventado: 'x' }, interesse: 'rescisão' } },
      { type: 'tool_use', id: 'b', name: 'solicitar_horario', input: { preferencia: 'terça de manhã', servico: 'consulta trabalhista' } },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anotado, Marta! A equipe te retorna com os horários.' }] },
  ]);
  await replyNow(cid, c.id);

  const tools = requests[0].tools.map((t) => t.name);
  assert.ok(!tools.includes('agendar'));
  assert.deepEqual(Object.keys(requests[0].tools.find((t) => t.name === 'atualizar_cliente').input_schema.properties.triagem.properties), ['area']);
  const prompt = requests[0].system[0].text;
  assert.match(prompt, /NÃO tem acesso à agenda/);
  assert.match(prompt, /audiência nos próximos dias/);
  assert.match(prompt, /dar parecer jurídico/);
  assert.match(prompt, /Área do caso/);

  const [task] = listTasks(cid, { contactId: c.id });
  assert.equal(task.type, 'horario');
  assert.equal(task.created_by, 'ai');
  assert.match(task.details, /terça de manhã/);
  assert.ok(Date.parse(task.due_at) > Date.now());
  assert.match(requests[1].messages.at(-1).content[1].content, /Prazo para retornar/);
  assert.deepEqual(JSON.parse(getContact(cid, c.id).custom_fields), { area: 'trabalhista' }, 'só campos configurados são salvos');
  assert.equal(get('SELECT COUNT(*) AS n FROM appointments WHERE company_id = ?', cid).n, 0);
});

test('com confirmação (dentista): horário fica reservado até a equipe confirmar, e o cliente é avisado', async () => {
  const cid = makeCompany({ ai: { scheduling_mode: 'confirm' }, integrations: { anthropic_api_key: 'sk-teste' } });
  const c = createContact(cid, { name: 'Paulo', phone: '11933334444' });
  const date = addDays(todayIn('America/Sao_Paulo'), 4);
  run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'in', 'contact', 'Pode ser às 10h?')", cid, c.id);
  scripted([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'agendar', input: { data: date, hora: '10:00' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reservei! Já te confirmo.' }] },
  ]);
  await replyNow(cid, c.id);
  const appt = get('SELECT * FROM appointments WHERE company_id = ?', cid);
  assert.equal(appt.status, 'solicitado');
  const task = listTasks(cid).find((t) => t.type === 'confirmar_agendamento');
  assert.equal(task.payload.appointment_id, appt.id);

  updateAppointment(cid, appt.id, { status: 'confirmado' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(listTasks(cid).find((t) => t.id === task.id).status, 'concluida');
  const last = get("SELECT body FROM messages WHERE contact_id = ? AND author = 'system' ORDER BY id DESC", c.id);
  assert.match(last.body, /está confirmado/);
});

test('cobrança com aprovação: a IA cria tarefa em vez de cobrar', async () => {
  const cid = makeCompany({ ai: { charge_mode: 'approval' } });
  const company = getCompany(cid);
  const c = createContact(cid, { name: 'Lia', phone: '11944445555' });
  const out = await executeTool('gerar_cobranca', { descricao: 'Honorários iniciais', valor: 1500 }, { company, contactId: c.id });
  assert.match(out, /aprovação/);
  assert.equal(get('SELECT COUNT(*) AS n FROM charges WHERE company_id = ?', cid).n, 0);
  const task = listTasks(cid)[0];
  assert.equal(task.type, 'aprovar_cobranca');
  assert.equal(task.payload.amount_cents, 150000);
});

test('urgência: transferir com urgente=true cria tarefa urgente com prazo curto', async () => {
  const cid = makeCompany();
  const c = createContact(cid, { name: 'Davi', phone: '11955556666' });
  await executeTool('transferir_para_humano', { motivo: 'Audiência amanhã', urgente: true }, { company: getCompany(cid), contactId: c.id });
  const task = listTasks(cid)[0];
  assert.equal(task.type, 'urgente');
  assert.ok(Date.parse(task.due_at) - Date.now() <= 16 * 60000);
  assert.equal(getContact(cid, c.id).ai_enabled, 0);
});

test('modo demonstração (sem chave) também respeita "sem agenda"', async () => {
  const cid = makeCompany({ ai: { scheduling_mode: 'request' } });
  const c = createContact(cid, { name: 'Bia', phone: '11966667777' });
  const reply = await ruleBasedReply(getCompany(cid), c, 'Quero marcar uma consulta');
  assert.match(reply, /retorno com os horários/);
  assert.equal(listTasks(cid)[0].type, 'horario');
});

test('tarefa atrasada: avisa o cliente uma vez, mas não se a equipe já respondeu', async () => {
  const cid = makeCompany();
  const a = createContact(cid, { name: 'Ana', phone: '11977778888' });
  const b = createContact(cid, { name: 'Beto', phone: '11988889999' });
  const past = new Date(Date.now() - 60000).toISOString();
  const old = new Date(Date.now() - 3600000).toISOString();
  run("INSERT INTO tasks (company_id, contact_id, type, title, due_at, created_at) VALUES (?, ?, 'horario', 'Horários Ana', ?, ?)", cid, a.id, past, old);
  run("INSERT INTO tasks (company_id, contact_id, type, title, due_at, created_at) VALUES (?, ?, 'horario', 'Horários Beto', ?, ?)", cid, b.id, past, old);
  run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'out', 'human', 'Tenho terça 10h')", cid, b.id);
  await processOverdueTasks();
  await processOverdueTasks();
  assert.equal(all("SELECT * FROM messages WHERE contact_id = ? AND author = 'system'", a.id).length, 1);
  assert.equal(all("SELECT * FROM messages WHERE contact_id = ? AND author = 'system'", b.id).length, 0);
});

test('prazo em horas úteis pula noite e fim de semana', () => {
  const hours = { dom: [], seg: [['09:00', '18:00']], ter: [['09:00', '18:00']], qua: [], qui: [], sex: [['09:00', '18:00']], sab: [] };
  // sexta 2026-10-23 17:00 SP (20:00 UTC) + 4h úteis -> segunda 12:00 SP (15:00 UTC)
  assert.equal(addBusinessHours(new Date('2026-10-23T20:00:00Z'), 4, 'America/Sao_Paulo', hours).toISOString(), '2026-10-26T15:00:00.000Z');
  // segunda 10:00 SP + 2h -> 12:00
  assert.equal(addBusinessHours(new Date('2026-10-26T13:00:00Z'), 2, 'America/Sao_Paulo', hours).toISOString(), '2026-10-26T15:00:00.000Z');
});
