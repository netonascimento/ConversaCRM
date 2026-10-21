import { main, now } from '../db.js';
import { config } from '../config.js';
import { grantCourtesy } from './subscriptions.js';
import { notifyPlatform } from './platform.js';

// Plano Básico grátis para MEI: a empresa envia o CCMEI (Certificado da Condição de Microempreendedor
// Individual) e o administrador confere e libera no painel. O certificado fica no banco principal.

export const MEI_MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const MEI_REASON = 'MEI: plano Básico grátis';

/** Confere os dígitos verificadores do CNPJ. */
export function validCnpj(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return null;
  const calc = (len) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = w.reduce((n, x, i) => n + x * Number(d[i]), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]) ? d : null;
}
const maskCnpj = (d) => d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

const publicRow = (r) => (r ? { id: r.id, cnpj: maskCnpj(r.cnpj), file_name: r.file_name, status: r.status, note: r.note, created_at: r.created_at, decided_at: r.decided_at } : null);

export function meiStatus(companyId) {
  return publicRow(main.get('SELECT * FROM mei_requests WHERE company_id = ? ORDER BY id DESC LIMIT 1', companyId));
}

export async function submitMei(companyId, user, { cnpj, file_name: fileName, mime, data_base64: data }) {
  const company = main.get('SELECT id, name, courtesy_reason FROM companies WHERE id = ?', companyId);
  if (company.courtesy_reason === MEI_REASON) throw new Error('Sua conta já tem o plano Básico grátis para MEI.');
  if (main.get("SELECT 1 AS x FROM mei_requests WHERE company_id = ? AND status = 'pendente'", companyId)) throw new Error('Seu pedido já está em análise. Avisamos assim que for liberado.');
  const doc = validCnpj(cnpj);
  if (!doc) throw new Error('CNPJ inválido. Confira os 14 números do seu MEI.');
  if (!TYPES[mime]) throw new Error('Envie o certificado em PDF, JPG ou PNG.');
  const bytes = Buffer.from(String(data || ''), 'base64');
  if (!bytes.length) throw new Error('Arquivo vazio. Escolha o certificado de novo.');
  if (bytes.length > MEI_MAX_BYTES) throw new Error('O arquivo passa de 5 MB. Envie uma versão menor (o PDF do Portal do Empreendedor costuma ter poucos KB).');
  const name = String(fileName || `ccmei.${TYPES[mime]}`).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const { id } = main.run('INSERT INTO mei_requests (company_id, cnpj, file_name, mime, data) VALUES (?, ?, ?, ?, ?)', companyId, doc, name, mime, bytes);
  notifyPlatform(`🧾 *Pedido de MEI* no Conversa CRM\nEmpresa: ${company.name}\nCNPJ: ${maskCnpj(doc)}\nEnviado por: ${user.name} (${user.email})\n\nConferir e liberar: ${config.publicUrl}/admin#mei`).catch(() => {});
  return publicRow(main.get('SELECT * FROM mei_requests WHERE id = ?', id));
}

/** Admin: pedidos (pendentes primeiro), sem o arquivo. */
export function listMei() {
  return main.all(
    `SELECT m.id, m.company_id, m.cnpj, m.file_name, m.mime, m.status, m.note, m.decided_by, m.decided_at, m.created_at, c.name AS company_name, c.plan
     FROM mei_requests m JOIN companies c ON c.id = m.company_id ORDER BY m.status = 'pendente' DESC, m.id DESC LIMIT 200`,
  ).map((r) => ({ ...r, cnpj: maskCnpj(r.cnpj) }));
}

export function meiFile(id) {
  return main.get('SELECT file_name, mime, data FROM mei_requests WHERE id = ?', id) || null;
}

/** Admin aprova (libera o Básico sem prazo, como cortesia) ou recusa, com observação. */
export function decideMei(id, { approve, note = '' }, actor) {
  const r = main.get('SELECT * FROM mei_requests WHERE id = ?', id);
  if (!r) return null;
  if (r.status !== 'pendente') throw new Error('Este pedido já foi decidido.');
  if (approve) grantCourtesy(r.company_id, 'basico', { until: null, reason: MEI_REASON });
  else if (!String(note).trim()) throw new Error('Diga o motivo da recusa (a empresa vê essa mensagem).');
  main.run('UPDATE mei_requests SET status = ?, note = ?, decided_by = ?, decided_at = ? WHERE id = ?',
    approve ? 'aprovado' : 'recusado', String(note).trim().slice(0, 300) || null, actor, now(), id);
  return main.get('SELECT id, status FROM mei_requests WHERE id = ?', id);
}
