import { test } from 'node:test';
import assert from 'node:assert/strict';
import stream from 'node:stream';
import { makeCompany } from './setup.js';

const { all, get, run } = await import('../src/db.js');
const { zonedToUtc, nextBusinessTime, zonedParts, todayIn, addDays } = await import('../src/services/time.js');
const { pixPayload, crc16, createCharge, processBilling, markPaid } = await import('../src/services/billing.js');
const { availableSlots, createAppointment } = await import('../src/services/scheduling.js');
const { createContact, getContact, changeStage, normalizePhone } = await import('../src/services/crm.js');
const { handleInbound, parseMetaWebhook, parseEvolutionWebhook, verifyMetaSignature } = await import('../src/services/messaging.js');
const { replyNow, setClientFactory } = await import('../src/services/ai.js');
const { enroll, processDueFollowups } = await import('../src/services/followup.js');
const { saveSettings } = await import('../src/services/company.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('fuso horário: 14:00 em São Paulo = 17:00 UTC', () => {
  assert.equal(zonedToUtc('2026-10-20', '14:00', 'America/Sao_Paulo').toISOString(), '2026-10-20T17:00:00.000Z');
  assert.deepEqual(zonedParts(new Date('2026-10-20T17:00:00Z'), 'America/Sao_Paulo'), { date: '2026-10-20', time: '14:00', weekday: 2 });
});

test('próximo horário comercial pula para a abertura do dia seguinte', () => {
  const hours = { dom: [], seg: [['09:00', '18:00']], ter: [['09:00', '18:00']], qua: [], qui: [], sex: [], sab: [] };
  // segunda 2026-10-19 às 20:00 em SP (23:00 UTC) -> terça 09:00 SP (12:00 UTC)
  const next = nextBusinessTime(new Date('2026-10-19T23:00:00Z'), 'America/Sao_Paulo', hours);
  assert.equal(next.toISOString(), '2026-10-20T12:00:00.000Z');
});

test('Pix: CRC16 confere com o exemplo do manual do Banco Central', () => {
  const body = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304';
  assert.equal(crc16(body), '1D3D');
  const code = pixPayload({ key: 'a@b.com', name: 'José Ação', city: 'São Paulo', amountCents: 15050, txid: 'VF1' });
  assert.match(code, /5406150\.50/);
  assert.match(code, /5909Jose Acao/);
  assert.equal(code.slice(-4), crc16(code.slice(0, -4)));
});

test('telefone é normalizado com DDI 55', () => {
  assert.equal(normalizePhone('(19) 99999-0000'), '5519999990000');
  assert.equal(normalizePhone('+55 11 3333-4444'), '551133334444');
});

test('agenda: horário ocupado some da lista e não pode ser reservado de novo', () => {
  const cid = makeCompany();
  const date = addDays(todayIn('America/Sao_Paulo'), 2);
  const before = availableSlots(cid, date);
  assert.ok(before.some((s) => s.time === '10:00'));
  createAppointment(cid, { title: 'Teste', date, time: '10:00', durationMin: 60 });
  const after = availableSlots(cid, date).map((s) => s.time);
  assert.ok(!after.includes('10:00'));
  assert.ok(!after.includes('09:30'), 'slot de 60min que termina dentro do agendamento também fica indisponível');
  assert.ok(after.includes('11:00'));
  assert.throws(() => createAppointment(cid, { title: 'Dup', date, time: '10:00' }), /indisponível/);
});

test('mensagem recebida cria lead e o robô responde (modo sem chave de API)', async () => {
  const cid = makeCompany();
  run("INSERT INTO products (company_id, name, price_cents) VALUES (?, 'Corte de cabelo', 5000)", cid);
  const r = handleInbound(cid, { phone: '11 98888-1111', name: 'Maria', text: 'Qual o preço?', providerId: 'abc' });
  assert.equal(r.created, true);
  assert.equal(handleInbound(cid, { phone: '11 98888-1111', text: 'Qual o preço?', providerId: 'abc' }), null, 'mensagem duplicada é ignorada');
  await wait(80);
  const out = all("SELECT * FROM messages WHERE contact_id = ? AND direction = 'out'", r.contact.id);
  assert.equal(out.length, 1);
  assert.match(out[0].body, /Corte de cabelo/);
  assert.equal(out[0].author, 'ai');
});

test('IA com ferramentas: consulta horários, agenda e responde', async () => {
  const cid = makeCompany({ integrations: { anthropic_api_key: 'sk-teste' } });
  const date = addDays(todayIn('America/Sao_Paulo'), 3);
  const contact = createContact(cid, { name: 'Pedro', phone: '11977776666' });
  run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'in', 'contact', 'Quero marcar dia ' || ? || ' às 15h')", cid, contact.id, date);

  const requests = [];
  const script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'consultar_horarios', input: { data: date } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'agendar', input: { data: date, hora: '15:00' } }, { type: 'tool_use', id: 't3', name: 'atualizar_cliente', input: { interesse: 'consulta' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prontinho, Pedro! Agendado às 15h. 😉' }] },
  ];
  setClientFactory(() => ({ beta: { messages: { create: async (req) => { requests.push(structuredClone(req)); return script.shift(); } } } }));

  const msg = await replyNow(cid, contact.id);
  assert.equal(msg.body, 'Prontinho, Pedro! Agendado às 15h. 😉');
  const appt = get('SELECT * FROM appointments WHERE company_id = ? AND contact_id = ?', cid, contact.id);
  assert.equal(appt.created_by, 'ai');
  assert.equal(appt.start_at, zonedToUtc(date, '15:00', 'America/Sao_Paulo').toISOString());
  assert.equal(getContact(cid, contact.id).interest, 'consulta');
  assert.equal(getContact(cid, contact.id).stage, 'qualificado', 'agendamento qualifica o lead');
  // As duas ferramentas da mesma resposta voltam juntas numa única mensagem de usuário.
  const toolResults = requests[2].messages.at(-1).content;
  assert.deepEqual(toolResults.map((b) => b.tool_use_id), ['t2', 't3']);
  assert.equal(requests[0].model, 'claude-opus-5-5');
  assert.equal(requests[0].fallbacks, 'default');
  setClientFactory(() => null);
});

test('follow-up: envia os passos em ordem e para quando o cliente responde', async () => {
  const cid = makeCompany();
  const contact = createContact(cid, { name: 'Ana Souza', phone: '11966665555' });
  const { id: seqId } = run('INSERT INTO sequences (company_id, name, steps) VALUES (?, ?, ?)', cid, 'Teste',
    JSON.stringify([{ delay_hours: 0, message: 'Oi {{nome}}, tudo bem?' }, { delay_hours: 0, message: 'Segundo passo' }, { delay_hours: 0, message: 'Terceiro' }]));
  const eid = enroll(cid, seqId, contact.id);
  await processDueFollowups();
  let msgs = all("SELECT body FROM messages WHERE contact_id = ? AND author = 'followup'", contact.id);
  assert.deepEqual(msgs.map((m) => m.body), ['Oi Ana, tudo bem?']);
  assert.equal(getContact(cid, contact.id).stage, 'contato', 'primeiro contato ativo move o lead');

  handleInbound(cid, { phone: contact.phone, text: 'Oi! Tudo sim' }, { autoReply: false });
  await processDueFollowups();
  msgs = all("SELECT body FROM messages WHERE contact_id = ? AND author = 'followup'", contact.id);
  assert.equal(msgs.length, 1, 'não envia mais depois da resposta');
  assert.equal(get('SELECT status FROM enrollments WHERE id = ?', eid).status, 'parado');
});

test('follow-up é disparado automaticamente pela mudança de etapa', () => {
  const cid = makeCompany();
  run("INSERT INTO sequences (company_id, name, trigger, steps) VALUES (?, 'Proposta', 'stage:proposta', ?)", cid, JSON.stringify([{ delay_hours: 24, message: 'E aí?' }]));
  const c = createContact(cid, { name: 'Lia', phone: '11955554444' });
  changeStage(cid, c.id, 'proposta');
  assert.equal(get("SELECT COUNT(*) AS n FROM enrollments WHERE contact_id = ? AND status = 'ativo'", c.id).n, 1);
  changeStage(cid, c.id, 'ganho');
  assert.equal(get("SELECT COUNT(*) AS n FROM enrollments WHERE contact_id = ? AND status = 'ativo'", c.id).n, 0, 'venda ganha encerra follow-ups');
});

test('cobrança: Pix gerado, régua de lembretes e baixa move o lead para ganho', async () => {
  const cid = makeCompany();
  const c = createContact(cid, { name: 'Bruno', phone: '11944443333' });
  const today = todayIn('America/Sao_Paulo');
  const charge = await createCharge(cid, { contactId: c.id, description: 'Plano mensal', amountCents: 9990, dueDate: addDays(today, -1) });
  assert.ok(charge.pix_code.startsWith('000201'));
  assert.equal(all("SELECT * FROM messages WHERE contact_id = ? AND author = 'billing'", c.id).length, 1);

  saveSettings(cid, { billing: { reminder_days_after: [1] } });
  await processBilling();
  const row = get('SELECT * FROM charges WHERE id = ?', charge.id);
  assert.equal(row.status, 'vencido');
  assert.deepEqual(JSON.parse(row.reminders), ['created', 'd+1']);
  const reminders = all("SELECT body FROM messages WHERE contact_id = ? AND author = 'billing' ORDER BY id", c.id);
  assert.equal(reminders.length, 2);
  assert.match(reminders[1].body, /ainda está em aberto/);
  await processBilling();
  assert.equal(all("SELECT * FROM messages WHERE contact_id = ? AND author = 'billing'", c.id).length, 2, 'lembrete não se repete');

  await markPaid(cid, charge.id);
  assert.equal(get('SELECT status FROM charges WHERE id = ?', charge.id).status, 'pago');
  assert.equal(getContact(cid, c.id).stage, 'ganho');
});

test('webhooks: Meta e Evolution viram mensagens; assinatura da Meta é validada', async () => {
  const meta = parseMetaWebhook({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '5511999', profile: { name: 'Zé' } }], messages: [{ from: '5511999', id: 'wamid.1', type: 'text', text: { body: 'Olá' } }] } }] }] });
  assert.deepEqual(meta, [{ phone: '5511999', name: 'Zé', text: 'Olá', providerId: 'wamid.1' }]);
  const evo = parseEvolutionWebhook({ event: 'messages.upsert', data: { key: { remoteJid: '5511888@s.whatsapp.net', fromMe: false, id: 'X1' }, pushName: 'Lu', message: { conversation: 'Oi' } } });
  assert.deepEqual(evo, [{ phone: '5511888', name: 'Lu', text: 'Oi', providerId: 'X1' }]);
  assert.deepEqual(parseEvolutionWebhook({ event: 'messages.upsert', data: { key: { remoteJid: '1@s.whatsapp.net', fromMe: true, id: 'Y' }, message: { conversation: 'eco' } } }), []);
  const crypto = await import('node:crypto');
  const sig = `sha256=${crypto.createHmac('sha256', 's3cr3t').update('{"a":1}').digest('hex')}`;
  assert.equal(verifyMetaSignature('s3cr3t', '{"a":1}', sig), true);
  assert.equal(verifyMetaSignature('s3cr3t', '{"a":2}', sig), false);
});

test('valores em reais no formato brasileiro', async () => {
  const { cents } = await import('../src/routes/api.js');
  assert.equal(cents('1.500'), 150000);
  assert.equal(cents('1.500,90'), 150090);
  assert.equal(cents('250,00'), 25000);
  assert.equal(cents('250.5'), 25050);
  assert.equal(cents('R$ 99,90'), 9990);
  assert.equal(cents(12.3), 1230);
});

test('arquivos estáticos: vídeo entregue por partes (Range), como o Safari exige', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { serveStatic } = await import('../src/http.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  fs.writeFileSync(path.join(root, 'v.mp4'), Buffer.from('0123456789'));
  const call = (range) => new Promise((resolve) => {
    const chunks = [];
    const res = new stream.Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.on('finish', () => resolve({ status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    serveStatic(root, { url: '/v.mp4', headers: range ? { range } : {} }, res, '/v.mp4');
  });
  const whole = await call();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['Content-Type'], 'video/mp4');
  assert.equal(whole.headers['Accept-Ranges'], 'bytes');
  const part = await call('bytes=2-5');
  assert.equal(part.status, 206);
  assert.equal(part.headers['Content-Range'], 'bytes 2-5/10');
  assert.equal(part.body, '2345');
  assert.equal((await call('bytes=-3')).body, '789');
  assert.equal((await call('bytes=20-')).status, 416);
});
