import crypto from 'node:crypto';
import { main, now } from '../db.js';
import { config } from '../config.js';
import { PLANS, REFERRAL_TRIAL_DAYS, TRIAL_DAYS, EXPIRED_PLAN } from './plans.js';
import { today, addMonths, startTrial, grantCourtesy, setFirstPaymentHook, isTrialReason } from './subscriptions.js';
import { addDays, zonedParts } from './time.js';
import { creditCustomer } from './stripe.js';

// "Indique e ganhe" (cliente chama cliente): cada usuário tem um código só dele (numa empresa com dois
// funcionários, cada um tem o seu). Quem chega com o código ganha 30 dias grátis (em vez de 7); a empresa
// de quem indicou ganha +1 mês quando o indicado fizer o primeiro pagamento (conta falsa não rende prêmio).
// Fica registrado qual usuário indicou, para o admin ver.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I, para ditar sem confusão
const randomPart = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const prefixOf = (name) => String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'CRM';
export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Código do usuário (criado na primeira vez), com o primeiro nome dele. Ex.: MARIA-7K3Q */
export function referralCode(userId) {
  const u = main.get('SELECT name, referral_code FROM users WHERE id = ?', userId);
  if (!u) return null;
  if (u.referral_code) return u.referral_code;
  for (let i = 0; i < 10; i++) {
    const code = `${prefixOf(String(u.name).split(' ')[0])}-${randomPart(4)}`;
    try {
      main.run('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', code, userId);
      return main.get('SELECT referral_code FROM users WHERE id = ?', userId).referral_code;
    } catch { /* código repetido: tenta outro */ }
  }
  throw new Error('Não foi possível gerar o código de indicação');
}

/** Dono do código: o usuário e a empresa dele (sem hífen e sem diferença de maiúsculas). */
export function ownerOfCode(code) {
  const norm = normalizeCode(code);
  if (norm.length < 5) return null;
  return main.get(
    `SELECT u.id AS user_id, u.name AS user_name, u.referral_code AS code, c.id AS company_id, c.name AS company_name, c.status
     FROM users u JOIN companies c ON c.id = u.company_id WHERE REPLACE(u.referral_code, '-', '') = ? AND u.active = 1`, norm,
  ) || null;
}

export const referralLink = (code) => `${config.publicUrl}/?ref=${encodeURIComponent(code)}`;
export const shareMessage = (code) => `Estou usando o Conversa CRM para atender meus clientes no WhatsApp, com IA, agenda e CRM, e acredito que você deveria conhecer. Com o meu código ${code} você ganha 1 mês grátis: ${referralLink(code)}`;

/** Cadastro novo: com código válido, 30 dias de teste e a indicação registrada; sem código, 7 dias. */
export function startSignupTrial(companyId, code) {
  const ref = code ? ownerOfCode(code) : null;
  if (ref && ref.company_id !== companyId && ref.status === 'ativa') {
    main.run('UPDATE companies SET referred_by = ?, referred_by_user = ? WHERE id = ?', ref.company_id, ref.user_id, companyId);
    startTrial(companyId, REFERRAL_TRIAL_DAYS, `Indicação: 1 mês grátis (código ${ref.code})`);
    return { days: REFERRAL_TRIAL_DAYS, referred_by: ref.company_id };
  }
  startTrial(companyId, TRIAL_DAYS, 'Teste grátis de 7 dias');
  return { days: TRIAL_DAYS, referred_by: null };
}

/** Já cadastrada, ainda no teste e sem indicação: usar um código estende o teste para 30 dias. */
export function redeemCode(companyId, code) {
  const c = main.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (c.referred_by) throw new Error('Sua conta já usou um código de indicação.');
  if (!isTrialReason(c.courtesy_reason)) throw new Error('O código de indicação vale para contas em teste grátis.');
  const ref = ownerOfCode(code);
  if (!ref || ref.status !== 'ativa') throw new Error('Código não encontrado. Confira com quem te indicou.');
  if (ref.company_id === companyId) throw new Error('Este código é da sua própria empresa: compartilhe com outras pessoas.');
  main.run('UPDATE companies SET referred_by = ?, referred_by_user = ? WHERE id = ?', ref.company_id, ref.user_id, companyId);
  // 30 dias contados do cadastro (o que já foi usado do teste conta).
  const start = zonedParts(new Date(c.created_at), 'America/Sao_Paulo').date;
  const until = [addDays(start, REFERRAL_TRIAL_DAYS), addDays(today(), 1)].sort().at(-1);
  main.run('UPDATE companies SET courtesy_until = ?, courtesy_reason = ? WHERE id = ?', until, `Indicação: 1 mês grátis (código ${ref.code})`, companyId);
  return { until };
}

const audit = (companyId, action, details) => main.run('INSERT INTO audit_log (actor, action, company_id, details) VALUES (?, ?, ?, ?)', 'sistema', action, companyId, details);

/**
 * O indicado pagou pela primeira vez: quem indicou ganha +1 mês.
 * Cartão: crédito no Stripe no valor do plano. Pix: mais um mês pago. Teste ou cortesia com prazo:
 * +30 dias. Teste encerrado: 30 dias de Básico. Sem como aplicar agora (ex.: cortesia sem prazo): fica
 * contado em referral_months, para o admin ver.
 */
export function rewardReferrer(companyId) {
  const invited = main.get('SELECT id, name, referred_by, referred_by_user, referral_rewarded_at FROM companies WHERE id = ?', companyId);
  if (!invited?.referred_by || invited.referral_rewarded_at) return null;
  main.run('UPDATE companies SET referral_rewarded_at = ? WHERE id = ?', now(), companyId);
  const r = main.get('SELECT * FROM companies WHERE id = ?', invited.referred_by);
  if (!r) return null;
  main.run('UPDATE companies SET referral_months = referral_months + 1 WHERE id = ?', r.id);
  let how;
  if (r.billing_method === 'cartao' && r.stripe_customer_id && r.subscription_status !== 'cancelada') {
    const cents = PLANS[r.plan]?.price_cents || 0;
    how = 'crédito de 1 mês na próxima fatura do cartão';
    creditCustomer(r.stripe_customer_id, cents, `Indicação: ${invited.name} assinou o Conversa CRM`).catch((err) => {
      audit(r.id, 'prêmio de indicação pendente', `crédito no Stripe falhou (${err.message}); aplicar à mão`);
    });
  } else if (r.billing_method === 'pix' && r.paid_until && r.subscription_status !== 'cancelada' && !r.courtesy_reason) {
    const base = r.paid_until >= today() ? r.paid_until : today();
    main.run('UPDATE companies SET paid_until = ? WHERE id = ?', addMonths(base, 1), r.id);
    how = 'mais 1 mês pago no Pix';
  } else if (r.courtesy_until) {
    main.run('UPDATE companies SET courtesy_until = ? WHERE id = ?', addDays(r.courtesy_until, 30), r.id);
    how = '+30 dias no teste/cortesia';
  } else if (r.plan === EXPIRED_PLAN) {
    grantCourtesy(r.id, 'basico', { until: addDays(today(), 30), reason: 'Indicação: mês grátis por indicar' });
    how = '30 dias do Básico';
  } else {
    how = 'mês contado para aplicar depois (conta sem cobrança agora)';
  }
  const who = invited.referred_by_user && main.get('SELECT name, referral_code FROM users WHERE id = ?', invited.referred_by_user);
  audit(r.id, 'prêmio de indicação', `${invited.name} fez o primeiro pagamento${who ? ` (indicada por ${who.name}, código ${who.referral_code})` : ''}: ${how}`);
  return { referrer: r.id, how };
}
setFirstPaymentHook(rewardReferrer);

/** Tela "Descontos e promoções": o código do usuário, link, mensagem pronta e resultados da empresa. */
export function referralOverview(companyId, userId) {
  const code = referralCode(userId);
  const c = main.get('SELECT referred_by, courtesy_reason, referral_months FROM companies WHERE id = ?', companyId);
  const invited = main.all(
    `SELECT c.name, c.created_at, c.referral_rewarded_at, c.referred_by_user, u.name AS by_name FROM companies c
     LEFT JOIN users u ON u.id = c.referred_by_user WHERE c.referred_by = ? ORDER BY c.created_at DESC LIMIT 100`, companyId,
  );
  const mine = invited.filter((i) => i.referred_by_user === userId);
  return {
    code, link: referralLink(code), message: shareMessage(code),
    mine: { invited: mine.length, converted: mine.filter((i) => i.referral_rewarded_at).length },
    invited: invited.length, converted: invited.filter((i) => i.referral_rewarded_at).length, months_earned: c.referral_months,
    // Lista sem dados de contato: a empresa indicada, quem da equipe indicou e se já assinou.
    people: invited.map((i) => ({ name: i.name, since: i.created_at, paid: Boolean(i.referral_rewarded_at), by: i.by_name || null })),
    can_redeem: !c.referred_by && isTrialReason(c.courtesy_reason),
    referred: Boolean(c.referred_by),
  };
}

/** Admin: todas as indicações, com o código usado, o usuário e a empresa de quem indicou. */
export function adminReferrals() {
  const rows = main.all(
    `SELECT c.id, c.name, c.plan, c.created_at, c.referral_rewarded_at, c.courtesy_reason,
       u.id AS by_user_id, u.name AS by_user, u.email AS by_email, u.referral_code AS code, r.id AS by_company_id, r.name AS by_company
     FROM companies c JOIN companies r ON r.id = c.referred_by LEFT JOIN users u ON u.id = c.referred_by_user
     ORDER BY c.created_at DESC LIMIT 500`,
  );
  // Ranking por usuário que indicou (quem mais traz gente e quem mais converte).
  const byUser = new Map();
  for (const x of rows) {
    const k = x.by_user_id || `c${x.by_company_id}`;
    const cur = byUser.get(k) || { user: x.by_user || '-', email: x.by_email || '', code: x.code || '', company: x.by_company, company_id: x.by_company_id, invited: 0, paid: 0 };
    cur.invited++; if (x.referral_rewarded_at) cur.paid++;
    byUser.set(k, cur);
  }
  return {
    total: rows.length, paid: rows.filter((x) => x.referral_rewarded_at).length,
    ranking: [...byUser.values()].sort((a, b) => b.paid - a.paid || b.invited - a.invited),
    list: rows,
  };
}
