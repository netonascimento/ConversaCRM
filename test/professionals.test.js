import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeCompany } from './setup.js';

const { get, run } = await import('../src/db.js');
const { saveSettings, getCompany } = await import('../src/services/company.js');
const { createContact, getContact } = await import('../src/services/crm.js');
const { saveProfessional } = await import('../src/services/professionals.js');
const { availableSlots, createAppointment } = await import('../src/services/scheduling.js');
const { ruleBasedReply, parseTimeChoice, setClientFactory } = await import('../src/services/ai.js');
const { listTasks } = await import('../src/services/tasks.js');
const { todayIn, addDays, zonedToUtc } = await import('../src/services/time.js');

after(() => setClientFactory(() => null));
const TZ = 'America/Sao_Paulo';
const allDay = [['09:00', '18:00']];
const week = { dom: allDay, seg: allDay, ter: allDay, qua: allDay, qui: allDay, sex: allDay, sab: allDay };

function lawFirm() {
  const cid = makeCompany({ scheduling: { slot_interval_min: 60, default_duration_min: 60, min_notice_min: 0 } });
  const trab = run("INSERT INTO products (company_id, name, duration_min) VALUES (?, 'Consulta trabalhista', 60)", cid).id;
  const fam = run("INSERT INTO products (company_id, name, duration_min) VALUES (?, 'Consulta família', 60)", cid).id;
  const ana = saveProfessional(cid, { name: 'Dra. Ana', services: [trab], business_hours: { ...week, dom: [], sab: [], seg: [['09:00', '12:00']], ter: [['09:00', '12:00']], qua: [['09:00', '12:00']], qui: [['09:00', '12:00']], sex: [['09:00', '12:00']] } });
  const carlos = saveProfessional(cid, { name: 'Dr. Carlos', services: [fam] });
  const bia = saveProfessional(cid, { name: 'Dra. Bia', services: [trab, fam] });
  return { cid, trab, fam, ana, carlos, bia };
}

test('horários livres consideram serviço, horário próprio e agenda de cada profissional', () => {
  const { cid, trab, fam, ana, carlos, bia } = lawFirm();
  // Dia útil daqui a 2+ dias: a Dra. Ana não atende no fim de semana (antes o teste quebrava às quintas e sextas).
  let date = addDays(todayIn(TZ), 2);
  while ([0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) date = addDays(date, 1);
  const at10 = availableSlots(cid, date, trab).find((s) => s.time === '10:00');
  assert.deepEqual(at10.professionals.map((p) => p.name).sort(), ['Dra. Ana', 'Dra. Bia'], 'Carlos não atende trabalhista');
  const at15 = availableSlots(cid, date, trab).find((s) => s.time === '15:00');
  assert.deepEqual(at15.professionals.map((p) => p.name), ['Dra. Bia'], 'Ana só atende de manhã');

  // Dois agendamentos no mesmo horário: um para cada profissional livre.
  const a1 = createAppointment(cid, { productId: trab, date, time: '10:00' });
  const a2 = createAppointment(cid, { productId: trab, date, time: '10:00' });
  assert.notEqual(a1.professional_id, a2.professional_id);
  assert.ok(!availableSlots(cid, date, trab).some((s) => s.time === '10:00'), 'os dois que atendem trabalhista estão ocupados');
  assert.ok(availableSlots(cid, date, fam).some((s) => s.time === '10:00' && s.professionals[0].id === carlos.id), 'Carlos continua livre para família');
  assert.throws(() => createAppointment(cid, { productId: trab, professionalId: ana.id, date, time: '10:00' }), /não está livre/);

  saveProfessional(cid, { ...bia, blocked_dates: [date] }, bia.id);
  assert.ok(!availableSlots(cid, date, trab).some((s) => s.time === '15:00'), 'folga remove os horários');
});

test('sem profissionais cadastrados a agenda continua única', () => {
  const cid = makeCompany();
  const date = addDays(todayIn(TZ), 2);
  const slot = availableSlots(cid, date).find((s) => s.time === '10:00');
  assert.equal(slot.professionals, undefined);
  assert.equal(createAppointment(cid, { date, time: '10:00' }).professional_id, null);
});

test('lê a escolha de horário do cliente', () => {
  assert.equal(parseTimeChoice('pode ser às 10h', TZ).time, '10:00');
  assert.equal(parseTimeChoice('quinta 15:30', TZ).time, '15:30');
  assert.equal(parseTimeChoice('amanhã as 9', TZ).date, addDays(todayIn(TZ), 1));
  assert.equal(parseTimeChoice('22/10 às 14h', TZ).time, '14:00');
  assert.equal(parseTimeChoice('tenho 2 filhos', TZ), null);
  assert.equal(parseTimeChoice('dia 22/10', TZ), null);
});

test('modo demonstração: triagem, horários e reserva com o profissional certo', async () => {
  const { cid, ana, bia } = lawFirm();
  saveSettings(cid, { ai: {
    objective: 'qualificar', scheduling_mode: 'confirm', price_mode: 'hide',
    intake_questions: [{ key: 'area', label: 'Área', question: 'Seu caso é trabalhista ou de família?' }, { key: 'resumo', label: 'Resumo', question: 'O que aconteceu?' }],
    urgency_rules: 'Audiência marcada\nPrisão',
  } });
  const company = getCompany(cid);
  const c = createContact(cid, { name: 'Marta', phone: '31911112222' });
  const say = async (text) => {
    run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'in', 'contact', ?)", cid, c.id, text);
    const reply = await ruleBasedReply(company, getContact(cid, c.id), text);
    run("INSERT INTO messages (company_id, contact_id, direction, author, body) VALUES (?, ?, 'out', 'ai', ?)", cid, c.id, reply);
    return reply;
  };
  assert.match(await say('Oi, preciso de um advogado'), /trabalhista ou de família/);
  assert.match(await say('Trabalhista'), /O que aconteceu/);
  const offer = await say('Fui demitida sem receber');
  assert.match(offer, /horários livres/);
  assert.deepEqual(JSON.parse(getContact(cid, c.id).custom_fields), { area: 'Trabalhista', resumo: 'Fui demitida sem receber' });
  const date = addDays(todayIn(TZ), 1);
  const reply = await say('amanhã às 10h');
  assert.match(reply, /Reservei/);
  const appt = get('SELECT * FROM appointments WHERE contact_id = ?', c.id);
  assert.equal(appt.status, 'solicitado');
  assert.equal(appt.start_at, zonedToUtc(date, '10:00', TZ).toISOString());
  assert.ok([ana.id, bia.id].includes(appt.professional_id));
  assert.equal(listTasks(cid, { contactId: c.id })[0].type, 'confirmar_agendamento');
});

test('modo demonstração: urgência configurada chama a equipe na hora', async () => {
  const cid = makeCompany({ ai: { urgency_rules: 'Audiência marcada para os próximos dias\nPrisão ou alguém preso' } });
  const c = createContact(cid, { name: 'Rui', phone: '31922223333' });
  const reply = await ruleBasedReply(getCompany(cid), c, 'Tenho audiência quinta e preciso de ajuda');
  assert.match(reply, /urgente/);
  assert.equal(listTasks(cid)[0].type, 'urgente');
  assert.equal(getContact(cid, c.id).ai_enabled, 0);
});
