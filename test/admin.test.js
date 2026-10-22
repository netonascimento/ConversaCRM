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

test('cadastro pela página inicial: teste de 7 dias do Básico, limite de 50 leads e preços novos', async () => {
  const { todayIn, addDays } = await import('../src/services/time.js');
  resetLoginAttempts();
  const u = browser();
  assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Loja Free', name: 'Fê', email: 'fe@free.com', password: 'senhaforte1', segment: 'loja' } })).status, 200);
  const meta = (await u('/api/meta')).data;
  assert.equal(meta.plan.id, 'basico');
  assert.equal(meta.plan.max_leads, 50);
  assert.deepEqual([meta.subscription.state, meta.subscription.courtesy_until, meta.expired], ['teste', addDays(todayIn('America/Sao_Paulo'), 7), false]);
  // Convite na aba Usuários: o próximo plano com mais usuários.
  assert.deepEqual(meta.plan.next_users, { id: 'essencial', label: 'Essencial', max_users: 2 });
  for (let i = 0; i < 50; i++) assert.equal((await u('/api/contacts', { method: 'POST', body: { name: `L${i}`, phone: `119000000${String(i).padStart(2, '0')}` } })).status, 200);
  const blocked = await u('/api/contacts', { method: 'POST', body: { name: 'L11', phone: '11900000099' } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /Limite de leads/);
  // Número novo pelo WhatsApp também não entra.
  await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11977770000', text: 'oi' } });
  assert.equal((await u('/api/contacts')).data.length, 50);
  const info = (await browser()('/api/public/info')).data;
  assert.deepEqual(info.plans.map((p) => [p.id, p.price_cents]), [['basico', 4990], ['essencial', 9990], ['profissional', 24990]], 'sem plano grátis à venda');
});

test('buscas no Google Maps: Básico 10, Essencial 30 e Profissional 50 por mês', async () => {
  resetLoginAttempts();
  const u = browser();
  assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Busca Free', name: 'Bia', email: 'bia@free.com', password: 'senhaforte1', segment: 'loja' } })).status, 200);
  const { config } = await import('../src/config.js');
  const platformKey = config.googlePlacesKey;
  config.googlePlacesKey = 'chave-places-da-plataforma';
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
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 10, used: 0, period: 'month' });
    // Sem credenciais do Google Cloud, a opção do Google Agenda nem aparece para o cliente.
    assert.equal((await u('/api/meta')).data.google_calendar, Boolean(config.googleClientId && config.googleClientSecret));
    for (let i = 0; i < 10; i++) assert.equal((await u('/api/prospecting/search', { method: 'POST', body: { query: `pet shop ${i}` } })).status, 200);
    const blocked = await u('/api/prospecting/search', { method: 'POST', body: { query: 'pet shop 11' } });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /10 buscas deste mês do plano Básico.*Essencial são 30/);
    assert.equal(googleCalls, 10); // a 11ª nem chega ao Google
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 10, used: 10, period: 'month' });
    assert.equal((await u('/api/prospecting/searches')).data.length, 10); // as anteriores continuam abertas

    // Assinou o Essencial: 30 por mês pela chave da plataforma (as do Básico contam no mês em que foram feitas).
    const a = await adminSession();
    const company = (await a('/api/admin/companies')).data.find((c) => c.name === 'Busca Free');
    assert.equal((await a(`/api/admin/companies/${company.id}`, { method: 'PUT', body: { plan: 'essencial' } })).status, 200);
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 30, used: 10, period: 'month' });
    for (let i = 10; i < 30; i++) assert.equal((await u('/api/prospecting/search', { method: 'POST', body: { query: `pet shop ${i}` } })).status, 200);
    const monthBlocked = await u('/api/prospecting/search', { method: 'POST', body: { query: 'pet shop 31' } });
    assert.equal(monthBlocked.status, 400);
    assert.match(monthBlocked.data.error, /30 buscas deste mês.*renovam no dia 1º.*Profissional são 50/);
    // Busca do mês passado não conta.
    mainDb.prepare("UPDATE prospect_searches SET created_at = '2000-01-01T00:00:00.000Z' WHERE company_id = ?").run(company.id);
    assert.equal((await u('/api/meta')).data.prospecting_searches.used, 0);
    // Profissional: 50 por mês.
    assert.equal((await a(`/api/admin/companies/${company.id}`, { method: 'PUT', body: { plan: 'profissional' } })).status, 200);
    assert.deepEqual((await u('/api/meta')).data.prospecting_searches, { max: 50, used: 0, period: 'month' });
    // Com chave própria do Google o custo é da empresa: plano pago sem limite.
    await u('/api/settings', { method: 'PUT', body: { settings: { integrations: { google_places_key: 'chave-propria' } } } });
    assert.equal((await u('/api/meta')).data.prospecting_searches, null);
  } finally {
    config.googlePlacesKey = platformKey;
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

test('teste encerrado: só leitura (vê tudo, não edita), IA e envios parados; assinar destrava', async () => {
  const { config } = await import('../src/config.js');
  const { setClientFactory } = await import('../src/services/ai.js');
  const { all } = await import('../src/db.js');
  const { processCourtesies } = await import('../src/services/subscriptions.js');
  const calls = [];
  setClientFactory(() => ({ beta: { messages: { create: async () => { calls.push(1); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }] }; } } } }));
  config.platformPixKey = '123e4567-e89b-42d3-a456-426614174000';
  config.platformPixName = 'Fulano de Tal';
  config.platformPixCity = 'SAO PAULO';
  try {
    const u = browser();
    assert.equal((await u('/api/auth/register', { method: 'POST', body: { companyName: 'Iota', name: 'Ivo', email: 'ivo@iota.com', password: 'senhaforte1' } })).status, 200);
    const contact = (await u('/api/contacts', { method: 'POST', body: { name: 'Cliente Antigo', phone: '11933330009' } })).data;
    // Passaram os 7 dias: o agendador encerra o teste.
    const { id } = (await u('/api/auth/me')).data.company;
    mainDb.prepare("UPDATE companies SET courtesy_until = '2000-01-01' WHERE id = ?").run(id);
    processCourtesies();
    const meta = (await u('/api/meta')).data;
    assert.deepEqual([meta.plan.id, meta.expired, meta.ai_locked, meta.subscription.state], ['gratis', true, true, 'gratis']);

    // Vê tudo…
    assert.equal((await u('/api/contacts')).status, 200);
    assert.equal((await u(`/api/contacts/${contact.id}`)).data.name, 'Cliente Antigo');
    // …mas não edita, altera nem cadastra.
    const blocked = await u('/api/contacts', { method: 'POST', body: { name: 'Novo', phone: '11933330010' } });
    assert.equal(blocked.status, 402);
    assert.match(blocked.data.error, /teste grátis terminou.*assinar/);
    assert.equal((await u(`/api/contacts/${contact.id}`, { method: 'PUT', body: { name: 'Outro nome' } })).status, 402);
    assert.equal((await u(`/api/contacts/${contact.id}`, { method: 'DELETE' })).status, 402);
    assert.equal((await u('/api/settings', { method: 'PUT', body: { name: 'X' } })).status, 402);
    assert.equal((await u(`/api/conversations/${contact.id}/messages`, { method: 'POST', body: { body: 'Olá!' } })).status, 402);
    // Assinar, promoções e sair continuam liberados.
    assert.equal((await u('/api/referral')).status, 200);
    assert.equal((await u('/api/upgrade/notify', { method: 'POST', body: { plan: 'basico' } })).status, 200);

    // Mensagem do cliente ainda chega (nada se perde), mas ninguém responde.
    await u('/api/simulator/inbound', { method: 'POST', body: { phone: '11933330001', text: 'Quanto custa?' } }).catch(() => {});
    const { handleInbound } = await import('../src/services/messaging.js');
    const { withCompanyDb } = await import('../src/db.js');
    const r = withCompanyDb(id, () => handleInbound(id, { phone: '11933330002', name: 'Cli', text: 'Oi', providerId: 'exp1' }));
    await new Promise((ok) => setTimeout(ok, 60));
    assert.equal(all("SELECT COUNT(*) AS n FROM messages WHERE contact_id = ? AND direction = 'out'", r.contact.id)[0].n, 0);
    assert.equal(calls.length, 0);

    // Paywall: Pix de cada plano, com a chave da plataforma e o identificador da empresa.
    const up = (await u('/api/upgrade')).data;
    assert.equal(up.expired, true);
    assert.deepEqual(up.plans.map((p) => [p.id, p.price_cents]), [['basico', 4990], ['essencial', 9990], ['profissional', 24990]]);
    assert.match(up.txid, /^CONVERSA[A-Za-z0-9]+$/);
    const basico = up.plans.find((p) => p.id === 'basico').pix_code;
    assert.ok(basico.includes('123e4567-e89b-42d3-a456-426614174000'));
    assert.ok(basico.includes('540549.90'));
    assert.ok(up.plans.find((p) => p.id === 'profissional').pix_code.includes('5406249.90'));
    assert.ok(basico.includes(up.txid));
    assert.equal(up.plans.find((p) => p.recommended).id, 'essencial');
    const a = await adminSession();
    const log = (await a('/api/admin/audit')).data.find((x) => x.action === 'pedido de assinatura' && x.company_id === id);
    assert.ok(log.details.includes(up.txid));

    // Assinou (admin confirmou o Pix): volta a editar e a IA destrava.
    await a(`/api/admin/companies/${id}/activate-plan`, { method: 'POST', body: { plan: 'essencial' } });
    assert.deepEqual([(await u('/api/meta')).data.expired, (await u('/api/meta')).data.ai_locked], [false, false]);
    assert.equal((await u('/api/contacts', { method: 'POST', body: { name: 'Novo', phone: '11933330010' } })).status, 200);
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
  assert.equal(listed.plan, 'basico');
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
    assert.equal(b.get('line_items[0][price_data][unit_amount]'), '9990');
    assert.equal(b.get('line_items[0][price_data][currency]'), 'brl');
    assert.equal(b.get('line_items[0][price_data][recurring][interval]'), 'month');
    assert.equal(b.get('subscription_data[metadata][company_id]'), String(companyId));
    assert.equal(b.get('customer_email'), 'lia@lambda.com');

    // Webhook sem assinatura válida é recusado e não muda nada.
    assert.equal((await hook('checkout.session.completed', { metadata: { company_id: companyId, plan: 'essencial' } }, { secret: 'outro' })).status, 400);
    assert.equal((await u('/api/meta')).data.plan.id, 'basico');

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
  assert.equal(after.received.by_method.pix - before.received.by_method.pix, 49980);
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
    assert.equal(b.get('line_items[0][price_data][unit_amount]'), '24990');
    assert.equal(b.get('metadata[kind]'), 'pix_month');

    const session = (sid, status = 'paid') => ({ object: 'checkout.session', id: sid, mode: 'payment', payment_status: status, amount_total: 24900, customer: 'cus_pix', metadata: { company_id: String(id), plan: 'profissional', kind: 'pix_month' } });
    // Ainda não pago: nada muda.
    assert.equal((await hook('checkout.session.completed', session('cs_a', 'unpaid'))).pending, true);
    assert.equal((await u('/api/meta')).data.plan.id, 'basico');
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
    assert.equal(update.get('items[0][price_data][unit_amount]'), '24990');
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

  // Não dá para esconder os Primeiros passos: a rota não existe mais, a tela não tem o botão, e quem
  // tinha escondido antes volta a ver até completar.
  assert.equal((await u('/api/onboarding/dismiss', { method: 'POST' })).status, 404);
  const appJs = await (await fetch(`${base}/app.js`)).text();
  assert.ok(!appJs.includes('hide-onboarding') && !appJs.includes('Esconder por enquanto'));
  const { markOnboarding } = await import('../src/services/onboarding.js');
  markOnboarding((await u('/api/auth/me')).data.company.id, { dismissed: true });
  assert.equal((await u('/api/onboarding')).data.dismissed, false);

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
    // Guarda por qual conexão saiu cada texto (a IA também pode responder no meio do teste).
    if (path.startsWith('/message/sendText/')) sends.push({ inst: decodeURIComponent(path.split('/').pop()), text: JSON.parse(init.body || '{}').text });
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
    const via = (text) => sends.find((x) => x.text === text)?.inst;
    assert.match(via('Olá do financeiro'), new RegExp(`-n${fin.id}$`));
    assert.doesNotMatch(via('Olá do principal'), /-n\d+$/);
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

test('mídias do WhatsApp: foto, áudio e documento aparecem na conversa; grande demais, falha e mensagens antigas', async () => {
  const { config } = await import('../src/config.js');
  const { setEvolutionFetch } = await import('../src/services/whatsapp-connect.js');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const asked = [];
  let mediaFails = false;
  setEvolutionFetch(async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/chat/getBase64FromMediaMessage/')) {
      const req = JSON.parse(init.body);
      asked.push(req.message.key.id);
      if (mediaFails) return { ok: false, status: 400, json: async () => ({ response: { message: ['mídia expirada'] } }) };
      const kind = req.message.message?.audioMessage ? { mimetype: 'audio/ogg; codecs=opus' } : req.message.message?.documentWithCaptionMessage ? { mimetype: 'application/pdf' } : { mimetype: 'image/png' };
      return { ok: true, status: 200, json: async () => ({ base64: PNG.toString('base64'), ...kind }) };
    }
    const data = path === '/instance/create' ? { hash: 'tok-media' } : path.startsWith('/instance/connectionState') ? { instance: { state: 'open' } }
      : path.startsWith('/instance/connect') ? { base64: 'QR' } : { ok: true };
    return { ok: true, status: 200, json: async () => data };
  });
  config.evolutionUrl = 'https://evo.conversacrm.test';
  config.evolutionApiKey = 'chave-global';
  try {
    resetLoginAttempts();
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Foto Ltda', name: 'Fá', email: 'fa@foto.com', password: 'senhaforte1' } });
    // O cadastro começa no teste do Básico, com IA: desliga a resposta automática para conferir só o que chegou.
    await u('/api/settings', { method: 'PUT', body: { settings: { ai: { enabled: false } } } });
    await u('/api/whatsapp/connect', { method: 'POST' });
    const hook = new URL((await u('/api/meta')).data.webhooks.evolution);
    const post = (data) => fetch(base + hook.pathname + hook.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'messages.upsert', data }) });
    await post({ key: { remoteJid: '5511966660000@s.whatsapp.net', fromMe: false, id: 'state' }, message: {} });
    await fetch(base + hook.pathname + hook.search, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'connection.update', data: { state: 'open' } }) });
    const key = (id) => ({ remoteJid: '5511966660001@s.whatsapp.net', fromMe: false, id });
    await post({ key: key('img1'), pushName: 'Cliente Foto', message: { imageMessage: { mimetype: 'image/jpeg', caption: 'Segue o comprovante', fileLength: '68' }, messageContextInfo: {} } });
    await post({ key: key('aud1'), message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: { low: 5000, high: 0 } } } });
    await post({ key: key('doc1'), message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'contrato.pdf', fileLength: 2048 } } } } });
    await post({ key: key('vid1'), message: { videoMessage: { mimetype: 'video/mp4', fileLength: String(50 * 1024 * 1024) } } });
    await post({ key: key('reac1'), message: { reactionMessage: { text: '👍' } } });
    await post({ key: key('loc1'), message: { locationMessage: { degreesLatitude: -23.5 } } });

    const conv = (await u('/api/conversations')).data.find((c) => c.phone === '5511966660001');
    let msgs = [];
    for (let i = 0; i < 50; i++) {
      msgs = (await u(`/api/conversations/${conv.id}/messages`)).data.messages;
      if (!msgs.some((m) => m.media_status === 'pending')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const by = (pid) => msgs.find((m) => m.provider_id === pid);
    assert.equal(msgs.length, 5, 'a reação não vira mensagem');
    assert.deepEqual([by('img1').body, by('img1').media_type, by('img1').media_status], ['Segue o comprovante', 'image', 'ok']);
    assert.deepEqual([by('aud1').body, by('aud1').media_status], ['🎤 Áudio', 'ok']);
    assert.deepEqual([by('doc1').body, by('doc1').media_name, by('doc1').media_status], ['📄 contrato.pdf', 'contrato.pdf', 'ok']);
    assert.equal(by('vid1').media_status, 'too_big');
    assert.ok(!asked.includes('vid1'), 'vídeo grande demais nem é baixado');
    assert.equal(by('loc1').body, '📍 Localização');

    // O arquivo abre para a equipe, com o tipo certo; documento é sempre baixado.
    const cookie = async () => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fa@foto.com', password: 'senhaforte1' }) });
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    };
    const ck = await cookie();
    const img = await fetch(`${base}/api/messages/${by('img1').id}/media`, { headers: { cookie: ck } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    const doc = await fetch(`${base}/api/messages/${by('doc1').id}/media`, { headers: { cookie: ck } });
    assert.match(doc.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''contrato\.pdf/);
    assert.equal((await fetch(`${base}/api/messages/${by('img1').id}/media`)).status, 401);

    // Outra empresa não abre o arquivo desta.
    const other = browser();
    await other('/api/auth/register', { method: 'POST', body: { companyName: 'Outra Foto', name: 'Ou', email: 'ou@foto.com', password: 'senhaforte1' } });
    assert.equal((await other(`/api/messages/${by('img1').id}/media`)).status, 404);
    assert.equal((await other(`/api/messages/${by('img1').id}/media/retry`, { method: 'POST' })).status, 404);

    // Falhou ao baixar: fica "não foi possível baixar" e dá para tentar de novo.
    mediaFails = true;
    await post({ key: key('img2'), message: { imageMessage: { mimetype: 'image/jpeg' } } });
    let failed;
    for (let i = 0; i < 50; i++) {
      failed = (await u(`/api/conversations/${conv.id}/messages`)).data.messages.find((m) => m.provider_id === 'img2');
      if (failed?.media_status !== 'pending') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual([failed.body, failed.media_status], ['📷 Foto', 'failed']);
    mediaFails = false;
    assert.equal((await u(`/api/messages/${failed.id}/media/retry`, { method: 'POST' })).data.media_status, 'ok');

    // Mensagem antiga ("[imageMessage recebido]"): aparece como foto para baixar e converte ao tentar.
    const { id: companyId } = (await u('/api/auth/me')).data.company;
    mainDb.prepare("INSERT INTO messages (company_id, contact_id, direction, author, body, status, provider_id) VALUES (?, ?, 'in', 'contact', '[imageMessage recebido]', 'received', 'old1')").run(companyId, conv.id);
    mainDb.prepare("INSERT INTO messages (company_id, contact_id, direction, author, body, status, provider_id) VALUES (?, ?, 'in', 'contact', '[contactMessage recebido]', 'received', 'old2')").run(companyId, conv.id);
    const list = (await u(`/api/conversations/${conv.id}/messages`)).data.messages;
    const old = list.find((m) => m.provider_id === 'old1');
    assert.deepEqual([old.body, old.media_type, old.media_status], ['📷 Foto', 'image', 'failed']);
    assert.equal(list.find((m) => m.provider_id === 'old2').body, '👤 Contato');
    assert.equal((await u('/api/conversations')).data.find((c) => c.id === conv.id).last_body, '👤 Contato');
    const fixed = (await u(`/api/messages/${old.id}/media/retry`, { method: 'POST' })).data;
    assert.deepEqual([fixed.body, fixed.media_status], ['📷 Foto', 'ok']);
    assert.ok(asked.includes('old1'));

    // Exclusão do contato leva os arquivos junto.
    await u(`/api/contacts/${conv.id}`, { method: 'DELETE' });
    assert.equal(mainDb.prepare('SELECT COUNT(*) AS n FROM message_media WHERE company_id = ?').get(companyId).n, 0);
  } finally {
    config.evolutionUrl = '';
    config.evolutionApiKey = '';
  }
});

test('processos (advocacia): OAB e número CNJ, histórico sem alerta, intimação nova avisa no WhatsApp, limite e isolamento', async () => {
  const legal = await import('../src/services/legal.js');
  // Número CNJ válido a partir dos outros campos (dígito verificador módulo 97).
  const cnjOf = (n, year = '2025', j = '8', tr = '02', origin = '0001') => {
    const dd = String(98n - (BigInt(`${n}${year}${j}${tr}${origin}00`) % 97n)).padStart(2, '0');
    return `${n}-${dd}.${year}.${j}.${tr}.${origin}`;
  };
  const CASE = '0729219-51.2021.8.02.0001';
  const CASE_D = '07292195120218020001';
  const OTHER_D = cnjOf('0700001').replace(/\D/g, '');
  const pub = (id, cnj, tipo, texto, date = '2026-10-10') => ({ id, numero_processo: cnj, data_disponibilizacao: date, siglaTribunal: 'TJAL', tipoComunicacao: tipo, nomeOrgao: '3ª Vara Cível da Capital', texto, link: 'https://www2.tjal.jus.br', ativo: true });
  let oabItems = [pub(1, CASE_D, 'Intimação', 'Processo antigo - Fica intimada a parte.')];
  let caseItems = [pub(2, CASE_D, 'Intimação', 'Publicação antiga do processo.')];
  let movements = [{ codigo: 85, nome: 'Petição', dataHora: '2026-08-01T10:00:00.000Z' }];
  let updated = '2026-09-10T00:00:00Z';
  const calls = [];
  legal.setLegalFetch(async (url, init = {}) => {
    calls.push(url);
    if (url.startsWith('https://comunicaapi.pje.jus.br/')) {
      const q = new URL(url).searchParams;
      const items = q.get('numeroOab') ? oabItems : q.get('numeroProcesso') === CASE_D ? caseItems : [];
      return new Response(JSON.stringify({ status: 'success', count: items.length, items: q.get('pagina') === '1' ? items : [] }), { status: 200 });
    }
    assert.match(init.headers.Authorization, /^APIKey /);
    assert.ok(url.endsWith('/api_publica_tjal/_search'));
    return new Response(JSON.stringify({ hits: { hits: [{ _source: { grau: 'G1', tribunal: 'TJAL', classe: { nome: 'Procedimento Comum Cível' }, orgaoJulgador: { nome: '3ª Vara Cível' }, assuntos: [{ nome: 'Indenização' }], dataHoraUltimaAtualizacao: updated, movimentos: movements } }] } }), { status: 200 });
  });
  const sent = [];
  legal.setLegalNotify(async (company, phone, text) => { sent.push({ phone, text }); });
  try {
    resetLoginAttempts();
    // Advocacia: o módulo aparece sozinho. Outro segmento: escondido até ligar.
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Silva Advogados', name: 'Dra. Ana', email: 'ana@silva.adv', password: 'senhaforte1', segment: 'advocacia' } });
    assert.equal((await u('/api/meta')).data.processes_enabled, true);
    const loja = browser();
    await loja('/api/auth/register', { method: 'POST', body: { companyName: 'Loja Sem Processo', name: 'Lu', email: 'lu@loja.com', password: 'senhaforte1', segment: 'loja' } });
    assert.equal((await loja('/api/meta')).data.processes_enabled, false);
    assert.equal((await loja('/api/legal/overview')).status, 404);

    // Número errado e tribunal detectado.
    assert.match((await u('/api/legal/check-cnj', { method: 'POST', body: { cnj: '0729219-52.2021.8.02.0001' } })).data.error, /dígito verificador/);
    assert.deepEqual((await u('/api/legal/check-cnj', { method: 'POST', body: { cnj: '07292195120218020001' } })).data, { cnj: CASE_D, masked: CASE, court: 'TJAL', alias: 'tjal' });
    assert.equal((await u('/api/legal/check-cnj', { method: 'POST', body: { cnj: '123' } })).status, 400);

    // OAB e processo: o histórico entra sem alerta.
    const client = (await u('/api/contacts', { method: 'POST', body: { name: 'Maria Cliente', phone: '82999990000' } })).data;
    const oab = (await u('/api/legal/oabs', { method: 'POST', body: { name: 'Dra. Ana', oab_number: '012345', oab_uf: 'al', phone: '(82) 98888-7777' } })).data;
    assert.deepEqual([oab.oab_number, oab.oab_uf, oab.phone], ['12345', 'AL', '82988887777']);
    assert.match((await u('/api/legal/oabs', { method: 'POST', body: { name: 'Outro', oab_number: '999', oab_uf: 'SP' } })).data.error, /1 OAB/, 'teste grátis: 1 usuário, 1 OAB');
    const c = (await u('/api/legal/cases', { method: 'POST', body: { cnj: CASE, label: 'Indenização — Maria', contact_id: client.id, oab_id: oab.id } })).data;
    assert.equal(c.court, 'TJAL');
    assert.equal((await u('/api/legal/cases', { method: 'POST', body: { cnj: CASE } })).data.error, 'Este processo já está cadastrado.');
    await legal.monitorOnce();
    let detail = (await u(`/api/legal/cases/${c.id}`)).data;
    assert.equal(detail.baseline_done, 1);
    assert.deepEqual([detail.class_name, detail.court_unit, detail.subjects], ['Procedimento Comum Cível', '3ª Vara Cível', 'Indenização']);
    assert.equal(detail.events.length, 3, 'as duas publicações antigas e a movimentação');
    assert.ok(detail.events.every((e) => e.baseline === 1));
    assert.equal(sent.length, 0, 'histórico não gera alerta');
    assert.equal((await u('/api/legal/overview')).data.news.length, 0);

    // Saiu uma intimação nova na OAB (com prazo) e outra de um processo que não está cadastrado.
    oabItems = [...oabItems,
      pub(3, CASE_D, 'Intimação', 'Processo 0729219-51.2021.8.02.0001 - Fica a parte autora intimada para, no prazo de 15 (quinze) dias úteis, se manifestar.', '2026-10-19'),
      pub(4, OTHER_D, 'Intimação', 'Fica intimado o advogado.', '2026-10-19'),
      { ...pub(5, OTHER_D, 'Intimação', 'Cancelada'), ativo: false }];
    mainDb.prepare("UPDATE legal_oabs SET checked_at = '2000-01-01T00:00:00Z'").run();
    await legal.monitorOnce();
    const news = (await u('/api/legal/overview')).data;
    assert.equal(news.news.length, 2);
    const linked = news.news.find((n) => n.case_id === c.id);
    assert.deepEqual([linked.severity, linked.deadline_hint, linked.title], ['alta', '15 dias úteis', 'Intimação']);
    assert.deepEqual(news.unlinked.map((x) => x.cnj), [OTHER_D]);
    assert.equal(news.unread, 2);
    assert.equal((await u('/api/meta')).data.legal_unread, 2);
    assert.equal(sent.length, 2, 'intimação é urgente: sai na hora');
    assert.ok(sent.every((s) => s.phone === '82988887777'));
    const msg = sent.find((s) => s.text.includes('Indenização — Maria')).text;
    assert.match(msg, /Intimação publicada no Diário/);
    assert.match(msg, /Prazo mencionado: 15 dias úteis\. Confira a contagem/);
    assert.match(msg, new RegExp(`#/processos/${c.id}`));
    // A mesma intimação vista de novo (pelo número do processo) não duplica nem avisa outra vez.
    caseItems = [...caseItems, oabItems[1]];
    mainDb.prepare('UPDATE legal_cases SET djen_checked_at = NULL').run();
    await legal.monitorOnce();
    assert.equal(sent.length, 2);
    assert.equal((await u(`/api/legal/cases/${c.id}`)).data.events.filter((e) => e.kind === 'publication').length, 3);

    // Movimentação comum no tribunal: vai para o resumo diário, não na hora.
    movements = [...movements, { codigo: 581, nome: 'Juntada', dataHora: '2026-10-01T10:00:00.000Z', complementosTabelados: [{ nome: 'Petição' }] }];
    updated = '2026-10-15T00:00:00Z';
    mainDb.prepare('UPDATE legal_cases SET djen_checked_at = NULL').run();
    await legal.monitorOnce();
    assert.equal(sent.length, 2);
    assert.equal(await legal.sendDigests(true), 1);
    assert.match(sent.at(-1).text, /Resumo do dia nos processos\* \(1 novidade\)\n• Indenização — Maria · 0729219-51\.2021\.8\.02\.0001 \(TJAL\): Juntada · Petição/);
    assert.equal(await legal.sendDigests(true), 0, 'cada novidade vai uma vez só');

    // Abrir o processo marca como lido; ficha do cliente lista o processo.
    await u('/api/legal/read', { method: 'POST', body: { case_id: c.id } });
    assert.equal((await u('/api/legal/overview')).data.unread, 1);
    assert.deepEqual((await u(`/api/legal/cases?contact_id=${client.id}`)).data.map((x) => x.id), [c.id]);

    // Limite do Básico: 10 processos.
    for (let n = 2; n <= 10; n++) assert.equal((await u('/api/legal/cases', { method: 'POST', body: { cnj: cnjOf(`07000${String(n).padStart(2, '0')}`) } })).status, 200);
    const over = await u('/api/legal/cases', { method: 'POST', body: { cnj: cnjOf('0700011') } });
    assert.equal(over.status, 400);
    assert.match(over.data.error, /até 10 processos.*Essencial são 20/);

    // Outra empresa (com o módulo ligado) não vê nada desta.
    // Fora da Advocacia, o dono não liga sozinho: só o administrador libera.
    await loja('/api/settings', { method: 'PUT', body: { settings: { modules: { processes: true } } } });
    assert.equal((await loja('/api/meta')).data.processes_enabled, false);
    const adm = await adminSession();
    const lojaId = (await loja('/api/auth/me')).data.company.id;
    assert.equal((await adm(`/api/admin/companies/${lojaId}`, { method: 'PUT', body: { processes_module: true } })).data.processes_module, true);
    assert.equal((await loja('/api/meta')).data.processes_enabled, true);
    assert.equal((await loja(`/api/legal/cases/${c.id}`)).status, 404);
    assert.equal((await loja(`/api/legal/events/${linked.id}`)).status, 404);
    assert.deepEqual((await loja('/api/legal/overview')).data.cases, []);
    assert.equal((await loja(`/api/legal/cases/${c.id}`, { method: 'DELETE' })).data.ok, false);

    // Remover o processo: movimentações saem; a intimação da OAB continua, como "sem processo".
    assert.equal((await u(`/api/legal/cases/${c.id}`, { method: 'DELETE' })).data.ok, true);
    const after = (await u('/api/legal/overview')).data;
    assert.ok(after.unlinked.some((x) => x.cnj === CASE_D));
    assert.ok(calls.every((x) => !x.includes('undefined')));
  } finally {
    legal.setLegalFetch((...a) => fetch(...a));
  }
});

test('indique e ganhe: código por usuário, 30 dias para quem chega, +1 mês para quem indicou no 1º pagamento, tudo visível no admin', async () => {
  const { todayIn, addDays } = await import('../src/services/time.js');
  const { addMonths } = await import('../src/services/subscriptions.js');
  const today = todayIn('America/Sao_Paulo');
  resetLoginAttempts();
  const a = await adminSession();
  // Empresa que indica, com dois usuários: cada um tem o próprio código.
  const dona = browser();
  await dona('/api/auth/register', { method: 'POST', body: { companyName: 'Clínica Sorriso', name: 'Marina Dona', email: 'marina@sorriso.com', password: 'senhaforte1' } });
  const sorrisoId = (await dona('/api/auth/me')).data.company.id;
  await a(`/api/admin/companies/${sorrisoId}/activate-plan`, { method: 'POST', body: { plan: 'essencial' } });
  await dona('/api/users', { method: 'POST', body: { name: 'Bruno Atendente', email: 'bruno@sorriso.com', password: 'senhaforte1', role: 'agent' } });
  const bruno = (await userSession('bruno@sorriso.com', 'senhaforte1')).u;
  const codeA = (await dona('/api/referral')).data.code;
  const ref = (await bruno('/api/referral')).data;
  assert.match(codeA, /^MARINA-[A-Z2-9]{4}$/);
  assert.match(ref.code, /^BRUNO-[A-Z2-9]{4}$/);
  assert.notEqual(codeA, ref.code);
  assert.equal(ref.link, `${(await import('../src/config.js')).config.publicUrl}/?ref=${ref.code}`);
  assert.match(ref.message, new RegExp(`acredito que você deveria conhecer.*${ref.code}.*1 mês grátis`));
  assert.equal((await bruno('/api/referral')).data.code, ref.code, 'o código não muda');

  // Página inicial com o código: mostra só o primeiro nome de quem indicou.
  assert.deepEqual((await browser()(`/api/public/referral/${ref.code.toLowerCase()}`)).data, { valid: true, code: ref.code, by: 'Bruno' });
  assert.equal((await browser()('/api/public/referral/XXXX-0000')).data.valid, false);

  // Cadastro com o código do Bruno: 30 dias de teste, ligado ao Bruno e à Clínica Sorriso.
  const novo = browser();
  await novo('/api/auth/register', { method: 'POST', body: { companyName: 'Pet Feliz', name: 'Paula', email: 'paula@pet.com', password: 'senhaforte1', ref: ref.code.replace('-', '') } });
  const sub = (await novo('/api/meta')).data.subscription;
  assert.deepEqual([sub.state, sub.courtesy_until, sub.referral], ['teste', addDays(today, 30), true]);
  const petId = (await novo('/api/auth/me')).data.company.id;
  assert.equal((await novo('/api/referral')).data.can_redeem, false, 'quem já veio indicado não usa outro código');

  // Sem código no cadastro, dá para usar um depois (ainda no teste): vira 30 dias do cadastro.
  const tardio = browser();
  await tardio('/api/auth/register', { method: 'POST', body: { companyName: 'Loja Tardia', name: 'Téo', email: 'teo@tardia.com', password: 'senhaforte1' } });
  assert.equal((await tardio('/api/meta')).data.subscription.courtesy_until, addDays(today, 7));
  assert.match((await tardio('/api/referral/redeem', { method: 'POST', body: { code: (await tardio('/api/referral')).data.code } })).data.error, /própria empresa/);
  assert.equal((await tardio('/api/referral/redeem', { method: 'POST', body: { code: codeA } })).status, 200);
  assert.equal((await tardio('/api/meta')).data.subscription.courtesy_until, addDays(today, 30));
  assert.match((await tardio('/api/referral/redeem', { method: 'POST', body: { code: ref.code } })).data.error, /já usou/);

  // Indicação ainda não paga: ninguém ganhou nada.
  const before = (await a(`/api/admin/companies/${sorrisoId}`)).data.subscription.paid_until;
  let sorriso = (await dona('/api/referral')).data;
  assert.deepEqual([sorriso.invited, sorriso.converted, sorriso.months_earned], [2, 0, 0]);
  assert.deepEqual((await bruno('/api/referral')).data.mine, { invited: 1, converted: 0 });

  // A Pet Feliz pagou o primeiro mês: a Clínica Sorriso (Pix) ganha +1 mês pago, uma vez só.
  await a(`/api/admin/companies/${petId}/activate-plan`, { method: 'POST', body: { plan: 'basico' } });
  assert.equal((await a(`/api/admin/companies/${sorrisoId}`)).data.subscription.paid_until, addMonths(before, 1));
  await a(`/api/admin/companies/${petId}/activate-plan`, { method: 'POST', body: { plan: 'basico' } });
  assert.equal((await a(`/api/admin/companies/${sorrisoId}`)).data.subscription.paid_until, addMonths(before, 1), 'só no primeiro pagamento');
  sorriso = (await dona('/api/referral')).data;
  assert.deepEqual([sorriso.converted, sorriso.months_earned], [1, 1]);
  assert.deepEqual(sorriso.people.find((p) => p.name === 'Pet Feliz'), { name: 'Pet Feliz', since: sorriso.people.find((p) => p.name === 'Pet Feliz').since, paid: true, by: 'Bruno Atendente' });

  // Admin: qual código, de qual usuário e de qual empresa trouxe cada cadastro.
  const adm = (await a('/api/admin/referrals')).data;
  const pet = adm.list.find((x) => x.name === 'Pet Feliz');
  assert.deepEqual([pet.code, pet.by_user, pet.by_email, pet.by_company, Boolean(pet.referral_rewarded_at)], [ref.code, 'Bruno Atendente', 'bruno@sorriso.com', 'Clínica Sorriso', true]);
  assert.equal(adm.list.find((x) => x.name === 'Loja Tardia').by_user, 'Marina Dona');
  const rank = adm.ranking.find((x) => x.user === 'Bruno Atendente');
  assert.deepEqual([rank.company, rank.invited, rank.paid], ['Clínica Sorriso', 1, 1]);
  assert.ok((await a('/api/admin/audit')).data.some((x) => x.action === 'prêmio de indicação' && x.company_id === sorrisoId && x.details.includes('Bruno Atendente') && x.details.includes(ref.code)));

  // Quem indicou ainda está no teste: ganha +30 dias no teste.
  const t2 = browser();
  await t2('/api/auth/register', { method: 'POST', body: { companyName: 'Indicada da Tardia', name: 'Ana', email: 'ana@indicada.com', password: 'senhaforte1', ref: (await tardio('/api/referral')).data.code } });
  const t2Id = (await t2('/api/auth/me')).data.company.id;
  await a(`/api/admin/companies/${t2Id}/activate-plan`, { method: 'POST', body: { plan: 'basico' } });
  assert.equal((await tardio('/api/meta')).data.subscription.courtesy_until, addDays(addDays(today, 30), 30));
});

test('MEI: envia o certificado, cai no admin (e no WhatsApp), admin aprova e o Básico fica grátis sem prazo', async () => {
  const { config } = await import('../src/config.js');
  const { setPlatformNotify } = await import('../src/services/platform.js');
  const pings = [];
  setPlatformNotify(async (company, phone, text) => { pings.push({ company: company.name, phone, text }); });
  config.salesWhatsapp = '5511999990000';
  try {
    resetLoginAttempts();
    const a = await adminSession();
    // A conta do próprio administrador no Conversa CRM (mesmo e-mail) é quem envia o aviso.
    const plataforma = browser();
    await plataforma('/api/auth/register', { method: 'POST', body: { companyName: 'Conversa CRM (plataforma)', name: 'Neto', email: 'admin@plataforma.com', password: 'senhaforte1' } });
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Doces da Lu', name: 'Lu', email: 'lu@doces.com', password: 'senhaforte1' } });
    const pdf = Buffer.from('%PDF-1.4 certificado MEI').toString('base64');
    assert.match((await u('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-80', file_name: 'ccmei.pdf', mime: 'application/pdf', data_base64: pdf } })).data.error, /CNPJ inválido/);
    assert.match((await u('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-81', file_name: 'x.exe', mime: 'application/x-msdownload', data_base64: pdf } })).data.error, /PDF, JPG ou PNG/);
    const sent = (await u('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-81', file_name: 'ccmei.pdf', mime: 'application/pdf', data_base64: pdf } })).data;
    assert.deepEqual([sent.status, sent.cnpj], ['pendente', '11.222.333/0001-81']);
    assert.match((await u('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-81', file_name: 'ccmei.pdf', mime: 'application/pdf', data_base64: pdf } })).data.error, /já está em análise/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pings.length, 1);
    assert.deepEqual([pings[0].company, pings[0].phone], ['Conversa CRM (plataforma)', '5511999990000']);
    assert.match(pings[0].text, /Pedido de MEI[\s\S]*Doces da Lu[\s\S]*11\.222\.333\/0001-81[\s\S]*lu@doces\.com[\s\S]*\/admin#mei/);

    // Admin vê o pedido, abre o certificado e aprova.
    const list = (await a('/api/admin/mei')).data;
    const req = list.find((x) => x.company_name === 'Doces da Lu');
    assert.equal(req.status, 'pendente');
    assert.ok(!('data' in req), 'a lista não carrega o arquivo');
    const cookie = await (async () => { const r = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@plataforma.com', password: 'admin12345' }) }); return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '); })();
    const file = await fetch(`${base}/api/admin/mei/${req.id}/file`, { headers: { cookie } });
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF-1.4 certificado MEI');
    assert.equal((await fetch(`${base}/api/admin/mei/${req.id}/file`)).status, 401);
    assert.equal((await u(`/api/admin/mei/${req.id}/file`)).status, 401, 'a empresa não acessa o painel');
    assert.equal((await a(`/api/admin/mei/${req.id}/decide`, { method: 'POST', body: { approve: true } })).data.status, 'aprovado');
    const meta = (await u('/api/meta')).data;
    assert.deepEqual([meta.plan.id, meta.subscription.state, meta.subscription.courtesy_until, meta.subscription.courtesy_reason], ['basico', 'cortesia', null, 'MEI: plano Básico grátis']);
    assert.equal((await u('/api/mei')).data.status, 'aprovado');
    assert.match((await u('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-81', file_name: 'ccmei.pdf', mime: 'application/pdf', data_base64: pdf } })).data.error, /já tem o plano Básico grátis/);

    // Recusa exige motivo, que a empresa vê.
    const v = browser();
    await v('/api/auth/register', { method: 'POST', body: { companyName: 'Não é MEI', name: 'Vi', email: 'vi@ltda.com', password: 'senhaforte1' } });
    await v('/api/mei', { method: 'POST', body: { cnpj: '11.222.333/0001-81', file_name: 'c.png', mime: 'image/png', data_base64: pdf } });
    const r2 = (await a('/api/admin/mei')).data.find((x) => x.company_name === 'Não é MEI');
    assert.equal((await a(`/api/admin/mei/${r2.id}/decide`, { method: 'POST', body: { approve: false } })).status, 400);
    await a(`/api/admin/mei/${r2.id}/decide`, { method: 'POST', body: { approve: false, note: 'O certificado é de uma LTDA, não de MEI.' } });
    assert.deepEqual([(await v('/api/mei')).data.status, (await v('/api/mei')).data.note], ['recusado', 'O certificado é de uma LTDA, não de MEI.']);
    assert.equal((await v('/api/meta')).data.subscription.state, 'teste');
  } finally {
    config.salesWhatsapp = '';
  }
});

test('medição: página inicial, cadastro e uso do sistema viram o relatório de inteligência do admin', async () => {
  resetLoginAttempts();
  const t = (body) => fetch(`${base}/api/t`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const vid = 'visitante-teste-1';
  // Visitante chega pelo Instagram, lê, rola, abre uma pergunta do FAQ e clica para começar.
  assert.equal((await t({ v: vid, s: 'sessao-teste-1', p: '/', src: 'instagram', d: 'mobile', e: [
    { k: 'pageview' }, { k: 'section', n: 'recursos', val: 8000 }, { k: 'section', n: 'planos', val: 12000 }, { k: 'scroll', val: 95 },
    { k: 'faq', n: 'Posso cancelar quando quiser?' }, { k: 'cta', n: 'Começar grátis (topo)' }, { k: 'time', val: 65000 }, { k: 'nao-existe' },
  ] })).n, 7, 'tipo desconhecido é ignorado');
  await t({ v: 'visitante-teste-2', s: 'sessao-teste-2', p: '/', d: 'desktop', e: [{ k: 'pageview' }, { k: 'section', n: 'recursos', val: 3000 }, { k: 'time', val: 15000 }] });
  assert.equal((await t({ v: 'x', e: [{ k: 'pageview' }] })).n, 0, 'identificador inválido');
  // Cadastro do mesmo visitante: a empresa fica ligada à origem.
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Studio Medido', name: 'Mel', email: 'mel@studio.com', password: 'senhaforte1', vid, src: 'instagram' } });
  const id = (await u('/api/auth/me')).data.company.id;
  assert.deepEqual(Object.values(mainDb.prepare('SELECT signup_visitor, signup_source FROM companies WHERE id = ?').get(id)), [vid, 'instagram']);
  // No sistema: tempo em cada menu (enviado pela tela) e ações (registradas no servidor, com usuário e empresa).
  await u('/api/t', { method: 'POST', body: { v: vid, s: 'sessao-teste-3', e: [{ k: 'app_page', n: 'inbox', val: 120000 }, { k: 'app_page', n: 'agenda', val: 30000 }, { k: 'share', n: 'whatsapp' }] } });
  await u('/api/contacts', { method: 'POST', body: { name: 'Cliente Medido', phone: '11955550001' } });
  const feat = mainDb.prepare("SELECT * FROM analytics_events WHERE kind = 'feature' AND company_id = ?").all(id);
  assert.deepEqual(feat.map((f) => f.name), ['POST /api/contacts']);
  assert.ok(feat[0].user_id);
  assert.ok(mainDb.prepare("SELECT 1 FROM analytics_events WHERE kind = 'app_page' AND company_id = ? AND user_id IS NOT NULL").get(id));

  const a = await adminSession();
  const intel = (await a('/api/admin/intelligence?days=30')).data;
  assert.equal(intel.goal.target_cents, 1000000);
  assert.ok(intel.landing.visitors >= 2);
  assert.ok(intel.landing.faq.some((f) => f.name === 'Posso cancelar quando quiser?'));
  assert.ok(intel.landing.sources.some((s) => s.name === 'instagram'));
  assert.ok(intel.landing.sections.find((s) => s.id === 'planos').seen_percent > 0);
  assert.ok(intel.landing.devices.some((d) => d.name === 'Celular'));
  assert.ok(intel.menus.find((m) => m.id === 'inbox').minutes >= 2);
  assert.equal(intel.features.find((f) => f.name === 'POST /api/contacts').label, 'Cadastrou cliente/lead');
  assert.equal(intel.funnel.length, 6);
  assert.ok(intel.funnel.find((s) => s.step === 'Usaram de verdade').count >= 1);
  assert.ok(intel.referral.shares >= 1);
  assert.ok(intel.tips.length >= 1);
  assert.ok(intel.companies.find((c) => c.id === id).actions >= 1);
  // Só administrador vê.
  assert.equal((await u('/api/admin/intelligence')).status, 401);
});

test('teste A/B/C da chamada: a versão vista na página inicial separa visitas, planos, cliques e cadastros', async () => {
  resetLoginAttempts();
  const t = (body) => fetch(`${base}/api/t`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await t({ v: 'visitante-ab-a1', s: 'sessao-ab-a1', p: '/', e: [{ k: 'pageview', n: 'hero-a' }, { k: 'section', n: 'planos', val: 4000 }] });
  await t({ v: 'visitante-ab-a2', s: 'sessao-ab-a2', p: '/', e: [{ k: 'pageview', n: 'hero-a' }] });
  await t({ v: 'visitante-ab-b1', s: 'sessao-ab-b1', p: '/', e: [{ k: 'pageview', n: 'hero-b' }, { k: 'section', n: 'planos', val: 4000 }, { k: 'cta', n: 'Testar grátis (topo)' }] });
  // Volta de outro dia: continua contando para a versão que viu primeiro.
  await t({ v: 'visitante-ab-b1', s: 'sessao-ab-b2', p: '/', e: [{ k: 'pageview', n: 'hero-b' }] });
  await t({ v: 'visitante-ab-c1', s: 'sessao-ab-c1', p: '/', e: [{ k: 'pageview', n: 'hero-c' }, { k: 'cta', n: 'Testar grátis (final)' }] });
  // Conferência pelo ?v=c não entra na conta.
  await t({ v: 'visitante-ab-c2', s: 'sessao-ab-c2', p: '/', e: [{ k: 'pageview', n: 'preview-hero-c' }] });
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Studio AB', name: 'Bia', email: 'bia@studioab.com', password: 'senhaforte1', vid: 'visitante-ab-b1', src: 'direto' } });

  const a = await adminSession();
  const ab = Object.fromEntries((await a('/api/admin/intelligence?days=30')).data.hero_ab.map((h) => [h.variant, h]));
  assert.deepEqual([ab.A.visitors, ab.A.saw_plans, ab.A.signup_clicks, ab.A.signups], [2, 1, 0, 0]);
  assert.deepEqual([ab.B.visitors, ab.B.saw_plans, ab.B.signup_clicks, ab.B.signups, ab.B.paid], [1, 1, 1, 1, 0]);
  assert.deepEqual([ab.C.visitors, ab.C.saw_plans, ab.C.signup_clicks, ab.C.signups], [1, 0, 1, 0]);
});

test('fim do grátis antigo: contas no grátis ganham 30 dias do Básico, uma vez só', async () => {
  const { migrateFreeAccounts } = await import('../src/services/subscriptions.js');
  const { todayIn, addDays } = await import('../src/services/time.js');
  mainDb.prepare('DELETE FROM platform_state').run();
  const u = browser();
  await u('/api/auth/register', { method: 'POST', body: { companyName: 'Grátis Antigo', name: 'Gil', email: 'gil@antigo.com', password: 'senhaforte1' } });
  const id = (await u('/api/auth/me')).data.company.id;
  mainDb.prepare("UPDATE companies SET plan = 'gratis', courtesy_until = NULL, courtesy_reason = NULL WHERE id = ?").run(id);
  assert.ok(migrateFreeAccounts() >= 1);
  const sub = (await u('/api/meta')).data.subscription;
  assert.deepEqual([sub.state, sub.courtesy_until], ['teste', addDays(todayIn('America/Sao_Paulo'), 30)]);
  mainDb.prepare("UPDATE companies SET plan = 'gratis', courtesy_until = NULL, courtesy_reason = NULL WHERE id = ?").run(id);
  assert.equal(migrateFreeAccounts(), 0, 'só roda uma vez');
});

test('telas sempre na versão nova: HTML sem cache e arquivos com versão no endereço', async () => {
  for (const [page, script] of [['/app', 'app.js'], ['/admin', 'admin.js']]) {
    const res = await fetch(base + page);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    const m = html.match(new RegExp(`src="/${script.replace('.', '\\.')}\\?v=([0-9a-f]{10})"`));
    assert.ok(m, `${page} aponta para /${script}?v=…`);
    assert.match(html, /href="\/ds\.css\?v=[0-9a-f]{10}"/);
    assert.match(html, /href="\/app\.css\?v=[0-9a-f]{10}"/);
    const js = await fetch(`${base}/${script}?v=${m[1]}`);
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    if (script === 'app.js') assert.match(await js.text(), /from '\.\/import\.js\?v=[0-9a-f]{10}'/, 'o import interno também tem versão');
    else await js.text();
  }
  // Sem versão no endereço (link antigo): não guarda.
  assert.equal((await fetch(`${base}/app.js`)).headers.get('cache-control'), 'no-cache');
});

test('processos: Diário recusando (fora do Brasil) vira mensagem amigável; com ponto de saída no Brasil, a consulta passa por ele', async () => {
  const legal = await import('../src/services/legal.js');
  const { config } = await import('../src/config.js');
  const urls = [];
  let djen403 = true;
  legal.setLegalFetch(async (url, init = {}) => {
    urls.push({ url, headers: init.headers || {} });
    if (url.includes('api-publica.datajud')) return new Response(JSON.stringify({ hits: { hits: [] } }), { status: 200 });
    if (djen403) return new Response('<html>403 ERROR</html>', { status: 403 });
    return new Response(JSON.stringify({ status: 'success', items: [] }), { status: 200 });
  });
  try {
    resetLoginAttempts();
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Adv Proxy', name: 'Pri', email: 'pri@adv.test', password: 'senhaforte1', segment: 'advocacia' } });
    const c = (await u('/api/legal/cases', { method: 'POST', body: { cnj: '4075574-44.2026.8.26.0100' } })).data;
    // Cada rodada verifica poucos processos (os de outros testes podem estar na frente).
    const until = async (ok) => { for (let i = 0; i < 10 && !(await ok()); i++) await legal.monitorOnce(); };
    await until(async () => (await u(`/api/legal/cases/${c.id}`)).data.baseline_done === 1);
    let d = (await u(`/api/legal/cases/${c.id}`)).data;
    assert.match(d.error, /Não conseguimos consultar o Diário \(DJEN\) agora\. Tentamos de novo sozinhos/);
    assert.doesNotMatch(d.error, /403/);
    assert.equal(legal.djenHealth(), 'bloqueado');
    assert.equal((await (await fetch(`${base}/health`)).json()).djen, 'bloqueado');

    // Com o ponto de saída no Brasil configurado, o Diário é consultado por ele (com a senha dele).
    config.djenProxyUrl = 'https://saida-br.exemplo.test/djen';
    config.djenProxyToken = 'segredo-do-proxy';
    djen403 = false;
    mainDb.prepare('UPDATE legal_cases SET djen_checked_at = NULL WHERE id = ?').run(c.id);
    await until(async () => (await u(`/api/legal/cases/${c.id}`)).data.djen_checked_at !== null);
    const viaProxy = urls.filter((x) => x.url.startsWith('https://saida-br.exemplo.test/djen?') && x.url.includes('numeroProcesso=40755744420268260100'));
    assert.ok(viaProxy.length >= 1, 'o processo foi consultado pelo ponto de saída');
    assert.equal(viaProxy[0].headers['x-proxy-token'], 'segredo-do-proxy');
    assert.ok(!urls.some((x) => x.url.startsWith('https://comunicaapi.pje.jus.br/') && urls.indexOf(x) > urls.indexOf(viaProxy[0])), 'com o ponto de saída, nada vai direto ao Diário');
    assert.equal(legal.djenHealth(), 'ok');
    d = (await u(`/api/legal/cases/${c.id}`)).data;
    assert.ok(!/Diário/.test(d.error || ''), 'sem erro do Diário quando a consulta funciona');
  } finally {
    config.djenProxyUrl = '';
    config.djenProxyToken = '';
    legal.setLegalFetch((...a) => fetch(...a));
  }
});

test('Stripe sem Pix ativado: o cliente cai no Pix pela chave da plataforma, sem ver o erro do Stripe', async () => {
  const { config } = await import('../src/config.js');
  const { setStripeFetch } = await import('../src/services/stripe.js');
  let calls = 0;
  setStripeFetch(async () => {
    calls++;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'The payment method type provided: pix is invalid. Please ensure the provided type is activated in your dashboard (https://dashboard.stripe.com/account/payments/settings)' } }) };
  });
  config.stripeSecretKey = 'sk_test_123';
  config.platformPixKey = '123e4567-e89b-42d3-a456-426614174000';
  try {
    resetLoginAttempts();
    const u = browser();
    await u('/api/auth/register', { method: 'POST', body: { companyName: 'Pix Manual', name: 'Pim', email: 'pim@pix.test', password: 'senhaforte1' } });
    const r = await u('/api/upgrade/pix', { method: 'POST', body: { plan: 'basico' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { manual: true });
    const up = (await u('/api/upgrade')).data;
    assert.equal(up.stripe_pix, false);
    assert.ok(up.plans.find((p) => p.id === 'basico').pix_code.includes('540549.90'), 'Pix copia e cola da plataforma pronto');
    // Na próxima tentativa nem chama o Stripe.
    assert.deepEqual((await u('/api/upgrade/pix', { method: 'POST', body: { plan: 'basico' } })).data, { manual: true });
    assert.equal(calls, 1);
  } finally {
    config.stripeSecretKey = '';
    config.platformPixKey = '';
  }
});
