import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import './google-env.js';
import { makeCompany } from './setup.js';

const { get, run } = await import('../src/db.js');
const { createContact } = await import('../src/services/crm.js');
const { saveProfessional } = await import('../src/services/professionals.js');
const { availableSlots, createAppointment, updateAppointment } = await import('../src/services/scheduling.js');
const google = await import('../src/services/google.js');
const { todayIn, addDays, zonedToUtc } = await import('../src/services/time.js');

const TZ = 'America/Sao_Paulo';
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

// Google de mentira: guarda os eventos criados e responde como a API real.
function fakeGoogle({ busy = [] } = {}) {
  const calls = [];
  const events = new Map();
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.hostname}${u.pathname}`);
    const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('client_id'), process.env.GOOGLE_CLIENT_ID);
      return json({ access_token: `token-${++n}`, refresh_token: body.get('grant_type') === 'authorization_code' ? 'refresh-1' : undefined, expires_in: 3600 });
    }
    if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/revoke') return json({});
    if (u.hostname === 'openidconnect.googleapis.com') return json({ email: 'dra.ana@gmail.com' });
    if (u.pathname.endsWith('/events') && method === 'GET') return json({ items: busy });
    if (u.pathname.endsWith('/events') && method === 'POST') {
      const id = `ev${++n}`;
      events.set(id, JSON.parse(init.body));
      return json({ id });
    }
    const m = u.pathname.match(/\/events\/([^/]+)$/);
    if (m && method === 'PATCH') { events.set(m[1], { ...events.get(m[1]), ...JSON.parse(init.body) }); return json({ id: m[1] }); }
    if (m && method === 'DELETE') { events.delete(m[1]); return json(null, 204); }
    return json({ error: { message: 'rota desconhecida' } }, 404);
  };
  return { calls, events };
}

async function connect(cid, professionalId) {
  const url = new URL(google.startConnect(cid, { professionalId }));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.falaki.test/api/google/callback');
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
  const row = google.consumeState(url.searchParams.get('state'));
  assert.throws(() => google.consumeState(url.searchParams.get('state')), /expirado/, 'o link de conexão só vale uma vez');
  return google.finishConnect(row, 'codigo-de-autorizacao');
}

test('agendamentos do Falaki viram eventos no Google: criar, remarcar e cancelar', async () => {
  const g = fakeGoogle();
  const cid = makeCompany();
  const ana = saveProfessional(cid, { name: 'Dra. Ana' });
  const c = createContact(cid, { name: 'Marta', phone: '11999990000' });
  const date = addDays(todayIn(TZ), 3);
  // Um agendamento que já existia antes da conexão também vai para o Google.
  const before = createAppointment(cid, { contactId: c.id, professionalId: ana.id, date, time: '09:00' });
  const conn = await connect(cid, ana.id);
  assert.equal(conn.email, 'dra.ana@gmail.com');
  assert.ok(get('SELECT google_event_id FROM appointments WHERE id = ?', before.id).google_event_id);

  const appt = createAppointment(cid, { contactId: c.id, professionalId: ana.id, date, time: '11:00', notes: 'por vídeo' });
  await new Promise((r) => setTimeout(r, 20));
  const row = get('SELECT * FROM appointments WHERE id = ?', appt.id);
  assert.equal(row.google_sync, 'ok');
  const ev = g.events.get(row.google_event_id);
  assert.match(ev.description, /Cliente: Marta/);
  assert.match(ev.description, /\+5511999990000/);
  assert.equal(ev.start.dateTime, zonedToUtc(date, '11:00', TZ).toISOString());
  assert.equal(ev.extendedProperties.private.falaki, '1');

  updateAppointment(cid, appt.id, { start_at: zonedToUtc(date, '14:00', TZ).toISOString() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.events.get(row.google_event_id).start.dateTime, zonedToUtc(date, '14:00', TZ).toISOString());

  updateAppointment(cid, appt.id, { status: 'cancelado' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.events.has(row.google_event_id), false, 'cancelado no Falaki some do Google');
  assert.ok(g.calls.some((x) => x.startsWith('PATCH')));
});

test('compromissos marcados direto no Google bloqueiam o horário no Falaki', async () => {
  const cid = makeCompany();
  const ana = saveProfessional(cid, { name: 'Dra. Ana' });
  const bia = saveProfessional(cid, { name: 'Dra. Bia' });
  const date = addDays(todayIn(TZ), 4);
  const at = (t) => zonedToUtc(date, t, TZ).toISOString();
  fakeGoogle({ busy: [
    { start: { dateTime: at('10:00') }, end: { dateTime: at('12:00') }, status: 'confirmed' },
    { start: { dateTime: at('15:00') }, end: { dateTime: at('16:00') }, transparency: 'transparent' }, // "disponível": não bloqueia
    { start: { dateTime: at('16:00') }, end: { dateTime: at('17:00') }, extendedProperties: { private: { fechou: '1' } } }, // criado pelo sistema quando ainda se chamava Fechou
  ] });
  await connect(cid, ana.id);
  const slots = availableSlots(cid, date);
  const proAt = (t) => slots.find((s) => s.time === t)?.professionals.map((p) => p.name) || [];
  assert.deepEqual(proAt('10:00'), ['Dra. Bia'], 'Ana está ocupada no Google às 10h');
  assert.deepEqual(proAt('11:00'), ['Dra. Bia']);
  assert.deepEqual(proAt('15:00').sort(), ['Dra. Ana', 'Dra. Bia'], 'evento "disponível" não bloqueia');
  assert.deepEqual(proAt('16:00').sort(), ['Dra. Ana', 'Dra. Bia'], 'evento do próprio Falaki não conta duas vezes');
  assert.ok(bia);

  // Folga de dia inteiro no Google.
  fakeGoogle({ busy: [{ start: { date }, end: { date: addDays(date, 1) } }] });
  await google.refreshBusy(google.connectionFor(cid, ana.id));
  assert.ok(availableSlots(cid, date).every((s) => !s.professionals.some((p) => p.name === 'Dra. Ana')));
});

test('agenda da empresa (sem profissionais) e desconexão', async () => {
  const g = fakeGoogle();
  const cid = makeCompany();
  const conn = await connect(cid, null);
  const date = addDays(todayIn(TZ), 2);
  const appt = createAppointment(cid, { date, time: '10:00', title: 'Reunião' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(get('SELECT google_event_id FROM appointments WHERE id = ?', appt.id).google_event_id);
  assert.equal(await google.disconnect(cid, conn.id), true);
  assert.ok(g.calls.some((x) => x.includes('/revoke')));
  assert.equal(google.connectionFor(cid, null), undefined);
});

test('acesso revogado no Google: conexão fica marcada para reconectar', async () => {
  fakeGoogle();
  const cid = makeCompany();
  const conn = await connect(cid, null);
  run('UPDATE google_connections SET expires_at = ? WHERE id = ?', new Date(0).toISOString(), conn.id);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
  await assert.rejects(google.refreshBusy(google.connectionFor(cid, null)));
  assert.equal(google.connectionFor(cid, null).status, 'erro');
});
