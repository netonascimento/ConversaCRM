import { all, get, run, transaction } from '../db.js';
import { normalizePhone } from './crm.js';

// Profissionais (advogados, dentistas, consultores...) com agenda e serviços próprios.
// Sem nenhum profissional ativo, a agenda funciona como uma agenda única da empresa.

function parse(row) {
  if (!row) return null;
  return {
    ...row,
    business_hours: row.business_hours ? JSON.parse(row.business_hours) : null,
    blocked_dates: JSON.parse(row.blocked_dates || '[]'),
    services: all('SELECT product_id FROM professional_services WHERE professional_id = ?', row.id).map((r) => r.product_id),
  };
}

export const getProfessional = (companyId, id) => parse(get('SELECT * FROM professionals WHERE company_id = ? AND id = ?', companyId, id));

export function listProfessionals(companyId, { activeOnly = false } = {}) {
  return all(`SELECT * FROM professionals WHERE company_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY active DESC, name`, companyId).map(parse);
}

export const hasProfessionals = (companyId) =>
  Boolean(get('SELECT 1 FROM professionals WHERE company_id = ? AND active = 1 LIMIT 1', companyId));

/** Profissionais ativos que atendem o serviço (quem não tem serviços vinculados atende todos). */
export function eligibleProfessionals(companyId, productId = null) {
  const pros = listProfessionals(companyId, { activeOnly: true });
  if (!productId) return pros;
  return pros.filter((p) => !p.services.length || p.services.includes(Number(productId)));
}

function cleanHours(hours) {
  if (!hours) return null;
  const out = {};
  for (const d of ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab']) {
    out[d] = (hours[d] || []).filter((r) => Array.isArray(r) && /^\d{2}:\d{2}$/.test(r[0]) && /^\d{2}:\d{2}$/.test(r[1]) && r[0] < r[1]);
  }
  return out;
}

export function saveProfessional(companyId, data, id = null) {
  if (!data.name?.trim()) throw new Error('Informe o nome do profissional');
  const services = (data.services || []).map(Number).filter((pid) => get('SELECT 1 FROM products WHERE id = ? AND company_id = ?', pid, companyId));
  const values = [
    data.name.trim(), (data.role || '').trim(), normalizePhone(data.phone), data.color || '#1f7a45',
    data.business_hours ? JSON.stringify(cleanHours(data.business_hours)) : null,
    JSON.stringify((data.blocked_dates || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))),
    data.active === false ? 0 : 1,
  ];
  return transaction(() => {
    if (id) {
      run('UPDATE professionals SET name = ?, role = ?, phone = ?, color = ?, business_hours = ?, blocked_dates = ?, active = ? WHERE id = ? AND company_id = ?', ...values, id, companyId);
    } else {
      id = run('INSERT INTO professionals (name, role, phone, color, business_hours, blocked_dates, active, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...values, companyId).id;
    }
    run('DELETE FROM professional_services WHERE professional_id = ?', id);
    for (const pid of services) run('INSERT INTO professional_services (professional_id, product_id) VALUES (?, ?)', id, pid);
    return getProfessional(companyId, id);
  });
}

export function deleteProfessional(companyId, id) {
  run('UPDATE appointments SET professional_id = NULL WHERE professional_id = ? AND company_id = ?', id, companyId);
  run('DELETE FROM professionals WHERE id = ? AND company_id = ?', id, companyId);
}
