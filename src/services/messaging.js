import crypto from 'node:crypto';
import { get, run, now } from '../db.js';
import { getCompany } from './company.js';
import { findOrCreateByPhone, getContact, firstName, changeStage, PlanLimitError } from './crm.js';
import { stopEnrollments } from './followup.js';
import { scheduleAiReply } from './ai.js';
import { autoAssign } from './assignment.js';
import { evolutionFetch, channelConfig } from './whatsapp-connect.js';
import { config } from '../config.js';
import { todayIn, zonedToUtc } from './time.js';
import { readEvolutionMessage, mediaLabel, MAX_MEDIA_BYTES } from './media.js';

// Pelo QR Code (conexão não oficial), mandar muitas primeiras mensagens para quem nunca falou
// com a empresa pode bloquear o número. Limite por dia, no fuso da empresa.
export const COLD_DAILY_LIMIT = 20;
export class ColdLimitError extends Error {}
const isCold = (contactId) => !get("SELECT 1 AS x FROM messages WHERE contact_id = ? AND (direction = 'in' OR cold = 1) LIMIT 1", contactId);
/** Primeiras mensagens enviadas hoje por um número (null = principal). */
export function coldSentToday(company, channelId = null) {
  const start = zonedToUtc(todayIn(company.timezone), '00:00', company.timezone).toISOString();
  return get('SELECT COUNT(*) AS n FROM messages WHERE company_id = ? AND cold = 1 AND created_at >= ? AND channel_id IS ?', company.id, start, channelId).n;
}
/** Número pelo qual o cliente falou por último (null = principal). */
const lastInboundChannel = (contactId) => get("SELECT channel_id FROM messages WHERE contact_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1", contactId)?.channel_id ?? null;
/** Esta mensagem é uma primeira mensagem de prospecção que passaria do limite do dia? */
export function coldBlocked(company, contactId, author) {
  if (company.settings.whatsapp.provider !== 'evolution' || !['followup', 'human'].includes(author) || !isCold(contactId)) return false;
  return coldSentToday(company) >= COLD_DAILY_LIMIT;
}
import { aiAllowed } from './plans.js';

// ---- Provedores de WhatsApp -------------------------------------------------

async function sendViaMeta(wa, contact, body) {
  if (!wa.meta_token || !wa.meta_phone_number_id) throw new Error('WhatsApp Cloud API (Meta) não configurado');
  const insideWindow = contact.last_inbound_at && Date.now() - Date.parse(contact.last_inbound_at) < 24 * 3600 * 1000;
  // Fora da janela de 24h a Meta só aceita mensagens de template aprovadas.
  const payload = !insideWindow && wa.meta_template_name
    ? {
      messaging_product: 'whatsapp', to: contact.phone, type: 'template',
      template: {
        name: wa.meta_template_name,
        language: { code: wa.meta_template_lang || 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: firstName(contact.name) || 'tudo bem' }] }],
      },
    }
    : { messaging_product: 'whatsapp', to: contact.phone, type: 'text', text: { body, preview_url: true } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${wa.meta_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${wa.meta_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Meta HTTP ${res.status}`);
  return data.messages?.[0]?.id || null;
}

async function sendViaEvolution(wa, contact, body) {
  // Conexão gerenciada pelo Conversa CRM: usa o servidor e a chave da plataforma.
  const apiKey = wa.evolution_api_key || (wa.evolution_managed ? config.evolutionApiKey : '');
  if (!wa.evolution_url || !apiKey || !wa.evolution_instance) throw new Error('Evolution API não configurada');
  const res = await evolutionFetch(`${wa.evolution_url.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(wa.evolution_instance)}`, {
    method: 'POST',
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: contact.phone, text: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Evolution HTTP ${res.status}`);
  return data.key?.id || null;
}

async function deliver(wa, recipient, body) {
  if (wa.provider === 'meta') return sendViaMeta(wa, recipient, body);
  if (wa.provider === 'evolution') return sendViaEvolution(wa, recipient, body);
  return null; // simulador: a mensagem fica só no histórico
}

// ---- Envio -------------------------------------------------------------------

/** Envia um aviso para um número que não é cliente (ex.: celular da equipe). Não entra no CRM. */
export async function sendToPhone(company, phone, body) {
  const wa = company.settings.whatsapp;
  const digits = String(phone).replace(/\D/g, '');
  const normalized = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  if (wa.provider === 'simulator') {
    console.log(`[aviso para equipe ${normalized}] ${body}`);
    return null;
  }
  // A equipe costuma não estar dentro da janela de 24h da Meta; tratamos como dentro para mandar texto livre.
  return deliver(wa, { phone: normalized, name: '', last_inbound_at: new Date().toISOString() }, body);
}

/**
 * Envia uma mensagem ao contato pelo canal configurado e registra no histórico.
 * author: ai | human | followup | billing | system. `user` é quem da equipe enviou (author human).
 */
export async function sendMessage(companyId, contactId, body, author = 'human', { user = null } = {}) {
  const company = getCompany(companyId);
  const contact = getContact(companyId, contactId);
  if (!contact) throw new Error('Contato não encontrado');
  // Resposta sai pelo número por onde o cliente falou por último; primeira mensagem, pelo principal.
  const firstContact = isCold(contactId);
  const { wa, channelId } = channelConfig(company, firstContact ? null : lastInboundChannel(contactId));
  const cold = wa.provider === 'evolution' && ['followup', 'human'].includes(author) && firstContact;
  if (cold && coldSentToday(company, channelId) >= COLD_DAILY_LIMIT) {
    throw new ColdLimitError(`Limite de ${COLD_DAILY_LIMIT} primeiras mensagens por dia para quem ainda não falou com você (proteção contra bloqueio do número). Continua amanhã.`);
  }
  const { id } = run(
    'INSERT INTO messages (company_id, contact_id, direction, author, body, status, user_id, user_name, cold, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    companyId, contactId, 'out', author, body, 'sending', user?.id || null, user?.name || null, cold ? 1 : 0, channelId,
  );
  try {
    if (!contact.phone && wa.provider !== 'simulator') throw new Error('Contato sem telefone');
    const providerId = await deliver(wa, contact, body);
    run('UPDATE messages SET status = ?, provider_id = ? WHERE id = ?', 'sent', providerId, id);
    run('UPDATE contacts SET last_outbound_at = ?, updated_at = ? WHERE id = ?', now(), now(), contactId);
    // Primeiro contato ativo move o lead de "novo" para "em contato".
    if (contact.stage === 'novo' && author !== 'ai') changeStage(companyId, contactId, 'contato');
  } catch (err) {
    run('UPDATE messages SET status = ?, error = ? WHERE id = ?', 'failed', String(err.message || err), id);
    console.error(`[whatsapp] falha ao enviar para contato ${contactId}:`, err.message);
  }
  return get('SELECT * FROM messages WHERE id = ?', id);
}

// ---- Recebimento -------------------------------------------------------------

/**
 * Processa uma mensagem recebida de um cliente (de qualquer provedor ou do simulador).
 * Retorna null se for duplicada.
 */
export function handleInbound(companyId, { phone, name, text, providerId = null, media = null }, { autoReply = true, channelId = null } = {}) {
  if (!text || !phone) return null;
  let found;
  try {
    found = findOrCreateByPhone(companyId, phone, name, 'whatsapp');
  } catch (err) {
    // Plano no limite de leads: número novo não entra no CRM (fica só no log).
    if (err instanceof PlanLimitError) {
      console.warn(`[whatsapp] empresa ${companyId}: limite de leads do plano atingido, mensagem de número novo ignorada`);
      return null;
    }
    throw err;
  }
  const { contact, created } = found;
  // Mídia: a mensagem entra já, e o arquivo é baixado depois (media_status 'pending').
  const mediaStatus = media ? (media.size > MAX_MEDIA_BYTES ? 'too_big' : 'pending') : null;
  const r = run(
    `INSERT OR IGNORE INTO messages (company_id, contact_id, direction, author, body, status, provider_id, channel_id, media_type, media_status, media_mime, media_name, media_size)
     VALUES (?, ?, 'in', 'contact', ?, 'received', ?, ?, ?, ?, ?, ?, ?)`,
    companyId, contact.id, text, providerId, channelId,
    media?.type || null, mediaStatus, media?.mime || null, media?.name || null, media?.size || null,
  );
  if (!r.changes) return null;
  run('UPDATE contacts SET last_inbound_at = ?, updated_at = ?, unread = unread + 1 WHERE id = ?', now(), now(), contact.id);
  if (!created && contact.stage === 'novo') changeStage(companyId, contact.id, 'contato', 'cliente respondeu');
  stopEnrollments(companyId, contact.id, 'cliente respondeu', { onlyStopOnReply: true });

  const company = getCompany(companyId);
  if (autoReply && aiAllowed(company) && company.settings.ai.enabled && contact.ai_enabled) scheduleAiReply(companyId, contact.id);
  // Sem IA nesta conversa, ela é da equipe: entra no rodízio de atendentes (se ligado).
  else autoAssign(companyId, contact.id);
  return { contact: getContact(companyId, contact.id), created, messageId: r.id, mediaPending: mediaStatus === 'pending' };
}

// ---- Parsers de webhook ------------------------------------------------------

export function parseMetaWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        let text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
        if (m.type === 'reaction') continue;
        // Mídia pela API oficial: por enquanto só o texto amigável (com a legenda, se houver).
        if (!text && m.type !== 'text') text = m[m.type]?.caption || mediaLabel(m.type, m.document?.filename);
        out.push({ phone: m.from, name: names[m.from] || '', text, providerId: m.id });
      }
    }
  }
  return out;
}

export function verifyMetaSignature(appSecret, rawBody, header) {
  if (!appSecret) return true;
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseEvolutionWebhook(body) {
  const event = String(body?.event || '').toLowerCase().replace('_', '.');
  if (event !== 'messages.upsert') return [];
  const items = Array.isArray(body.data) ? body.data : [body.data];
  const out = [];
  for (const d of items) {
    if (!d?.key || d.key.fromMe) continue;
    const jid = d.key.remoteJid || '';
    if (jid.endsWith('@g.us')) continue; // ignora grupos
    const content = readEvolutionMessage(d.message);
    if (!content) continue; // reação, mensagem apagada e avisos internos não são conversa
    // raw vai junto para baixar o arquivo sem depender do histórico do servidor do WhatsApp.
    out.push({ phone: jid.split('@')[0], name: d.pushName || '', text: content.text, providerId: d.key.id, ...(content.media ? { media: content.media, raw: { key: d.key, message: d.message } } : {}) });
  }
  return out;
}
