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

test('teste grátis: cadastro pela página inicial com limite de 30 leads', async () => {
  resetLoginAttempts();
  const u = browser();
  assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Loja Free', name: 'Fê', email: 'fe@free.com', password: 'senhaforte1', segment: 'loja' } })).status, 200);
  const meta = (await u('/api/meta')).data;
  assert.equal(meta.plan.id, 'gratis');
  assert.equal(meta.plan.max_leads, 30);
  for (let i = 0; i < 30; i++) assert.equal((await u('/api/contacts', { method: 'POST', body: { name: `L${i}`, phone: `119000000${String(i).padStart(2, '0')}` } })).status, 200);
  const blocked = await u('/api/contacts', { method: 'POST', body: { name: 'L11', phone: '11900000099' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Limite de leads/);
  // Número novo pelo WhatsApp também não entra.
  await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11977770000', text: 'oi' } });
  assert.equal((await u('/api/contacts')).data.length, 30);
  const info = (await browser()('/api/public/info')).data;
  assert.deepEqual(info.plans.map((p) => p.price_cents), [0, 10000, 24900]);
});

test('teste grátis: só 3 buscas no Google Maps, para sempre; plano pago busca à vontade', async () => {
  resetLoginAttempts();
  const u = browser();
  assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Busca Free', name: 'Bia', email: 'bia@free.com', password: 'senhaforte1', segment: 'loja' } })).status, 200);
  await u('/api/settings', { method: 'PUT', body: { settings: { integrations: { google_places_key: 'chave-places-teste' } } } });
  const realFetch = globalThis.fetch;
  let googleCalls = 0;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith('https://places.googleapis.com/')) {
      googleCalls++;
      return Promise.resolve(new Response(JSON.stringify({ places: [{ id: `p${googleCalls}`, displayName: { text: 'Pet Shop' }, nationalPhoneNumber: '(11) 3333-0000' }] }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
  try {
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 3, used: 0 });
    for (let i = 0; i < 3; i++) assert.equal((await u('/api/prospecting/search', { method: 'POST', body: { query: `pet shop ${i}` } })).status, 200);
    const blocked = await u('/api/prospecting/search', { method: 'POST', body: { query: 'pet shop 4' } });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /3 buscas do teste grátis/);
    assert.equal(googleCalls, 3); // a quarta nem chega ao Google
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 3, used: 3 });
    assert.equal((await u('/api/prospecting/searches')).data.length, 3); // as anteriores continuam abertas

    // Assinou: sem limite.
    const a = await adminSession();
    const company = (await a('/api/admin/companies')).data.find((c) => c.name === 'Busca Free');
    assert.equal((await a(`/api/admin/companies/${company.id}`, { method: 'PUT', body: { plan: 'essencial' } })).status, 200);
    assert.equal((await u('/api/meta')).data.prospecting_searches, null);
    assert.equal((await u('/api/prospecting/search', { method: 'POST', body: { query: 'pet shop 4' } })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
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

test('chave da IA: a empresa usa a própria; só o admin libera a da plataforma, e o consumo fica registrado', async () => {
  const { config } = await import('../src/config.js');
  const { getCompany } = await import('../src/services/company.js');
  const { generateInsights, setClientFactory } = await import('../src/services/ai.js');
  config.anthropicKey = 'sk-plataforma';
  const keys = [];
  setClientFactory((key) => ({ beta: { messages: { create: async () => {
    keys.push(key);
    return { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } };
  } } } }));
  try {
    const a = await adminSession();
    const c = (await a('/api/admin/companies', { method: 'POST', body: {
      name: 'Delta', plan: 'essencial', owner_name: 'Dani', owner_email: 'dani@delta.com', owner_password: 'senhaforte1',
    } })).data;
    const { u } = await userSession('dani@delta.com', 'senhaforte1');

    // Sem chave própria e sem liberação: a chave da plataforma não é usada.
    assert.equal((await u('/api/meta')).data.ai_configured, false);
    assert.equal(c.ai_platform_key, false);

    // A empresa cadastra a própria chave.
    await u('/api/settings', { method: 'PUT', body: { settings: { integrations: { anthropic_api_key: 'sk-da-empresa' } } } });
    assert.equal((await u('/api/meta')).data.ai_key_source, 'company');
    await generateInsights(getCompany(c.id), { period_days: 30 });
    assert.equal(keys.at(-1), 'sk-da-empresa');

    // A empresa não consegue se liberar para a chave da plataforma.
    await u('/api/settings', { method: 'PUT', body: { ai_platform_key: true, settings: { ai_platform_key: true } } });
    assert.equal(getCompany(c.id).ai_platform_key, 0);

    // O admin libera: passa a usar a chave da plataforma e o consumo é separado por origem.
    const out = (await a(`/api/admin/companies/${c.id}`, { method: 'PUT', body: { ai_platform_key: true } })).data;
    assert.equal(out.ai_platform_key, true);
    assert.equal((await u('/api/meta')).data.ai_key_source, 'platform');
    await generateInsights(getCompany(c.id), { period_days: 30 });
    await generateInsights(getCompany(c.id), { period_days: 30 });
    assert.equal(keys.at(-1), 'sk-plataforma');

    const detail = (await a(`/api/admin/companies/${c.id}`)).data;
    const platform = detail.ai_usage.find((r) => r.key_source === 'platform');
    assert.deepEqual([platform.requests, platform.input_tokens, platform.output_tokens, platform.cache_read_tokens], [2, 200, 40, 100]);
    assert.equal(detail.ai_usage.find((r) => r.key_source === 'company').requests, 1);
    const listed = (await a('/api/admin/companies')).data.find((x) => x.id === c.id);
    assert.equal(listed.ai_platform_month.output_tokens, 40);
    assert.ok((await a('/api/admin/audit')).data.some((r) => r.action === 'IA com chave da plataforma' && r.company_id === c.id));
    // A chave da plataforma nunca aparece para a empresa.
    assert.ok(!JSON.stringify((await u('/api/settings')).data).includes('sk-plataforma'));

    // O admin desliga: volta para a chave da empresa.
    await a(`/api/admin/companies/${c.id}`, { method: 'PUT', body: { ai_platform_key: false } });
    await generateInsights(getCompany(c.id), { period_days: 30 });
    assert.equal(keys.at(-1), 'sk-da-empresa');
  } finally {
    config.anthropicKey = '';
    setClientFactory(() => null);
  }
});

test('atendimento manual com vários atendentes: rodízio, filtros, assumir e passar a conversa', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Épsilon', plan: 'profissional', owner_name: 'Eva', owner_email: 'eva@epsilon.com', owner_password: 'senhaforte1',
  } })).data;
  const { u: owner } = await userSession('eva@epsilon.com', 'senhaforte1');
  // Sem IA e com rodízio ligado.
  await owner('/api/settings', { method: 'PUT', body: { settings: { ai: { enabled: false }, team: { auto_assign: true } } } });
  const at1 = (await owner('/api/users', { method: 'POST', body: { name: 'Atendente Um', email: 'um@epsilon.com', password: 'senhaforte1', role: 'agent' } })).data;
  const at2 = (await owner('/api/users', { method: 'POST', body: { name: 'Atendente Dois', email: 'dois@epsilon.com', password: 'senhaforte1', role: 'agent' } })).data;
  const { u: one } = await userSession('um@epsilon.com', 'senhaforte1');
  const { u: two } = await userSession('dois@epsilon.com', 'senhaforte1');

  // Três clientes escrevem no mesmo número: as conversas são divididas em rodízio.
  const ids = [];
  for (const [i, phone] of ['11900000001', '11900000002', '11900000003'].entries()) {
    ids.push((await owner('/api/simulator/inbound', { method: 'POST', body: { phone, name: `Cliente ${i + 1}`, text: 'Oi, quero atendimento' } })).data.contact.id);
  }
  const all = (await owner('/api/conversations')).data;
  const owners = ids.map((id) => all.find((x) => x.id === id).assigned_user_id);
  assert.deepEqual(owners, [at1.id, at2.id, at1.id]);
  assert.equal(all.find((x) => x.id === ids[1]).assigned_name, 'Atendente Dois');

  // Cada atendente filtra as próprias conversas.
  assert.deepEqual((await one('/api/conversations?scope=mine')).data.map((x) => x.id).sort(), [ids[0], ids[2]].sort());
  assert.deepEqual((await two('/api/conversations?scope=mine')).data.map((x) => x.id), [ids[1]]);
  assert.equal((await two('/api/conversations?scope=unassigned')).data.length, 0);

  // Passar a conversa para outro atendente e tirar o responsável.
  const moved = (await one(`/api/conversations/${ids[2]}/assign`, { method: 'POST', body: { user_id: at2.id } })).data;
  assert.equal(moved.assigned_user_id, at2.id);
  await two(`/api/conversations/${ids[2]}/assign`, { method: 'POST', body: { user_id: null } });
  assert.deepEqual((await two('/api/conversations?scope=unassigned')).data.map((x) => x.id), [ids[2]]);

  // Quem responde uma conversa sem responsável fica com ela, e a mensagem leva o nome de quem enviou.
  const sent = (await one(`/api/conversations/${ids[2]}/messages`, { method: 'POST', body: { body: 'Olá! Sou o Um.' } })).data;
  assert.equal(sent.user_name, 'Atendente Um');
  assert.equal(sent.user_id, at1.id);
  const detail = (await owner(`/api/contacts/${ids[2]}`)).data;
  assert.equal(detail.contact?.assigned_user_id ?? detail.assigned_user_id, at1.id);
  const acts = (detail.activities || []).map((x) => x.description);
  assert.ok(acts.includes('Atendente Um passou a conversa para Atendente Dois'));
  assert.ok(acts.includes('Atendente Um assumiu a conversa'));

  // Não dá para atribuir a alguém de outra empresa.
  const other = mainDb.prepare("SELECT id FROM users WHERE email = 'dani@delta.com' OR company_id != ? LIMIT 1").get(c.id);
  assert.equal((await one(`/api/conversations/${ids[0]}/assign`, { method: 'POST', body: { user_id: other.id } })).status, 400);
});

test('usuário desativado: as conversas dele voltam para "sem responsável"', async () => {
  const a = await adminSession();
  const c = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Zeta', plan: 'profissional', owner_name: 'Zé', owner_email: 'ze@zeta.com', owner_password: 'senhaforte1',
  } })).data;
  const { u: owner } = await userSession('ze@zeta.com', 'senhaforte1');
  const at = (await owner('/api/users', { method: 'POST', body: { name: 'Tina', email: 'tina@zeta.com', password: 'senhaforte1', role: 'agent' } })).data;
  const id = (await owner('/api/simulator/inbound', { method: 'POST', body: { phone: '11900000099', text: 'Oi' } })).data.contact.id;
  await owner(`/api/conversations/${id}/assign`, { method: 'POST', body: { user_id: at.id } });
  assert.equal((await owner('/api/conversations?scope=unassigned')).data.length, 0);

  await owner(`/api/users/${at.id}`, { method: 'PUT', body: { active: false } });
  assert.deepEqual((await owner('/api/conversations?scope=unassigned')).data.map((x) => x.id), [id]);
  const acts = (await owner(`/api/contacts/${id}`)).data.activities.map((x) => x.description);
  assert.ok(acts.includes('Tina saiu do atendimento: conversa sem responsável'));
  assert.ok(c.id);
});

test('clientes e contratos: cadastro vira cliente, aviso antes do vencimento, renovação e valores só para o dono', async () => {
  const { processContracts } = await import('../src/services/contracts.js');
  const { todayIn, addDays } = await import('../src/services/time.js');
  const today = todayIn('America/Sao_Paulo');
  const a = await adminSession();
  await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Eta', plan: 'profissional', owner_name: 'Edu', owner_email: 'edu@eta.com', owner_password: 'senhaforte1',
  } });
  const { u: owner } = await userSession('edu@eta.com', 'senhaforte1');
  await owner('/api/users', { method: 'POST', body: { name: 'Ari', email: 'ari@eta.com', password: 'senhaforte1', role: 'agent' } });
  const { u: agent } = await userSession('ari@eta.com', 'senhaforte1');
  const contact = (await owner('/api/contacts', { method: 'POST', body: { name: 'Loja Bela', phone: '11955550001' } })).data;
  assert.equal((await owner('/api/clients')).data.length, 0, 'lead ainda não é cliente');

  // Contrato anual vencendo em 10 dias, aviso 30 dias antes.
  const k = (await owner('/api/contracts', { method: 'POST', body: {
    contact_id: contact.id, title: 'Manutenção anual', value: '1.200,00', period: 'anual',
    start_date: addDays(today, -355), end_date: addDays(today, 10), notice_days: 30,
  } })).data;
  assert.equal(k.value_cents, 120000);
  assert.equal(k.situation, 'vencendo');
  assert.equal(k.days_left, 10);
  const clients = (await owner('/api/clients')).data;
  assert.deepEqual(clients.map((c) => [c.name, c.active_contracts, c.next_end_date]), [['Loja Bela', 1, addDays(today, 10)]]);
  assert.equal((await owner(`/api/contacts/${contact.id}`)).data.stage, 'ganho');
  const summary = (await owner('/api/clients/summary')).data;
  assert.deepEqual([summary.clients, summary.active, summary.expiring, summary.monthly_recurring_cents], [1, 1, 1, 10000]);

  // Atendente gerencia, mas não vê nem altera valores.
  const seen = (await agent('/api/contracts')).data[0];
  assert.equal(seen.value_cents, null);
  assert.equal((await agent('/api/clients/summary')).data.monthly_recurring_cents, null);
  await agent(`/api/contracts/${k.id}`, { method: 'PUT', body: { value: '1,00', notes: 'cliente pediu desconto' } });
  assert.equal((await owner('/api/contracts')).data[0].value_cents, 120000);

  // O agendador cria uma única tarefa de renovação.
  await processContracts();
  await processContracts();
  const tasks = (await owner('/api/tasks?status=aberta')).data.filter((t) => t.type === 'renovar_contrato');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].details, /vence em 10 dia/);

  // Renovar: o atual vira "renovado", nasce o próximo período e a tarefa fecha.
  const renewed = (await owner(`/api/contracts/${k.id}/renew`, { method: 'POST', body: { value: '1.320,00' } })).data;
  assert.equal(renewed.start_date, addDays(today, 11));
  assert.equal(renewed.value_cents, 132000);
  assert.equal(renewed.renewed_from_id, k.id);
  assert.equal(renewed.situation, 'vigente');
  assert.equal((await owner('/api/tasks?status=aberta')).data.filter((t) => t.type === 'renovar_contrato').length, 0);
  assert.equal((await owner('/api/contracts?filter=encerrados')).data[0].status, 'renovado');

  // Renovação automática de contrato vencido.
  const auto = (await owner('/api/contracts', { method: 'POST', body: {
    contact_id: contact.id, title: 'Locação', period: 'mensal', start_date: addDays(today, -31), end_date: addDays(today, -1), auto_renew: true, notice_days: 5,
  } })).data;
  assert.equal(auto.situation, 'vencido');
  await processContracts();
  const after = (await owner('/api/contracts')).data.find((x) => x.renewed_from_id === auto.id);
  assert.equal(after.start_date, today);
  assert.equal(after.situation, 'vigente');

  // Encerrar tira dos ativos; atendente não exclui.
  await owner(`/api/contracts/${after.id}/close`, { method: 'POST', body: { status: 'cancelado' } });
  assert.ok(!(await owner('/api/contracts')).data.some((x) => x.id === after.id));
  assert.equal((await agent(`/api/contracts/${renewed.id}`, { method: 'DELETE' })).status, 403);

  // Validação.
  const bad = await owner('/api/contracts', { method: 'POST', body: { contact_id: contact.id, title: 'X', start_date: today, end_date: addDays(today, -5) } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /antes do início/);
});

test('documentos: anexar, abrir, formatos aceitos, acesso por perfil e exclusão junto com o cliente', async () => {
  const a = await adminSession();
  const company = (await a('/api/admin/companies', { method: 'POST', body: {
    name: 'Teta', plan: 'profissional', owner_name: 'Téo', owner_email: 'teo@teta.com', owner_password: 'senhaforte1',
  } })).data;
  const { u: owner } = await userSession('teo@teta.com', 'senhaforte1');
  const pro = (await owner('/api/professionals', { method: 'POST', body: { name: 'Dra. Paz' } })).data;
  await owner('/api/users', { method: 'POST', body: { name: 'Paz', email: 'paz@teta.com', password: 'senhaforte1', role: 'professional', professional_id: pro.id } });
  const { u: prof } = await userSession('paz@teta.com', 'senhaforte1');
  const mine = (await owner('/api/contacts', { method: 'POST', body: { name: 'Cliente da Paz', phone: '11944440001' } })).data;
  const other = (await owner('/api/contacts', { method: 'POST', body: { name: 'Outro', phone: '11944440002' } })).data;
  await owner('/api/appointments', { method: 'POST', body: { contact_id: mine.id, professional_id: pro.id, date: '2031-05-10', time: '10:00' } });

  const pdf = Buffer.from('%PDF-1.4 conteúdo de teste').toString('base64');
  const doc = (await owner('/api/documents', { method: 'POST', body: { name: 'contrato.pdf', data: pdf, contact_id: other.id, category: 'Contrato' } })).data;
  assert.equal(doc.mime, 'application/pdf');
  assert.equal(doc.uploaded_by, 'Téo');
  const content = (await owner(`/api/documents/${doc.id}/content`)).data;
  assert.equal(Buffer.from(content.data, 'base64').toString(), '%PDF-1.4 conteúdo de teste');
  const general = (await owner('/api/documents', { method: 'POST', body: { name: 'alvara.png', data: pdf } })).data;
  assert.equal(general.contact_id, null);
  assert.deepEqual((await owner('/api/documents?scope=company')).data.map((d) => d.id), [general.id]);

  // Formatos perigosos e arquivos grandes ficam de fora.
  assert.equal((await owner('/api/documents', { method: 'POST', body: { name: 'pagina.html', data: pdf } })).status, 400);
  assert.equal((await owner('/api/documents', { method: 'POST', body: { name: 'x.svg', data: pdf } })).status, 400);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  const tooBig = await owner('/api/documents', { method: 'POST', body: { name: 'grande.pdf', data: big } });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.data.error, /10 MB/);

  // Profissional: só documentos dos próprios clientes, sem os gerais nem contratos.
  const mineDoc = (await prof('/api/documents', { method: 'POST', body: { name: 'laudo.pdf', data: pdf, contact_id: mine.id } })).data;
  assert.equal(mineDoc.contact_id, mine.id);
  assert.deepEqual((await prof('/api/documents')).data.map((d) => d.id), [mineDoc.id]);
  assert.equal((await prof(`/api/documents/${doc.id}/content`)).status, 404);
  assert.equal((await prof(`/api/documents/${general.id}/content`)).status, 404);
  assert.equal((await prof('/api/documents', { method: 'POST', body: { name: 'a.pdf', data: pdf } })).status, 403);
  assert.equal((await prof('/api/contracts')).status, 403);
  assert.equal((await prof(`/api/documents/${mineDoc.id}`, { method: 'DELETE' })).status, 403);

  // Exportação leva os arquivos; excluir o cliente apaga os documentos dele.
  const exported = (await a(`/api/admin/companies/${company.id}/export`)).data;
  assert.equal(exported.data.documents.length, 3);
  assert.equal(Buffer.from(exported.data.document_files.find((f) => f.document_id === doc.id).data_base64, 'base64').toString(), '%PDF-1.4 conteúdo de teste');
  await owner(`/api/contacts/${other.id}`, { method: 'DELETE' });
  assert.equal((await owner(`/api/documents/${doc.id}/content`)).status, 404);
  assert.equal(mainDb.prepare('SELECT COUNT(*) AS n FROM document_files WHERE document_id = ?').get(doc.id).n, 0);
});

test('teste grátis: IA bloqueada no servidor e assinatura por Pix com identificador da empresa', async () => {
  const { config } = await import('../src/config.js');
  const { setClientFactory } = await import('../src/services/ai.js');
  const { all } = await import('../src/db.js');
  const calls = [];
  setClientFactory(() => ({ beta: { messages: { create: async () => { calls.push(1); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }] }; } } } }));
  config.platformPixKey = '123e4567-e89b-42d3-a456-426614174000';
  config.platformPixName = 'Fulano de Tal';
  config.platformPixCity = 'SAO PAULO';
  try {
    // Cadastro pela página inicial = teste grátis.
    const u = browser();
    assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Iota', name: 'Ivo', email: 'ivo@iota.com', password: 'senhaforte1' } })).status, 200);
    await u('/api/settings', { method: 'PUT', body: { settings: { integrations: { anthropic_api_key: 'sk-propria' } } } });
    const meta = (await u('/api/meta')).data;
    assert.equal(meta.ai_locked, true);

    // Mensagem chega: ninguém responde automaticamente (nem a resposta simples).
    const r = (await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11933330001', text: 'Quanto custa?' } })).data;
    await new Promise((ok) => setTimeout(ok, 60));
    assert.equal(all("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out'", r.contact.id)[0].n, 0);
    assert.equal(calls.length, 0);
    assert.equal((await u(`/api/conversations/${r.contact.id}/ai-reply`, { method: 'POST' })).status, 402);
    assert.equal((await u(`/api/conversations/${r.contact.id}/ai`, { method: 'POST', body: { enabled: true } })).status, 402);
    assert.equal((await u('/api/dashboard/insights', { method: 'POST', body: {} })).status, 402);
    // Atendimento manual continua funcionando.
    assert.equal((await u(`/api/conversations/${r.contact.id}/messages`, { method: 'POST', body: { body: 'Olá! Custa R$ 100.' } })).status, 200);

    // Paywall: Pix de cada plano pago, com a chave da plataforma e o identificador da empresa.
    const up = (await u('/api/upgrade')).data;
    assert.deepEqual(up.plans.map((p) => [p.id, p.price_cents]), [['essencial', 10000], ['profissional', 24900]]);
    assert.match(up.txid, /^CONVERSA[A-Za-z0-9]+$/);
    const essencial = up.plans.find((p) => p.id === 'essencial').pix_code;
    assert.ok(essencial.includes('123e4567-e89b-42d3-a456-426614174000'));
    assert.ok(essencial.includes('5406100.00'));
    assert.ok(up.plans.find((p) => p.id === 'profissional').pix_code.includes('5406249.00'));
    assert.ok(essencial.includes(up.txid));
    assert.equal(up.email, 'contato@conversacrm.online');

    // "Já enviei o comprovante" aparece no histórico do admin.
    await u('/api/upgrade/notify', { method: 'POST', body: { plan: 'profissional' } });
    const a = await adminSession();
    const log = (await a('/api/admin/audit')).data.find((x) => x.action === 'pedido de assinatura');
    assert.match(log.details, /Profissional/);
    assert.ok(log.details.includes(up.txid));

    // Admin muda o plano: a IA destrava.
    const id = (await a('/api/admin/companies')).data.find((x) => x.name === 'Iota').id;
    await a(`/api/admin/companies/${id}`, { method: 'PUT', body: { plan: 'essencial' } });
    assert.equal((await u('/api/meta')).data.ai_locked, false);
    assert.equal((await u(`/api/conversations/${r.contact.id}/ai`, { method: 'POST', body: { enabled: true } })).status, 200);
  } finally {
    config.platformPixKey = '';
    setClientFactory(() => null);
  }
});

test('pedido de assinatura: aparece como "aguardando Pix" e o admin ativa o plano com os limites dele', async () => {
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Kappa', name: 'Kai', email: 'kai@kappa.com', password: 'senhaforte1' } });
  await u('/api/upgrade/notify', { method: 'POST', body: { plan: 'profissional' } });
  assert.equal((await u('/api/upgrade')).data.requested_plan, 'profissional');
  const a = await adminSession();
  const overview = (await a('/api/admin/overview')).data;
  assert.ok(overview.upgrade_requests >= 1);
  const listed = overview.list.find((x) => x.name === 'Kappa');
  assert.equal(listed.plan, 'gratis');
  assert.equal(listed.upgrade_plan, 'profissional');
  assert.equal(overview.list[0].upgrade_plan !== null, true, 'pedidos em aberto aparecem primeiro');

  const out = (await a(`/api/admin/companies/${listed.id}/activate-plan`, { method: 'POST', body: { plan: 'profissional' } })).data;
  assert.deepEqual([out.plan, out.max_users, out.max_leads, out.upgrade_plan], ['profissional', 10, null, null]);
  assert.equal((await u('/api/meta')).data.ai_locked, false);
  assert.ok((await a('/api/admin/audit')).data.some((r) => r.action === 'assinatura ativada' && r.company_id === listed.id));
  assert.equal((await a(`/api/admin/companies/${listed.id}/activate-plan`, { method: 'POST', body: { plan: 'gratis' } })).status, 400);
});

test('Stripe: assinatura no cartão ativa, renova, recusa e encerra pelo webhook assinado; painel financeiro soma tudo', async () => {
  const crypto = await import('node:crypto');
  const { config } = await import('../src/config.js');
  const { setStripeFetch, stripeMode } = await import('../src/services/stripe.js');
  const sent = [];
  setStripeFetch(async (url, init) => {
    sent.push({ url, body: new URLSearchParams(init.body), auth: init.headers.Authorization });
    const data = url.endsWith('checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' } : { url: 'https://billing.stripe.com/p/session/1' };
    return { ok: true, status: 200, json: async () => data };
  });
  config.stripeSecretKey = 'sk_test_123';
  config.stripeWebhookSecret = 'whsec_teste';
  const hook = async (type, object, { secret = 'whsec_teste' } = {}) => {
    const body = JSON.stringify({ id: `evt_${Math.random()}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const res = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body });
    return { status: res.status, data: await res.json() };
  };
  try {
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Lambda', name: 'Lia', email: 'lia@lambda.com', password: 'senhaforte1' } });
    const up = (await u('/api/upgrade')).data;
    assert.equal(up.card_enabled, true);
    const companyId = (await u('/api/auth/me')).data.company.id;

    // Checkout: assinatura mensal em reais, com a empresa nos metadados.
    const co = (await u('/api/upgrade/card', { method: 'POST', body: { plan: 'essencial' } })).data;
    assert.equal(co.url, 'https://checkout.stripe.com/c/pay/cs_1');
    const b = sent[0].body;
    assert.equal(sent[0].auth, 'Bearer sk_test_123');
    assert.equal(b.get('mode'), 'subscription');
    assert.equal(b.get('line_items[0][price_data][unit_amount]'), '10000');
    assert.equal(b.get('line_items[0][price_data][currency]'), 'brl');
    assert.equal(b.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(b.get('subscription_data[metadata][company_id]'), String(companyId));
    assert.equal(b.get('customer_email'), 'lia@lambda.com');

    // Webhook sem assinatura válida é recusado e não muda nada.
    assert.equal((await hook('checkout.session.completed', { metadata: { company_id: companyId, plan: 'essencial' } }, { secret: 'outro' })).status, 400);
    assert.equal((await u('/api/meta')).data.plan.id, 'gratis');

    // Pagamento aprovado: plano ativo e mensalidade registrada (eventos repetidos não duplicam).
    await hook('checkout.session.completed', { object: 'checkout.session', customer: 'cus_1', subscription: 'sub_1', client_reference_id: String(companyId), metadata: { company_id: String(companyId), plan: 'essencial' } });
    const now = Math.floor(Date.now() / 1000);
    const invoice = { object: 'invoice', id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_paid: 10000, status_transitions: { paid_at: now },
      lines: { data: [{ period: { start: now, end: now + 30 * 86400 }, metadata: { company_id: String(companyId), plan: 'essencial' } }] } };
    await hook('invoice.paid', invoice);
    await hook('invoice.paid', invoice);
    const meta = (await u('/api/meta')).data;
    assert.equal(meta.plan.id, 'essencial');
    assert.equal(meta.ai_locked, false);
    const sub = (await u('/api/upgrade')).data.subscription;
    assert.deepEqual([sub.method, sub.state, sub.has_card], ['cartao', 'em_dia', true]);
    // Já assinante no cartão: não abre outro checkout; usa a área do cliente.
    assert.equal((await u('/api/upgrade/card', { method: 'POST', body: { plan: 'profissional' } })).status, 400);
    assert.equal((await u('/api/upgrade/portal', { method: 'POST' })).data.url, 'https://billing.stripe.com/p/session/1');
    assert.equal(sent.at(-1).body.get('customer'), 'cus_1');

    const a = await adminSession();
    let f = (await a('/api/admin/finance')).data;
    assert.equal(f.stripe_mode, 'test');
    assert.equal(f.payments.filter((p) => p.company_id === companyId && p.status === 'pago').length, 1);
    assert.ok(f.received.this_month_cents >= 10000);
    assert.ok(f.received.by_method.cartao >= 10000);
    const ess = f.plans.find((p) => p.id === 'essencial');
    assert.ok(ess.card >= 1 && ess.mrr_cents >= 10000);
    assert.ok(f.receivable.renewing.some((r) => r.id === companyId && r.method === 'cartao'), 'renova em 30 dias');

    // Cartão recusado: aparece em atraso; cancelamento: volta para o grátis.
    await hook('invoice.payment_failed', { object: 'invoice', id: 'in_2', customer: 'cus_1', subscription: 'sub_1', amount_due: 10000, attempt_count: 1 });
    f = (await a('/api/admin/finance')).data;
    assert.ok(f.receivable.overdue.some((r) => r.id === companyId && r.state === 'atrasada'));
    await hook('customer.subscription.deleted', { object: 'subscription', id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { company_id: String(companyId) } });
    const after = (await u('/api/meta')).data;
    assert.deepEqual([after.plan.id, after.ai_locked, after.plan.max_leads], ['gratis', true, 30]);
    assert.ok((await a('/api/admin/audit')).data.some((r) => r.action === 'assinatura encerrada' && r.company_id === companyId));

    // Chave de produção fica bloqueada em localhost.
    config.stripeSecretKey = 'rk_live_abc';
    assert.equal(stripeMode(), 'live_blocked');
    assert.equal((await u('/api/upgrade')).data.card_enabled, false);
  } finally {
    config.stripeSecretKey = '';
    config.stripeWebhookSecret = '';
  }
});

test('Pix confirmado pelo admin soma um mês por pagamento e entra no financeiro', async () => {
  const { today, addMonths } = await import('../src/services/subscriptions.js');
  const { addDays } = await import('../src/services/time.js');
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Mu', name: 'Mel', email: 'mel@mu.com', password: 'senhaforte1' } });
  const id = (await u('/api/auth/me')).data.company.id;
  const a = await adminSession();
  const before = (await a('/api/admin/finance')).data;
  let c = (await a(`/api/admin/companies/${id}/activate-plan`, { method: 'POST', body: { plan: 'profissional' } })).data;
  const firstEnd = addDays(addMonths(today(), 1), -1);
  assert.equal(c.subscription.paid_until, firstEnd);
  assert.equal(c.subscription.state, 'em_dia');
  c = (await a(`/api/admin/companies/${id}/activate-plan`, { method: 'POST', body: { plan: 'profissional' } })).data;
  assert.equal(c.subscription.paid_until, addDays(addMonths(addDays(firstEnd, 1), 1), -1), 'segundo Pix começa depois do primeiro mês');
  assert.equal(c.payments.length, 2);
  const after = (await a('/api/admin/finance')).data;
  assert.equal(after.received.by_method.pix - before.received.by_method.pix, 49800);
  assert.equal(after.plans.find((p) => p.id === 'profissional').pix - before.plans.find((p) => p.id === 'profissional').pix, 1);
});

test('Stripe Pix: cada pagamento soma um mês, confirmado pelo webhook, sem duplicar', async () => {
  const crypto = await import('node:crypto');
  const { config } = await import('../src/config.js');
  const { setStripeFetch } = await import('../src/services/stripe.js');
  const { today, addMonths } = await import('../src/services/subscriptions.js');
  const { addDays } = await import('../src/services/time.js');
  const sent = [];
  setStripeFetch(async (url, init) => { sent.push(new URLSearchParams(init.body)); return { ok: true, status: 200, json: async () => ({ id: 'cs_pix', url: 'https://checkout.stripe.com/c/pay/cs_pix' }) }; });
  config.stripeSecretKey = 'sk_test_123';
  config.stripeWebhookSecret = 'whsec_teste';
  const hook = async (type, object) => {
    const body = JSON.stringify({ id: `evt_${Math.random()}`, type, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_teste').update(`${t}.${body}`).digest('hex');
    return (await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body })).json();
  };
  try {
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Nu', name: 'Nina', email: 'nina@nu.com', password: 'senhaforte1' } });
    const id = (await u('/api/auth/me')).data.company.id;
    const r = (await u('/api/upgrade/pix', { method: 'POST', body: { plan: 'profissional' } })).data;
    assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_pix');
    const b = sent[0];
    assert.equal(b.get('mode'), 'payment');
    assert.equal(b.get('payment_method_types[0]'), 'pix');
    assert.equal(b.get('line_items[0][price_data][unit_amount]'), '24900');
    assert.equal(b.get('metadata[kind]'), 'pix_month');

    const session = (sid, status = 'paid') => ({ object: 'checkout.session', id: sid, mode: 'payment', payment_status: status, amount_total: 24900, customer: 'cus_pix', metadata: { company_id: String(id), plan: 'profissional', kind: 'pix_month' } });
    // Ainda não pago: nada muda.
    assert.equal((await hook('checkout.session.completed', session('cs_a', 'unpaid'))).pending, true);
    assert.equal((await u('/api/meta')).data.plan.id, 'gratis');
    // Pago: plano ativo por um mês; aviso repetido não soma de novo.
    await hook('checkout.session.async_payment_succeeded', session('cs_a'));
    await hook('checkout.session.async_payment_succeeded', session('cs_a'));
    const firstEnd = addDays(addMonths(today(), 1), -1);
    let meta = (await u('/api/meta')).data;
    assert.deepEqual([meta.plan.id, meta.subscription.method, meta.subscription.paid_until, meta.ai_locked], ['profissional', 'pix', firstEnd, false]);
    // Segundo mês pago antes do vencimento: começa depois do primeiro.
    await hook('checkout.session.completed', session('cs_b'));
    meta = (await u('/api/meta')).data;
    assert.equal(meta.subscription.paid_until, addDays(addMonths(addDays(firstEnd, 1), 1), -1));
    const a = await adminSession();
    const pays = (await a(`/api/admin/companies/${id}`)).data.payments;
    assert.deepEqual(pays.map((p) => [p.method, p.amount_cents, p.provider_ref]).sort(), [['pix', 24900, 'cs_a'], ['pix', 24900, 'cs_b']]);
  } finally {
    config.stripeSecretKey = '';
    config.stripeWebhookSecret = '';
  }
});

test('Stripe: fatura no formato atual da API (parent.subscription_details) também ativa e registra', async () => {
  const { handleStripeEvent } = await import('../src/services/stripe.js');
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Xi', name: 'Xa', email: 'xa@xi.com', password: 'senhaforte1' } });
  const id = (await u('/api/auth/me')).data.company.id;
  const now = Math.floor(Date.now() / 1000);
  // Renovação chega sem o checkout (ex.: assinatura criada antes): só a fatura identifica a empresa.
  const r = handleStripeEvent({ type: 'invoice.paid', created: now, data: { object: {
    object: 'invoice', id: 'in_novo', customer: 'cus_novo', amount_paid: 24900, billing_reason: 'subscription_cycle',
    status_transitions: { paid_at: now },
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_novo', metadata: { company_id: String(id), plan: 'profissional' } } },
    lines: { data: [{ period: { start: now, end: now + 30 * 86400 }, metadata: {} }] },
  } } });
  assert.deepEqual(r, { ok: true });
  const meta = (await u('/api/meta')).data;
  assert.deepEqual([meta.plan.id, meta.subscription.method, meta.subscription.state], ['profissional', 'cartao', 'em_dia']);
  // Eventos seguintes acham a empresa pela assinatura gravada.
  handleStripeEvent({ type: 'customer.subscription.updated', data: { object: { object: 'subscription', id: 'sub_novo', customer: 'cus_novo', status: 'active', cancel_at_period_end: true } } });
  assert.equal((await u('/api/upgrade')).data.subscription.cancel_at_period_end, true);
});

test('Stripe: quem assina no cartão muda de plano na mesma assinatura, com diferença proporcional', async () => {
  const { config } = await import('../src/config.js');
  const { setStripeFetch, handleStripeEvent } = await import('../src/services/stripe.js');
  const calls = [];
  setStripeFetch(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? new URLSearchParams(init.body) : null });
    const data = url.includes('/subscriptions/') && init.method === 'GET'
      ? { id: 'sub_m', items: { data: [{ id: 'si_m', price: { product: 'prod_m' } }] } } : url.endsWith('/products') ? { id: 'prod_pro' } : { id: 'ok' };
    return { ok: true, status: 200, json: async () => data };
  });
  config.stripeSecretKey = 'sk_test_123';
  try {
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Omicron', name: 'Oto', email: 'oto@omicron.com', password: 'senhaforte1' } });
    const id = (await u('/api/auth/me')).data.company.id;
    handleStripeEvent({ type: 'checkout.session.completed', data: { object: { object: 'checkout.session', customer: 'cus_m', subscription: 'sub_m', metadata: { company_id: String(id), plan: 'essencial' } } } });
    assert.equal((await u('/api/meta')).data.plan.id, 'essencial');

    const r = await u('/api/upgrade/change', { method: 'POST', body: { plan: 'profissional' } });
    assert.equal(r.status, 200);
    const update = calls.find((c) => c.method === 'POST' && c.url.endsWith('/subscriptions/sub_m')).body;
    assert.equal(update.get('items[0][id]'), 'si_m');
    assert.equal(update.get('items[0][price_data][unit_amount]'), '24900');
    assert.equal(update.get('items[0][price_data][product]'), 'prod_pro');
    assert.equal(update.get('proration_behavior'), 'always_invoice');
    assert.equal(update.get('metadata[plan]'), 'profissional');
    assert.equal(calls.find((c) => c.url.endsWith('/products')).body.get('name'), 'Conversa CRM — plano Profissional');
    const meta = (await u('/api/meta')).data;
    assert.deepEqual([meta.plan.id, meta.plan.max_users, meta.plan.max_leads], ['profissional', 10, null]);
    assert.equal((await u('/api/upgrade/change', { method: 'POST', body: { plan: 'profissional' } })).status, 400, 'mesmo plano');
  } finally {
    config.stripeSecretKey = '';
  }
});

test('cortesia: admin libera plano pago de graça, com motivo e prazo; vence sozinha e sai da receita', async () => {
  const { processCourtesies, today } = await import('../src/services/subscriptions.js');
  const { addDays } = await import('../src/services/time.js');
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Pi', name: 'Pia', email: 'pia@pi.com', password: 'senhaforte1' } });
  const id = (await u('/api/auth/me')).data.company.id;
  const a = await adminSession();
  const before = (await a('/api/admin/finance')).data;

  // Sem motivo, não libera.
  assert.equal((await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'profissional' } })).status, 400);
  assert.equal((await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'gratis', reason: 'x' } })).status, 400);
  const until = addDays(today(), 30);
  const c = (await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'profissional', until, reason: 'Parceiro' } })).data;
  assert.deepEqual([c.plan, c.max_users, c.max_leads, c.subscription.state, c.subscription.courtesy_until, c.subscription.courtesy_reason], ['profissional', 10, null, 'cortesia', until, 'Parceiro']);

  // A empresa vê a cortesia, com IA liberada.
  const meta = (await u('/api/meta')).data;
  assert.deepEqual([meta.ai_locked, meta.subscription.state, meta.subscription.courtesy_until], [false, 'cortesia', until]);

  // Financeiro: conta como cortesia, não como receita.
  const f = (await a('/api/admin/finance')).data;
  assert.equal(f.plans.find((p) => p.id === 'profissional').courtesy - before.plans.find((p) => p.id === 'profissional').courtesy, 1);
  assert.equal(f.mrr_cents, before.mrr_cents);
  assert.ok((await a('/api/admin/audit')).data.some((r) => r.action === 'cortesia liberada' && r.company_id === id && /Parceiro/.test(r.details)));

  // Prazo vencido: o agendador devolve para o grátis.
  processCourtesies(addDays(today(), 31));
  const after = (await u('/api/meta')).data;
  assert.deepEqual([after.plan.id, after.ai_locked, after.subscription.state], ['gratis', true, 'gratis']);
  assert.ok((await a('/api/admin/audit')).data.some((r) => r.action === 'cortesia encerrada' && r.company_id === id));

  // Sem prazo + pagamento: pagar encerra a cortesia.
  await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'essencial', until: '', reason: 'Teste estendido' } });
  assert.equal((await u('/api/meta')).data.subscription.courtesy_until, null);
  const paid = (await a(`/api/admin/companies/${id}/activate-plan`, { method: 'POST', body: { plan: 'essencial' } })).data;
  assert.equal(paid.subscription.state, 'em_dia');

  // Encerrar à mão.
  await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'profissional', reason: 'Influenciador' } });
  const ended = (await a(`/api/admin/companies/${id}/courtesy`, { method: 'DELETE' })).data;
  assert.equal(ended.plan, 'gratis');

  // Plano pago colocado à mão, sem motivo: "sem cobrança" (interna), não cortesia.
  const internal = (await a(`/api/admin/companies/${id}`, { method: 'PUT', body: { plan: 'profissional', max_users: 10, max_leads: '' } })).data;
  assert.equal(internal.subscription.state, 'em_dia', 'continua com o Pix pago registrado');
});

test('primeiros passos: cada passo é marcado pelo que a empresa configurou de verdade', async () => {
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Rho', name: 'Rui', email: 'rui@rho.com', password: 'senhaforte1' } });
  let o = (await u('/api/onboarding')).data;
  assert.deepEqual([o.done_count, o.total, o.percent, o.next], [0, 5, 0, 'empresa']);
  assert.equal((await u('/api/meta')).data.onboarding.done_count, 0);

  await u('/api/settings', { method: 'PUT', body: { settings: { ai: { business_description: 'Barbearia no centro de Campinas. Aceitamos Pix e cartão.' } } } });
  await u('/api/products', { method: 'POST', body: { name: 'Corte', price: '50,00', kind: 'servico', duration_min: 30 } });
  o = (await u('/api/onboarding')).data;
  assert.deepEqual([o.done_count, o.next], [2, 'horarios']);

  // Salvar outra aba não conta como horários; salvar os horários conta.
  await u('/api/settings', { method: 'PUT', body: { settings: { team: { task_sla_hours: 2 } } } });
  assert.equal((await u('/api/onboarding')).data.next, 'horarios');
  await u('/api/settings', { method: 'PUT', body: { settings: { business_hours: { seg: [['09:00', '18:00']] } } } });
  await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11955550123', text: 'Oi, tem horário amanhã?' } });
  o = (await u('/api/onboarding')).data;
  assert.deepEqual([o.done_count, o.percent, o.next, o.complete], [4, 80, 'whatsapp', false]);

  // Esconder e voltar.
  assert.equal((await u('/api/onboarding/dismiss', { method: 'POST' })).data.dismissed, true);
  assert.equal((await u('/api/onboarding/dismiss', { method: 'POST', body: { dismissed: false } })).data.dismissed, false);

  // Cliente cadastrado direto na tela Clientes.
  const c = (await u('/api/contacts', { method: 'POST', body: { name: 'Cliente Direto', phone: '11955550124', stage: 'ganho' } })).data;
  const listed = (await u('/api/clients')).data.find((x) => x.id === c.id);
  assert.ok(listed && listed.won_at, 'aparece em Clientes com a data em que virou cliente');
});

test('WhatsApp por QR Code gerenciado: conecta sem campos técnicos, recebe o aviso de conexão e limita 20 primeiras mensagens por dia', async () => {
  const { config } = await import('../src/config.js');
  const { setEvolutionFetch } = await import('../src/services/whatsapp-connect.js');
  const calls = [];
  let state = 'connecting';
  setEvolutionFetch(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, key: init.headers?.apikey });
    const path = new URL(url).pathname;
    const data = path === '/instance/create' ? { instance: { instanceName: 'x' }, hash: 'token-da-instancia' }
      : path.startsWith('/instance/connectionState') ? { instance: { state } }
        : path.startsWith('/instance/connect') ? { base64: 'data:image/png;base64,QRCODE' }
          : path.startsWith('/message/sendText') ? { key: { id: `msg${calls.length}` } } : { ok: true };
    return { ok: true, status: 200, json: async () => data };
  });
  config.evolutionUrl = 'https://evo.conversacrm.test';
  config.evolutionApiKey = 'chave-global';
  try {
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Sigma', name: 'Sil', email: 'sil@sigma.com', password: 'senhaforte1' } });
    const meta = (await u('/api/meta')).data;
    assert.equal(meta.whatsapp_managed, true);

    // Conectar: cria a instância, liga o aviso de mensagens e devolve o QR Code.
    const r = (await u('/api/whatsapp/connect', { method: 'POST' })).data;
    assert.deepEqual(r, { state: 'connecting', qr: 'data:image/png;base64,QRCODE' });
    const create = calls.find((c) => c.url.endsWith('/instance/create'));
    assert.equal(create.body.integration, 'WHATSAPP-BAILEYS');
    assert.match(create.body.instanceName, /^crm-\d+$/);
    assert.equal(create.key, 'chave-global');
    const hook = calls.find((c) => c.url.includes('/webhook/set/')).body.webhook;
    assert.deepEqual(hook.events, ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
    assert.equal(hook.url, meta.webhooks.evolution);
    // Nada técnico volta para o cliente: chave da instância fica mascarada.
    assert.ok(!JSON.stringify((await u('/api/settings')).data).includes('token-da-instancia'));

    // O celular leu o QR Code: o Evolution avisa e o WhatsApp vira o canal da empresa.
    const hookPath = new URL(meta.webhooks.evolution).pathname + new URL(meta.webhooks.evolution).search;
    await fetch(base + hookPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'connection.update', data: { state: 'open' } }) });
    state = 'open';
    const after = (await u('/api/meta')).data;
    assert.equal(after.whatsapp_provider, 'evolution');
    assert.equal((await u('/api/onboarding')).data.steps.find((s) => s.id === 'whatsapp').done, true);
    assert.deepEqual((await u('/api/whatsapp/state')).data, { state: 'open' });

    // Prospecção: até 20 primeiras mensagens por dia para quem nunca falou com a empresa.
    const ids = [];
    for (let i = 0; i < 21; i++) ids.push((await u('/api/contacts', { method: 'POST', body: { name: `Prospect ${i}`, phone: `1193000${String(i).padStart(4, '0')}` } })).data.id);
    for (let i = 0; i < 20; i++) assert.equal((await u(`/api/conversations/${ids[i]}/messages`, { method: 'POST', body: { body: 'Olá! Conhece o nosso serviço?' } })).status, 200);
    const blocked = await u(`/api/conversations/${ids[20]}/messages`, { method: 'POST', body: { body: 'Olá!' } });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /20 primeiras mensagens/);
    // Segunda mensagem para quem já recebeu a primeira, e respostas a quem chamou, não contam.
    assert.equal((await u(`/api/conversations/${ids[0]}/messages`, { method: 'POST', body: { body: 'Ainda tem interesse?' } })).status, 200);
    await fetch(base + hookPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', data: { key: { remoteJid: '5511977770000@s.whatsapp.net', fromMe: false, id: 'in1' }, pushName: 'Cliente', message: { conversation: 'Oi, quero um orçamento' } } }) });
    const inbound = (await u('/api/conversations')).data.find((c) => c.phone === '5511977770000');
    assert.equal((await u(`/api/conversations/${inbound.id}/messages`, { method: 'POST', body: { body: 'Claro! Me conta mais.' } })).status, 200);
    assert.deepEqual((await u('/api/meta')).data.prospecting_limit, { limit: 20, used: 20 });
    const send = calls.filter((c) => c.url.includes('/message/sendText/'));
    assert.equal(send.at(-1).key, 'token-da-instancia');

    // Celular desconectou: aviso para o dono.
    await fetch(base + hookPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'connection.update', data: { state: 'close' } }) });
    assert.equal((await u('/api/meta')).data.whatsapp_state, 'close');
    // Desconectar pelo Conversa CRM volta para o simulador.
    await u('/api/whatsapp/disconnect', { method: 'POST' });
    assert.equal((await u('/api/meta')).data.whatsapp_provider, 'simulator');
  } finally {
    config.evolutionUrl = '';
    config.evolutionApiKey = '';
  }
});

test('limite de prospecção: follow-up que passa das 20 do dia fica para amanhã, sem perder o passo', async () => {
  const { makeCompany } = await import('./setup.js');
  const { saveSettings } = await import('../src/services/company.js');
  const { createContact } = await import('../src/services/crm.js');
  const { enroll, processDueFollowups } = await import('../src/services/followup.js');
  const { run, get } = await import('../src/db.js');
  const { setEvolutionFetch } = await import('../src/services/whatsapp-connect.js');
  setEvolutionFetch(async () => ({ ok: true, status: 200, json: async () => ({ key: { id: 'x' } }) }));
  const cid = makeCompany({ whatsapp: { provider: 'evolution', evolution_url: 'https://evo.conversacrm.test', evolution_instance: 'i', evolution_api_key: 'k' } });
  // 20 primeiras mensagens já enviadas hoje.
  for (let i = 0; i < 20; i++) {
    const c = createContact(cid, { name: `Já ${i}`, phone: `1194000${String(i).padStart(4, '0')}` });
    run("INSERT INTO messages (company_id, contact_id, direction, author, body, cold) VALUES (?, ?, 'out', 'followup', 'oi', 1)", cid, c.id);
  }
  const { id: seq } = run('INSERT INTO sequences (company_id, name, steps) VALUES (?, ?, ?)', cid, 'Prospecção', JSON.stringify([{ delay_hours: 0, message: 'Oi {{nome}}!' }]));
  const novo = createContact(cid, { name: 'Novo Prospect', phone: '11940009999' });
  const eid = enroll(cid, seq, novo.id);
  await processDueFollowups();
  const e = get('SELECT * FROM enrollments WHERE id = ?', eid);
  assert.equal(e.status, 'ativo');
  assert.equal(e.step_index, 0, 'o passo não foi consumido');
  const { todayIn, addDays, zonedToUtc } = await import('../src/services/time.js');
  const tomorrow = zonedToUtc(addDays(todayIn('America/Sao_Paulo'), 1), '00:00', 'America/Sao_Paulo').getTime();
  assert.ok(Date.parse(e.next_run_at) >= tomorrow, 'reagendado para o dia seguinte, no fuso da empresa');
  assert.equal(get("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out'", novo.id).n, 0);
  saveSettings(cid, { whatsapp: { provider: 'simulator' } });
});

test('ficha única com data de nascimento: aniversariantes do mês e parabéns automático uma vez por ano', async () => {
  const { processBirthdays } = await import('../src/services/birthdays.js');
  const { todayIn } = await import('../src/services/time.js');
  const { get, run } = await import('../src/db.js');
  const today = todayIn('America/Sao_Paulo');
  const [ty, tm, td] = today.split('-');
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Tau', name: 'Teo', email: 'teo@tau.com', password: 'senhaforte1' } });

  // Formatos aceitos: dd/mm/aaaa, dd/mm (sem ano) e AAAA-MM-DD; inválida é recusada.
  const lead = (await u('/api/contacts', { method: 'POST', body: { name: 'Lia Lead', phone: '11955551001', birth_date: `${td}/${tm}/1990` } })).data;
  assert.equal(lead.birth_date, `1990-${tm}-${td}`);
  assert.equal(lead.stage, 'novo');
  const client = (await u('/api/contacts', { method: 'POST', body: { name: 'Caio Cliente', phone: '11955551002', stage: 'ganho', birth_date: `${td}/${tm}` } })).data;
  assert.equal(client.birth_date, `1904-${tm}-${td}`, 'sem ano');
  const bad = await u('/api/contacts', { method: 'POST', body: { name: 'X', phone: '11955551003', birth_date: '31/02/1990' } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /nascimento/);
  // Mesma ficha: lead vira cliente só trocando a etapa, e a data continua lá.
  const updated = (await u(`/api/contacts/${lead.id}`, { method: 'PUT', body: { stage: 'ganho', birth_date: '1990-01-15' } })).data;
  assert.deepEqual([updated.stage, updated.birth_date], ['ganho', '1990-01-15']);
  await u(`/api/contacts/${lead.id}`, { method: 'PUT', body: { birth_date: `${td}/${tm}/1990` } });

  // Aniversariantes do mês: leads e clientes, com a idade e "hoje".
  const b = (await u(`/api/birthdays?month=${Number(tm)}`)).data;
  const lia = b.list.find((x) => x.id === lead.id);
  const caio = b.list.find((x) => x.id === client.id);
  assert.deepEqual([lia.today, lia.turns, caio.today, caio.turns], [true, Number(ty) - 1990, true, null]);
  assert.equal(b.soon.length, 2);

  // Parabéns automático: sequência com o gatilho "No dia do aniversário", uma vez por ano.
  const companyId = (await u('/api/auth/me')).data.company.id;
  run('INSERT INTO sequences (company_id, name, trigger, steps, active) VALUES (?, ?, ?, ?, 1)', companyId, 'Parabéns', 'birthday', JSON.stringify([{ delay_hours: 0, message: 'Feliz aniversário, {{nome}}! 🎉' }]));
  processBirthdays();
  processBirthdays();
  const enrolled = get("SELECT COUNT(*) AS n FROM enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE s.company_id = ? AND s.trigger = 'birthday'", companyId).n;
  assert.equal(enrolled, 2);
  assert.ok((await u('/api/meta')).data.triggers.some((t) => t.id === 'birthday'));

  // Importação traz a data; data inválida na planilha é ignorada sem derrubar a linha.
  const imp = (await u('/api/contacts/import', { method: 'POST', body: { contacts: [
    { name: 'Importado', phone: '11955551004', birth_date: '05/09/1988' }, { name: 'Data ruim', phone: '11955551005', birth_date: 'ontem' },
  ] } })).data;
  assert.equal(imp.created, 2);
  const all = (await u('/api/contacts')).data;
  assert.equal(all.find((x) => x.name === 'Importado').birth_date, '1988-09-05');
  assert.equal(all.find((x) => x.name === 'Data ruim').birth_date, null);
});

test('vários números de WhatsApp: limite por plano, resposta pelo número da conversa, chave própria e isolamento', async () => {
  const { config } = await import('../src/config.js');
  const { setEvolutionFetch } = await import('../src/services/whatsapp-connect.js');
  const sends = [];
  setEvolutionFetch(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/message/sendText/')) sends.push(decodeURIComponent(path.split('/').pop()));
    const data = path === '/instance/create' ? { hash: `tok-${path}` } : path.startsWith('/instance/connectionState') ? { instance: { state: 'open' } }
      : path.startsWith('/instance/connect') ? { base64: 'data:image/png;base64,QR' } : path.startsWith('/message/sendText') ? { key: { id: `m${sends.length}` } } : { ok: true };
    return { ok: true, status: 200, json: async () => data };
  });
  config.evolutionUrl = 'https://evo.conversacrm.test';
  config.evolutionApiKey = 'chave-global';
  try {
    const a = await adminSession();
    // Essencial: 1 número só.
    const ess = browser();
    await ess('/api/auth/register', { method: 'POST', body: { companyName: 'Upsilon', name: 'Uli', email: 'uli@upsilon.com', password: 'senhaforte1' } });
    const essId = (await ess('/api/auth/me')).data.company.id;
    await a(`/api/admin/companies/${essId}/courtesy`, { method: 'POST', body: { plan: 'essencial', reason: 'teste' } });
    assert.equal((await ess('/api/whatsapp/numbers')).data.limit, 1);
    const blocked = await ess('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Financeiro' } });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /Profissional/);
    assert.equal((await ess('/api/meta')).data.whatsapp_numbers, null, 'com um número só, nada muda nas telas');

    // Profissional: principal + 2 extras.
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Phi', name: 'Fi', email: 'fi@phi.com', password: 'senhaforte1' } });
    const id = (await u('/api/auth/me')).data.company.id;
    await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'profissional', reason: 'teste' } });
    await u('/api/whatsapp/connect', { method: 'POST' });
    const meta0 = (await u('/api/meta')).data;
    const principalHook = new URL(meta0.webhooks.evolution);
    await fetch(base + principalHook.pathname + principalHook.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'connection.update', data: { state: 'open' } }) });
    const fin = (await u('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Financeiro' } })).data;
    await u('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Suporte' } });
    assert.equal((await u('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Quarto' } })).status, 400, 'até 3 números');
    const r = (await u('/api/whatsapp/connect', { method: 'POST', body: { number_id: fin.id } })).data;
    assert.equal(r.state, 'open');
    const ov = (await u('/api/whatsapp/numbers')).data;
    assert.deepEqual([ov.limit, ov.extras.length, ov.extras[0].label, ov.extras[0].state], [3, 2, 'Financeiro', 'open']);
    assert.ok(!JSON.stringify(ov).includes('tok-'), 'chaves nunca vão para a tela');

    // Mensagem chega pelo Financeiro (chave própria do número); chave errada é recusada.
    const finHook = `${principalHook.pathname}?token=${encodeURIComponent((await import('../src/services/whatsapp-connect.js')).getNumber(id, fin.id).webhook_token)}&n=${fin.id}`;
    const bad = await fetch(`${base}${principalHook.pathname}?token=${principalHook.searchParams.get('token')}&n=${fin.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 401, 'chave do principal não vale para o número extra');
    const inbound = (phone, mid) => ({ event: 'messages.upsert', data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: mid }, pushName: 'Cli', message: { conversation: 'Oi' } } });
    await fetch(base + finHook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inbound('5511911110001', 'a1')) });
    await fetch(base + principalHook.pathname + principalHook.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inbound('5511911110002', 'a2')) });
    const convs = (await u('/api/conversations')).data;
    const cFin = convs.find((c) => c.phone === '5511911110001');
    const cPri = convs.find((c) => c.phone === '5511911110002');
    assert.deepEqual([cFin.channel_id, cPri.channel_id], [fin.id, null]);
    assert.deepEqual((await u(`/api/conversations?number=${fin.id}`)).data.map((c) => c.id), [cFin.id]);
    assert.ok((await u('/api/conversations?number=principal')).data.some((c) => c.id === cPri.id));
    assert.equal((await u('/api/meta')).data.whatsapp_numbers.length, 3);

    // Resposta sai pelo número por onde o cliente falou.
    sends.length = 0;
    const m1 = (await u(`/api/conversations/${cFin.id}/messages`, { method: 'POST', body: { body: 'Olá do financeiro' } })).data;
    const m2 = (await u(`/api/conversations/${cPri.id}/messages`, { method: 'POST', body: { body: 'Olá do principal' } })).data;
    assert.deepEqual([m1.channel_id, m2.channel_id], [fin.id, null]);
    assert.match(sends[0], new RegExp(`-n${fin.id}$`));
    assert.doesNotMatch(sends[1], /-n\d+$/);
    // Primeira mensagem para quem nunca falou: pelo principal.
    const novo = (await u('/api/contacts', { method: 'POST', body: { name: 'Prospect', phone: '11911110003' } })).data;
    assert.equal((await u(`/api/conversations/${novo.id}/messages`, { method: 'POST', body: { body: 'Oi!' } })).data.channel_id, null);

    // Remover o Financeiro: as conversas ficam; a próxima resposta sai pelo principal.
    await u(`/api/whatsapp/numbers/${fin.id}`, { method: 'DELETE' });
    assert.equal((await u(`/api/conversations/${cFin.id}/messages`, { method: 'POST', body: { body: 'Seguimos por aqui' } })).data.channel_id, null);
    assert.equal((await fetch(base + finHook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

    // Isolamento: outra empresa não vê nem mexe nos números desta.
    const other = (await ess('/api/whatsapp/numbers')).data;
    assert.equal(other.extras.length, 0);
    assert.equal((await ess(`/api/whatsapp/numbers/${ov.extras[1].id}`, { method: 'DELETE' })).data.ok, false);
    assert.equal((await u('/api/whatsapp/numbers')).data.extras.length, 1);

    // Rebaixamento: o extra que sobrou continua recebendo, mas não dá para acrescentar outro.
    await a(`/api/admin/companies/${id}/courtesy`, { method: 'POST', body: { plan: 'essencial', reason: 'rebaixado' } });
    const after = (await u('/api/whatsapp/numbers')).data;
    assert.deepEqual([after.limit, after.extras.length], [1, 1]);
    assert.equal((await u('/api/whatsapp/numbers', { method: 'POST', body: { label: 'Outro' } })).status, 400);
  } finally {
    config.evolutionUrl = '';
    config.evolutionApiKey = '';
  }
});
