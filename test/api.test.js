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
  const r = await call('/api/auth/register', { method: 'POST', body: { companyName: `Loja ${email}`, name: 'Dono', email, password: 'senha123' } });
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
