import { get, run } from '../db.js';
import { getCompany } from './company.js';
import { channelConfig, evolutionFetch } from './whatsapp-connect.js';
import { config } from '../config.js';

// Fotos, áudios, vídeos e documentos recebidos no WhatsApp. A mensagem entra na conversa na hora
// (com "📷 Foto" ou a legenda como texto) e o arquivo é baixado em seguida, sem atrasar o recebimento.
// O arquivo fica no banco da empresa (message_media), como os documentos dos clientes.

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_LABEL = { image: '📷 Foto', audio: '🎤 Áudio', video: '🎬 Vídeo', document: '📄 Documento', sticker: '🖼️ Figurinha' };

// Tipos de mensagem do WhatsApp (como chegam pela Evolution API) que têm arquivo.
const EVOLUTION_MEDIA = {
  imageMessage: 'image', audioMessage: 'audio', videoMessage: 'video', ptvMessage: 'video',
  documentMessage: 'document', documentWithCaptionMessage: 'document', stickerMessage: 'sticker',
};
// Outros tipos: viram um texto amigável. Os da lista IGNORED não são conversa (reação, mensagem
// apagada ou editada, avisos internos do WhatsApp) e não entram no histórico.
const OTHER_LABEL = {
  locationMessage: '📍 Localização', liveLocationMessage: '📍 Localização em tempo real',
  contactMessage: '👤 Contato', contactsArrayMessage: '👤 Contatos',
  pollCreationMessage: '📊 Enquete', pollCreationMessageV3: '📊 Enquete',
};
const IGNORED = new Set(['reactionMessage', 'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'editedMessage']);
const UNSUPPORTED = '💬 Mensagem que o Conversa CRM ainda não mostra (veja no celular)';

/** Texto padrão de uma mídia sem legenda. */
export const mediaLabel = (type, name = null) => (type === 'document' && name ? `📄 ${name}` : MEDIA_LABEL[type] || UNSUPPORTED);

// Mensagens temporárias e de visualização única chegam "embrulhadas".
function unwrap(msg) {
  let m = msg || {};
  for (let i = 0; i < 3; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

const fileLength = (v) => {
  const n = Number(v?.low ?? v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Lê o conteúdo de uma mensagem da Evolution API: texto, mídia (sem o arquivo) ou null para ignorar.
 * Retorna { text, media: { type, mime, name, size } | null }.
 */
export function readEvolutionMessage(rawMessage) {
  const msg = unwrap(rawMessage);
  const text = msg.conversation || msg.extendedTextMessage?.text;
  if (text) return { text, media: null };
  for (const [key, type] of Object.entries(EVOLUTION_MEDIA)) {
    let m = msg[key];
    if (!m) continue;
    if (key === 'documentWithCaptionMessage') m = m.message?.documentMessage || {};
    const media = { type, mime: m.mimetype || null, name: type === 'document' ? (m.fileName || m.title || null) : null, size: fileLength(m.fileLength) };
    return { text: String(m.caption || '').trim() || mediaLabel(type, media.name), media };
  }
  const keys = Object.keys(msg).filter((k) => !IGNORED.has(k));
  if (!keys.length) return null;
  return { text: OTHER_LABEL[keys[0]] || UNSUPPORTED, media: null };
}

// Mensagens antigas, de antes de o Conversa CRM baixar mídias: "[imageMessage recebido]".
const LEGACY = /^\[(\w+) recebido\]$/;
/** Tipo de mídia de uma mensagem antiga, ou null. */
export function legacyMediaType(body) {
  const k = String(body || '').match(LEGACY)?.[1];
  return (k && EVOLUTION_MEDIA[k]) || null;
}
/** Texto para mostrar no lugar do formato antigo. */
export function friendlyBody(body) {
  const k = String(body || '').match(LEGACY)?.[1];
  if (!k) return body;
  if (EVOLUTION_MEDIA[k]) return MEDIA_LABEL[EVOLUTION_MEDIA[k]];
  return OTHER_LABEL[k] || UNSUPPORTED;
}
/** Mensagem como a tela mostra: as antigas com mídia aparecem como mídia para baixar de novo. */
export function presentMessage(m) {
  if (m.media_type || !m.body || m.direction !== 'in') return m;
  const type = legacyMediaType(m.body);
  if (type) return { ...m, body: MEDIA_LABEL[type], media_type: type, media_status: 'failed' };
  const body = friendlyBody(m.body);
  return body === m.body ? m : { ...m, body };
}

const setStatus = (id, status, extra = {}) => run(
  'UPDATE messages SET media_status = ?, media_mime = COALESCE(?, media_mime), media_size = COALESCE(?, media_size) WHERE id = ?',
  status, extra.mime || null, extra.size || null, id,
);

/**
 * Baixa o arquivo de uma mensagem recebida e guarda no banco. `raw` é a mensagem como veio no aviso
 * da Evolution ({ key, message }); sem ela (tentar de novo), o servidor procura pela identificação.
 * Nunca lança erro: em caso de falha a mensagem fica como "não foi possível baixar".
 */
export async function downloadMedia(companyId, messageId, raw = null) {
  const m = get('SELECT * FROM messages WHERE id = ? AND company_id = ?', messageId, companyId);
  if (!m?.media_type) return m || null;
  try {
    if (m.media_size && m.media_size > MAX_MEDIA_BYTES) {
      setStatus(m.id, 'too_big');
      return get('SELECT * FROM messages WHERE id = ?', m.id);
    }
    const { wa } = channelConfig(getCompany(companyId), m.channel_id);
    const apiKey = wa.evolution_api_key || (wa.evolution_managed ? config.evolutionApiKey : '');
    if (wa.provider !== 'evolution' || !wa.evolution_url || !apiKey || !wa.evolution_instance || !m.provider_id) throw new Error('WhatsApp não conectado pelo QR Code');
    const res = await evolutionFetch(`${wa.evolution_url.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${encodeURIComponent(wa.evolution_instance)}`, {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: raw || { key: { id: m.provider_id } }, convertToMp4: false }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.base64) throw new Error(data.response?.message?.[0] || data.message || `HTTP ${res.status}`);
    const bytes = Buffer.from(String(data.base64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!bytes.length) throw new Error('arquivo vazio');
    if (bytes.length > MAX_MEDIA_BYTES) {
      setStatus(m.id, 'too_big', { size: bytes.length });
    } else {
      run('INSERT OR REPLACE INTO message_media (message_id, company_id, data) VALUES (?, ?, ?)', m.id, companyId, bytes);
      setStatus(m.id, 'ok', { mime: data.mimetype, size: bytes.length });
    }
  } catch (err) {
    setStatus(m.id, 'failed');
    console.error(`[whatsapp] empresa ${companyId}: não foi possível baixar a mídia da mensagem ${m.id} (${err.name === 'TimeoutError' ? 'demorou demais' : err.message})`);
  }
  return get('SELECT * FROM messages WHERE id = ?', m.id);
}

/** Tenta baixar de novo (também converte uma mensagem antiga "[imageMessage recebido]"). */
export async function retryMedia(companyId, messageId) {
  const m = get("SELECT * FROM messages WHERE id = ? AND company_id = ? AND direction = 'in'", messageId, companyId);
  if (!m) return null;
  if (!m.media_type) {
    const type = legacyMediaType(m.body);
    if (!type) return m;
    run('UPDATE messages SET media_type = ?, body = ? WHERE id = ?', type, MEDIA_LABEL[type], m.id);
  }
  if (m.media_status === 'ok') return m;
  run("UPDATE messages SET media_status = 'pending' WHERE id = ?", m.id);
  return downloadMedia(companyId, m.id);
}

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};
// Só estes tipos abrem dentro da página; o resto é sempre baixado (nunca executa no navegador).
const INLINE = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|webm|wav)|video\/(mp4|webm|3gpp))$/;

/** Arquivo de uma mensagem para entregar ao navegador, ou null. */
export function mediaFile(companyId, messageId) {
  const m = get('SELECT id, media_type, media_mime, media_name FROM messages WHERE id = ? AND company_id = ?', messageId, companyId);
  const file = m && get('SELECT data FROM message_media WHERE message_id = ? AND company_id = ?', m.id, companyId);
  if (!file) return null;
  const mime = String(m.media_mime || '').split(';')[0].trim().toLowerCase();
  const inline = INLINE.test(mime);
  const name = m.media_name || `${m.media_type || 'arquivo'}-${m.id}.${EXT[mime] || 'bin'}`;
  return { data: Buffer.from(file.data), mime: inline || mime === 'application/pdf' ? mime : 'application/octet-stream', inline, name };
}
