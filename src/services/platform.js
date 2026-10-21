import { main } from '../db.js';
import { config } from '../config.js';
import { getCompany } from './company.js';
import { sendToPhone } from './messaging.js';

// Avisos para o dono da plataforma (ex.: pedido de MEI chegou). Saem pelo WhatsApp da empresa do
// próprio administrador (a conta dele no Conversa CRM, com o mesmo e-mail do admin) para o
// número de vendas (SALES_WHATSAPP). Sem isso configurado, o aviso fica só no painel admin.
let notifyImpl = sendToPhone;
export function setPlatformNotify(fn) { notifyImpl = fn; }

export async function notifyPlatform(text) {
  if (!config.salesWhatsapp) return false;
  const row = main.get(
    `SELECT u.company_id FROM users u JOIN admins a ON LOWER(a.email) = LOWER(u.email)
     JOIN companies c ON c.id = u.company_id WHERE u.active = 1 AND c.status = 'ativa' ORDER BY u.id LIMIT 1`,
  );
  if (!row) return false;
  try {
    await notifyImpl(getCompany(row.company_id), config.salesWhatsapp, text);
    return true;
  } catch (err) {
    console.error('[plataforma] aviso no WhatsApp não enviado:', err.message);
    return false;
  }
}
