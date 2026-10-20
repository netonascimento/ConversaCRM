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
  // Banco padrão: data/falaki.db. Instalações antigas (data/fechou.db) continuam usando o arquivo delas.
  dbPath: process.env.DB_PATH || (fs.existsSync(path.join(ROOT, 'data', 'fechou.db')) && !fs.existsSync(path.join(ROOT, 'data', 'falaki.db'))
    ? path.join(ROOT, 'data', 'fechou.db') : path.join(ROOT, 'data', 'falaki.db')),
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  salesWhatsapp: (process.env.SALES_WHATSAPP || '').replace(/\D/g, ''),
  // Pix da plataforma para a assinatura (botão Comprar do teste grátis) e e-mail para o comprovante.
  platformPixKey: (process.env.PLATFORM_PIX_KEY || '').trim(),
  platformPixName: process.env.PLATFORM_PIX_NAME || 'Conversa CRM',
  platformPixCity: process.env.PLATFORM_PIX_CITY || 'Sao Paulo',
  salesEmail: process.env.SALES_EMAIL || 'contato@conversacrm.online',
  // Stripe (cartão e Pix). STRIPE_SECRET_KEY tem prioridade; senão, rodando em localhost usa a chave de
  // teste (STRIPE_TEST_API_KEY) e, publicado, a de produção (STRIPE_API_KEY).
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || (/^http:\/\/(localhost|127\.0\.0\.1)/.test(process.env.PUBLIC_URL || 'http://localhost')
    ? process.env.STRIPE_TEST_API_KEY || process.env.STRIPE_API_KEY
    : process.env.STRIPE_API_KEY || process.env.STRIPE_TEST_API_KEY) || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  // Servidor Evolution API da plataforma: com ele, cada empresa conecta o WhatsApp só lendo um QR Code.
  evolutionUrl: (process.env.EVOLUTION_URL || '').trim(),
  evolutionApiKey: (process.env.EVOLUTION_API_KEY || '').trim(),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-opus-5-5',
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY || '',
  // App OAuth do Google Cloud (um só para a plataforma) para sincronizar o Google Agenda.
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60_000),
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
};
