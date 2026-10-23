import crypto from 'node:crypto';
import { main, randomId } from './db.js';
import { HttpError, parseCookies } from './http.js';
import { DEFAULT_SETTINGS, saveSettings } from './services/company.js';
import { PRESETS } from './services/presets.js';
import { PLANS, DEFAULT_PLAN } from './services/plans.js';

// Contas, usuários, sessões e administradores ficam sempre no banco principal.
const { get, run, transaction, all } = main;

const SESSION_DAYS = 30;
const ADMIN_SESSION_HOURS = 12;
export const ROLES = [
  { id: 'owner', label: 'Dono (acesso total)' },
  { id: 'agent', label: 'Atendente (sem configurações e financeiro)' },
  { id: 'professional', label: 'Profissional (vê a própria agenda e clientes)' },
];
const ROLE_IDS = ROLES.map((r) => r.id);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function checkPassword(password) {
  if (!password || String(password).length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres');
}

// ---- Proteção contra tentativa de senha em massa ------------------------------------

const attempts = new Map();
const LIMIT = 10;
const WINDOW_MS = 15 * 60000;

function guardLogin(key) {
  const a = attempts.get(key);
  if (a && a.count >= LIMIT && Date.now() - a.first < WINDOW_MS) {
    throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  }
}
function failLogin(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}
export const resetLoginAttempts = () => { attempts.clear(); signups.clear(); };

// ---- Proteção do cadastro público contra robôs ---------------------------------------

const signups = new Map();
const SIGNUP_WINDOW_MS = 3600000;
// Robô de spam costuma pôr link no nome (a primeira empresa cadastrada veio com um link do TikTok).
const LINK_RE = /(https?:|www\.|:\/\/|\.[a-z]{2,}\/)/i;

/** IP de quem fez a requisição (atrás do proxy, o primeiro do X-Forwarded-For). */
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

/** Barra cadastro em massa (por IP), o campo-isca preenchido e links nos nomes. */
export function guardSignup(ip, body) {
  // Campo escondido no formulário: pessoa não vê, robô preenche.
  if (body.website) throw new HttpError(400, 'Não foi possível criar a conta.');
  if (LINK_RE.test(body.companyName || '') || LINK_RE.test(body.name || '')) {
    throw new HttpError(400, 'Use o nome da empresa e o seu nome, sem links.');
  }
  const limit = Number(process.env.SIGNUP_IP_LIMIT || 5);
  const a = signups.get(ip);
  if (!a || Date.now() - a.first > SIGNUP_WINDOW_MS) signups.set(ip, { count: 1, first: Date.now() });
  else if (a.count >= limit) throw new HttpError(429, 'Muitos cadastros feitos daqui. Tente de novo mais tarde.');
  else a.count++;
}

// ---- Confirmação de e-mail do cadastro ---------------------------------------------

const CODE_MINUTES = 30;
const CODE_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/** Gera um código novo de 6 dígitos para o usuário (vale 30 min) e devolve para enviar por e-mail. */
export function issueVerificationCode(userId) {
  const user = get('SELECT verify_sent_at FROM users WHERE id = ?', userId);
  if (user?.verify_sent_at && Date.now() - Date.parse(user.verify_sent_at) < RESEND_SECONDS * 1000) {
    throw new HttpError(429, 'Aguarde um minuto para pedir outro código.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  run('UPDATE users SET verify_code_hash = ?, verify_expires_at = ?, verify_attempts = 0, verify_sent_at = ? WHERE id = ?',
    hashCode(code), new Date(Date.now() + CODE_MINUTES * 60000).toISOString(), new Date().toISOString(), userId);
  return code;
}

export function verifyEmailCode(userId, code) {
  const user = get('SELECT email_verified, verify_code_hash, verify_expires_at, verify_attempts FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'Usuário não encontrado');
  if (user.email_verified) return;
  if (!user.verify_code_hash || user.verify_expires_at < new Date().toISOString()) {
    throw new HttpError(400, 'O código expirou. Peça um novo.');
  }
  if (user.verify_attempts >= CODE_ATTEMPTS) throw new HttpError(429, 'Muitas tentativas erradas. Peça um novo código.');
  const given = String(code || '').replace(/\D/g, '');
  if (hashCode(given) !== user.verify_code_hash) {
    run('UPDATE users SET verify_attempts = verify_attempts + 1 WHERE id = ?', userId);
    throw new HttpError(400, 'Código incorreto.');
  }
  run('UPDATE users SET email_verified = 1, verify_code_hash = NULL, verify_expires_at = NULL WHERE id = ?', userId);
}

// ---- Sessões de usuários das empresas -------------------------------------------------

export function createSession(userId, { impersonatedBy = null } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + (impersonatedBy ? 2 * 3600000 : SESSION_DAYS * 86400000)).toISOString();
  run('INSERT INTO sessions (token, user_id, expires_at, impersonated_by) VALUES (?, ?, ?, ?)', token, userId, expires, impersonatedBy);
  return token;
}

const secureFlag = (req) => (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

export function sessionCookie(token, req) {
  return `vf_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? SESSION_DAYS * 86400 : 0}${secureFlag(req)}`;
}

/** Cria uma empresa com o primeiro usuário (dono). Usado pelo cadastro público e pelo painel do administrador. */
export function registerCompany({ companyName, name, email, password, phone = null, emailVerified = true, timezone, segment = 'generico', plan = DEFAULT_PLAN, maxUsers, maxLeads, notes = '' }) {
  if (!companyName || !name || !email || !password) throw new HttpError(400, 'Preencha empresa, nome, e-mail e senha');
  checkPassword(password);
  const normalized = email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE email = ?', normalized)) throw new HttpError(409, 'Já existe uma conta com esse e-mail');
  const preset = PRESETS[segment] ? segment : 'generico';
  const planId = PLANS[plan] ? plan : DEFAULT_PLAN;
  const users = Number(maxUsers) || PLANS[planId].max_users;
  const leads = maxLeads === undefined ? PLANS[planId].max_leads : (maxLeads === '' || maxLeads === null ? null : Number(maxLeads));
  const ids = transaction(() => {
    const { id: companyId } = run(
      `INSERT INTO companies (name, timezone, settings, segment, plan, max_users, max_leads, notes, public_id, webhook_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      companyName.trim(), timezone || 'America/Sao_Paulo', JSON.stringify(DEFAULT_SETTINGS), preset, planId, users, leads, notes, randomId(), randomId(18),
    );
    const { id: userId } = run(
      'INSERT INTO users (company_id, name, email, password_hash, role, phone, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
      companyId, name.trim(), normalized, hashPassword(password), 'owner', phone, emailVerified ? 1 : 0,
    );
    return { companyId, userId };
  });
  if (preset !== 'generico') saveSettings(ids.companyId, structuredClone(PRESETS[preset].settings));
  return ids;
}

export function login(email, password, ip = '') {
  const normalized = String(email || '').trim().toLowerCase();
  const key = `u:${normalized}:${ip}`;
  guardLogin(key);
  const user = get('SELECT u.*, c.status AS company_status FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?', normalized);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    failLogin(key);
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }
  if (!user.active) throw new HttpError(403, 'Seu acesso foi desativado. Fale com o responsável pela sua empresa.');
  if (user.company_status !== 'ativa') throw new HttpError(403, 'A conta da sua empresa está suspensa. Fale com o suporte.');
  run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
  return user;
}

export function userFromRequest(req) {
  const token = parseCookies(req).vf_session || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.company_id, u.name, u.email, u.role, u.active, u.professional_id, u.email_verified, s.expires_at, s.impersonated_by,
            c.status AS company_status
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN companies c ON c.id = u.company_id WHERE s.token = ?`, token,
  );
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { ...row, token };
}

export function requireAuth(req) {
  const user = userFromRequest(req);
  if (!user) throw new HttpError(401, 'Faça login para continuar');
  if (!user.active) throw new HttpError(403, 'Seu acesso foi desativado.');
  // O administrador consegue entrar numa empresa suspensa para dar suporte.
  if (user.company_status !== 'ativa' && !user.impersonated_by) throw new HttpError(403, 'A conta da sua empresa está suspensa. Fale com o suporte.');
  req.user = user;
  req.companyId = user.company_id;
}

/** Restringe a rota a alguns papéis (o dono sempre passa). */
export const requireRole = (...roles) => (req) => {
  if (req.user.role !== 'owner' && !roles.includes(req.user.role)) {
    throw new HttpError(403, 'Seu perfil de acesso não permite esta ação.');
  }
};
export const ownerOnly = requireRole();

// ---- Usuários de uma empresa ------------------------------------------------------------

export const listUsers = (companyId) => all(
  `SELECT u.id, u.name, u.email, u.role, u.active, u.professional_id, u.last_login_at, u.created_at
   FROM users u WHERE u.company_id = ? ORDER BY u.active DESC, u.name`, companyId);

export function createUser(companyId, { name, email, password, role = 'agent', professional_id: professionalId = null }) {
  const company = get('SELECT max_users FROM companies WHERE id = ?', companyId);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  if (!name?.trim() || !email?.trim()) throw new HttpError(400, 'Informe nome e e-mail');
  checkPassword(password);
  if (!ROLE_IDS.includes(role)) throw new HttpError(400, 'Perfil inválido');
  const active = get('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1', companyId).n;
  if (active >= company.max_users) throw new HttpError(400, `O plano desta empresa permite até ${company.max_users} usuários ativos.`);
  const normalized = email.trim().toLowerCase();
  if (get('SELECT id FROM users WHERE email = ?', normalized)) throw new HttpError(409, 'Já existe um usuário com esse e-mail');
  const { id } = run(
    'INSERT INTO users (company_id, name, email, password_hash, role, professional_id) VALUES (?, ?, ?, ?, ?, ?)',
    companyId, name.trim(), normalized, hashPassword(password), role, role === 'professional' ? Number(professionalId) || null : null,
  );
  return get('SELECT id, name, email, role, active, professional_id FROM users WHERE id = ?', id);
}

export function updateUser(companyId, userId, data) {
  const user = get('SELECT * FROM users WHERE id = ? AND company_id = ?', userId, companyId);
  if (!user) throw new HttpError(404, 'Usuário não encontrado');
  const role = data.role ?? user.role;
  if (!ROLE_IDS.includes(role)) throw new HttpError(400, 'Perfil inválido');
  const active = data.active === undefined ? user.active : data.active ? 1 : 0;
  // A empresa nunca fica sem um dono ativo.
  if ((role !== 'owner' || !active) && user.role === 'owner' && user.active) {
    const owners = get("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'owner' AND active = 1", companyId).n;
    if (owners <= 1) throw new HttpError(400, 'A empresa precisa de pelo menos um dono ativo.');
  }
  if (active && !user.active) {
    const company = get('SELECT max_users FROM companies WHERE id = ?', companyId);
    const count = get('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND active = 1', companyId).n;
    if (count >= company.max_users) throw new HttpError(400, `O plano desta empresa permite até ${company.max_users} usuários ativos.`);
  }
  if (data.email && data.email.trim().toLowerCase() !== user.email) {
    const normalized = data.email.trim().toLowerCase();
    if (get('SELECT id FROM users WHERE email = ? AND id != ?', normalized, userId)) throw new HttpError(409, 'Já existe um usuário com esse e-mail');
    run('UPDATE users SET email = ? WHERE id = ?', normalized, userId);
  }
  const professionalId = role === 'professional' ? (data.professional_id !== undefined ? Number(data.professional_id) || null : user.professional_id) : null;
  run('UPDATE users SET name = ?, role = ?, active = ?, professional_id = ? WHERE id = ?', data.name?.trim() || user.name, role, active, professionalId, userId);
  if (data.password) {
    checkPassword(data.password);
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(data.password), userId);
  }
  // Desativou ou trocou a senha: derruba as sessões abertas.
  if (!active || data.password) run('DELETE FROM sessions WHERE user_id = ?', userId);
  return get('SELECT id, name, email, role, active, professional_id FROM users WHERE id = ?', userId);
}

// ---- Administradores da plataforma ------------------------------------------------------

export function createAdmin({ name, email, password }) {
  if (!name?.trim() || !email?.trim()) throw new HttpError(400, 'Informe nome e e-mail');
  checkPassword(password);
  const normalized = email.trim().toLowerCase();
  if (get('SELECT id FROM admins WHERE email = ?', normalized)) throw new HttpError(409, 'Já existe um administrador com esse e-mail');
  const { id } = run('INSERT INTO admins (name, email, password_hash) VALUES (?, ?, ?)', name.trim(), normalized, hashPassword(password));
  return get('SELECT id, name, email, created_at FROM admins WHERE id = ?', id);
}

export function adminLogin(email, password, ip = '') {
  const normalized = String(email || '').trim().toLowerCase();
  const key = `a:${normalized}:${ip}`;
  guardLogin(key);
  const admin = get('SELECT * FROM admins WHERE email = ?', normalized);
  if (!admin || !verifyPassword(String(password || ''), admin.password_hash)) {
    failLogin(key);
    throw new HttpError(401, 'E-mail ou senha incorretos');
  }
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)', token, admin.id, new Date(Date.now() + ADMIN_SESSION_HOURS * 3600000).toISOString());
  return { admin, token };
}

export function adminCookie(token, req) {
  return `vf_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? ADMIN_SESSION_HOURS * 3600 : 0}${secureFlag(req)}`;
}

export function requireAdmin(req) {
  const token = parseCookies(req).vf_admin || (req.headers['x-admin-token'] || '');
  const row = token && get(
    'SELECT a.id, a.name, a.email, s.expires_at FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token = ?', token,
  );
  if (!row || row.expires_at < new Date().toISOString()) throw new HttpError(401, 'Faça login como administrador');
  req.admin = { ...row, token };
}
