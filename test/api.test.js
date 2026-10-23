import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

const { createServer } = await import('../src/server.js');

let server;
let base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function client(email) {
  let cookie = '';
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const r = await call('/api/auth/register', { method: 'POST', body: { phone: '11999990000', companyName: `Loja ${email}`, name: 'Dono', email, password: 'senha123' } });
  assert.equal(r.status, 200);
  return call;
}

test('fluxo pela API e isolamento entre empresas', async () => {
  const a = await client('a@loja.com');
  const b = await client('b@loja.com');

  assert.equal((await fetch(`${base}/api/contacts`)).status, 401, 'sem login não acessa');

  const contact = (await a('/api/contacts', { method: 'POST', body: { name: 'Cliente A', phone: '11912345678', value: '1.500' } })).data;
  assert.equal(contact.value_cents, 150000);
  assert.equal((await a(`/api/contacts/${contact.id}`)).status, 200);
  assert.equal((await b(`/api/contacts/${contact.id}`)).status, 404, 'empresa B não vê contato da A');
  assert.equal((await b('/api/contacts')).data.length, 0);

  const product = (await a('/api/products', { method: 'POST', body: { name: 'Consultoria', price: '250,00', duration_min: 60 } })).data;
  assert.equal(product.price_cents, 25000);

  const charge = await a('/api/charges', { method: 'POST', body: { contact_id: contact.id, product_id: product.id, send: false } });
  assert.equal(charge.status, 400, 'sem chave Pix configurada, a cobrança é recusada com mensagem clara');
  assert.match(charge.data.error, /Chave Pix/);
  await a('/api/settings', { method: 'PUT', body: { settings: { billing: { pix_key: 'pix@loja.com', pix_city: 'Recife' } } } });
  const ok = await a('/api/charges', { method: 'POST', body: { contact_id: contact.id, product_id: product.id, send: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.amount_cents, 25000);
  assert.equal((await b(`/api/charges/${ok.data.id}/paid`, { method: 'POST' })).status, 404, 'empresa B não dá baixa em cobrança da A');

  const appt = await b('/api/appointments', { method: 'POST', body: { contact_id: contact.id, date: '2030-01-10', time: '10:00' } });
  assert.equal(appt.status, 404, 'empresa B não agenda para contato da A');

  const settings = await a('/api/settings', { method: 'PUT', body: { settings: { integrations: { anthropic_api_key: 'sk-ant-1234567890' } } } });
  assert.equal(settings.data.settings.integrations.anthropic_api_key, '••••7890', 'segredos voltam mascarados');
  await a('/api/settings', { method: 'PUT', body: { settings: { integrations: { anthropic_api_key: '••••7890' } } } });
  assert.equal((await a('/api/meta')).data.ai_configured, true, 'valor mascarado não sobrescreve a chave salva');

  const dash = await a('/api/dashboard');
  assert.equal(dash.status, 200);
  assert.equal(dash.data.metrics.leads_new, 1);
});

test('webhook da Meta: verificação e recebimento', async () => {
  const a = await client('meta@loja.com');
  await a('/api/settings', { method: 'PUT', body: { settings: { ai: { enabled: false }, whatsapp: { meta_verify_token: 'tok' } } } });
  const metaUrl = new URL((await a('/api/meta')).data.webhooks.meta);
  const id = metaUrl.pathname.split('/').pop();
  assert.ok(!/^\d+$/.test(id), 'URL do webhook usa identificador aleatório, não o número da empresa');
  const v = await fetch(`${base}/webhooks/whatsapp/meta/${id}?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=42`);
  assert.equal(await v.text(), '42');
  assert.equal((await fetch(`${base}/webhooks/whatsapp/meta/${id}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=42`)).status, 403);
  await fetch(`${base}/webhooks/whatsapp/meta/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '5581999990000', profile: { name: 'Rita' } }], messages: [{ from: '5581999990000', id: 'w1', type: 'text', text: { body: 'Oi' } }] } }] }] }),
  });
  const convs = (await a('/api/conversations')).data;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].name, 'Rita');
});

// Cliente sem cadastro automático, para testar o próprio cadastro.
function anon(ip = '10.0.0.1') {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, 'x-forwarded-for': ip },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('cadastro: pede WhatsApp, barra links, campo-isca e excesso por IP', async () => {
  const { resetLoginAttempts } = await import('../src/auth.js');
  const reg = (u, extra) => u('/api/auth/register', { method: 'POST', body: { companyName: 'Padaria Sol', name: 'Ana', email: `ana${Math.random()}@sol.com`, password: 'senhaforte1', phone: '11988887777', ...extra } });
  assert.equal((await reg(anon(), { phone: '' })).status, 400, 'sem WhatsApp');
  assert.equal((await reg(anon(), { phone: '1234' })).status, 400, 'WhatsApp inválido');
  assert.equal((await reg(anon(), { companyName: 'https://www.tiktok.com/@alguem' })).status, 400, 'link no nome');
  assert.equal((await reg(anon(), { website: 'http://spam' })).status, 400, 'campo-isca preenchido');
  assert.equal((await reg(anon(), { companyName: 'Padaria.com' })).status, 200, 'domínio sem link passa');

  process.env.SIGNUP_IP_LIMIT = '2';
  resetLoginAttempts();
  try {
    assert.equal((await reg(anon('10.9.9.9'))).status, 200);
    assert.equal((await reg(anon('10.9.9.9'))).status, 200);
    assert.equal((await reg(anon('10.9.9.9'))).status, 429, 'terceiro cadastro do mesmo IP na hora');
    assert.equal((await reg(anon('10.9.9.8'))).status, 200, 'outro IP segue');
  } finally {
    process.env.SIGNUP_IP_LIMIT = '1000';
    resetLoginAttempts();
  }
});

test('cadastro: confirmação de e-mail por código', async () => {
  const { config } = await import('../src/config.js');
  const { setEmailSender } = await import('../src/services/email.js');
  const { main } = await import('../src/db.js');
  const sent = [];
  setEmailSender(async (msg) => { sent.push(msg); return { id: 'x' }; });
  config.resendKey = 're_teste';
  try {
    const u = anon('10.1.1.1');
    const r = await u('/api/auth/register', { method: 'POST', body: { companyName: 'Clínica Lua', name: 'Bia Souza', email: 'bia@lua.com', password: 'senhaforte1', phone: '(21) 98888-7777' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.verify_email, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'bia@lua.com');
    const code = sent[0].text.match(/\b(\d{6})\b/)[1];

    const me = (await u('/api/auth/me')).data;
    assert.equal(me.email_pending, true);
    assert.equal((await u('/api/contacts')).status, 403, 'sem confirmar não usa o sistema');
    assert.equal((await u('/api/auth/resend-code', { method: 'POST' })).status, 429, 'reenvio só depois de 1 minuto');

    const wrong = code === '000000' ? '111111' : '000000';
    assert.equal((await u('/api/auth/verify-email', { method: 'POST', body: { code: wrong } })).status, 400);
    assert.equal((await u('/api/auth/verify-email', { method: 'POST', body: { code } })).status, 200);
    assert.equal((await u('/api/auth/me')).data.email_pending, false);
    assert.equal((await u('/api/contacts')).status, 200);
    const user = main.get("SELECT phone, verify_code_hash FROM users WHERE email = 'bia@lua.com'");
    assert.equal(user.phone, '5521988887777');
    assert.equal(user.verify_code_hash, null);

    // Tentativas erradas demais travam o código.
    const v = anon('10.1.1.2');
    await v('/api/auth/register', { method: 'POST', body: { companyName: 'Clínica Sol', name: 'Caio', email: 'caio@sol.com', password: 'senhaforte1', phone: '21988887776' } });
    const right = sent.at(-1).text.match(/\b(\d{6})\b/)[1];
    const bad = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await v('/api/auth/verify-email', { method: 'POST', body: { code: bad } });
    assert.equal((await v('/api/auth/verify-email', { method: 'POST', body: { code: right } })).status, 429);
  } finally {
    config.resendKey = '';
  }
});

test('IA: teto mensal de tokens na chave da plataforma', async () => {
  const { config } = await import('../src/config.js');
  const { main } = await import('../src/db.js');
  const { getCompany } = await import('../src/services/company.js');
  const { platformQuotaReached } = await import('../src/services/ai-usage.js');
  const { zonedParts } = await import('../src/services/time.js');
  const { makeCompany } = await import('./setup.js');
  const id = makeCompany();
  main.run('UPDATE companies SET ai_platform_key = 1 WHERE id = ?', id);
  const before = { key: config.anthropicKey, cap: config.aiPlatformMonthlyTokens };
  config.anthropicKey = 'sk-teste';
  config.aiPlatformMonthlyTokens = 1000;
  try {
    const company = getCompany(id);
    assert.equal(platformQuotaReached(company), false);
    const month = zonedParts(new Date(), company.timezone).date.slice(0, 7);
    main.run("INSERT INTO ai_usage (company_id, month, model, key_source, requests, input_tokens, output_tokens) VALUES (?, ?, 'm', 'platform', 1, 800, 300)", id, month);
    assert.equal(platformQuotaReached(company), true);
    config.aiPlatformMonthlyTokens = 0;
    assert.equal(platformQuotaReached(company), false, '0 = sem teto');
  } finally {
    config.anthropicKey = before.key;
    config.aiPlatformMonthlyTokens = before.cap;
  }
});
