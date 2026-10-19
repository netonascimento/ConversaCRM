import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carrega um arquivo .env simples (CHAVE=valor) sem dependências externas.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

export const config = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'fechou.db'),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  salesWhatsapp: (process.env.SALES_WHATSAPP || '').replace(/\D/g, ''),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-5-5',
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY || '',
  // App OAuth do Google Cloud (um só para a plataforma) para sincronizar o Google Agenda.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60_000),
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
};
