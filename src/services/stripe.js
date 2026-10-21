import crypto from 'node:crypto';
import { main } from '../db.js';
import { config } from '../config.js';
import { PLANS } from './plans.js';
import { applyPlan, recordPayment, confirmPixPayment } from './subscriptions.js';
import { zonedParts } from './time.js';

// Assinatura por cartão no Stripe (Checkout + Billing + Customer Portal), sem SDK: a API é
// chamada direto. O cartão é digitado na página do Stripe e nunca passa pelo Conversa CRM.

let fetchImpl = (...args) => fetch(...args);
// Permite simular o Stripe nos testes.
export function setStripeFetch(fn) { fetchImpl = fn; }

const isLiveKey = (key) => /^(sk|rk)_live_/.test(key);
const isLocal = () => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(config.publicUrl);
/**
 * Chave de produção (sk_live/rk_live) só vale no endereço público https: rodando em
 * localhost, cobranças reais ficam bloqueadas (use a chave de teste para desenvolver).
 */
export const stripeEnabled = () => Boolean(config.stripeSecretKey) && !(isLiveKey(config.stripeSecretKey) && isLocal());
export const stripeMode = () => (!config.stripeSecretKey ? 'off' : isLiveKey(config.stripeSecretKey) ? (isLocal() ? 'live_blocked' : 'live') : 'test');

/** Converte objetos aninhados para o formato de formulário do Stripe (a[b][0][c]=x). */
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, params, method = 'POST') {
  if (!stripeEnabled()) throw new Error('Pagamento com cartão indisponível no momento');
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}${method === 'GET' ? `?${form(params || {})}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripeSecretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe respondeu ${res.status}`);
  return data;
}

/** Página de pagamento do Stripe para assinar um plano (cobrança mensal no cartão). */
export async function createCheckout(company, user, planId) {
  const plan = PLANS[planId];
  if (!plan || !(plan.price_cents > 0)) throw new Error('Plano inválido');
  if (hasActiveCard(company)) throw new Error('Você já tem uma assinatura no cartão. Use "Gerenciar assinatura" para trocar o cartão ou cancelar.');
  const meta = { company_id: company.id, plan: planId };
  const session = await stripe('checkout/sessions', {
    mode: 'subscription',
    locale: 'pt-BR',
    ...(company.stripe_customer_id ? { customer: company.stripe_customer_id } : { customer_email: user.email }),
    client_reference_id: company.id,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'brl', unit_amount: plan.price_cents, recurring: { interval: 'month' },
        product_data: { name: `Conversa CRM — plano ${plan.label}` },
      },
    }],
    metadata: meta,
    subscription_data: { metadata: meta },
    success_url: `${config.publicUrl}/app#/assinar?cartao=ok`,
    cancel_url: `${config.publicUrl}/app#/assinar?cartao=cancelado`,
  });
  return { url: session.url };
}

const hasActiveCard = (company) => company.billing_method === 'cartao' && company.stripe_subscription_id && company.subscription_status !== 'cancelada';

/**
 * Pix pelo Stripe: paga um mês do plano (o Pix Automático não existe para empresas no Brasil,
 * então cada mês é um pagamento). O webhook confirma e soma o mês sozinho.
 */
export async function createPixCheckout(company, user, planId) {
  const plan = PLANS[planId];
  if (!plan || !(plan.price_cents > 0)) throw new Error('Plano inválido');
  if (hasActiveCard(company)) throw new Error('Você já paga no cartão, com renovação automática. Use "Gerenciar assinatura" para trocar a forma de pagamento.');
  const meta = { company_id: company.id, plan: planId, kind: 'pix_month' };
  const session = await stripe('checkout/sessions', {
    mode: 'payment',
    locale: 'pt-BR',
    payment_method_types: ['pix'],
    ...(company.stripe_customer_id ? { customer: company.stripe_customer_id } : { customer_email: user.email }),
    client_reference_id: company.id,
    line_items: [{ quantity: 1, price_data: { currency: 'brl', unit_amount: plan.price_cents, product_data: { name: `Conversa CRM — plano ${plan.label} (1 mês)` } } }],
    metadata: meta,
    payment_intent_data: { metadata: meta },
    success_url: `${config.publicUrl}/app#/assinar?pix=ok`,
    cancel_url: `${config.publicUrl}/app#/assinar?pix=cancelado`,
  });
  return { url: session.url };
}

/**
 * Troca de plano de quem já assina no cartão: altera o preço da mesma assinatura e cobra
 * (ou credita) a diferença proporcional na hora. O plano novo vale imediatamente.
 */
export async function changeCardPlan(company, planId) {
  const plan = PLANS[planId];
  if (!plan || !(plan.price_cents > 0)) throw new Error('Plano inválido');
  if (!hasActiveCard(company)) throw new Error('Esta conta não tem assinatura no cartão');
  if (company.plan === planId) throw new Error('Você já está neste plano');
  const sub = await stripe(`subscriptions/${company.stripe_subscription_id}`, {}, 'GET');
  const item = sub.items?.data?.[0];
  if (!item) throw new Error('Assinatura sem item no Stripe');
  // Produto com o nome do plano novo, para as próximas faturas mostrarem o plano certo
  // (o produto criado pela página de pagamento não pode ser renomeado).
  const product = (await stripe('products', { name: `Conversa CRM — plano ${plan.label}`, metadata: { plan: planId } })).id;
  await stripe(`subscriptions/${company.stripe_subscription_id}`, {
    items: [{ id: item.id, price_data: { currency: 'brl', unit_amount: plan.price_cents, recurring: { interval: 'month' }, product } }],
    proration_behavior: 'always_invoice',
    metadata: { company_id: company.id, plan: planId },
  });
  applyPlan(company.id, planId);
  auditLog(company.id, 'plano alterado no cartão', `${PLANS[company.plan]?.label || company.plan} → ${plan.label} (diferença proporcional cobrada pelo Stripe)`);
  return { plan: planId };
}

/** Área do cliente no Stripe: trocar cartão, ver faturas, cancelar. */
export async function createPortal(company) {
  if (!company.stripe_customer_id) throw new Error('Esta empresa ainda não tem assinatura no cartão');
  const session = await stripe('billing_portal/sessions', { customer: company.stripe_customer_id, return_url: `${config.publicUrl}/app#/assinar` });
  return { url: session.url };
}

/** Confere a assinatura do webhook (cabeçalho Stripe-Signature: t=...,v1=...). */
export function verifyStripeSignature(secret, rawBody, header, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const dateOf = (unix) => (unix ? zonedParts(new Date(unix * 1000), 'America/Sao_Paulo').date : null);
const STATUS = { active: 'ativa', trialing: 'ativa', past_due: 'atrasada', unpaid: 'atrasada', incomplete: 'atrasada', canceled: 'cancelada', incomplete_expired: 'cancelada' };

function auditLog(companyId, action, details) {
  main.run('INSERT INTO audit_log (actor, action, company_id, details) VALUES (?, ?, ?, ?)', 'stripe', action, companyId, details);
}

/** Acha a empresa do evento: metadados da assinatura, cliente ou assinatura já gravados. */
function companyFor(obj) {
  const metaId = Number(
    obj.metadata?.company_id || obj.subscription_details?.metadata?.company_id
    || obj.parent?.subscription_details?.metadata?.company_id || obj.lines?.data?.[0]?.metadata?.company_id || obj.client_reference_id,
  );
  if (metaId) {
    const c = main.get('SELECT * FROM companies WHERE id = ?', metaId);
    if (c) return c;
  }
  const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.object === 'subscription' ? obj.id : null;
  if (subId) {
    const c = main.get('SELECT * FROM companies WHERE stripe_subscription_id = ?', subId);
    if (c) return c;
  }
  return obj.customer ? main.get('SELECT * FROM companies WHERE stripe_customer_id = ?', obj.customer) || null : null;
}

const planFrom = (obj, amount) => {
  const meta = obj.metadata?.plan || obj.subscription_details?.metadata?.plan || obj.parent?.subscription_details?.metadata?.plan || obj.lines?.data?.[0]?.metadata?.plan;
  if (PLANS[meta]) return meta;
  return Object.keys(PLANS).find((id) => PLANS[id].price_cents > 0 && PLANS[id].price_cents === amount) || null;
};

/** Processa um evento do Stripe. Eventos repetidos não duplicam nada. */
export function handleStripeEvent(event) {
  const obj = event.data?.object || {};
  const company = companyFor(obj);
  if (!company) return { ignored: 'empresa não encontrada' };
  const id = company.id;

  // Pix de um mês: confirmado na hora (completed já pago) ou depois (async_payment_succeeded).
  if (obj.object === 'checkout.session' && obj.metadata?.kind === 'pix_month') {
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) || obj.payment_status !== 'paid') return { ok: true, pending: true };
    const plan = PLANS[obj.metadata.plan] ? obj.metadata.plan : company.plan;
    if (obj.customer) main.run('UPDATE companies SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?', obj.customer, id);
    const term = confirmPixPayment(id, plan, { providerRef: obj.id, amountCents: obj.amount_total });
    if (term) auditLog(id, 'mensalidade paga no Pix', `plano ${PLANS[plan].label}, pago até ${term.end.split('-').reverse().join('/')}`);
    return { ok: true };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const plan = planFrom(obj);
      main.run("UPDATE companies SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_method = 'cartao', subscription_status = 'ativa', cancel_at_period_end = 0 WHERE id = ?",
        obj.customer, obj.subscription, id);
      if (plan) applyPlan(id, plan);
      auditLog(id, 'assinatura no cartão', `plano ${PLANS[plan]?.label || '?'} assinado pelo Stripe`);
      return { ok: true };
    }
    case 'invoice.paid': {
      const amount = obj.amount_paid ?? obj.total ?? 0;
      if (!(amount > 0)) return { ok: true };
      const plan = planFrom(obj, amount) || company.plan;
      const period = obj.lines?.data?.[0]?.period || {};
      const periodEnd = dateOf(period.end);
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.parent?.subscription_details?.subscription || company.stripe_subscription_id;
      main.run("UPDATE companies SET stripe_customer_id = COALESCE(stripe_customer_id, ?), stripe_subscription_id = COALESCE(?, stripe_subscription_id), billing_method = 'cartao', subscription_status = 'ativa', paid_until = ? WHERE id = ?",
        obj.customer, subId || null, periodEnd ? periodEnd : company.paid_until, id);
      if (PLANS[plan] && company.plan !== plan) applyPlan(id, plan);
      const created = recordPayment(id, {
        plan, amountCents: amount, method: 'cartao', periodStart: dateOf(period.start), periodEnd,
        providerRef: obj.id, paidAt: new Date((obj.status_transitions?.paid_at || event.created || Date.now() / 1000) * 1000).toISOString(),
      });
      if (created) auditLog(id, 'mensalidade paga no cartão', `${(amount / 100).toFixed(2).replace('.', ',')} — plano ${PLANS[plan]?.label || plan}`);
      return { ok: true };
    }
    case 'invoice.payment_failed': {
      main.run("UPDATE companies SET subscription_status = 'atrasada' WHERE id = ?", id);
      const created = recordPayment(id, {
        plan: planFrom(obj, obj.amount_due) || company.plan, amountCents: obj.amount_due || 0, method: 'cartao', status: 'falhou',
        providerRef: `${obj.id}:falha:${obj.attempt_count || 1}`,
      });
      if (created) auditLog(id, 'cartão recusado', `tentativa ${obj.attempt_count || 1}; o Stripe tenta de novo automaticamente`);
      return { ok: true };
    }
    case 'customer.subscription.updated': {
      const status = STATUS[obj.status] || company.subscription_status;
      main.run('UPDATE companies SET subscription_status = ?, cancel_at_period_end = ?, stripe_subscription_id = ? WHERE id = ?',
        status, obj.cancel_at_period_end ? 1 : 0, obj.id, id);
      if (obj.cancel_at_period_end && !company.cancel_at_period_end) auditLog(id, 'cancelamento agendado', 'a assinatura termina no fim do período pago');
      return { ok: true };
    }
    case 'customer.subscription.deleted': {
      // Assinatura encerrada: a conta fica só com leitura (os dados ficam) até assinar de novo.
      main.run("UPDATE companies SET subscription_status = 'cancelada', cancel_at_period_end = 0, stripe_subscription_id = NULL WHERE id = ?", id);
      applyPlan(id, 'gratis');
      auditLog(id, 'assinatura encerrada', 'conta só com leitura até assinar de novo');
      return { ok: true };
    }
    default:
      return { ignored: event.type };
  }
}

/** Crédito na conta do cliente no Stripe (abate da próxima fatura). Usado no "indique e ganhe". */
export async function creditCustomer(customerId, cents, description) {
  return stripe(`customers/${customerId}/balance_transactions`, { amount: -Math.abs(cents), currency: 'brl', description });
}
