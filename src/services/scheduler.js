import { all, run, forEachDatabase } from '../db.js';
import { getCompany } from './company.js';
import { firstName } from './crm.js';
import { sendMessage } from './messaging.js';
import { processDueFollowups } from './followup.js';
import { processBilling } from './billing.js';
import { processOverdueTasks } from './tasks.js';
import { processGoogle } from './google.js';
import { processContracts } from './contracts.js';
import { processCourtesies } from './subscriptions.js';
import { formatLocal } from './time.js';

/** Envia lembretes de agendamento (ex.: 24h antes). */
export async function processAppointmentReminders() {
  let sent = 0;
  const horizon = new Date(Date.now() + 72 * 3600000).toISOString();
  const rows = all(
    `SELECT a.*, c.name AS contact_name FROM appointments a JOIN contacts c ON c.id = a.contact_id
     WHERE a.reminder_sent = 0 AND a.status IN ('agendado', 'confirmado') AND a.start_at > ? AND a.start_at <= ?`,
    new Date().toISOString(), horizon,
  );
  for (const a of rows) {
    const company = getCompany(a.company_id);
    if (company.status !== 'ativa') continue;
    const hoursBefore = company.settings.scheduling.reminder_hours_before;
    if (!hoursBefore || Date.parse(a.start_at) - Date.now() > hoursBefore * 3600000) continue;
    run('UPDATE appointments SET reminder_sent = 1 WHERE id = ?', a.id);
    const when = formatLocal(a.start_at, company.timezone, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    await sendMessage(a.company_id, a.contact_id,
      `Oi, ${firstName(a.contact_name) || 'tudo bem'}! Lembrete do seu horário na ${company.name}: *${a.title}* — ${when}. Responda *SIM* para confirmar ou me avise se precisar remarcar. 😉`,
      'system');
    sent++;
  }
  return sent;
}

let timer = null;
let busy = false;

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    let followups = 0; let billing = 0; let reminders = 0; let overdue = 0; let contracts = 0;
    // Cortesias ficam no banco principal (empresas): uma vez por rodada, fora do laço por banco.
    const courtesies = processCourtesies();
    if (courtesies) console.log(`[agendador] cortesias encerradas: ${courtesies}`);
    await forEachDatabase(async () => {
      followups += await processDueFollowups();
      billing += await processBilling();
      reminders += await processAppointmentReminders();
      overdue += await processOverdueTasks();
      contracts += await processContracts();
      await processGoogle();
    });
    if (followups || billing || reminders || overdue || contracts) {
      console.log(`[agendador] follow-ups: ${followups}, lembretes de cobrança: ${billing}, lembretes de agenda: ${reminders}, tarefas atrasadas: ${overdue}, contratos: ${contracts}`);
    }
  } catch (err) {
    console.error('[agendador] erro:', err);
  } finally {
    busy = false;
  }
}

export function startScheduler(intervalMs) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  setTimeout(tick, 3000);
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}
