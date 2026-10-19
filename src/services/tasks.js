import { all, get, run, now } from '../db.js';
import { getCompany } from './company.js';
import { getContact, logActivity, firstName, formatMoney } from './crm.js';
import { sendMessage, sendToPhone } from './messaging.js';
import { addBusinessHours, formatLocal } from './time.js';

// Tarefas são o que a IA (ou a automação) entrega para a equipe quando não consegue concluir sozinha.
export const TASK_TYPES = [
  { id: 'horario', label: 'Enviar horários' },
  { id: 'confirmar_agendamento', label: 'Confirmar agendamento' },
  { id: 'orcamento', label: 'Fazer orçamento' },
  { id: 'urgente', label: 'Atendimento urgente' },
  { id: 'aprovar_cobranca', label: 'Aprovar cobrança' },
  { id: 'retorno', label: 'Retornar contato' },
  { id: 'outro', label: 'Outro' },
];
const label = (type) => TASK_TYPES.find((t) => t.id === type)?.label || type;

// Tipos em que o cliente está esperando uma resposta da equipe.
const CLIENT_WAITING = ['horario', 'orcamento', 'retorno', 'confirmar_agendamento'];

const parse = (row) => row && { ...row, payload: JSON.parse(row.payload || '{}') };

export const getTask = (companyId, id) => parse(get(
  `SELECT t.*, c.name AS contact_name, c.phone AS contact_phone FROM tasks t
   LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.company_id = ? AND t.id = ?`, companyId, id));

export function listTasks(companyId, { status, contactId } = {}) {
  const where = ['t.company_id = ?'];
  const params = [companyId];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (contactId) { where.push('t.contact_id = ?'); params.push(contactId); }
  return all(
    `SELECT t.*, c.name AS contact_name, c.phone AS contact_phone FROM tasks t
     LEFT JOIN contacts c ON c.id = t.contact_id WHERE ${where.join(' AND ')}
     ORDER BY CASE t.status WHEN 'aberta' THEN 0 ELSE 1 END, CASE t.type WHEN 'urgente' THEN 0 ELSE 1 END, t.due_at`,
    ...params,
  ).map(parse);
}

/** Prazo da tarefa em horas úteis, a partir de agora. */
export function dueFor(company, slaHours) {
  const hours = slaHours ?? company.settings.team.task_sla_hours;
  return addBusinessHours(new Date(), Number(hours) || 4, company.timezone, company.settings.business_hours);
}

export async function notifyTeam(company, text) {
  const phone = company.settings.team.notify_phone;
  if (!phone) return false;
  try {
    await sendToPhone(company, phone, text);
    return true;
  } catch (err) {
    console.error('[tarefas] falha ao avisar a equipe:', err.message);
    return false;
  }
}

export async function createTask(companyId, { contactId = null, type = 'outro', title, details = '', payload = {}, dueAt, slaHours, createdBy = 'manual' }) {
  const company = getCompany(companyId);
  const due = dueAt ? new Date(dueAt) : type === 'urgente' ? new Date(Date.now() + 15 * 60000) : dueFor(company, slaHours);
  const contact = contactId ? getContact(companyId, contactId) : null;
  const finalTitle = title || `${label(type)}${contact ? ` — ${contact.name || contact.phone}` : ''}`;
  const { id } = run(
    'INSERT INTO tasks (company_id, contact_id, type, title, details, payload, due_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    companyId, contactId, type, finalTitle, details, JSON.stringify(payload), due.toISOString(), createdBy,
  );
  if (contact) logActivity(companyId, contactId, 'tarefa', `Tarefa para a equipe: ${finalTitle}${createdBy === 'ai' ? ' (criada pela IA)' : ''}`);
  if (type === 'urgente' || company.settings.team.notify_on_new_task) {
    await notifyTeam(company, `${type === 'urgente' ? '🚨 URGENTE' : '📋 Nova tarefa'}: ${finalTitle}\n${details ? `${details}\n` : ''}Prazo: ${formatLocal(due.toISOString(), company.timezone)}${contact?.phone ? `\nCliente: ${contact.name || ''} +${contact.phone}` : ''}`);
  }
  return getTask(companyId, id);
}

export function completeTask(companyId, id, status = 'concluida') {
  const task = getTask(companyId, id);
  if (!task || task.status !== 'aberta') return task;
  run('UPDATE tasks SET status = ?, done_at = ? WHERE id = ?', status, now(), id);
  if (task.contact_id) logActivity(companyId, task.contact_id, 'tarefa', `Tarefa ${status === 'concluida' ? 'concluída' : 'cancelada'}: ${task.title}`);
  return getTask(companyId, id);
}

/** Fecha tarefas abertas ligadas a um registro (ex.: confirmação de um agendamento). */
export function closeTasksFor(companyId, type, key, value) {
  for (const t of all("SELECT id, payload FROM tasks WHERE company_id = ? AND type = ? AND status = 'aberta'", companyId, type)) {
    if (JSON.parse(t.payload || '{}')[key] === value) completeTask(companyId, t.id);
  }
}

/** Tarefas que passaram do prazo: avisa a equipe e tranquiliza o cliente (uma vez). Chamado pelo agendador. */
export async function processOverdueTasks() {
  let count = 0;
  const overdue = all("SELECT * FROM tasks WHERE status = 'aberta' AND overdue_notified = 0 AND due_at <= ?", now());
  for (const task of overdue) {
    const company = getCompany(task.company_id);
    if (company.status !== 'ativa') continue;
    run('UPDATE tasks SET overdue_notified = 1 WHERE id = ?', task.id);
    await notifyTeam(company, `⏰ Tarefa atrasada: ${task.title}`);
    // Se alguém da equipe já falou com o cliente depois da tarefa, não manda o "ainda estamos verificando".
    const teamReplied = task.contact_id && get(
      "SELECT 1 FROM messages WHERE contact_id = ? AND author = 'human' AND created_at > ? LIMIT 1", task.contact_id, task.created_at,
    );
    if (task.contact_id && !teamReplied && CLIENT_WAITING.includes(task.type) && company.settings.team.client_message_on_overdue) {
      const contact = getContact(task.company_id, task.contact_id);
      await sendMessage(task.company_id, task.contact_id,
        `Oi${firstName(contact?.name) ? `, ${firstName(contact.name)}` : ''}! Só para avisar que não esquecemos de você: a equipe ainda está verificando e te retorna em breve. 🙏`,
        'system');
    }
    count++;
  }
  return count;
}

export function describePayload(task) {
  const p = task.payload || {};
  if (task.type === 'aprovar_cobranca') return `${p.description} — ${formatMoney(p.amount_cents)}`;
  return '';
}
