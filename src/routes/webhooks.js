import crypto from 'node:crypto';
import { get, main, withCompanyDb } from '../db.js';
import { HttpError } from '../http.js';
import { getCompany } from '../services/company.js';
import { handleInbound, parseMetaWebhook, verifyMetaSignature, parseEvolutionWebhook } from '../services/messaging.js';
import { applyState, getNumber } from '../services/whatsapp-connect.js';
import { markPaid, fetchMercadoPagoPayment } from '../services/billing.js';
import { config } from '../config.js';
import { verifyStripeSignature, handleStripeEvent } from '../services/stripe.js';

// As URLs usam o identificador público aleatório da empresa (não o número interno),
// e cada provedor tem sua verificação: token, assinatura ou consulta à API.
function companyOr404(publicId) {
  const row = main.get('SELECT id FROM companies WHERE public_id = ?', String(publicId));
  const company = row && getCompany(row.id);
  if (!company) throw new HttpError(404, 'Empresa não encontrada');
  return company;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

const chargeFromRef = (companyId, ref) => {
  const m = String(ref || '').match(/^charge:(\d+)$/);
  return m ? get('SELECT * FROM charges WHERE id = ? AND company_id = ?', Number(m[1]), companyId) : null;
};

// Empresa suspensa: o webhook responde OK (para o provedor não reenviar), mas nada é processado.
const active = (company) => company.status === 'ativa';

export function registerWebhooks(router) {
  // Stripe: assinatura das empresas na plataforma (cartão). Só processa com a assinatura válida.
  router.post('/webhooks/stripe', (req, res, { body }) => {
    if (!config.stripeWebhookSecret) throw new HttpError(503, 'Webhook do Stripe não configurado');
    if (!verifyStripeSignature(config.stripeWebhookSecret, req.rawBody, req.headers['stripe-signature'])) throw new HttpError(400, 'Assinatura inválida');
    return handleStripeEvent(body);
  });

  // WhatsApp Cloud API (Meta): verificação do webhook
  router.get('/webhooks/whatsapp/meta/:companyId', (req, res, { params, query }) => {
    const wa = companyOr404(params.companyId).settings.whatsapp;
    if (query['hub.mode'] === 'subscribe' && wa.meta_verify_token && safeEqual(query['hub.verify_token'], wa.meta_verify_token)) {
      return String(query['hub.challenge'] || '');
    }
    throw new HttpError(403, 'Token de verificação inválido');
  });

  router.post('/webhooks/whatsapp/meta/:companyId', (req, res, { params, body }) => {
    const company = companyOr404(params.companyId);
    if (!verifyMetaSignature(company.settings.whatsapp.meta_app_secret, req.rawBody, req.headers['x-hub-signature-256'])) {
      throw new HttpError(401, 'Assinatura inválida');
    }
    if (active(company)) withCompanyDb(company.id, () => { for (const msg of parseMetaWebhook(body)) handleInbound(company.id, msg); });
    return { ok: true };
  });

  // Evolution API (WhatsApp via QR Code): exige o token da empresa na URL.
  router.post('/webhooks/whatsapp/evolution/:companyId', (req, res, { params, body, query }) => {
    const company = companyOr404(params.companyId);
    const given = query.token || req.headers['x-webhook-token'];
    // Número extra (?n=…): tem a chave própria. Sem ?n: o número principal, como sempre foi.
    let channelId = null;
    if (query.n) {
      const number = getNumber(company.id, Number(query.n));
      if (!number || !safeEqual(given, number.webhook_token)) throw new HttpError(401, 'Token inválido');
      channelId = number.id;
    } else {
      const secret = company.settings.whatsapp.evolution_webhook_secret;
      if (!safeEqual(given, company.webhook_token) && !(secret && safeEqual(given, secret))) throw new HttpError(401, 'Token inválido');
    }
    // Conectou ou desconectou o celular (QR Code gerenciado pelo Conversa CRM).
    const event = String(body?.event || '').toLowerCase().replace('_', '.');
    if (event === 'connection.update' && body.data?.state) applyState(company.id, body.data.state, channelId);
    if (active(company)) withCompanyDb(company.id, () => { for (const msg of parseEvolutionWebhook(body)) handleInbound(company.id, msg, { channelId }); });
    return { ok: true };
  });

  // Asaas: confirmação de pagamento
  router.post('/webhooks/billing/asaas/:companyId', async (req, res, { params, body }) => {
    const company = companyOr404(params.companyId);
    const token = company.settings.billing.asaas_webhook_token;
    if (!token || !safeEqual(req.headers['asaas-access-token'], token)) throw new HttpError(401, 'Token inválido');
    if (active(company) && ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(body.event)) {
      await withCompanyDb(company.id, async () => {
        const charge = chargeFromRef(company.id, body.payment?.externalReference);
        if (charge && charge.provider_id === body.payment?.id) await markPaid(company.id, charge.id, { via: 'Asaas' });
      });
    }
    return { ok: true };
  });

  // Mercado Pago: a notificação só traz o ID; consultamos o pagamento na API para confirmar.
  router.post('/webhooks/billing/mercadopago/:companyId', async (req, res, { params, body, query }) => {
    const company = companyOr404(params.companyId);
    if (!safeEqual(query.token, company.webhook_token)) throw new HttpError(401, 'Token inválido');
    const type = body.type || query.type || query.topic;
    const paymentId = body.data?.id || query['data.id'] || query.id;
    if (active(company) && type === 'payment' && paymentId && company.settings.billing.mercadopago_token) {
      const payment = await fetchMercadoPagoPayment(company, paymentId);
      await withCompanyDb(company.id, async () => {
        const charge = chargeFromRef(company.id, payment.external_reference);
        if (charge && payment.status === 'approved' && Math.round(payment.transaction_amount * 100) >= charge.amount_cents) {
          await markPaid(company.id, charge.id, { via: 'Mercado Pago' });
        }
      });
    }
    return { ok: true };
  });
}
