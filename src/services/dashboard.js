import { all, get } from '../db.js';
import { getCompany } from './company.js';
import { STAGES } from './crm.js';
import { zonedParts, zonedToUtc, todayIn, addDays } from './time.js';

export function getMetrics(companyId, periodDays = 30) {
  const company = getCompany(companyId);
  const tz = company.timezone;
  const today = todayIn(tz);
  const firstDay = addDays(today, -(periodDays - 1));
  const since = zonedToUtc(firstDay, '00:00', tz).toISOString();
  const todayStart = zonedToUtc(today, '00:00', tz).toISOString();
  const tomorrowStart = zonedToUtc(addDays(today, 1), '00:00', tz).toISOString();
  const weekEnd = zonedToUtc(addDays(today, 7), '00:00', tz).toISOString();
  const one = (sql, ...p) => Object.values(get(sql, companyId, ...p))[0] || 0;

  const leadsNew = one('SELECT COUNT(*) FROM contacts WHERE company_id = ? AND created_at >= ?', since);
  const won = one('SELECT COUNT(*) FROM contacts WHERE company_id = ? AND won_at >= ?', since);
  const stages = Object.fromEntries(STAGES.map((s) => [s.id, 0]));
  for (const r of all('SELECT stage, COUNT(*) AS n FROM contacts WHERE company_id = ? GROUP BY stage', companyId)) stages[r.stage] = r.n;
  const sources = Object.fromEntries(all('SELECT source, COUNT(*) AS n FROM contacts WHERE company_id = ? AND created_at >= ? GROUP BY source', companyId, since).map((r) => [r.source, r.n]));

  const apptsPeriod = all("SELECT status FROM appointments WHERE company_id = ? AND start_at >= ? AND start_at < ?", companyId, since, tomorrowStart);
  const finished = apptsPeriod.filter((a) => ['concluido', 'faltou'].includes(a.status));
  const msgs = Object.fromEntries(all('SELECT author, COUNT(*) AS n FROM messages WHERE company_id = ? AND created_at >= ? GROUP BY author', companyId, since).map((r) => [r.author, r.n]));

  // Séries diárias (receita e leads) no fuso da empresa.
  const days = Array.from({ length: periodDays }, (_, i) => addDays(firstDay, i));
  const revenueByDay = Object.fromEntries(days.map((d) => [d, 0]));
  for (const c of all("SELECT amount_cents, paid_at FROM charges WHERE company_id = ? AND status = 'pago' AND paid_at >= ?", companyId, since)) {
    const d = zonedParts(new Date(c.paid_at), tz).date;
    if (d in revenueByDay) revenueByDay[d] += c.amount_cents;
  }
  const leadsByDay = Object.fromEntries(days.map((d) => [d, 0]));
  for (const c of all('SELECT created_at FROM contacts WHERE company_id = ? AND created_at >= ?', companyId, since)) {
    const d = zonedParts(new Date(c.created_at), tz).date;
    if (d in leadsByDay) leadsByDay[d]++;
  }

  return {
    period_days: periodDays,
    leads_new: leadsNew,
    won,
    conversion_rate: leadsNew ? Math.round((won / leadsNew) * 1000) / 10 : 0,
    revenue_cents: one("SELECT SUM(amount_cents) FROM charges WHERE company_id = ? AND status = 'pago' AND paid_at >= ?", since),
    receivable_cents: one("SELECT SUM(amount_cents) FROM charges WHERE company_id = ? AND status = 'pendente'"),
    overdue_cents: one("SELECT SUM(amount_cents) FROM charges WHERE company_id = ? AND status = 'vencido'"),
    overdue_count: one("SELECT COUNT(*) FROM charges WHERE company_id = ? AND status = 'vencido'"),
    pipeline_cents: one("SELECT SUM(value_cents) FROM contacts WHERE company_id = ? AND stage NOT IN ('ganho', 'perdido')"),
    stages,
    sources,
    appointments_today: one("SELECT COUNT(*) FROM appointments WHERE company_id = ? AND status != 'cancelado' AND start_at >= ? AND start_at < ?", todayStart, tomorrowStart),
    appointments_upcoming: one("SELECT COUNT(*) FROM appointments WHERE company_id = ? AND status != 'cancelado' AND start_at >= ? AND start_at < ?", new Date().toISOString(), weekEnd),
    no_show_rate: finished.length ? Math.round((finished.filter((a) => a.status === 'faltou').length / finished.length) * 1000) / 10 : 0,
    messages_in: msgs.contact || 0,
    ai_messages: msgs.ai || 0,
    human_messages: msgs.human || 0,
    followup_messages: msgs.followup || 0,
    billing_messages: msgs.billing || 0,
    followups_active: one("SELECT COUNT(*) FROM enrollments WHERE company_id = ? AND status = 'ativo'"),
    tasks_open: one("SELECT COUNT(*) FROM tasks WHERE company_id = ? AND status = 'aberta'"),
    tasks_overdue: one("SELECT COUNT(*) FROM tasks WHERE company_id = ? AND status = 'aberta' AND due_at < ?", new Date().toISOString()),
    appointments_pending: one("SELECT COUNT(*) FROM appointments WHERE company_id = ? AND status = 'solicitado' AND start_at >= ?", new Date().toISOString()),
    series: days.map((d) => ({ date: d, revenue_cents: revenueByDay[d], leads: leadsByDay[d] })),
  };
}

export function getDashboard(companyId, periodDays = 30) {
  const nowIso = new Date().toISOString();
  return {
    metrics: getMetrics(companyId, periodDays),
    upcoming: all(
      `SELECT a.id, a.title, a.start_at, a.status, c.name AS contact_name FROM appointments a
       LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.company_id = ? AND a.status != 'cancelado' AND a.start_at >= ? ORDER BY a.start_at LIMIT 6`, companyId, nowIso),
    overdue: all(
      `SELECT ch.id, ch.description, ch.amount_cents, ch.due_date, c.name AS contact_name FROM charges ch
       LEFT JOIN contacts c ON c.id = ch.contact_id
       WHERE ch.company_id = ? AND ch.status = 'vencido' ORDER BY ch.due_date LIMIT 6`, companyId),
    activities: all(
      `SELECT a.*, c.name AS contact_name FROM activities a LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.company_id = ? ORDER BY a.id DESC LIMIT 12`, companyId),
  };
}
