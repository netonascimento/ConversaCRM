import { config } from '../config.js';
import { getCompany, saveSettings } from './company.js';

// WhatsApp por QR Code gerenciado pelo Conversa CRM: a plataforma roda um servidor Evolution API
// (EVOLUTION_URL + EVOLUTION_API_KEY) e cria a conexão de cada empresa sozinha. O cliente só
// lê o QR Code no celular; endereço, instância e chaves nunca aparecem para ele.

let fetchImpl = (...args) => fetch(...args);
// Permite simular o Evolution nos testes (também usado no envio de mensagens).
export function setEvolutionFetch(fn) { fetchImpl = fn; }
export const evolutionFetch = (...args) => fetchImpl(...args);

export const managedEnabled = () => Boolean(config.evolutionUrl && config.evolutionApiKey);
const base = () => config.evolutionUrl.replace(/\/$/, '');
export const instanceName = (company) => `conversacrm-${String(company.public_id).toLowerCase().replace(/[^a-z0-9-]/g, '')}`;

async function evo(path, { method = 'GET', body } = {}) {
  const res = await fetchImpl(`${base()}${path}`, {
    method,
    headers: { apikey: config.evolutionApiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const webhookUrl = (company) => `${config.publicUrl}/webhooks/whatsapp/evolution/${company.public_id}?token=${company.webhook_token}`;

/** Cria (se ainda não existir) a conexão da empresa no servidor e liga o aviso de mensagens. */
async function ensureInstance(company) {
  const name = instanceName(company);
  const created = await evo('/instance/create', { method: 'POST', body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' } });
  // Já existia: segue com ela. Outro erro: o servidor de conexão está fora do ar ou mal configurado.
  const exists = !created.ok && /exist|in use|already/i.test(JSON.stringify(created.data));
  if (!created.ok && !exists) throw new Error('Não foi possível falar com o servidor do WhatsApp. Tente de novo em alguns minutos.');
  const hook = await evo(`/webhook/set/${name}`, {
    method: 'POST',
    body: { webhook: { enabled: true, url: webhookUrl(company), byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } },
  });
  if (!hook.ok) throw new Error('Não foi possível configurar o recebimento de mensagens. Tente de novo.');
  const token = typeof created.data?.hash === 'string' ? created.data.hash : created.data?.hash?.apikey;
  saveSettings(company.id, { whatsapp: {
    evolution_managed: true, evolution_url: base(), evolution_instance: name,
    ...(token ? { evolution_api_key: token } : {}),
  } });
  return { name, qr: created.data?.qrcode?.base64 || null };
}

/** Situação da conexão: open (conectado), connecting (esperando o QR Code) ou close. */
export async function connectionState(companyId) {
  const company = getCompany(companyId);
  if (!managedEnabled() || !company.settings.whatsapp.evolution_managed) return { state: 'none' };
  const r = await evo(`/instance/connectionState/${instanceName(company)}`);
  const state = r.data?.instance?.state || r.data?.state || 'close';
  applyState(companyId, state);
  return { state };
}

/** Grava a situação; conectado = o WhatsApp passa a ser o canal da empresa. */
export function applyState(companyId, state) {
  const company = getCompany(companyId);
  const wa = company.settings.whatsapp;
  if (!wa.evolution_managed) return;
  const patch = { connection_state: state };
  if (state === 'open' && wa.provider !== 'evolution') patch.provider = 'evolution';
  if (wa.connection_state !== state || patch.provider) saveSettings(companyId, { whatsapp: patch });
}

/** Começa (ou retoma) a conexão e devolve o QR Code para ler no celular. */
export async function startConnection(companyId) {
  if (!managedEnabled()) throw new Error('A conexão por QR Code ainda não está disponível.');
  const company = getCompany(companyId);
  const { name, qr } = await ensureInstance(company);
  const st = await connectionState(companyId);
  if (st.state === 'open') return { state: 'open' };
  const r = await evo(`/instance/connect/${name}`);
  const code = r.data?.base64 || qr;
  if (!code) throw new Error('O servidor do WhatsApp não devolveu o QR Code. Tente de novo.');
  return { state: 'connecting', qr: code.startsWith('data:') ? code : `data:image/png;base64,${code}` };
}

/** Desconecta o número (o cliente pode conectar outro depois). */
export async function disconnect(companyId) {
  const company = getCompany(companyId);
  if (company.settings.whatsapp.evolution_managed && managedEnabled()) {
    await evo(`/instance/logout/${instanceName(company)}`, { method: 'DELETE' }).catch(() => {});
  }
  saveSettings(companyId, { whatsapp: { provider: 'simulator', connection_state: 'close' } });
  return { state: 'close' };
}
