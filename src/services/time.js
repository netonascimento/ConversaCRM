// Conversões de fuso horário sem bibliotecas externas (usa Intl).

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
export { WEEKDAYS };

export function offsetMinutes(tz, date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // "GMT-03:00" ou "GMT"
  const m = part.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] || 0);
  return m[1] === '-' ? -mins : mins;
}

// "2026-10-20" + "14:30" no fuso tz -> Date (UTC)
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - offsetMinutes(tz, new Date(guess)) * 60000;
  const corrected = guess - offsetMinutes(tz, new Date(utc)) * 60000;
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

export function zonedParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: wd };
}

export const todayIn = (tz) => zonedParts(new Date(), tz).date;

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T12:00:00Z`) - Date.parse(`${fromDate}T12:00:00Z`)) / 86400000);
}

export const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();

export function formatLocal(iso, tz, opts = { dateStyle: 'short', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, ...opts }).format(new Date(iso));
}

export function formatDateBR(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export { toMin };

// O momento está dentro do horário comercial?
export function isWithinHours(date, tz, hours) {
  const p = zonedParts(date, tz);
  const ranges = hours[WEEKDAYS[p.weekday]] || [];
  const m = toMin(p.time);
  return ranges.some(([a, b]) => m >= toMin(a) && m < toMin(b));
}

// Próximo instante dentro do horário comercial (ou o próprio, se já estiver).
export function nextBusinessTime(date, tz, hours) {
  if (isWithinHours(date, tz, hours)) return date;
  const p = zonedParts(date, tz);
  for (let i = 0; i < 14; i++) {
    const day = addDays(p.date, i);
    const ranges = [...(hours[WEEKDAYS[weekdayOf(day)]] || [])].sort((a, b) => toMin(a[0]) - toMin(b[0]));
    for (const [start] of ranges) {
      const candidate = zonedToUtc(day, start, tz);
      if (candidate > date) return candidate;
    }
  }
  return date;
}

/** Soma horas úteis (dentro do horário comercial) a uma data. Sem horário configurado, soma horas corridas. */
export function addBusinessHours(date, hours, tz, businessHours) {
  const hasHours = Object.values(businessHours).some((r) => r.length);
  if (!hasHours) return new Date(date.getTime() + hours * 3600000);
  let remaining = hours * 60;
  let cursor = nextBusinessTime(date, tz, businessHours);
  for (let guard = 0; guard < 60 && remaining > 0; guard++) {
    const p = zonedParts(cursor, tz);
    const m = toMin(p.time);
    const range = (businessHours[WEEKDAYS[p.weekday]] || []).find(([a, b]) => m >= toMin(a) && m < toMin(b));
    if (!range) { cursor = nextBusinessTime(new Date(cursor.getTime() + 60000), tz, businessHours); continue; }
    const available = toMin(range[1]) - m;
    if (remaining <= available) return new Date(cursor.getTime() + remaining * 60000);
    remaining -= available;
    cursor = nextBusinessTime(new Date(cursor.getTime() + available * 60000), tz, businessHours);
  }
  return cursor;
}

/** Prazo em linguagem natural: "hoje às 13:00", "amanhã às 10:00" ou "quinta-feira às 09:00". */
export function friendlyDeadline(iso, tz) {
  const target = zonedParts(new Date(iso), tz);
  const today = todayIn(tz);
  if (target.date === today) return `hoje às ${target.time}`;
  if (target.date === addDays(today, 1)) return `amanhã às ${target.time}`;
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long' }).format(new Date(iso));
  return `${weekday} às ${target.time}`;
}
