import { all, get, run, now } from '../db.js';
import { getCompany } from './company.js';
import { getContact, render, firstName, logActivity } from './crm.js';
import { sendMessage } from './messaging.js';
import { writeFollowup } from './ai.js';
import { nextBusinessTime } from './time.js';

export const TRIGGERS = [
  { id: 'manual', label: 'Manual (eu escolho quem entra)' },
  { id: 'new_lead', label: 'Novo lead criado' },
  { id: 'stage:contato', label: 'Lead entrou em "Em contato"' },
  { id: 'stage:qualificado', label: 'Lead entrou em "Qualificado"' },
  { id: 'stage:proposta', label: 'Lead entrou em "Proposta"' },
  { id: 'stage:ganho', label: 'Venda ganha (pós-venda)' },
  { id: 'stage:perdido', label: 'Lead perdido (reativação)' },
  { id: 'prospect', label: 'Prospect importado do Google Maps' },
];

export function parseSequence(row) {
  return row && { ...row, steps: JSON.parse(row.steps || '[]') };
}

export const listSequences = (companyId) =>
  all(`SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id = s.id AND e.status = 'ativo') AS active_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id = s.id) AS total_count
       FROM sequences s WHERE company_id = ? ORDER BY id`, companyId).map(parseSequence);

export function enroll(companyId, sequenceId, contactId) {
  const seq = parseSequence(get('SELECT * FROM sequences WHERE id = ? AND company_id = ?', sequenceId, companyId));
  if (!seq || !seq.steps.length) return null;
  const already = get("SELECT id FROM enrollments WHERE sequence_id = ? AND contact_id = ? AND status = 'ativo'", sequenceId, contactId);
  if (already) return already.id;
  const runAt = new Date(Date.now() + Number(seq.steps[0].delay_hours || 0) * 3600000).toISOString();
  const { id } = run(
    'INSERT INTO enrollments (company_id, sequence_id, contact_id, next_run_at) VALUES (?, ?, ?, ?)',
    companyId, sequenceId, contactId, runAt,
  );
  logActivity(companyId, contactId, 'followup', `Entrou no follow-up "${seq.name}"`);
  return id;
}

export function triggerSequences(companyId, contactId, trigger) {
  for (const s of all('SELECT id FROM sequences WHERE company_id = ? AND active = 1 AND trigger = ?', companyId, trigger)) {
    enroll(companyId, s.id, contactId);
  }
}

export function stopEnrollments(companyId, contactId, reason, { onlyStopOnReply = false } = {}) {
  const rows = all(
    `SELECT e.id, s.name FROM enrollments e JOIN sequences s ON s.id = e.sequence_id
     WHERE e.company_id = ? AND e.contact_id = ? AND e.status = 'ativo' ${onlyStopOnReply ? 'AND s.stop_on_reply = 1' : ''}`,
    companyId, contactId,
  );
  for (const r of rows) {
    run("UPDATE enrollments SET status = 'parado', stop_reason = ? WHERE id = ?", reason, r.id);
    logActivity(companyId, contactId, 'followup', `Follow-up "${r.name}" encerrado: ${reason}`);
  }
  return rows.length;
}

/** Executa os passos de follow-up que venceram. Chamado pelo agendador. */
export async function processDueFollowups() {
  const due = all("SELECT * FROM enrollments WHERE status = 'ativo' AND next_run_at <= ? ORDER BY next_run_at LIMIT 100", now());
  let sent = 0;
  for (const e of due) {
    const company = getCompany(e.company_id);
    if (company.status !== 'ativa') continue;
    const seq = parseSequence(get('SELECT * FROM sequences WHERE id = ?', e.sequence_id));
    const contact = getContact(e.company_id, e.contact_id);
    if (!seq || !seq.active || !contact) {
      run("UPDATE enrollments SET status = 'parado', stop_reason = 'sequência ou contato indisponível' WHERE id = ?", e.id);
      continue;
    }
    // Só envia dentro do horário comercial: senão reagenda para a próxima abertura.
    const sendAt = nextBusinessTime(new Date(), company.timezone, company.settings.business_hours);
    if (sendAt.getTime() > Date.now() + 1000) {
      run('UPDATE enrollments SET next_run_at = ? WHERE id = ?', sendAt.toISOString(), e.id);
      continue;
    }
    const step = seq.steps[e.step_index];
    const nextIndex = e.step_index + 1;
    // Avança antes de enviar para nunca mandar a mesma mensagem duas vezes.
    if (nextIndex >= seq.steps.length) {
      run("UPDATE enrollments SET step_index = ?, status = 'concluido' WHERE id = ?", nextIndex, e.id);
    } else {
      const nextAt = new Date(Date.now() + Number(seq.steps[nextIndex].delay_hours || 0) * 3600000).toISOString();
      run('UPDATE enrollments SET step_index = ?, next_run_at = ? WHERE id = ?', nextIndex, nextAt, e.id);
    }
    const vars = { nome: firstName(contact.name), nome_completo: contact.name, empresa: company.name, interesse: contact.interest, negocio: contact.business_name || contact.name };
    let text = render(step.message, vars);
    if (step.use_ai) text = (await writeFollowup(company, contact, text, e.step_index + 1)) || text;
    await sendMessage(e.company_id, e.contact_id, text, 'followup');
    logActivity(e.company_id, e.contact_id, 'followup', `Follow-up "${seq.name}" — passo ${e.step_index + 1} enviado`);
    sent++;
  }
  return sent;
}
