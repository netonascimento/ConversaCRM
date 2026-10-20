import { all, run } from '../db.js';
import { getCompany } from './company.js';
import { UNKNOWN_BIRTH_YEAR, logActivity } from './crm.js';
import { triggerSequences } from './followup.js';
import { todayIn } from './time.js';

// Aniversariantes: lista do mês e o gatilho "No dia do aniversário" dos follow-ups.

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Aniversariantes de um mês (1–12), com a idade que fazem e quantos dias faltam. */
export function listBirthdays(companyId, month) {
  const company = getCompany(companyId);
  const today = todayIn(company.timezone);
  const year = Number(today.slice(0, 4));
  const mm = String(month).padStart(2, '0');
  return all(
    `SELECT id, name, phone, stage, birth_date, birthday_year FROM contacts
     WHERE company_id = ? AND birth_date IS NOT NULL AND substr(birth_date, 6, 2) = ? ORDER BY substr(birth_date, 9, 2), name COLLATE NOCASE`,
    companyId, mm,
  ).map((c) => {
    const [by, m, d] = c.birth_date.split('-').map(Number);
    // 29/02 em ano que não é bissexto: comemora em 28/02.
    const day = m === 2 && d === 29 && !isLeap(year) ? 28 : d;
    let next = `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (next < today) next = `${year + 1}-${String(m).padStart(2, '0')}-${String(m === 2 && d === 29 && !isLeap(year + 1) ? 28 : d).padStart(2, '0')}`;
    const daysUntil = Math.round((Date.parse(`${next}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
    return { ...c, day, turns: by === UNKNOWN_BIRTH_YEAR ? null : Number(next.slice(0, 4)) - by, days_until: daysUntil, today: daysUntil === 0 };
  });
}

/** Agendador: no dia do aniversário, inscreve o contato nas sequências "No dia do aniversário" (uma vez por ano). */
export function processBirthdays() {
  let count = 0;
  for (const { company_id: companyId } of all("SELECT DISTINCT company_id FROM sequences WHERE trigger = 'birthday' AND active = 1")) {
    const company = getCompany(companyId);
    if (!company || company.status !== 'ativa') continue;
    const today = todayIn(company.timezone);
    const year = Number(today.slice(0, 4));
    const md = today.slice(5);
    const days = [md];
    if (md === '02-28' && !isLeap(year)) days.push('02-29');
    const rows = all(
      `SELECT id, name FROM contacts WHERE company_id = ? AND birth_date IS NOT NULL AND substr(birth_date, 6, 5) IN (${days.map(() => '?').join(', ')})
       AND (birthday_year IS NULL OR birthday_year < ?)`,
      companyId, ...days, year,
    );
    for (const c of rows) {
      run('UPDATE contacts SET birthday_year = ? WHERE id = ?', year, c.id);
      logActivity(companyId, c.id, 'followup', 'Aniversário hoje 🎂: mensagem de parabéns programada');
      triggerSequences(companyId, c.id, 'birthday');
      count++;
    }
  }
  return count;
}

export const birthdaysSoon = (companyId) => {
  const today = todayIn(getCompany(companyId).timezone);
  const m = Number(today.slice(5, 7));
  const list = [...listBirthdays(companyId, m), ...listBirthdays(companyId, (m % 12) + 1)];
  return list.filter((c) => c.days_until <= 7);
};
