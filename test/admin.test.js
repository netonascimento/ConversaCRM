import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

const { createServer } = await import('../src/server.js');
const { createAdmin, resetLoginAttempts } = await import('../src/auth.js');
const { mainDb } = await import('../src/db.js');

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  createAdmin({ name: 'Neto', email: 'admin@plataforma.com', password: 'admin12345' });
});
after(() => server.close());

// Cliente HTTP com cookies (como um navegador).
function browser() {
  const jar = {};
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      jar[k] = v;
    }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return call;
}

async function adminSession() {
  const a = browser();
  assert.equal((await a('/api/admin/login', { method: 'POST', body: { email: 'admin@plataforma.com', password: 'admin12345' } })).status, 200);
  return a;
}

async function userSession(email, password) {
  const u = browser();
  const r = await u('/api/auth/login', { method: 'POST', body: { email, password } });
  return { u, status: r.status, error: r.data?.error };
}

test('painel: só administrador acessa; cria empresa com plano, modelo de segmento e dono', async () => {
  assert.equal((await browser()('/api/admin/companies')).status, 401);
  const owner = await userSession('ninguem@x.com', 'x');
  assert.equal(owner.status, 401);

  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Clínica Alfa', segment: 'advocacia', plan: 'essencial', max_users: 2, max_leads: '',
    owner_name: 'Ana', owner_email: 'ana@alfa.com', owner_password: 'senhaforte1',
  } })).data;
  assert.equal(c.plan, 'essencial');
  assert.equal(c.max_users, 2);
  assert.equal(c.max_leads, null);
  assert.equal(c.ai_objective, 'qualificar', 'modelo de advocacia aplicado na IA');

  const { u, status } = await userSession('ana@alfa.com', 'senhaforte1');
  assert.equal(status, 200);
  assert.equal((await u('/api/auth/me')).data.company.name, 'Clínica Alfa');

  const list = (await a('/api/admin/companies')).data;
  assert.ok(list.some((x) => x.name === 'Clínica Alfa' && x.usage.active_users === 1));
  const audit = (await a('/api/admin/audit')).data;
  assert.ok(audit.some((r) => r.action === 'empresa criada'));
});

test('suspender bloqueia login e sessões abertas; reativar libera', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Beta', plan: 'profissional', owner_name: 'Bia', owner_email: 'bia@beta.com', owner_password: 'senhaforte1',
  } })).data;
  const { u } = await userSession('bia@beta.com', 'senhaforte1');
  assert.equal((await u('/api/contacts')).status, 200);
  await a(`/api/admin/companies/${c.id}/suspend`, { method: 'POST' });
  assert.equal((await u('/api/contacts')).status, 401, 'sessão derrubada');
  const again = await userSession('bia@beta.com', 'senhaforte1');
  assert.equal(again.status, 403);
  assert.match(again.error, /suspensa/);
  await a(`/api/admin/companies/${c.id}/reactivate`, { method: 'POST' });
  assert.equal((await userSession('bia@beta.com', 'senhaforte1')).status, 200);
});

test('perfis: limite de usuários do plano, atendente sem financeiro, profissional só com os próprios clientes', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Gama Advocacia', plan: 'essencial', owner_name: 'Gil', owner_email: 'gil@gama.com', owner_password: 'senhaforte1',
  } })).data;
  const { u: owner } = await userSession('gil@gama.com', 'senhaforte1');

  // Dono cadastra dois profissionais e clientes com agendamentos.
  const p1 = (await owner('/api/professionals', { method: 'POST', body: { name: 'Dra. Um' } })).data;
  const p2 = (await owner('/api/professionals', { method: 'POST', body: { name: 'Dr. Dois' } })).data;
  const c1 = (await owner('/api/contacts', { method: 'POST', body: { name: 'Cliente Um', phone: '11911110001' } })).data;
  const c2 = (await owner('/api/contacts', { method: 'POST', body: { name: 'Cliente Dois', phone: '11911110002' } })).data;
  assert.equal((await owner('/api/appointments', { method: 'POST', body: { contact_id: c1.id, professional_id: p1.id, date: '2031-03-10', time: '10:00' } })).status, 200);
  assert.equal((await owner('/api/appointments', { method: 'POST', body: { contact_id: c2.id, professional_id: p2.id, date: '2031-03-10', time: '10:00' } })).status, 200);

  // Plano Essencial: 2 usuários (dono + 1).
  assert.equal((await owner('/api/users', { method: 'POST', body: { name: 'Dra. Um', email: 'um@gama.com', password: 'senhaforte1', role: 'professional', professional_id: p1.id } })).status, 200);
  const third = await owner('/api/users', { method: 'POST', body: { name: 'Atendente', email: 'at@gama.com', password: 'senhaforte1', role: 'agent' } });
  assert.equal(third.status, 400);
  assert.match(third.data.error, /até 2 usuários/);

  const { u: pro } = await userSession('um@gama.com', 'senhaforte1');
  const contacts = (await pro('/api/contacts')).data;
  assert.deepEqual(contacts.map((x) => x.name), ['Cliente Um']);
  assert.equal((await pro(`/api/contacts/${c2.id}`)).status, 404, 'não vê cliente de outro profissional');
  const appts = (await pro('/api/appointments')).data;
  assert.ok(appts.every((x) => x.professional_id === p1.id));
  assert.equal((await pro('/api/charges')).status, 403);
  assert.equal((await pro('/api/settings', { method: 'PUT', body: { name: 'Hack' } })).status, 403);
  assert.equal((await pro('/api/sequences')).status, 403);

  // Admin aumenta o limite e o dono cadastra um atendente.
  await a(`/api/admin/companies/${c.id}`, { method: 'PUT', body: { max_users: 3 } });
  assert.equal((await owner('/api/users', { method: 'POST', body: { name: 'Atendente', email: 'at@gama.com', password: 'senhaforte1', role: 'agent' } })).status, 200);
  const { u: agent } = await userSession('at@gama.com', 'senhaforte1');
  assert.equal((await agent('/api/contacts')).data.length, 2);
  assert.equal((await agent('/api/charges')).status, 403);
  assert.equal((await agent('/api/settings', { method: 'PUT', body: { name: 'Hack' } })).status, 403);
  const dash = (await agent('/api/dashboard')).data;
  assert.equal(dash.financial_hidden, true);
  assert.equal(dash.metrics.revenue_cents, null);
  // A empresa nunca fica sem dono ativo.
  const me = (await owner('/api/auth/me')).data;
  assert.equal((await owner(`/api/users/${me.user.id}`, { method: 'PUT', body: { role: 'agent' } })).status, 400);
});

test('teste grátis: cadastro pela página inicial com limite de 10 leads', async () => {
  resetLoginAttempts();
  const u = browser();
  assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Loja Free', name: 'Fê', email: 'fe@free.com', password: 'senhaforte1', segment: 'loja' } })).status, 200);
  const meta = (await u('/api/meta')).data;
  assert.equal(meta.plan.id, 'gratis');
  assert.equal(meta.plan.max_leads, 10);
  for (let i = 0; i < 10; i++) assert.equal((await u('/api/contacts', { method: 'POST', body: { name: `L${i}`, phone: `1190000000${i}` } })).status, 200);
  const blocked = await u('/api/contacts', { method: 'POST', body: { name: 'L11', phone: '11900000099' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Limite de leads/);
  // Número novo pelo WhatsApp também não entra.
  await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11977770000', text: 'oi' } });
  assert.equal((await u('/api/contacts')).data.length, 10);
  const info = (await browser()('/api/public/info')).data;
  assert.deepEqual(info.plans.map((p) => p.price_cents), [0, 10000, 24900]);
});

test('acesso de suporte: administrador entra como a empresa e fica registrado', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Delta', plan: 'profissional', owner_name: 'Davi', owner_email: 'davi@delta.com', owner_password: 'senhaforte1',
  } })).data;
  const r = await a(`/api/admin/companies/${c.id}/impersonate`, { method: 'POST' });
  assert.equal(r.status, 200);
  const me = (await a('/api/auth/me')).data;
  assert.equal(me.company.name, 'Delta');
  assert.equal(me.impersonated, true);
  assert.ok((await a('/api/admin/audit')).data.some((x) => x.action === 'acesso de suporte' && x.company_id === c.id));
});

test('banco separado: move os dados, mantém tudo funcionando e isolado; exporta e exclui', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Sigilo Advogados', plan: 'profissional', owner_name: 'Sá', owner_email: 'sa@sigilo.com', owner_password: 'senhaforte1',
  } })).data;
  const { u } = await userSession('sa@sigilo.com', 'senhaforte1');
  const before = (await u('/api/contacts', { method: 'POST', body: { name: 'Cliente Antigo', phone: '11955550001' } })).data;
  await u('/api/products', { method: 'POST', body: { name: 'Consulta', price: '300', duration_min: 60 } });

  const moved = (await a(`/api/admin/companies/${c.id}/dedicated`, { method: 'POST' })).data;
  assert.equal(moved.storage, 'dedicated');
  assert.equal(mainDb.prepare('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?').get(c.id).n, 0, 'nada da empresa no banco compartilhado');

  // Continua funcionando normalmente pela API.
  assert.deepEqual((await u('/api/contacts')).data.map((x) => x.name), ['Cliente Antigo']);
  assert.equal((await u(`/api/contacts/${before.id}`)).status, 200);
  await u('/api/contacts', { method: 'POST', body: { name: 'Cliente Novo', phone: '11955550002' } });
  assert.equal((await u('/api/contacts')).data.length, 2);
  assert.equal(mainDb.prepare('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?').get(c.id).n, 0);
  assert.equal((await u('/api/products')).data.length, 1);

  // Outra empresa não enxerga nada.
  const other = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Outra', plan: 'profissional', owner_name: 'O', owner_email: 'o@outra.com', owner_password: 'senhaforte1',
  } })).data;
  const { u: o } = await userSession('o@outra.com', 'senhaforte1');
  assert.equal((await o('/api/contacts')).data.length, 0);
  assert.equal((await o(`/api/contacts/${before.id}`)).status, 404);
  assert.ok(other.id);

  const exp = (await a(`/api/admin/companies/${c.id}/export`)).data;
  assert.equal(exp.data.contacts.length, 2);
  assert.equal(exp.users[0].email, 'sa@sigilo.com');
  assert.equal(exp.users[0].password_hash, undefined);

  assert.equal((await a(`/api/admin/companies/${c.id}`, { method: 'DELETE', body: { confirm_name: 'errado' } })).status, 400);
  assert.equal((await a(`/api/admin/companies/${c.id}`, { method: 'DELETE', body: { confirm_name: 'Sigilo Advogados' } })).status, 200);
  assert.equal((await userSession('sa@sigilo.com', 'senhaforte1')).status, 401);
});

test('webhooks: identificador aleatório e token obrigatório na Evolution; empresa suspensa é ignorada', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Zap', plan: 'profissional', owner_name: 'Zé', owner_email: 'ze@zap.com', owner_password: 'senhaforte1',
  } })).data;
  const { u } = await userSession('ze@zap.com', 'senhaforte1');
  await u('/api/settings', { method: 'PUT', body: { settings: { ai: { enabled: false } } } });
  const evo = new URL((await u('/api/meta')).data.webhooks.evolution);
  const payload = { event: 'messages.upsert', data: { key: { remoteJid: '5511944443333@s.whatsapp.net', fromMe: false, id: 'E1' }, pushName: 'Cli', message: { conversation: 'Oi' } } };
  const post = (url) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post(`${base}${evo.pathname}`)).status, 401, 'sem token');
  assert.equal((await post(`${base}/webhooks/whatsapp/evolution/${c.id}${evo.search}`)).status, 404, 'número interno não funciona');
  assert.equal((await post(`${base}${evo.pathname}${evo.search}`)).status, 200);
  assert.equal((await u('/api/conversations')).data.length, 1);

  await a(`/api/admin/companies/${c.id}/suspend`, { method: 'POST' });
  payload.data.key.id = 'E2';
  payload.data.key.remoteJid = '5511922221111@s.whatsapp.net';
  assert.equal((await post(`${base}${evo.pathname}${evo.search}`)).status, 200);
  await a(`/api/admin/companies/${c.id}/reactivate`, { method: 'POST' });
  const { u: u2 } = await userSession('ze@zap.com', 'senhaforte1');
  assert.equal((await u2('/api/conversations')).data.length, 1, 'mensagem recebida durante a suspensão não foi processada');
});
