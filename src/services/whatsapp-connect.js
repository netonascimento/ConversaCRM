import crypto from 'node:crypto';
import { main } from '../db.js';
import { config } from '../config.js';
import { getCompany, saveSettings } from './company.js';
import { maxWhatsapp } from './plans.js';

// WhatsApp por QR Code gerenciado pelo Conversa CRM: a plataforma roda um servidor Evolution API
// (EVOLUTION_URL + EVOLUTION_API_KEY) e cria a conexão de cada empresa sozinha. O cliente só
// lê o QR Code no celular; endereço, instância e chaves nunca aparecem para ele.
//
// Cada empresa tem o número principal (em settings.whatsapp, como sempre foi) e, conforme o plano,
// números extras (tabela whatsapp_numbers). numberId = null é sempre o principal.

let fetchImpl = (...args) => fetch(...args);
// Permite simular o Evolution nos testes (também usado no envio de mensagens).
export function setEvolutionFetch(fn) { fetchImpl = fn; }
export const evolutionFetch = (...args) => fetchImpl(...args);

export const managedEnabled = () => Boolean(config.evolutionUrl && config.evolutionApiKey);
const base = () => config.evolutionUrl.replace(/\/$/, '');
// Nome da conexão no servidor: usa o número interno da empresa (único), nunca o identificador
// público em minúsculas (dois identificadores diferentes podiam virar o mesmo nome). Conexão que já
// existe continua com o nome salvo, para ninguém precisar reconectar.
export const instanceName = (company, number = null) => {
  if (number) return number.evolution_instance || `crm-${company.id}-n${number.id}`;
  const wa = company.settings?.whatsapp || {};
  return wa.evolution_managed && wa.evolution_instance ? wa.evolution_instance : `crm-${company.id}`;
};

async function evo(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetchImpl(`${base()}${path}`, {
      method,
      headers: { apikey: config.evolutionApiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    // Fora do ar, endereço errado ou demorou demais: fica no log com o motivo (nunca a chave).
    console.error(`[whatsapp] ${method} ${path}: sem resposta do servidor de conexão (${err.name === 'TimeoutError' ? 'demorou mais de 20s' : err.message})`);
    throw new Error('O servidor do WhatsApp não respondeu. Tente de novo em alguns minutos.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) console.error(`[whatsapp] ${method} ${path}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return { ok: res.ok, status: res.status, data };
}

// ---- Números extras ----------------------------------------------------------------------

export const listNumbers = (companyId) => main.all('SELECT * FROM whatsapp_numbers WHERE company_id = ? ORDER BY id', companyId);
export const getNumber = (companyId, id) => (id ? main.get('SELECT * FROM whatsapp_numbers WHERE company_id = ? AND id = ?', companyId, id) || null : null);

/** Situação dos números da empresa, para as telas (sem chaves). */
export function numbersOverview(companyId) {
  const company = getCompany(companyId);
  const wa = company.settings.whatsapp;
  return {
    limit: maxWhatsapp(company),
    principal: { id: null, label: 'Principal', state: wa.provider === 'simulator' ? 'close' : wa.connection_state || 'open', provider: wa.provider },
    extras: listNumbers(companyId).map((n) => ({ id: n.id, label: n.label, state: n.connection_state })),
  };
}

/** Acrescenta um número extra (só o cadastro; a conexão é pelo QR Code depois). */
export function addNumber(companyId, label) {
  const company = getCompany(companyId);
  const name = String(label || '').trim().slice(0, 40);
  if (!name) throw new Error('Dê um nome ao número (ex.: Comercial, Financeiro).');
  if (!managedEnabled()) throw new Error('A conexão por QR Code ainda não está disponível.');
  const limit = maxWhatsapp(company);
  if (1 + listNumbers(companyId).length >= limit) {
    throw new Error(limit > 1 ? `O seu plano permite até ${limit} números de WhatsApp.` : 'Mais números de WhatsApp estão disponíveis no plano Profissional.');
  }
  const { id } = main.run('INSERT INTO whatsapp_numbers (company_id, label, webhook_token) VALUES (?, ?, ?)', companyId, name, crypto.randomBytes(18).toString('base64url'));
  return getNumber(companyId, id);
}

/** Remove um número extra: desconecta no servidor e apaga o cadastro (as conversas ficam no CRM). */
export async function removeNumber(companyId, id) {
  const company = getCompany(companyId);
  const n = getNumber(companyId, id);
  if (!n) return false;
  if (managedEnabled()) {
    await evo(`/instance/logout/${instanceName(company, n)}`, { method: 'DELETE' }).catch(() => {});
    await evo(`/instance/delete/${instanceName(company, n)}`, { method: 'DELETE' }).catch(() => {});
  }
  main.run('DELETE FROM whatsapp_numbers WHERE id = ?', n.id);
  return true;
}

/**
 * Configuração de envio de um canal, no mesmo formato de settings.whatsapp. Número extra que não
 * existe mais (removido) cai no principal, para a resposta nunca se perder.
 */
export function channelConfig(company, channelId) {
  const n = channelId ? getNumber(company.id, channelId) : null;
  if (!n) return { wa: company.settings.whatsapp, channelId: null };
  return {
    wa: { provider: 'evolution', evolution_managed: true, evolution_url: base(), evolution_instance: n.evolution_instance || instanceName(company, n), evolution_api_key: n.evolution_api_key || '' },
    channelId: n.id,
  };
}

// ---- Conexão (principal ou extra) ---------------------------------------------------------

const webhookUrl = (company, number = null) => (number
  ? `${config.publicUrl}/webhooks/whatsapp/evolution/${company.public_id}?token=${number.webhook_token}&n=${number.id}`
  : `${config.publicUrl}/webhooks/whatsapp/evolution/${company.public_id}?token=${company.webhook_token}`);

/** Cria (se ainda não existir) a conexão no servidor e liga o aviso de mensagens. */
async function ensureInstance(company, number = null) {
  const name = instanceName(company, number);
  const created = await evo('/instance/create', { method: 'POST', body: { instanceName: name, qrcode: true, integration: 'WHATSAPP-BAILEYS' } });
  // Já existia: segue com ela. Outro erro: o servidor de conexão está fora do ar ou mal configurado.
  const exists = !created.ok && /exist|in use|already/i.test(JSON.stringify(created.data));
  if (!created.ok && !exists) throw new Error('Não foi possível falar com o servidor do WhatsApp. Tente de novo em alguns minutos.');
  const hook = await evo(`/webhook/set/${name}`, {
    method: 'POST',
    body: { webhook: { enabled: true, url: webhookUrl(company, number), byEvents: false, base64: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] } },
  });
  if (!hook.ok) throw new Error('Não foi possível configurar o recebimento de mensagens. Tente de novo.');
  const token = typeof created.data?.hash === 'string' ? created.data.hash : created.data?.hash?.apikey;
  if (number) {
    main.run('UPDATE whatsapp_numbers SET evolution_instance = ?, evolution_api_key = COALESCE(?, evolution_api_key) WHERE id = ?', name, token || null, number.id);
  } else {
    saveSettings(company.id, { whatsapp: {
      evolution_managed: true, evolution_url: base(), evolution_instance: name,
      ...(token ? { evolution_api_key: token } : {}),
    } });
  }
  return { name, qr: created.data?.qrcode?.base64 || null };
}

/** Situação da conexão: open (conectado), connecting (esperando o QR Code) ou close. */
export async function connectionState(companyId, numberId = null) {
  const company = getCompany(companyId);
  const number = getNumber(companyId, numberId);
  if (numberId && !number) return { state: 'none' };
  if (!managedEnabled() || (!number && !company.settings.whatsapp.evolution_managed)) return { state: 'none' };
  const r = await evo(`/instance/connectionState/${instanceName(company, number)}`);
  const state = r.data?.instance?.state || r.data?.state || 'close';
  applyState(companyId, state, numberId);
  return { state };
}

/** Grava a situação; o principal conectado passa a ser o canal da empresa. */
export function applyState(companyId, state, numberId = null) {
  if (numberId) {
    main.run('UPDATE whatsapp_numbers SET connection_state = ? WHERE company_id = ? AND id = ?', state, companyId, numberId);
    return;
  }
  const company = getCompany(companyId);
  const wa = company.settings.whatsapp;
  if (!wa.evolution_managed) return;
  const patch = { connection_state: state };
  if (state === 'open' && wa.provider !== 'evolution') patch.provider = 'evolution';
  if (wa.connection_state !== state || patch.provider) saveSettings(companyId, { whatsapp: patch });
}

/** Começa (ou retoma) a conexão e devolve o QR Code para ler no celular. */
export async function startConnection(companyId, numberId = null) {
  if (!managedEnabled()) throw new Error('A conexão por QR Code ainda não está disponível.');
  const company = getCompany(companyId);
  const number = getNumber(companyId, numberId);
  if (numberId && !number) throw new Error('Número não encontrado.');
  const { name, qr } = await ensureInstance(company, number);
  const st = await connectionState(companyId, numberId);
  if (st.state === 'open') return { state: 'open' };
  const r = await evo(`/instance/connect/${name}`);
  const code = r.data?.base64 || qr;
  if (!code) throw new Error('O servidor do WhatsApp não devolveu o QR Code. Tente de novo.');
  return { state: 'connecting', qr: code.startsWith('data:') ? code : `data:image/png;base64,${code}` };
}

/** Desconecta o número (o cliente pode conectar outro depois). */
export async function disconnect(companyId, numberId = null) {
  const company = getCompany(companyId);
  const number = getNumber(companyId, numberId);
  if (numberId) {
    if (!number) return { state: 'none' };
    if (managedEnabled()) await evo(`/instance/logout/${instanceName(company, number)}`, { method: 'DELETE' }).catch(() => {});
    applyState(companyId, 'close', numberId);
    return { state: 'close' };
  }
  if (company.settings.whatsapp.evolution_managed && managedEnabled()) {
    await evo(`/instance/logout/${instanceName(company)}`, { method: 'DELETE' }).catch(() => {});
  }
  saveSettings(companyId, { whatsapp: { provider: 'simulator', connection_state: 'close' } });
  return { state: 'close' };
}
