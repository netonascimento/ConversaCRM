import { all, get, run, now, main } from '../db.js';
import { triggerSequences, stopEnrollments } from './followup.js';

export const STAGES = [
  { id: 'novo', label: 'Novo lead' },
  { id: 'contato', label: 'Em contato' },
  { id: 'qualificado', label: 'Qualificado' },
  { id: 'proposta', label: 'Proposta' },
  { id: 'ganho', label: 'Ganho' },
  { id: 'perdido', label: 'Perdido' },
];
export const STAGE_IDS = STAGES.map((s) => s.id);

// Normaliza telefone para dígitos com DDI (Brasil por padrão).
export function normalizePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d;
}

export const formatMoney = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';

export function render(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? ''));
}

export function logActivity(companyId, contactId, type, description) {
  run('INSERT INTO activities (company_id, contact_id, type, description) VALUES (?, ?, ?, ?)', companyId, contactId, type, description);
}

export const getContact = (companyId, id) => get('SELECT * FROM contacts WHERE company_id = ? AND id = ?', companyId, id);

export const findContactByPhone = (companyId, phone) =>
  get('SELECT * FROM contacts WHERE company_id = ? AND phone = ?', companyId, normalizePhone(phone));

const EDITABLE = ['name', 'phone', 'email', 'document', 'business_name', 'source', 'value_cents', 'tags', 'notes', 'interest', 'address', 'website', 'rating', 'place_id', 'ai_enabled'];

export class PlanLimitError extends Error {}

/** Quantos leads a empresa ainda pode cadastrar no plano (null = ilimitado). */
export function leadsRemaining(companyId) {
  const company = main.get('SELECT max_leads FROM companies WHERE id = ?', companyId);
  if (!company || company.max_leads === null || company.max_leads === undefined) return null;
  return Math.max(0, company.max_leads - get('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?', companyId).n);
}

export function createContact(companyId, data, { trigger = true } = {}) {
  if (leadsRemaining(companyId) === 0) {
    throw new PlanLimitError('Limite de leads do plano atingido. Fale com a gente para mudar de plano e liberar leads ilimitados.');
  }
  const fields = { stage: STAGE_IDS.includes(data.stage) ? data.stage : 'novo' };
  for (const k of EDITABLE) if (data[k] !== undefined) fields[k] = data[k];
  if (fields.phone) fields.phone = normalizePhone(fields.phone);
  const cols = Object.keys(fields);
  const { id } = run(
    `INSERT INTO contacts (company_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
    companyId, ...Object.values(fields),
  );
  logActivity(companyId, id, 'lead', `Lead criado (origem: ${fields.source || 'manual'})`);
  if (trigger) triggerSequences(companyId, id, 'new_lead');
  return getContact(companyId, id);
}

export function findOrCreateByPhone(companyId, phone, name, source = 'whatsapp') {
  const existing = findContactByPhone(companyId, phone);
  if (existing) {
    if (!existing.name && name) run('UPDATE contacts SET name = ? WHERE id = ?', name, existing.id);
    return { contact: getContact(companyId, existing.id), created: false };
  }
  return { contact: createContact(companyId, { phone, name: name || '', source }), created: true };
}

export function updateContact(companyId, id, data) {
  const contact = getContact(companyId, id);
  if (!contact) return null;
  const sets = [];
  const vals = [];
  for (const k of EDITABLE) {
    if (data[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'phone' ? normalizePhone(data[k]) : data[k]);
  }
  if (sets.length) run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
  if (data.stage && data.stage !== contact.stage) changeStage(companyId, id, data.stage);
  return getContact(companyId, id);
}

/** Salva respostas da triagem (perguntas configuradas na IA) junto com o contato. */
export function saveCustomFields(companyId, id, fields) {
  const contact = getContact(companyId, id);
  if (!contact) return null;
  const merged = { ...JSON.parse(contact.custom_fields || '{}') };
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null && String(v).trim()) merged[k] = String(v).trim();
  run('UPDATE contacts SET custom_fields = ?, updated_at = ? WHERE id = ?', JSON.stringify(merged), now(), id);
  return getContact(companyId, id);
}

export function changeStage(companyId, id, stage, reason = '') {
  if (!STAGE_IDS.includes(stage)) throw new Error(`Etapa inválida: ${stage}`);
  const contact = getContact(companyId, id);
  if (!contact || contact.stage === stage) return contact;
  run('UPDATE contacts SET stage = ?, updated_at = ?, won_at = ? WHERE id = ?',
    stage, now(), stage === 'ganho' ? now() : contact.won_at, id);
  const label = STAGES.find((s) => s.id === stage).label;
  logActivity(companyId, id, 'stage', `Etapa alterada para "${label}"${reason ? ` — ${reason}` : ''}`);
  if (stage === 'ganho' || stage === 'perdido') stopEnrollments(companyId, id, `lead ${stage}`);
  triggerSequences(companyId, id, `stage:${stage}`);
  return getContact(companyId, id);
}

export function listContacts(companyId, { q, stage, source, limit = 500 } = {}) {
  const where = ['company_id = ?'];
  const params = [companyId];
  if (stage) { where.push('stage = ?'); params.push(stage); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (q) {
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR business_name LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  return all(`SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, ...params, limit);
}
