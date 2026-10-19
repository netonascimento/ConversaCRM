import { main, all, get, run, now, withCompanyDb } from '../db.js';
import { getCompany } from './company.js';
import { getContact, logActivity } from './crm.js';

// Responsável por cada conversa. Os usuários ficam no banco principal; os contatos, no banco
// da empresa — por isso os nomes são resolvidos aqui, e não por JOIN.

/** Usuários ativos que podem atender conversas (dono e atendentes). */
export const assignableUsers = (companyId) => main.all(
  "SELECT id, name, role FROM users WHERE company_id = ? AND active = 1 AND role IN ('owner', 'agent') ORDER BY name", companyId,
);

export const userNames = (companyId) => Object.fromEntries(
  main.all('SELECT id, name FROM users WHERE company_id = ?', companyId).map((u) => [u.id, u.name]),
);

/** Define (ou tira, com userId null) o responsável pela conversa. `by` é quem fez a mudança. */
export function assignContact(companyId, contactId, userId, by = null) {
  const contact = getContact(companyId, contactId);
  if (!contact) return null;
  let target = null;
  if (userId) {
    target = assignableUsers(companyId).find((u) => u.id === Number(userId));
    if (!target) throw new Error('Usuário não encontrado ou sem acesso ao atendimento');
  }
  if ((contact.assigned_user_id || null) === (target?.id || null)) return contact;
  run('UPDATE contacts SET assigned_user_id = ?, assigned_at = ? WHERE id = ?', target?.id || null, target ? now() : null, contactId);
  const who = by?.name || 'Sistema';
  let text;
  if (!target) text = `${who} tirou o responsável da conversa`;
  else if (by?.id === target.id) text = `${who} assumiu a conversa`;
  else text = `${who} passou a conversa para ${target.name}`;
  logActivity(companyId, contactId, 'atendimento', text);
  return getContact(companyId, contactId);
}

/**
 * Distribuição automática (se ligada): entrega a conversa sem responsável para o atendente
 * que recebeu conversa há mais tempo (rodízio). Sem atendentes, vai para o dono.
 */
export function autoAssign(companyId, contactId) {
  const company = getCompany(companyId);
  if (!company?.settings.team.auto_assign) return null;
  const contact = getContact(companyId, contactId);
  if (!contact || contact.assigned_user_id) return null;
  const users = assignableUsers(companyId);
  const agents = users.filter((u) => u.role === 'agent');
  const pool = agents.length ? agents : users;
  if (!pool.length) return null;
  const lastAt = (u) => get('SELECT MAX(assigned_at) AS t FROM contacts WHERE company_id = ? AND assigned_user_id = ?', companyId, u.id).t || '';
  const next = pool.map((u) => ({ u, t: lastAt(u) })).sort((a, b) => a.t.localeCompare(b.t) || a.u.id - b.u.id)[0].u;
  run('UPDATE contacts SET assigned_user_id = ?, assigned_at = ? WHERE id = ?', next.id, now(), contactId);
  logActivity(companyId, contactId, 'atendimento', `Conversa distribuída automaticamente para ${next.name}`);
  return next;
}

/**
 * Usuário desativado (ou que virou Profissional) deixa de atender: as conversas dele
 * voltam para "sem responsável", para alguém da equipe assumir.
 */
export function releaseAssignments(companyId, user) {
  if (user.active && user.role !== 'professional') return 0;
  return withCompanyDb(companyId, () => {
    const rows = all('SELECT id FROM contacts WHERE company_id = ? AND assigned_user_id = ?', companyId, user.id);
    for (const r of rows) {
      run('UPDATE contacts SET assigned_user_id = NULL, assigned_at = NULL WHERE id = ?', r.id);
      logActivity(companyId, r.id, 'atendimento', `${user.name} saiu do atendimento: conversa sem responsável`);
    }
    return rows.length;
  });
}

/** Tira a IA da conversa e chama a equipe (distribuindo, se a empresa usa rodízio). */
export function handToHuman(companyId, contactId) {
  run('UPDATE contacts SET ai_enabled = 0 WHERE id = ?', contactId);
  autoAssign(companyId, contactId);
}
