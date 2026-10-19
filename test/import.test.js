import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './setup.js';

const { parseDelimited, parseVCard, guessMapping, toContacts } = await import('../public/import.js');
const { createServer } = await import('../src/server.js');

test('planilha do Excel brasileiro (ponto e vírgula, aspas e acentos)', () => {
  const csv = '﻿Nome;Celular;E-mail;Empresa\r\n"Silva, João";(11) 98888-7777;joao@x.com;Padaria Pão\r\nMaria;11 97777-6666;;\r\n';
  const rows = parseDelimited(csv);
  assert.deepEqual(rows[1], ['Silva, João', '(11) 98888-7777', 'joao@x.com', 'Padaria Pão']);
  const { mapping, header } = guessMapping(rows);
  assert.deepEqual(mapping, { name: 0, phone: 1, email: 2, business_name: 3 });
  assert.deepEqual(toContacts(rows, mapping, { header: Boolean(header) })[1], { name: 'Maria', phone: '11 97777-6666' });
});

test('exportação do Google Contatos e texto colado sem cabeçalho', () => {
  const google = 'Name,Given Name,Phone 1 - Type,Phone 1 - Value,E-mail 1 - Value,Organization 1 - Name\nAna Lima,Ana,Mobile,+55 21 99999-1111,ana@x.com,Clínica\n';
  const g = guessMapping(parseDelimited(google));
  assert.equal(g.mapping.name, 0);
  assert.equal(g.mapping.phone, 3, 'pega o valor do telefone, não o tipo');
  assert.equal(g.mapping.email, 4);
  const pasted = 'Carlos Souza\t11 95555-4444\nBeatriz\t(19) 98123-4567';
  const p = guessMapping(parseDelimited(pasted));
  assert.equal(p.header, null);
  assert.deepEqual(toContacts(parseDelimited(pasted), p.mapping, { header: false }), [
    { name: 'Carlos Souza', phone: '11 95555-4444' }, { name: 'Beatriz', phone: '(19) 98123-4567' },
  ]);
});

test('contatos do celular (.vcf), preferindo o celular', () => {
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Pedro Alves\r\nTEL;TYPE=HOME:1133334444\r\nTEL;TYPE=CELL:11 96666-5555\r\nEMAIL:pedro@x.com\r\nORG:Oficina;\r\nEND:VCARD\r\nBEGIN:VCARD\r\nN:Souza;Lia;;;\r\nTEL:21988887777\r\nEND:VCARD';
  const rows = parseVCard(vcf);
  assert.deepEqual(rows[1], ['Pedro Alves', '11 96666-5555', 'pedro@x.com', 'Oficina', '']);
  assert.equal(rows[2][0], 'Lia Souza');
});

let server; let base;
before(async () => { server = createServer(); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test('importação pela API: cria, evita duplicados, completa existentes e respeita o plano', async () => {
  let cookie = '';
  const call = async (path, body) => {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await call('/api/auth/register', { companyName: 'Loja Import', name: 'Ivo', email: 'ivo@import.com', password: 'senhaforte1' });
  await call('/api/contacts', { name: 'Já Existe', phone: '11911112222' });
  const r = (await call('/api/contacts/import', {
    contacts: [
      { name: 'Novo Um', phone: '(11) 93333-0001', tags: 'vip' },
      { name: 'Repetido na lista', phone: '11 93333-0001' },
      { phone: '11911112222', email: 'existe@x.com' },
      { name: '' },
      ...Array.from({ length: 32 }, (_, i) => ({ name: `Lote ${i}`, phone: `119444400${String(i).padStart(2, '0')}` })),
    ],
    tags: 'importado', update_existing: true, stage: 'contato',
  })).data;
  // Plano grátis: 30 leads (1 já existia) -> 29 novos; o resto fica de fora.
  assert.equal(r.created, 29);
  assert.equal(r.updated, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.invalid, 1);
  assert.equal(r.limit_skipped, 4);
  const contacts = (await call('/api/contacts')).data;
  const novo = contacts.find((c) => c.name === 'Novo Um');
  assert.equal(novo.source, 'importacao');
  assert.equal(novo.stage, 'contato');
  assert.equal(novo.tags, 'vip, importado');
  assert.equal(contacts.find((c) => c.name === 'Já Existe').email, 'existe@x.com');
});
