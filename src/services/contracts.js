import { all, get, run, now } from '../db.js';
import { getCompany } from './company.js';
import { getContact, changeStage, logActivity, formatMoney } from './crm.js';
import { createTask, closeTasksFor } from './tasks.js';
import { todayIn, addDays, zonedToUtc, formatDateBR } from './time.js';

// Contratos dos clientes, com vencimento. Antes de vencer (notice_days), a equipe recebe uma
// tarefa para renovar; com renovação automática, o contrato vencido é renovado sozinho.

export const PERIODS = [
  { id: 'unico', label: 'Pagamento único' },
  { id: 'mensal', label: 'Mensal' },
  { id: 'trimestral', label: 'Trimestral' },
  { id: 'semestral', label: 'Semestral' },
  { id: 'anual', label: 'Anual' },
];
const PERIOD_IDS = PERIODS.map((p) => p.id);
const MONTHS_IN = { mensal: 1, trimestral: 3, semestral: 6, anual: 12 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Situação do contrato hoje: vigente, vencendo (dentro do aviso), vencido, sem_vencimento,
 * ou a situação final gravada (encerrado, cancelado, renovado).
 */
export function situation(c, today) {
  if (c.status !== 'ativo') return { situation: c.status, days_left: null };
  if (!c.end_date) return { situation: 'sem_vencimento', days_left: null };
  const daysLeft = daysBetween(today, c.end_date);
  if (daysLeft < 0) return { situation: 'vencido', days_left: daysLeft };
  return { situation: daysLeft <= c.notice_days ? 'vencendo' : 'vigente', days_left: daysLeft };
}

const SELECT = `SELECT k.*, c.name AS contact_name, c.phone AS contact_phone FROM contracts k
  JOIN contacts c ON c.id = k.contact_id`;

function withSituation(companyId, rows) {
  const today = todayIn(getCompany(companyId).timezone);
  return rows.map((r) => ({ ...r, auto_renew: Boolean(r.auto_renew), ...situation(r, today) }));
}

export const getContract = (companyId, id) => withSituation(companyId, all(`${SELECT} WHERE k.company_id = ? AND k.id = ?`, companyId, id))[0] || null;

/** filter: ativos (padrão: vigentes + vencendo + vencidos), vencendo, vencido, encerrados, todos. */
export function listContracts(companyId, { contactId, filter } = {}) {
  const where = ['k.company_id = ?'];
  const params = [companyId];
  if (contactId) { where.push('k.contact_id = ?'); params.push(contactId); }
  if (!filter || ['ativos', 'vencendo', 'vencido'].includes(filter)) where.push("k.status = 'ativo'");
  if (filter === 'encerrados') where.push("k.status != 'ativo'");
  const rows = withSituation(companyId, all(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY k.status = 'ativo' DESC, k.end_date IS NULL, k.end_date, k.id DESC`, ...params,
  ));
  return filter === 'vencendo' || filter === 'vencido' ? rows.filter((r) => r.situation === filter) : rows;
}

function clean(data, current = {}) {
  const out = {
    title: (data.title ?? current.title ?? '').trim(),
    value_cents: data.value_cents ?? current.value_cents ?? 0,
    period: data.period ?? current.period ?? 'mensal',
    start_date: data.start_date ?? current.start_date,
    end_date: data.end_date === undefined ? current.end_date ?? null : data.end_date || null,
    notice_days: data.notice_days === undefined || data.notice_days === '' ? current.notice_days ?? 30 : Number(data.notice_days),
    auto_renew: data.auto_renew === undefined ? current.auto_renew ?? 0 : data.auto_renew === true || data.auto_renew === 'true' ? 1 : 0,
    notes: data.notes ?? current.notes ?? '',
  };
  if (!out.title) throw new Error('Informe o nome do contrato');
  if (!PERIOD_IDS.includes(out.period)) throw new Error('Periodicidade inválida');
  if (!DATE.test(out.start_date || '')) throw new Error('Informe a data de início');
  if (out.end_date && !DATE.test(out.end_date)) throw new Error('Data de vencimento inválida');
  if (out.end_date && out.end_date < out.start_date) throw new Error('O vencimento não pode ser antes do início');
  if (!(out.notice_days >= 0 && out.notice_days <= 365)) throw new Error('O aviso deve ser de 0 a 365 dias');
  if (out.auto_renew && !out.end_date) throw new Error('Renovação automática precisa de data de vencimento');
  return out;
}

export function createContract(companyId, data, { by = 'Equipe', renewedFrom = null } = {}) {
  const contact = getContact(companyId, data.contact_id);
  if (!contact) throw new Error('Cliente não encontrado');
  const k = clean(data);
  const { id } = run(
    `INSERT INTO contracts (company_id, contact_id, title, value_cents, period, start_date, end_date, notice_days, auto_renew, notes, renewed_from_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId, contact.id, k.title, k.value_cents, k.period, k.start_date, k.end_date, k.notice_days, k.auto_renew, k.notes, renewedFrom,
  );
  if (!renewedFrom) {
    logActivity(companyId, contact.id, 'contrato', `${by} cadastrou o contrato "${k.title}"${k.end_date ? `, vencimento em ${formatDateBR(k.end_date)}` : ''}`);
    // Contrato fechado: o contato passa a ser cliente.
    if (contact.stage !== 'ganho') changeStage(companyId, contact.id, 'ganho', 'contrato cadastrado');
  }
  return getContract(companyId, id);
}

export function updateContract(companyId, id, data, { by = 'Equipe' } = {}) {
  const current = get('SELECT * FROM contracts WHERE company_id = ? AND id = ?', companyId, id);
  if (!current) return null;
  const k = clean(data, current);
  // Mudou o vencimento ou o aviso: o alerta pode precisar sair de novo.
  const resetAlert = k.end_date !== current.end_date || k.notice_days !== current.notice_days;
  run(
    `UPDATE contracts SET title = ?, value_cents = ?, period = ?, start_date = ?, end_date = ?, notice_days = ?, auto_renew = ?, notes = ?,
       alert_sent_at = ?, updated_at = ? WHERE id = ?`,
    k.title, k.value_cents, k.period, k.start_date, k.end_date, k.notice_days, k.auto_renew, k.notes,
    resetAlert ? null : current.alert_sent_at, now(), id,
  );
  if (resetAlert) closeTasksFor(companyId, 'renovar_contrato', 'contract_id', id);
  if (current.end_date !== k.end_date) {
    logActivity(companyId, current.contact_id, 'contrato', `${by} alterou o vencimento de "${k.title}" para ${k.end_date ? formatDateBR(k.end_date) : 'sem vencimento'}`);
  }
  return getContract(companyId, id);
}

/** Próximo período: mesma duração do atual (em meses, quando der; senão em dias). */
function nextTerm(c) {
  const start = addDays(c.end_date, 1);
  const days = daysBetween(c.start_date, c.end_date);
  const months = Math.round((days + 1) / 30.44);
  const sameMonths = months >= 1 && Math.abs(daysBetween(c.start_date, addDays(addMonths(c.start_date, months), -1)) - days) <= 3;
  return { start, end: sameMonths ? addDays(addMonths(start, months), -1) : addDays(start, days) };
}

/** Renova: o contrato atual fica como "renovado" e nasce um novo para o próximo período. */
export function renewContract(companyId, id, { endDate, valueCents, by = 'Equipe', automatic = false } = {}) {
  const c = get('SELECT * FROM contracts WHERE company_id = ? AND id = ?', companyId, id);
  if (!c) return null;
  if (c.status !== 'ativo') throw new Error('Só é possível renovar um contrato ativo');
  if (!c.end_date) throw new Error('Contrato sem vencimento não precisa de renovação');
  const term = nextTerm(c);
  const end = endDate || term.end;
  if (end <= term.start) throw new Error('O novo vencimento precisa ser depois do início do novo período');
  run("UPDATE contracts SET status = 'renovado', updated_at = ? WHERE id = ?", now(), id);
  closeTasksFor(companyId, 'renovar_contrato', 'contract_id', id);
  const renewed = createContract(companyId, {
    ...c, start_date: term.start, end_date: end, value_cents: valueCents ?? c.value_cents, auto_renew: Boolean(c.auto_renew),
  }, { by, renewedFrom: id });
  logActivity(companyId, c.contact_id, 'contrato',
    `${automatic ? 'Renovação automática' : `${by} renovou`} "${c.title}": novo período ${formatDateBR(term.start)} a ${formatDateBR(end)}`);
  return renewed;
}

/** Encerra ou cancela (fica no histórico). */
export function closeContract(companyId, id, status, { by = 'Equipe' } = {}) {
  if (!['encerrado', 'cancelado'].includes(status)) throw new Error('Situação inválida');
  const c = get('SELECT * FROM contracts WHERE company_id = ? AND id = ?', companyId, id);
  if (!c) return null;
  run('UPDATE contracts SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
  closeTasksFor(companyId, 'renovar_contrato', 'contract_id', id);
  logActivity(companyId, c.contact_id, 'contrato', `${by} ${status === 'cancelado' ? 'cancelou' : 'encerrou'} o contrato "${c.title}"`);
  return getContract(companyId, id);
}

export function deleteContract(companyId, id) {
  const c = get('SELECT * FROM contracts WHERE company_id = ? AND id = ?', companyId, id);
  if (!c) return false;
  closeTasksFor(companyId, 'renovar_contrato', 'contract_id', id);
  run('DELETE FROM contracts WHERE id = ?', id);
  logActivity(companyId, c.contact_id, 'contrato', `Contrato "${c.title}" excluído`);
  return true;
}

/** Agendador: renova os automáticos vencidos e avisa a equipe dos que estão para vencer. */
export async function processContracts() {
  let count = 0;
  const rows = all("SELECT * FROM contracts WHERE status = 'ativo' AND end_date IS NOT NULL");
  for (const c of rows) {
    const company = getCompany(c.company_id);
    if (!company || company.status !== 'ativa') continue;
    const today = todayIn(company.timezone);
    const { situation: s, days_left: left } = situation(c, today);
    if (s === 'vencido' && c.auto_renew) {
      renewContract(c.company_id, c.id, { automatic: true });
      count++;
      continue;
    }
    if (c.alert_sent_at || !['vencendo', 'vencido'].includes(s)) continue;
    run('UPDATE contracts SET alert_sent_at = ? WHERE id = ?', now(), c.id);
    const when = left < 0 ? `venceu em ${formatDateBR(c.end_date)}` : left === 0 ? 'vence hoje' : `vence em ${left} dia(s), em ${formatDateBR(c.end_date)}`;
    await createTask(c.company_id, {
      contactId: c.contact_id, type: 'renovar_contrato', title: `Renovar contrato — ${c.title}`,
      details: `O contrato "${c.title}" ${when}.${c.value_cents ? ` Valor: ${formatMoney(c.value_cents)}.` : ''}${c.auto_renew ? ' Renovação automática ligada: renova sozinho no vencimento se ninguém mexer.' : ' Fale com o cliente e renove ou encerre o contrato.'}`,
      payload: { contract_id: c.id },
      dueAt: zonedToUtc(left < 0 ? today : c.end_date, '18:00', company.timezone).toISOString(),
      createdBy: 'sistema',
    });
    count++;
  }
  return count;
}

// ---- Clientes ----------------------------------------------------------------

/** Cliente = contato marcado como "Ganho" ou com algum contrato. */
export function listClients(companyId, { q } = {}) {
  const where = ['c.company_id = ?', "(c.stage = 'ganho' OR EXISTS (SELECT 1 FROM contracts k WHERE k.contact_id = c.id))"];
  const params = [companyId];
  if (q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.document LIKE ? OR c.business_name LIKE ?)'); params.push(...Array(5).fill(`%${q}%`)); }
  return all(
    `SELECT c.id, c.name, c.phone, c.email, c.document, c.business_name, c.stage, c.won_at, c.assigned_user_id, c.created_at,
       (SELECT COUNT(*) FROM contracts k WHERE k.contact_id = c.id AND k.status = 'ativo') AS active_contracts,
       (SELECT MIN(k.end_date) FROM contracts k WHERE k.contact_id = c.id AND k.status = 'ativo') AS next_end_date,
       (SELECT COUNT(*) FROM documents d WHERE d.contact_id = c.id) AS documents
     FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.name COLLATE NOCASE LIMIT 1000`, ...params,
  );
}

/** Números da página de clientes. Receita recorrente = contratos ativos convertidos para valor mensal. */
export function contractsSummary(companyId) {
  const active = listContracts(companyId);
  const count = (s) => active.filter((k) => k.situation === s).length;
  const monthly = active.reduce((n, k) => n + (MONTHS_IN[k.period] ? Math.round(k.value_cents / MONTHS_IN[k.period]) : 0), 0);
  return {
    clients: listClients(companyId).length,
    active: active.length,
    expiring: count('vencendo'),
    expired: count('vencido'),
    monthly_recurring_cents: monthly,
  };
}
