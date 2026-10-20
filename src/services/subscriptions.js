import { main, now } from '../db.js';
import { PLANS } from './plans.js';
import { todayIn, addDays } from './time.js';

// Assinatura das empresas na plataforma (o que elas pagam ao Conversa CRM).
// billing_method: 'pix' (o admin confirma cada mês) ou 'cartao' (Stripe cobra sozinho).
// paid_until: até quando o mês pago vale. subscription_status: ativa | atrasada | cancelada.

const TZ = 'America/Sao_Paulo';
export const today = () => todayIn(TZ);

export function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Aplica o plano com os limites dele e encerra o pedido de assinatura em aberto. */
export function applyPlan(companyId, planId) {
  const plan = PLANS[planId];
  main.run('UPDATE companies SET plan = ?, max_users = ?, max_leads = ?, upgrade_plan = NULL, upgrade_requested_at = NULL WHERE id = ?',
    planId, plan.max_users, plan.max_leads, companyId);
}

/** Registra uma mensalidade (idempotente pelo provider_ref). Retorna false se já existia. */
export function recordPayment(companyId, { plan, amountCents, method, status = 'pago', periodStart = null, periodEnd = null, providerRef = null, paidAt = now() }) {
  // Pagou: deixa de ser cortesia.
  if (status === 'pago') main.run('UPDATE companies SET courtesy_until = NULL, courtesy_reason = NULL WHERE id = ?', companyId);
  const r = main.run(
    `INSERT OR IGNORE INTO subscription_payments (company_id, plan, amount_cents, method, status, period_start, period_end, provider_ref, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId, plan, amountCents, method, status, periodStart, periodEnd, providerRef, status === 'pago' ? paidAt : null,
  );
  return r.changes > 0;
}

/**
 * Pix confirmado pelo admin: ativa o plano e paga mais um mês, a partir do fim do período
 * atual (se ainda estiver valendo) ou de hoje.
 */
export function confirmPixPayment(companyId, planId, { providerRef = null, amountCents } = {}) {
  const plan = PLANS[planId];
  if (!plan || !(plan.price_cents > 0)) throw new Error('Plano inválido');
  // Aviso repetido do Stripe: o mês já foi somado.
  if (providerRef && main.get('SELECT id FROM subscription_payments WHERE provider_ref = ?', providerRef)) return null;
  const c = main.get('SELECT id, paid_until, billing_method, stripe_subscription_id FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  if (c.billing_method === 'cartao' && c.stripe_subscription_id) throw new Error('Esta empresa paga por cartão: a renovação é automática pelo Stripe');
  const start = c.paid_until && c.paid_until >= today() ? addDays(c.paid_until, 1) : today();
  const end = addDays(addMonths(start, 1), -1);
  applyPlan(companyId, planId);
  main.run("UPDATE companies SET billing_method = 'pix', paid_until = ?, subscription_status = 'ativa', cancel_at_period_end = 0 WHERE id = ?", end, companyId);
  recordPayment(companyId, { plan: planId, amountCents: amountCents ?? plan.price_cents, method: 'pix', periodStart: start, periodEnd: end, providerRef });
  return { start, end };
}

/**
 * Situação da assinatura para telas: cortesia (liberada pelo admin, com motivo e prazo opcional),
 * interna (plano pago colocado à mão, sem cobrança), em dia, vencida, atrasada, cancelada…
 */
export function subscriptionState(c, ref = today()) {
  const plan = PLANS[c.plan];
  if (!plan || !(plan.price_cents > 0)) return { state: c.plan === 'gratis' ? 'gratis' : 'personalizado', paying: false };
  if (c.courtesy_reason || c.courtesy_until) return { state: 'cortesia', paying: false, courtesy_until: c.courtesy_until || null, courtesy_reason: c.courtesy_reason || '' };
  if (!c.billing_method) return { state: 'interna', paying: false };
  if (c.subscription_status === 'cancelada') return { state: 'cancelada', paying: false };
  if (c.subscription_status === 'atrasada') return { state: 'atrasada', paying: true };
  if (c.paid_until && c.paid_until < ref) return { state: 'vencida', paying: true };
  return { state: 'em_dia', paying: true };
}

/**
 * Cortesia: o admin libera um plano pago sem cobrança, com motivo e, se quiser, prazo.
 * No fim do prazo a empresa volta sozinha para o teste grátis.
 */
export function grantCourtesy(companyId, planId, { until = null, reason = '' } = {}) {
  const plan = PLANS[planId];
  if (!plan || !(plan.price_cents > 0)) throw new Error('Escolha um plano pago para a cortesia');
  const why = String(reason || '').trim().slice(0, 120);
  if (!why) throw new Error('Informe o motivo da cortesia');
  if (until && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < today())) throw new Error('O prazo precisa ser hoje ou uma data futura');
  const c = main.get('SELECT billing_method, stripe_subscription_id, subscription_status FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  if (c.billing_method === 'cartao' && c.stripe_subscription_id && c.subscription_status !== 'cancelada') {
    throw new Error('Esta empresa paga no cartão. Cancele a assinatura no Stripe antes de liberar uma cortesia.');
  }
  applyPlan(companyId, planId);
  main.run('UPDATE companies SET courtesy_until = ?, courtesy_reason = ? WHERE id = ?', until || null, why, companyId);
  return { plan: planId, until: until || null, reason: why };
}

/** Encerra a cortesia: volta para o teste grátis. */
export function endCourtesy(companyId) {
  if (!main.get('SELECT id FROM companies WHERE id = ?', companyId)) return null;
  applyPlan(companyId, 'gratis');
  main.run('UPDATE companies SET courtesy_until = NULL, courtesy_reason = NULL WHERE id = ?', companyId);
  return true;
}

/** Agendador: cortesias vencidas voltam para o teste grátis. */
export function processCourtesies(ref = today()) {
  const due = main.all('SELECT id, plan, courtesy_until FROM companies WHERE courtesy_until IS NOT NULL AND courtesy_until < ?', ref);
  for (const c of due) {
    endCourtesy(c.id);
    main.run('INSERT INTO audit_log (actor, action, company_id, details) VALUES (?, ?, ?, ?)', 'sistema', 'cortesia encerrada', c.id,
      `prazo terminou em ${c.courtesy_until.split('-').reverse().join('/')}; voltou para o teste grátis`);
  }
  return due.length;
}

const monthKey = (iso) => String(iso).slice(0, 7);

/** Painel financeiro da plataforma: recebidos, a receber e assinantes por plano. */
export function financeOverview() {
  const ref = today();
  const in30 = addDays(ref, 30);
  const companies = main.all(
    `SELECT id, name, status, plan, billing_method, paid_until, subscription_status, cancel_at_period_end, upgrade_plan, upgrade_requested_at,
       courtesy_until, courtesy_reason FROM companies ORDER BY name`,
  ).map((c) => ({ ...c, ...subscriptionState(c, ref), price_cents: PLANS[c.plan]?.price_cents || 0 }));

  const payments = main.all("SELECT p.*, c.name AS company_name FROM subscription_payments p LEFT JOIN companies c ON c.id = p.company_id ORDER BY COALESCE(p.paid_at, p.created_at) DESC");
  const paid = payments.filter((p) => p.status === 'pago');
  const thisMonth = monthKey(ref);
  const prevMonth = monthKey(addMonths(`${thisMonth}-01`, -1));
  const sumIn = (list, month) => list.filter((p) => monthKey(p.paid_at) === month).reduce((n, p) => n + p.amount_cents, 0);
  const months = Array.from({ length: 12 }, (_, i) => monthKey(addMonths(`${thisMonth}-01`, i - 11)));

  // A receber: renovações dos próximos 30 dias, pedidos de Pix em aberto e mensalidades atrasadas.
  const renewing = companies.filter((c) => c.paying && c.state === 'em_dia' && !c.cancel_at_period_end && c.paid_until && c.paid_until <= in30)
    .map((c) => ({ id: c.id, name: c.name, plan: c.plan, method: c.billing_method, due_date: addDays(c.paid_until, 1), amount_cents: c.price_cents }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = companies.filter((c) => ['vencida', 'atrasada'].includes(c.state))
    .map((c) => ({ id: c.id, name: c.name, plan: c.plan, method: c.billing_method, due_date: c.paid_until ? addDays(c.paid_until, 1) : null, amount_cents: c.price_cents, state: c.state }));
  const requests = companies.filter((c) => c.upgrade_plan)
    .map((c) => ({ id: c.id, name: c.name, plan: c.upgrade_plan, requested_at: c.upgrade_requested_at, amount_cents: PLANS[c.upgrade_plan]?.price_cents || 0 }));
  const total = (list) => list.reduce((n, x) => n + x.amount_cents, 0);

  const plans = Object.entries(PLANS).map(([id, p]) => {
    const on = companies.filter((c) => c.plan === id && c.status === 'ativa');
    const paying = on.filter((c) => c.paying && c.state !== 'cancelada');
    return {
      id, label: p.label, price_cents: p.price_cents,
      companies: on.length, paying: paying.length,
      card: paying.filter((c) => c.billing_method === 'cartao').length,
      pix: paying.filter((c) => c.billing_method === 'pix').length,
      courtesy: on.filter((c) => c.state === 'cortesia').length,
      internal: on.filter((c) => c.state === 'interna').length,
      mrr_cents: paying.length * p.price_cents,
    };
  });

  return {
    today: ref,
    received: {
      this_month_cents: sumIn(paid, thisMonth),
      prev_month_cents: sumIn(paid, prevMonth),
      last_12m_cents: paid.filter((p) => monthKey(p.paid_at) >= months[0]).reduce((n, p) => n + p.amount_cents, 0),
      by_method: { cartao: paid.filter((p) => p.method === 'cartao').reduce((n, p) => n + p.amount_cents, 0), pix: paid.filter((p) => p.method === 'pix').reduce((n, p) => n + p.amount_cents, 0) },
      series: months.map((m) => ({ month: m, cents: sumIn(paid, m) })),
    },
    receivable: {
      next_30d_cents: total(renewing),
      card_cents: total(renewing.filter((r) => r.method === 'cartao')),
      pix_cents: total(renewing.filter((r) => r.method === 'pix')),
      renewing,
      requests, requests_cents: total(requests),
      overdue, overdue_cents: total(overdue),
    },
    plans,
    mrr_cents: plans.reduce((n, p) => n + p.mrr_cents, 0),
    payments: payments.slice(0, 50),
  };
}
