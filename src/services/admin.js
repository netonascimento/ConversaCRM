import fs from 'node:fs';
import { main, mainDb, tenantDb, tenantDbFile, closeTenantDb, withCompanyDb, all } from '../db.js';
import { getCompany, maskSettings } from './company.js';

// Tabelas com dados de cada empresa, na ordem em que podem ser copiadas (respeita as referências).
export const TENANT_TABLES = [
  'products', 'professionals', 'professional_services', 'contacts', 'activities', 'appointments', 'messages',
  'sequences', 'enrollments', 'charges', 'tasks', 'prospect_searches', 'prospects', 'google_connections',
];

export function audit(actor, action, companyId = null, details = '') {
  main.run('INSERT INTO audit_log (actor, action, company_id, details) VALUES (?, ?, ?, ?)', actor, action, companyId, details);
}

export const listAudit = (companyId = null) => main.all(
  `SELECT l.*, c.name AS company_name FROM audit_log l LEFT JOIN companies c ON c.id = l.company_id
   ${companyId ? 'WHERE l.company_id = ?' : ''} ORDER BY l.id DESC LIMIT 300`, ...(companyId ? [companyId] : []),
);

/** Números de uso de uma empresa (lidos no banco dela). */
export function companyUsage(companyId) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const counts = withCompanyDb(companyId, () => {
    const one = (sql, ...p) => Object.values(all(sql, ...p)[0] || {})[0] || 0;
    return {
      contacts: one('SELECT COUNT(*) FROM contacts WHERE company_id = ?', companyId),
      leads_30d: one('SELECT COUNT(*) FROM contacts WHERE company_id = ? AND created_at >= ?', companyId, since),
      messages_30d: one('SELECT COUNT(*) FROM messages WHERE company_id = ? AND created_at >= ?', companyId, since),
      ai_messages_30d: one("SELECT COUNT(*) FROM messages WHERE company_id = ? AND author = 'ai' AND created_at >= ?", companyId, since),
      appointments_30d: one('SELECT COUNT(*) FROM appointments WHERE company_id = ? AND created_at >= ?', companyId, since),
      revenue_30d_cents: one("SELECT COALESCE(SUM(amount_cents), 0) FROM charges WHERE company_id = ? AND status = 'pago' AND paid_at >= ?", companyId, since),
    };
  });
  const users = main.get('SELECT COUNT(*) AS n, SUM(active) AS active, MAX(last_login_at) AS last_login FROM users WHERE company_id = ?', companyId);
  return { ...counts, users: users.n, active_users: users.active || 0, last_login_at: users.last_login };
}

export function listCompanies() {
  return main.all('SELECT id, name, status, plan, max_users, max_leads, segment, storage, public_id, notes, created_at FROM companies ORDER BY name')
    .map((c) => ({ ...c, usage: companyUsage(c.id) }));
}

export function companyDetail(companyId) {
  const company = getCompany(companyId);
  if (!company) return null;
  const { settings, ...rest } = company;
  return {
    ...rest,
    whatsapp_provider: settings.whatsapp.provider,
    billing_provider: settings.billing.provider,
    ai_objective: settings.ai.objective,
    usage: companyUsage(companyId),
    users: main.all('SELECT id, name, email, role, active, professional_id, last_login_at, created_at FROM users WHERE company_id = ? ORDER BY active DESC, name', companyId),
    professionals: withCompanyDb(companyId, () => all('SELECT id, name FROM professionals WHERE company_id = ? AND active = 1 ORDER BY name', companyId)),
  };
}

export function updateCompany(companyId, data) {
  const c = main.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  // Limite de leads: vazio = ilimitado.
  const maxLeads = data.max_leads === undefined ? c.max_leads : (data.max_leads === '' || data.max_leads === null ? null : Number(data.max_leads));
  main.run('UPDATE companies SET name = ?, plan = ?, max_users = ?, max_leads = ?, notes = ? WHERE id = ?',
    data.name?.trim() || c.name, data.plan ?? c.plan, Number(data.max_users) || c.max_users, maxLeads, data.notes ?? c.notes, companyId);
  return companyDetail(companyId);
}

export function setStatus(companyId, status) {
  main.run('UPDATE companies SET status = ? WHERE id = ?', status, companyId);
  // Suspensa: derruba as sessões abertas dos usuários.
  if (status !== 'ativa') main.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
}

// Linhas da empresa em cada tabela (professional_services não tem company_id: vai pelo profissional).
function rowsOf(db, table, companyId) {
  if (table === 'professional_services') {
    return db.prepare('SELECT ps.* FROM professional_services ps JOIN professionals p ON p.id = ps.professional_id WHERE p.company_id = ?').all(companyId);
  }
  return db.prepare(`SELECT * FROM ${table} WHERE company_id = ?`).all(companyId);
}

function deleteRows(db, table, companyId) {
  if (table === 'professional_services') {
    db.prepare('DELETE FROM professional_services WHERE professional_id IN (SELECT id FROM professionals WHERE company_id = ?)').run(companyId);
  } else {
    db.prepare(`DELETE FROM ${table} WHERE company_id = ?`).run(companyId);
  }
}

/** Todos os dados da empresa, para entregar ao cliente (LGPD) ou guardar como backup. */
export function exportCompany(companyId) {
  const company = getCompany(companyId);
  const db = company.storage === 'dedicated' ? tenantDb(company.public_id) : mainDb;
  const data = Object.fromEntries(TENANT_TABLES.map((t) => [t, rowsOf(db, t, companyId)]));
  // Tokens de acesso ao Google não saem na exportação.
  data.google_connections = data.google_connections.map(({ refresh_token: r, access_token: a, ...rest }) => rest);
  const { settings, ...info } = company;
  return {
    exported_at: new Date().toISOString(),
    company: { ...info, settings: maskSettings(settings) },
    users: main.all('SELECT id, name, email, role, active, created_at, last_login_at FROM users WHERE company_id = ?', companyId),
    data,
  };
}

/** Move os dados de uma empresa do banco compartilhado para um banco só dela. */
export function moveToDedicated(companyId) {
  const company = getCompany(companyId);
  if (!company) throw new Error('Empresa não encontrada');
  if (company.storage === 'dedicated') throw new Error('Esta empresa já usa um banco separado');
  const target = tenantDb(company.public_id);
  try {
    target.exec('BEGIN');
    // As tabelas da empresa referenciam companies(id): o banco dedicado guarda uma cópia mínima do registro.
    target.prepare('INSERT OR IGNORE INTO companies (id, name, public_id) VALUES (?, ?, ?)').run(companyId, company.name, company.public_id);
    for (const table of TENANT_TABLES) {
      for (const row of rowsOf(mainDb, table, companyId)) {
        const cols = Object.keys(row);
        target.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      }
    }
    target.exec('COMMIT');
  } catch (err) {
    try { target.exec('ROLLBACK'); } catch { /* já encerrada */ }
    closeTenantDb(company.public_id);
    removeTenantFile(company.public_id);
    throw err;
  }
  mainDb.exec('BEGIN');
  try {
    mainDb.prepare("UPDATE companies SET storage = 'dedicated' WHERE id = ?").run(companyId);
    for (const table of [...TENANT_TABLES].reverse()) deleteRows(mainDb, table, companyId);
    mainDb.exec('COMMIT');
  } catch (err) {
    mainDb.exec('ROLLBACK');
    throw err;
  }
  return companyDetail(companyId);
}

function removeTenantFile(publicId) {
  const file = tenantDbFile(publicId);
  if (file === ':memory:') return;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
}

/** Apaga a empresa e todos os dados dela. Não tem volta. */
export function deleteCompany(companyId) {
  const company = getCompany(companyId);
  if (!company) return false;
  if (company.storage === 'dedicated') {
    closeTenantDb(company.public_id);
    removeTenantFile(company.public_id);
  } else {
    mainDb.exec('BEGIN');
    try {
      for (const table of [...TENANT_TABLES].reverse()) deleteRows(mainDb, table, companyId);
      mainDb.exec('COMMIT');
    } catch (err) {
      mainDb.exec('ROLLBACK');
      throw err;
    }
  }
  main.run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
  main.run('DELETE FROM users WHERE company_id = ?', companyId);
  main.run('DELETE FROM companies WHERE id = ?', companyId);
  return true;
}

export function platformOverview() {
  const companies = listCompanies();
  const sum = (k) => companies.reduce((n, c) => n + (c.usage[k] || 0), 0);
  return {
    companies: companies.length,
    active: companies.filter((c) => c.status === 'ativa').length,
    suspended: companies.filter((c) => c.status !== 'ativa').length,
    dedicated: companies.filter((c) => c.storage === 'dedicated').length,
    users: sum('active_users'),
    messages_30d: sum('messages_30d'),
    ai_messages_30d: sum('ai_messages_30d'),
    leads_30d: sum('leads_30d'),
    list: companies,
  };
}
