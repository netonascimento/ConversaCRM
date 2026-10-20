import { all, get, run, main, randomId, now } from '../db.js';
import { config } from '../config.js';
import { getCompany } from './company.js';
import { zonedToUtc } from './time.js';

// Sincronização com o Google Agenda.
// - Cada profissional (ou a empresa, quando não há profissionais) conecta a conta Google uma vez.
// - Agendamentos do Conversa CRM viram eventos no Google (criar, remarcar e cancelar).
// - Eventos marcados direto no Google bloqueiam esses horários no Conversa CRM (a IA não oferece).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const BUSY_DAYS = 60;
const BUSY_REFRESH_MS = 10 * 60000;

export const googleConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
const redirectUri = () => `${config.publicUrl}/api/google/callback`;

export class GoogleError extends Error {}

// ---- Conexão (OAuth) ---------------------------------------------------------------------

export function startConnect(companyId, { professionalId = null, userId = null } = {}) {
  if (!googleConfigured()) throw new GoogleError('A integração com o Google ainda não foi configurada pelo administrador da plataforma (GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET).');
  const state = randomId(18);
  main.run('DELETE FROM oauth_states WHERE expires_at < ?', now());
  main.run('INSERT INTO oauth_states (state, company_id, professional_id, user_id, expires_at) VALUES (?, ?, ?, ?, ?)',
    state, companyId, professionalId, userId, new Date(Date.now() + 15 * 60000).toISOString());
  const params = new URLSearchParams({
    client_id: config.googleClientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(data.error_description || data.error || `Google respondeu ${res.status}`);
  return data;
}

/** Retorno do Google depois que a pessoa autoriza. Valida o "state" e guarda a conexão. */
export function consumeState(state) {
  const row = main.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
  main.run('DELETE FROM oauth_states WHERE state = ?', String(state || ''));
  if (!row || row.expires_at < now()) throw new GoogleError('Link de conexão expirado. Tente conectar de novo.');
  return row;
}

/** Deve rodar no banco da empresa (withCompanyDb). */
export async function finishConnect(stateRow, code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!tokens.refresh_token) throw new GoogleError('O Google não liberou acesso permanente. Remova o acesso do Conversa CRM na sua conta Google e conecte de novo.');
  const info = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json()).catch(() => ({}));
  const { company_id: companyId, professional_id: professionalId } = stateRow;
  const old = connectionFor(companyId, professionalId);
  if (old) run('DELETE FROM google_connections WHERE id = ?', old.id);
  const { id } = run(
    `INSERT INTO google_connections (company_id, professional_id, email, refresh_token, access_token, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    companyId, professionalId, info.email || '', tokens.refresh_token, tokens.access_token,
    new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
  );
  const conn = get('SELECT * FROM google_connections WHERE id = ?', id);
  await refreshBusy(conn).catch(() => {});
  // Envia para o Google os agendamentos futuros que já existiam.
  const pending = all(
    `SELECT id FROM appointments WHERE company_id = ? AND status != 'cancelado' AND start_at >= ? AND google_event_id IS NULL
     AND ${professionalId ? 'professional_id = ?' : 'professional_id IS NULL'}`,
    companyId, now(), ...(professionalId ? [professionalId] : []),
  );
  for (const a of pending) await syncAppointment(companyId, a.id).catch(() => {});
  return conn;
}

export function connectionFor(companyId, professionalId = null) {
  return professionalId
    ? get('SELECT * FROM google_connections WHERE company_id = ? AND professional_id = ?', companyId, professionalId)
    : get('SELECT * FROM google_connections WHERE company_id = ? AND professional_id IS NULL', companyId);
}

export const listConnections = (companyId) => all(
  'SELECT id, professional_id, email, status, last_error, busy_synced_at, created_at FROM google_connections WHERE company_id = ?', companyId,
);

export async function disconnect(companyId, connectionId) {
  const conn = get('SELECT * FROM google_connections WHERE id = ? AND company_id = ?', connectionId, companyId);
  if (!conn) return false;
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(conn.refresh_token)}`, { method: 'POST' }).catch(() => {});
  run('DELETE FROM google_connections WHERE id = ?', conn.id);
  return true;
}

async function accessToken(conn) {
  if (conn.access_token && conn.expires_at && Date.parse(conn.expires_at) - Date.now() > 60000) return conn.access_token;
  try {
    const t = await tokenRequest({ refresh_token: conn.refresh_token, grant_type: 'refresh_token' });
    const expires = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
    run("UPDATE google_connections SET access_token = ?, expires_at = ?, status = 'ok', last_error = NULL WHERE id = ?", t.access_token, expires, conn.id);
    conn.access_token = t.access_token;
    conn.expires_at = expires;
    return t.access_token;
  } catch (err) {
    // Acesso revogado ou senha trocada: a conexão precisa ser refeita.
    run("UPDATE google_connections SET status = 'erro', last_error = ? WHERE id = ?", err.message, conn.id);
    throw err;
  }
}

async function gapi(conn, method, path, body) {
  const token = await accessToken(conn);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new GoogleError(data.error?.message || `Google Agenda respondeu ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const calendarPath = (conn) => `/calendars/${encodeURIComponent(conn.calendar_id || 'primary')}`;

// ---- Conversa CRM -> Google ----------------------------------------------------------------------

function eventFor(appt, company) {
  const lines = [
    appt.contact_name && `Cliente: ${appt.contact_name}`,
    appt.contact_phone && `WhatsApp: +${appt.contact_phone}`,
    appt.product_name && `Serviço: ${appt.product_name}`,
    appt.notes && `Observações: ${appt.notes}`,
    appt.status === 'solicitado' && 'Aguardando confirmação no Conversa CRM.',
    '',
    'Agendado pelo Conversa CRM.',
  ].filter((l) => l !== false && l !== null && l !== undefined);
  return {
    summary: `${appt.status === 'solicitado' ? '⏳ ' : ''}${appt.title}`,
    description: lines.join('\n'),
    start: { dateTime: appt.start_at, timeZone: company.timezone },
    end: { dateTime: appt.end_at, timeZone: company.timezone },
    extendedProperties: { private: { falaki: '1', falaki_id: String(appt.id) } },
    reminders: { useDefault: true },
  };
}

const apptWithNames = (companyId, id) => get(
  `SELECT a.*, c.name AS contact_name, c.phone AS contact_phone, p.name AS product_name FROM appointments a
   LEFT JOIN contacts c ON c.id = a.contact_id LEFT JOIN products p ON p.id = a.product_id
   WHERE a.company_id = ? AND a.id = ?`, companyId, id);

/** Cria, atualiza ou remove o evento do agendamento no Google. Roda no banco da empresa. */
export async function syncAppointment(companyId, apptId) {
  const appt = apptWithNames(companyId, apptId);
  if (!appt) return null;
  const conn = connectionFor(companyId, appt.professional_id);
  if (!conn || conn.status !== 'ok') return null;
  const company = getCompany(companyId);
  try {
    if (['cancelado'].includes(appt.status)) {
      if (appt.google_event_id) {
        await gapi(conn, 'DELETE', `${calendarPath(conn)}/events/${encodeURIComponent(appt.google_event_id)}`).catch((e) => { if (e.status !== 404 && e.status !== 410) throw e; });
      }
      run("UPDATE appointments SET google_event_id = NULL, google_sync = 'ok' WHERE id = ?", appt.id);
      return null;
    }
    let event;
    if (appt.google_event_id) {
      event = await gapi(conn, 'PATCH', `${calendarPath(conn)}/events/${encodeURIComponent(appt.google_event_id)}`, eventFor(appt, company))
        .catch(async (e) => {
          if (e.status === 404 || e.status === 410) return gapi(conn, 'POST', `${calendarPath(conn)}/events`, eventFor(appt, company));
          throw e;
        });
    } else {
      event = await gapi(conn, 'POST', `${calendarPath(conn)}/events`, eventFor(appt, company));
    }
    run("UPDATE appointments SET google_event_id = ?, google_sync = 'ok' WHERE id = ?", event.id, appt.id);
    return event.id;
  } catch (err) {
    run("UPDATE appointments SET google_sync = 'erro' WHERE id = ?", appt.id);
    console.error(`[google] agendamento ${appt.id}:`, err.message);
    return null;
  }
}

/** Chamado quando um agendamento muda: marca como pendente e sincroniza em segundo plano. */
export function queueAppointmentSync(companyId, apptId) {
  const appt = get('SELECT professional_id FROM appointments WHERE id = ? AND company_id = ?', apptId, companyId);
  if (!appt || !connectionFor(companyId, appt.professional_id)) return;
  run("UPDATE appointments SET google_sync = 'pendente' WHERE id = ?", apptId);
  syncAppointment(companyId, apptId).catch(() => {});
}

/** Antes de apagar um agendamento do Conversa CRM, apaga o evento no Google. */
export async function removeAppointmentEvent(companyId, apptId) {
  const appt = get('SELECT * FROM appointments WHERE id = ? AND company_id = ?', apptId, companyId);
  if (!appt?.google_event_id) return;
  const conn = connectionFor(companyId, appt.professional_id);
  if (!conn) return;
  await gapi(conn, 'DELETE', `${calendarPath(conn)}/events/${encodeURIComponent(appt.google_event_id)}`).catch(() => {});
}

// ---- Google -> Conversa CRM (horários ocupados) --------------------------------------------------

export async function refreshBusy(conn) {
  const company = getCompany(conn.company_id);
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + BUSY_DAYS * 86400000).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', showDeleted: 'false',
    fields: 'items(id,status,transparency,start,end,summary,extendedProperties)',
  });
  const data = await gapi(conn, 'GET', `${calendarPath(conn)}/events?${params}`);
  const busy = [];
  for (const ev of data?.items || []) {
    if (ev.status === 'cancelled' || ev.transparency === 'transparent') continue;
    // Evento criado pelo próprio Conversa CRM (a marca "fechou" é de quando o sistema tinha o nome antigo).
    if (ev.extendedProperties?.private?.falaki === '1' || ev.extendedProperties?.private?.fechou === '1') continue;
    const start = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : ev.start?.date ? zonedToUtc(ev.start.date, '00:00', company.timezone).getTime() : null;
    const end = ev.end?.dateTime ? Date.parse(ev.end.dateTime) : ev.end?.date ? zonedToUtc(ev.end.date, '00:00', company.timezone).getTime() : null;
    if (start && end && end > start) busy.push([start, end]);
  }
  run('UPDATE google_connections SET busy_cache = ?, busy_synced_at = ? WHERE id = ?', JSON.stringify(busy), now(), conn.id);
  return busy;
}

/** Intervalos ocupados no Google ([início, fim] em ms) do profissional ou da agenda da empresa. */
export function busyIntervals(companyId, professionalId = null) {
  const conn = connectionFor(companyId, professionalId);
  if (!conn || conn.status !== 'ok') return [];
  return JSON.parse(conn.busy_cache || '[]');
}

/** Automação: atualiza os horários ocupados e reenvia agendamentos com erro. Roda em cada banco. */
export async function processGoogle() {
  if (!googleConfigured()) return 0;
  let n = 0;
  for (const conn of all("SELECT * FROM google_connections WHERE status = 'ok'")) {
    if (main.get('SELECT status FROM companies WHERE id = ?', conn.company_id)?.status !== 'ativa') continue;
    if (!conn.busy_synced_at || Date.now() - Date.parse(conn.busy_synced_at) > BUSY_REFRESH_MS) {
      await refreshBusy(conn).catch((err) => console.error('[google] horários ocupados:', err.message));
      n++;
    }
  }
  for (const a of all("SELECT id, company_id FROM appointments WHERE google_sync IN ('pendente', 'erro') LIMIT 20")) {
    await syncAppointment(a.company_id, a.id);
    n++;
  }
  return n;
}
