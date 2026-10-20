// Leitura de contatos para importação: planilha (CSV do Excel, Google Planilhas, Google Contatos),
// texto colado de uma planilha e contatos do celular (.vcf). Funções puras, usadas no navegador e nos testes.

/** CSV/TSV com aspas, quebras de linha dentro de aspas e separador detectado (; , ou tab). */
export function parseDelimited(text) {
  const clean = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const firstLine = clean.split('\n').find((l) => l.trim()) || '';
  const counts = { '\t': firstLine.split('\t').length, ';': firstLine.split(';').length, ',': firstLine.split(',').length };
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; } else if (ch === '\n') {
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c)) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

/** Arquivo .vcf (exportado do celular, Google Contatos ou iCloud) -> linhas com cabeçalho. */
export function parseVCard(text) {
  const unfolded = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
  const out = [['Nome', 'Telefone', 'E-mail', 'Empresa', 'Observações', 'Nascimento']];
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.split('\n');
    const value = (prop) => {
      const line = lines.find((l) => new RegExp(`^(item\\d+\\.)?${prop}[;:]`, 'i').test(l));
      return line ? decodeVCard(line.slice(line.indexOf(':') + 1)) : '';
    };
    let name = value('FN');
    if (!name) {
      const n = value('N').split(';');
      name = [n[1], n[0]].filter(Boolean).join(' ');
    }
    // Prefere o celular quando houver mais de um telefone.
    const tels = lines.filter((l) => /^(item\d+\.)?TEL[;:]/i.test(l));
    const mobile = tels.find((l) => /CELL|MOBILE|WHATSAPP/i.test(l)) || tels[0];
    const phone = mobile ? decodeVCard(mobile.slice(mobile.indexOf(':') + 1)) : '';
    if (!name && !phone) continue;
    out.push([name, phone, value('EMAIL'), value('ORG').replace(/;+$/, '').replace(/;/g, ' '), value('NOTE'), vcardBirthday(value('BDAY'))]);
  }
  return out;
}

// BDAY do vCard: 19850315, 1985-03-15 ou --0315 (sem ano) -> dd/mm/aaaa ou dd/mm.
function vcardBirthday(v) {
  const m = String(v || '').replace(/T.*$/, '').match(/^(\d{4}|--)-?(\d{2})-?(\d{2})$/);
  if (!m) return '';
  return m[1] === '--' ? `${m[3]}/${m[2]}` : `${m[3]}/${m[2]}/${m[1]}`;
}

function decodeVCard(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
}

// Campos do Conversa CRM e os nomes de coluna que costumam aparecer em planilhas e exportações.
export const FIELDS = [
  { id: 'name', label: 'Nome', match: /^(nome|name|cliente|contato|nome completo|full name|razao social|razão social|first name|given name)$|^nome\b|name$/i },
  { id: 'phone', label: 'Telefone / WhatsApp', match: /(telefone|celular|whats|fone|phone|mobile|tel\b|contato tel)/i },
  { id: 'email', label: 'E-mail', match: /(e-?mail|correio)/i },
  { id: 'business_name', label: 'Empresa', match: /(empresa|company|organization|organiza|org\b|negócio|negocio)/i },
  { id: 'document', label: 'CPF / CNPJ', match: /(cpf|cnpj|documento)/i },
  { id: 'birth_date', label: 'Data de nascimento', match: /(nascimento|anivers|birthday|birth|data nasc|dt nasc)/i },
  { id: 'interest', label: 'Interesse', match: /(interesse|produto|serviço|servico)/i },
  { id: 'tags', label: 'Etiquetas', match: /(etiqueta|tag|grupo|group|label|categoria)/i },
  { id: 'value', label: 'Valor (R$)', match: /(valor|value|ticket|preço|preco)/i },
  { id: 'notes', label: 'Observações', match: /(obs|nota|note|coment|descri)/i },
];

const looksLikePhone = (v) => /^\+?[\d\s().-]{8,}$/.test(v) && String(v).replace(/\D/g, '').length >= 8;
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** Tem cabeçalho? Se a primeira linha já parece dado (telefone, e-mail), não tem. */
export function hasHeader(rows) {
  const first = rows[0] || [];
  return !first.some((c) => looksLikePhone(c) || looksLikeEmail(c));
}

/** Sugere qual coluna vai para cada campo (pelo cabeçalho e, sem cabeçalho, pelo conteúdo). */
export function guessMapping(rows) {
  const header = hasHeader(rows) ? rows[0] : null;
  const sample = rows.slice(header ? 1 : 0, (header ? 1 : 0) + 20);
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const mapping = {};
  const used = new Set();
  if (header) {
    for (const field of FIELDS) {
      // Google Contatos: "Phone 1 - Value" (e não "Phone 1 - Type"); "Name" antes de "Given Name".
      const idx = header.findIndex((h, i) => !used.has(i) && field.match.test(h.trim()) && !/type|tipo|label/i.test(h));
      if (idx >= 0) { mapping[field.id] = idx; used.add(idx); }
    }
  }
  for (let i = 0; i < cols; i++) {
    if (used.has(i)) continue;
    const values = sample.map((r) => r[i] || '').filter(Boolean);
    if (!values.length) continue;
    if (mapping.phone === undefined && values.filter(looksLikePhone).length >= values.length * 0.7) { mapping.phone = i; used.add(i); continue; }
    if (mapping.email === undefined && values.filter(looksLikeEmail).length >= values.length * 0.7) { mapping.email = i; used.add(i); continue; }
    if (mapping.name === undefined && values.every((v) => /[a-zà-ú]/i.test(v) && !looksLikeEmail(v))) { mapping.name = i; used.add(i); }
  }
  return { mapping, header };
}

/** Aplica o mapeamento e devolve os contatos prontos para enviar. */
export function toContacts(rows, mapping, { header = true } = {}) {
  const body = header ? rows.slice(1) : rows;
  return body.map((r) => {
    const c = {};
    for (const [field, idx] of Object.entries(mapping)) {
      if (idx === '' || idx === null || idx === undefined) continue;
      const v = (r[Number(idx)] || '').trim();
      if (v) c[field] = v;
    }
    return c;
  }).filter((c) => c.name || c.phone || c.email);
}
