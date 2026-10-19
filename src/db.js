import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  company_id INTEGER,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT,
  document TEXT,
  business_name TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  stage TEXT NOT NULL DEFAULT 'novo',
  value_cents INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  interest TEXT NOT NULL DEFAULT '',
  address TEXT,
  website TEXT,
  rating REAL,
  place_id TEXT,
  ai_enabled INTEGER NOT NULL DEFAULT 1,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  won_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_company_phone ON contacts(company_id, phone);
CREATE INDEX IF NOT EXISTS idx_contacts_company_stage ON contacts(company_id, stage);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'servico',
  duration_min INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'agendado',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'manual',
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_company_start ON appointments(company_id, start_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider ON messages(company_id, provider_id) WHERE provider_id IS NOT NULL AND direction = 'in';
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual',
  steps TEXT NOT NULL DEFAULT '[]',
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativo',
  stop_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_enrollments_due ON enrollments(status, next_run_at);
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  provider TEXT NOT NULL DEFAULT 'pix_manual',
  provider_id TEXT,
  payment_url TEXT,
  pix_code TEXT,
  paid_at TEXT,
  reminders TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_charges_company_status ON charges(company_id, status);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'outro',
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta',
  created_by TEXT NOT NULL DEFAULT 'manual',
  overdue_notified INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_company_status ON tasks(company_id, status, due_at);
CREATE TABLE IF NOT EXISTS professionals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  phone TEXT,
  color TEXT NOT NULL DEFAULT '#1f7a45',
  business_hours TEXT,
  blocked_dates TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS professional_services (
  professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (professional_id, product_id)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL,
  professional_id INTEGER,
  user_id INTEGER,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS google_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  professional_id INTEGER,
  email TEXT NOT NULL DEFAULT '',
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  last_error TEXT,
  busy_cache TEXT NOT NULL DEFAULT '[]',
  busy_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS prospect_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  query TEXT NOT NULL,
  results_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  search_id INTEGER NOT NULL REFERENCES prospect_searches(id) ON DELETE CASCADE,
  place_id TEXT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  website TEXT,
  rating REAL,
  reviews INTEGER,
  category TEXT,
  maps_url TEXT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL
);
`;

// Colunas adicionadas depois da primeira versão (bancos antigos recebem via ALTER TABLE).
const COLUMNS = [
  ['contacts', 'custom_fields', "TEXT NOT NULL DEFAULT '{}'"],
  ['appointments', 'professional_id', 'INTEGER'],
  ['appointments', 'google_event_id', 'TEXT'],
  ['appointments', 'google_sync', 'TEXT'],
  ['companies', 'status', "TEXT NOT NULL DEFAULT 'ativa'"],
  ['companies', 'plan', "TEXT NOT NULL DEFAULT ''"],
  ['companies', 'max_users', 'INTEGER NOT NULL DEFAULT 5'],
  ['companies', 'max_leads', 'INTEGER'],
  ['companies', 'segment', "TEXT NOT NULL DEFAULT 'generico'"],
  ['companies', 'notes', "TEXT NOT NULL DEFAULT ''"],
  ['companies', 'public_id', 'TEXT'],
  ['companies', 'webhook_token', 'TEXT'],
  ['companies', 'storage', "TEXT NOT NULL DEFAULT 'shared'"],
  ['users', 'active', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'professional_id', 'INTEGER'],
  ['users', 'last_login_at', 'TEXT'],
  ['sessions', 'impersonated_by', 'INTEGER'],
];

export const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

function migrate(db) {
  for (const [table, column, def] of COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  // Identificador público (usado nas URLs de webhook) e token de webhook para empresas antigas.
  for (const c of db.prepare('SELECT id FROM companies WHERE public_id IS NULL OR webhook_token IS NULL').all()) {
    db.prepare('UPDATE companies SET public_id = COALESCE(public_id, ?), webhook_token = COALESCE(webhook_token, ?) WHERE id = ?').run(randomId(), randomId(18), c.id);
  }
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ---- Bancos: um compartilhado (principal) e, em casos especiais, um por empresa ----------
//
// O banco principal guarda empresas, usuários, sessões e administradores, além dos dados
// das empresas no modo compartilhado. Uma empresa no modo "dedicated" tem os dados dela
// (contatos, conversas, agenda, cobranças...) num arquivo próprio. As consultas dos
// serviços vão para o banco da empresa da requisição atual (definido com withDb).

const mainDb = open(config.dbPath);
const tenantDbs = new Map();
const context = new AsyncLocalStorage();

export function tenantDbFile(publicId) {
  return config.dbPath === ':memory:' ? ':memory:' : path.join(path.dirname(config.dbPath), 'empresas', `${publicId}.db`);
}

export function tenantDb(publicId) {
  if (!tenantDbs.has(publicId)) tenantDbs.set(publicId, open(tenantDbFile(publicId)));
  return tenantDbs.get(publicId);
}

export function closeTenantDb(publicId) {
  tenantDbs.get(publicId)?.close();
  tenantDbs.delete(publicId);
}

/** Banco onde ficam os dados da empresa. */
export function dbForCompany(companyId) {
  const c = mainDb.prepare('SELECT storage, public_id FROM companies WHERE id = ?').get(companyId);
  return c?.storage === 'dedicated' ? tenantDb(c.public_id) : mainDb;
}

export const withDb = (db, fn) => context.run(db, fn);
export const withCompanyDb = (companyId, fn) => context.run(dbForCompany(companyId), fn);

/** Executa fn em cada banco (principal e os dedicados). Usado pelas automações. */
export async function forEachDatabase(fn) {
  const dedicated = mainDb.prepare("SELECT public_id FROM companies WHERE storage = 'dedicated'").all();
  for (const db of [mainDb, ...dedicated.map((c) => tenantDb(c.public_id))]) await context.run(db, fn);
}

const current = () => context.getStore() || mainDb;
const wrap = (pick) => ({
  all: (sql, ...params) => pick().prepare(sql).all(...params),
  get: (sql, ...params) => pick().prepare(sql).get(...params),
  run: (sql, ...params) => {
    const r = pick().prepare(sql).run(...params);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  },
  transaction(fn) {
    const db = pick();
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
});

// Dados da empresa atual (roteados para o banco certo).
const tenant = wrap(current);
export const { all, get, run, transaction } = tenant;
// Empresas, usuários, sessões e administradores: sempre no banco principal.
export const main = wrap(() => mainDb);
export { mainDb };

export const now = () => new Date().toISOString();
