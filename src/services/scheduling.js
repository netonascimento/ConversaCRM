import { all, get, run } from '../db.js';
import { getCompany } from './company.js';
import { getContact, logActivity, changeStage, firstName } from './crm.js';
import { sendMessage, sendToPhone } from './messaging.js';
import { closeTasksFor } from './tasks.js';
import { eligibleProfessionals, hasProfessionals, getProfessional } from './professionals.js';
import { busyIntervals, queueAppointmentSync } from './google.js';
import { zonedToUtc, zonedParts, weekdayOf, WEEKDAYS, toMin, formatLocal, addDays } from './time.js';

const ACTIVE = "status NOT IN ('cancelado')";

function durationFor(company, productId) {
  if (productId) {
    const p = get('SELECT duration_min FROM products WHERE id = ? AND company_id = ?', productId, company.id);
    if (p?.duration_min) return p.duration_min;
  }
  return company.settings.scheduling.default_duration_min;
}

function overlapping(companyId, startIso, endIso, ignoreId = 0) {
  return get(
    `SELECT COUNT(*) AS n FROM appointments WHERE company_id = ? AND ${ACTIVE} AND id != ? AND start_at < ? AND end_at > ?`,
    companyId, ignoreId, endIso, startIso,
  ).n;
}

// Agendamentos sem profissional (de antes do cadastro da equipe) bloqueiam todos.
function overlappingForPro(companyId, proId, startIso, endIso, ignoreId = 0) {
  return get(
    `SELECT COUNT(*) AS n FROM appointments WHERE company_id = ? AND ${ACTIVE} AND id != ?
     AND (professional_id = ? OR professional_id IS NULL) AND start_at < ? AND end_at > ?`,
    companyId, ignoreId, proId, endIso, startIso,
  ).n;
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Gera os inícios possíveis num dia a partir das faixas de horário.
function* candidateStarts(ranges, duration, interval) {
  for (const [open, close] of ranges) {
    for (let m = toMin(open); m + duration <= toMin(close); m += interval) yield hhmm(m);
  }
}

/**
 * Horários livres em uma data (YYYY-MM-DD, no fuso da empresa).
 * Com profissionais cadastrados, cada horário traz quem está livre nele.
 */
export function availableSlots(companyId, dateStr, productId = null, professionalId = null) {
  const company = getCompany(companyId);
  const { scheduling, business_hours: hours } = company.settings;
  const tz = company.timezone;
  if (scheduling.blocked_dates.includes(dateStr)) return [];
  const duration = durationFor(company, productId);
  const earliest = Date.now() + scheduling.min_notice_min * 60000;
  const dayStart = zonedToUtc(dateStr, '00:00', tz).toISOString();
  const dayEnd = zonedToUtc(addDays(dateStr, 1), '00:00', tz).toISOString();
  const booked = all(
    `SELECT start_at, end_at, professional_id FROM appointments WHERE company_id = ? AND ${ACTIVE} AND start_at < ? AND end_at > ?`,
    companyId, dayEnd, dayStart,
  ).map((a) => ({ s: Date.parse(a.start_at), e: Date.parse(a.end_at), pro: a.professional_id }));
  const weekday = WEEKDAYS[weekdayOf(dateStr)];

  const overlapsGoogle = (busy, start, end) => busy.some(([s, e]) => s < end && e > start);

  if (!hasProfessionals(companyId)) {
    const googleBusy = busyIntervals(companyId, null);
    const slots = [];
    for (const time of candidateStarts(hours[weekday] || [], duration, scheduling.slot_interval_min)) {
      const start = zonedToUtc(dateStr, time, tz).getTime();
      const end = start + duration * 60000;
      if (start < earliest || overlapsGoogle(googleBusy, start, end)) continue;
      if (booked.filter((b) => b.s < end && b.e > start).length < scheduling.capacity) slots.push({ time, start_at: new Date(start).toISOString() });
    }
    return slots;
  }

  let pros = eligibleProfessionals(companyId, productId);
  if (professionalId) pros = pros.filter((p) => p.id === Number(professionalId));
  const byTime = new Map();
  for (const pro of pros) {
    if (pro.blocked_dates.includes(dateStr)) continue;
    const ranges = (pro.business_hours || hours)[weekday] || [];
    const googleBusy = busyIntervals(companyId, pro.id);
    for (const time of candidateStarts(ranges, duration, scheduling.slot_interval_min)) {
      const start = zonedToUtc(dateStr, time, tz).getTime();
      const end = start + duration * 60000;
      if (start < earliest) continue;
      if (booked.some((b) => (b.pro === pro.id || b.pro === null) && b.s < end && b.e > start)) continue;
      if (overlapsGoogle(googleBusy, start, end)) continue;
      if (!byTime.has(time)) byTime.set(time, { time, start_at: new Date(start).toISOString(), professionals: [] });
      byTime.get(time).professionals.push({ id: pro.id, name: pro.name });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
}

/** Próximos dias com horários livres (para a IA sugerir). */
export function nextAvailableSlots(companyId, { productId = null, professionalId = null, days = 7, perDay = 4 } = {}) {
  const company = getCompany(companyId);
  const today = zonedParts(new Date(), company.timezone).date;
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i);
    const slots = availableSlots(companyId, date, productId, professionalId);
    if (slots.length) out.push({ date, times: slots.slice(0, perDay).map((s) => s.time), slots: slots.slice(0, perDay) });
  }
  return out;
}

// Entre os profissionais livres, escolhe o que tem menos atendimentos no dia (distribui a agenda).
function leastBusy(companyId, proIds, dateIso) {
  const day = dateIso.slice(0, 10);
  return [...proIds].sort((a, b) => {
    const count = (id) => get(`SELECT COUNT(*) AS n FROM appointments WHERE professional_id = ? AND ${ACTIVE} AND substr(start_at, 1, 10) = ?`, id, day).n;
    return count(a) - count(b);
  })[0];
}

export function createAppointment(companyId, {
  contactId = null, productId = null, professionalId = null, title, date, time, startAt, durationMin,
  notes = '', createdBy = 'manual', force = false, status = 'agendado',
}) {
  const company = getCompany(companyId);
  const start = startAt ? new Date(startAt) : zonedToUtc(date, time, company.timezone);
  if (Number.isNaN(start.getTime())) throw new Error('Data/hora inválida');
  const duration = durationMin || durationFor(company, productId);
  const end = new Date(start.getTime() + duration * 60000);
  const withPros = hasProfessionals(companyId);
  let proId = professionalId ? Number(professionalId) : null;

  if (!force) {
    const local = zonedParts(start, company.timezone);
    const slot = availableSlots(companyId, local.date, productId, proId).find((s) => s.start_at === start.toISOString());
    if (!slot) throw new Error(proId ? 'Esse profissional não está livre nesse horário' : 'Horário indisponível');
    if (withPros) proId = proId || leastBusy(companyId, slot.professionals.map((p) => p.id), start.toISOString());
  } else if (withPros) {
    const free = eligibleProfessionals(companyId, productId)
      .filter((p) => overlappingForPro(companyId, p.id, start.toISOString(), end.toISOString()) === 0)
      .map((p) => p.id);
    if (proId && !free.includes(proId)) {
      if (!getProfessional(companyId, proId)) throw new Error('Profissional não encontrado');
      throw new Error('Esse profissional já tem agendamento nesse horário');
    }
    if (!proId) {
      if (!free.length) throw new Error('Nenhum profissional livre nesse horário');
      proId = leastBusy(companyId, free, start.toISOString());
    }
  } else if (overlapping(companyId, start.toISOString(), end.toISOString()) >= company.settings.scheduling.capacity) {
    throw new Error('Já existe agendamento nesse horário');
  }

  const product = productId ? get('SELECT name FROM products WHERE id = ? AND company_id = ?', productId, companyId) : null;
  const contact = contactId ? getContact(companyId, contactId) : null;
  const pro = proId ? getProfessional(companyId, proId) : null;
  const finalTitle = title || [product?.name || 'Atendimento', contact?.name].filter(Boolean).join(' — ');
  const { id } = run(
    `INSERT INTO appointments (company_id, contact_id, product_id, professional_id, title, start_at, end_at, notes, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId, contactId, productId, proId, finalTitle, start.toISOString(), end.toISOString(), notes, createdBy, status,
  );
  const when = formatLocal(start.toISOString(), company.timezone);
  if (contact) {
    const verb = status === 'solicitado' ? 'Horário solicitado (aguardando confirmação)' : 'Agendado';
    logActivity(companyId, contactId, 'agenda', `${verb}: ${finalTitle}${pro ? ` com ${pro.name}` : ''} em ${when}${createdBy === 'ai' ? ' (pela IA)' : ''}`);
    if (['novo', 'contato'].includes(contact.stage)) changeStage(companyId, contactId, 'qualificado', 'agendamento realizado');
  }
  // Avisa o profissional no WhatsApp dele.
  if (pro?.phone && createdBy !== 'seed') {
    const head = status === 'solicitado' ? '⏳ Pedido de horário (aguardando confirmação)' : '📅 Novo agendamento';
    sendToPhone(company, pro.phone, `${head}: ${finalTitle} — ${when}`).catch(() => {});
  }
  if (createdBy !== 'seed') queueAppointmentSync(companyId, id);
  return getAppointment(companyId, id);
}

const SELECT_APPT = `SELECT a.*, c.name AS contact_name, c.phone AS contact_phone, p.name AS product_name,
  pr.name AS professional_name, pr.color AS professional_color
  FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id LEFT JOIN products p ON p.id = a.product_id
  LEFT JOIN professionals pr ON pr.id = a.professional_id`;

export const getAppointment = (companyId, id) => get(`${SELECT_APPT} WHERE a.company_id = ? AND a.id = ?`, companyId, id);

export function listAppointments(companyId, { from, to, contactId, professionalId } = {}) {
  const where = ['a.company_id = ?'];
  const params = [companyId];
  if (from) { where.push('a.start_at >= ?'); params.push(from); }
  if (to) { where.push('a.start_at < ?'); params.push(to); }
  if (contactId) { where.push('a.contact_id = ?'); params.push(contactId); }
  if (professionalId) { where.push('a.professional_id = ?'); params.push(professionalId); }
  return all(`${SELECT_APPT} WHERE ${where.join(' AND ')} ORDER BY a.start_at`, ...params);
}

export const APPOINTMENT_STATUSES = ['solicitado', 'agendado', 'confirmado', 'concluido', 'cancelado', 'faltou'];

export function updateAppointment(companyId, id, data) {
  const appt = getAppointment(companyId, id);
  if (!appt) return null;
  if (data.status && !APPOINTMENT_STATUSES.includes(data.status)) throw new Error('Status inválido');
  if (data.start_at) {
    const start = new Date(data.start_at);
    const duration = (Date.parse(appt.end_at) - Date.parse(appt.start_at)) / 60000;
    const end = new Date(start.getTime() + duration * 60000);
    const company = getCompany(companyId);
    const busy = appt.professional_id
      ? overlappingForPro(companyId, appt.professional_id, start.toISOString(), end.toISOString(), id) > 0
      : overlapping(companyId, start.toISOString(), end.toISOString(), id) >= company.settings.scheduling.capacity;
    if (busy) throw new Error('Já existe agendamento nesse horário');
    run('UPDATE appointments SET start_at = ?, end_at = ?, reminder_sent = 0 WHERE id = ?', start.toISOString(), end.toISOString(), id);
  }
  for (const k of ['status', 'notes', 'title']) if (data[k] !== undefined) run(`UPDATE appointments SET ${k} = ? WHERE id = ?`, data[k], id);
  if (data.start_at || data.status || data.title || data.notes !== undefined) queueAppointmentSync(companyId, id);
  if (data.status && data.status !== appt.status && appt.contact_id) {
    logActivity(companyId, appt.contact_id, 'agenda', `Agendamento "${appt.title}" marcado como ${data.status}`);
  }
  // Pedido de horário respondido pela equipe: avisa o cliente e fecha a tarefa de confirmação.
  if (appt.status === 'solicitado' && data.status && data.status !== 'solicitado') {
    closeTasksFor(companyId, 'confirmar_agendamento', 'appointment_id', appt.id);
    if (appt.contact_id) {
      const company = getCompany(companyId);
      const updated = getAppointment(companyId, id);
      const when = formatLocal(updated.start_at, company.timezone, { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const nome = firstName(appt.contact_name);
      const withPro = appt.professional_name ? ` com ${appt.professional_name}` : '';
      const text = ['agendado', 'confirmado'].includes(data.status)
        ? `Oi${nome ? `, ${nome}` : ''}! Seu horário está confirmado: *${appt.title}*${withPro} — ${when}. Até lá! 😊`
        : data.status === 'cancelado'
          ? `Oi${nome ? `, ${nome}` : ''}! Infelizmente não conseguimos confirmar o horário de ${when}. Podemos ver outra opção para você?`
          : null;
      if (text) sendMessage(companyId, appt.contact_id, text, 'system').catch(() => {});
    }
  }
  return getAppointment(companyId, id);
}
