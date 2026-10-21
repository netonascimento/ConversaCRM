import { main } from '../db.js';
import { financeOverview } from './subscriptions.js';
import { PLANS } from './plans.js';

// Medição própria do Conversa CRM, sem ferramentas de terceiros:
// - página inicial: visitas, origem, tempo de leitura, atenção por seção, rolagem, FAQ e botões clicados;
// - sistema: tempo em cada menu (enviado pela tela) e uso de cada função (registrado aqui no servidor);
// - cadastro, ativação, assinatura e indicações, para o funil.
// O visitante é um identificador aleatório guardado só no navegador; não guardamos IP nem cookies de terceiros.

export const GOAL_MRR_CENTS = 1000000; // meta do dono: R$ 10 mil por mês

const KINDS = new Set(['pageview', 'section', 'scroll', 'time', 'faq', 'cta', 'plan', 'app_page', 'share', 'signup_view', 'promo']);
const ID = /^[A-Za-z0-9_-]{6,40}$/;
const clean = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) || null);

// Proteção simples: cada visitante manda no máximo 300 eventos por 10 minutos.
const buckets = new Map();
function allowed(key, n) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > 600000) { buckets.set(key, { start: now, n }); return true; }
  b.n += n;
  if (buckets.size > 20000) buckets.clear();
  return b.n <= 300;
}

/** Eventos enviados pela página inicial ou pelo sistema (POST /api/t). */
export function track(body, { userId = null, companyId = null } = {}) {
  const visitor = ID.test(body?.v || '') ? body.v : null;
  const session = ID.test(body?.s || '') ? body.s : null;
  const events = Array.isArray(body?.e) ? body.e.slice(0, 60) : [];
  if (!events.length || (!visitor && !userId)) return 0;
  if (!allowed(visitor || `u${userId}`, events.length)) return 0;
  const device = body.d === 'mobile' ? 'mobile' : 'desktop';
  const source = clean(body.src, 80);
  let n = 0;
  for (const e of events) {
    if (!KINDS.has(e?.k)) continue;
    const value = Number.isFinite(Number(e.val)) ? Math.max(0, Math.min(Number(e.val), 86400000)) : null;
    main.run(
      'INSERT INTO analytics_events (visitor_id, session_id, user_id, company_id, kind, name, value, path, source, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      visitor, session, userId, companyId, e.k, clean(e.n, 120), value, clean(body.p, 120), e.k === 'pageview' ? source : null, device,
    );
    n++;
  }
  return n;
}

/** Uso de uma função do sistema (chamado pelo servidor a cada ação de quem está logado). */
export function recordFeature(req, pattern) {
  try {
    main.run('INSERT INTO analytics_events (user_id, company_id, kind, name) VALUES (?, ?, ?, ?)', req.user.id, req.companyId, 'feature', `${req.method} ${pattern}`);
  } catch { /* medição nunca derruba a requisição */ }
}

/** Cadastro: liga a empresa nova ao visitante da página inicial (origem, campanha, indicação). */
export function recordSignup(companyId, { visitor, source }) {
  const v = ID.test(visitor || '') ? visitor : null;
  main.run('UPDATE companies SET signup_visitor = ?, signup_source = ? WHERE id = ?', v, clean(source, 80), companyId);
  main.run('INSERT INTO analytics_events (visitor_id, company_id, kind, name, source) VALUES (?, ?, ?, ?, ?)', v, companyId, 'signup', 'cadastro', clean(source, 80));
}

/** Apaga eventos antigos (LGPD: guardar só o necessário). */
export function purgeAnalytics(days = 180) {
  return main.run('DELETE FROM analytics_events WHERE at < ?', new Date(Date.now() - days * 86400000).toISOString()).changes;
}

// Nomes amigáveis das funções mais importantes (o resto aparece pelo caminho da API).
const FEATURES = {
  'POST /api/conversations/:id/messages': 'Respondeu no Atendimento',
  'POST /api/conversations/:id/ai-reply': 'Pediu resposta à IA',
  'POST /api/conversations/:id/assign': 'Passou conversa para alguém',
  'POST /api/contacts': 'Cadastrou cliente/lead',
  'PUT /api/contacts/:id': 'Editou cliente',
  'POST /api/contacts/import': 'Importou contatos',
  'POST /api/contacts/:id/stage': 'Moveu no funil',
  'POST /api/appointments': 'Criou agendamento',
  'PUT /api/appointments/:id': 'Alterou agendamento',
  'POST /api/charges': 'Criou cobrança',
  'POST /api/sequences': 'Criou follow-up',
  'POST /api/prospecting/search': 'Buscou no Google Maps',
  'POST /api/prospecting/import': 'Importou da prospecção',
  'POST /api/tasks': 'Criou tarefa',
  'PUT /api/settings': 'Mudou configurações',
  'POST /api/whatsapp/connect': 'Conectou WhatsApp',
  'POST /api/products': 'Cadastrou produto/serviço',
  'POST /api/documents': 'Anexou documento',
  'POST /api/contracts': 'Criou contrato',
  'POST /api/legal/cases': 'Cadastrou processo',
  'POST /api/legal/oabs': 'Cadastrou OAB',
  'POST /api/users': 'Convidou usuário',
  'POST /api/upgrade/card': 'Abriu pagamento no cartão',
  'POST /api/upgrade/pix': 'Abriu pagamento no Pix',
  'POST /api/referral/redeem': 'Usou código de indicação',
  'POST /api/mei': 'Enviou certificado MEI',
  'POST /api/insights': 'Gerou recomendações',
};
const SECTION = { inicio: 'Topo (início)', recursos: 'Recursos', 'para-quem': 'Para quem é', 'como-funciona': 'Como funciona', planos: 'Planos', duvidas: 'Dúvidas (FAQ)', final: 'Chamada final' };
const MENU = { dashboard: 'Dashboard', inbox: 'Atendimento', tarefas: 'Tarefas', crm: 'CRM / Funil', clientes: 'Clientes', processos: 'Processos', agenda: 'Agenda', followup: 'Follow-up', cobranca: 'Cobrança', prospeccao: 'Prospecção', produtos: 'Produtos', config: 'Configurações', assinar: 'Assinatura', promocoes: 'Descontos e promoções', comecar: 'Primeiros passos' };

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Relatório executivo para o admin: meta, funil, página inicial, uso do sistema, indicações e alertas. */
export function intelligence(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const ev = (kind) => main.all('SELECT * FROM analytics_events WHERE kind = ? AND at >= ?', kind, since);

  // ---- Meta de receita
  const fin = financeOverview();
  const paying = fin.plans.reduce((n, p) => n + p.paying, 0);
  const avgTicket = paying ? Math.round(fin.mrr_cents / paying) : PLANS.essencial.price_cents;
  const goal = {
    target_cents: GOAL_MRR_CENTS, mrr_cents: fin.mrr_cents, percent: pct(fin.mrr_cents, GOAL_MRR_CENTS),
    paying, avg_ticket_cents: avgTicket,
    missing_customers: Math.max(0, Math.ceil((GOAL_MRR_CENTS - fin.mrr_cents) / avgTicket)),
    trial: fin.plans.reduce((n, p) => n + (p.trial || 0), 0),
  };

  // ---- Página inicial
  const views = ev('pageview').filter((e) => (e.path || '/') === '/');
  const visitors = new Set(views.map((e) => e.visitor_id)).size;
  const sessions = new Set(views.map((e) => e.session_id)).size;
  const timeBySession = new Map();
  for (const e of ev('time')) timeBySession.set(e.session_id, Math.max(timeBySession.get(e.session_id) || 0, e.value || 0));
  const reading = [...timeBySession.values()].filter((v) => v > 0);
  const scrollBySession = new Map();
  for (const e of ev('scroll')) scrollBySession.set(e.session_id, Math.max(scrollBySession.get(e.session_id) || 0, e.value || 0));
  const scrolls = [...scrollBySession.values()];
  const sectionStats = new Map();
  for (const e of ev('section')) {
    const s = sectionStats.get(e.name) || { sessions: new Set(), ms: 0 };
    if ((e.value || 0) >= 1500) s.sessions.add(e.session_id);
    s.ms += e.value || 0;
    sectionStats.set(e.name, s);
  }
  const sections = [...sectionStats.entries()].map(([id, s]) => ({
    id, label: SECTION[id] || id, seen_percent: pct(s.sessions.size, sessions), avg_seconds: s.sessions.size ? Math.round(s.ms / s.sessions.size / 1000) : 0,
  })).sort((a, b) => Object.keys(SECTION).indexOf(a.id) - Object.keys(SECTION).indexOf(b.id));
  const countBy = (list, key = 'name') => [...list.reduce((m, e) => m.set(e[key] || '(sem nome)', (m.get(e[key] || '(sem nome)') || 0) + 1), new Map())]
    .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const firstSource = new Map();
  for (const e of views) if (!firstSource.has(e.visitor_id)) firstSource.set(e.visitor_id, e.source || 'direto');
  const sources = countBy([...firstSource.values()].map((s) => ({ name: s }))).slice(0, 10);
  const devices = countBy(views.map((e) => ({ name: e.device === 'mobile' ? 'Celular' : 'Computador', session: e.session_id }))
    .filter((x, i, a) => a.findIndex((y) => y.session === x.session) === i));
  const landing = {
    visitors, sessions,
    avg_seconds: reading.length ? Math.round(reading.reduce((a, b) => a + b, 0) / reading.length / 1000) : 0,
    median_seconds: Math.round(median(reading) / 1000),
    scroll: { half: pct(scrolls.filter((v) => v >= 50).length, scrolls.length), full: pct(scrolls.filter((v) => v >= 90).length, scrolls.length) },
    sections, faq: countBy(ev('faq')).slice(0, 10), cta: countBy(ev('cta')).slice(0, 10), plans: countBy(ev('plan')).slice(0, 10),
    sources, devices,
  };

  // ---- Funil (cadastros do período)
  const signups = main.all('SELECT id, name, signup_source, signup_visitor, created_at, plan, referred_by FROM companies WHERE created_at >= ?', since);
  const ids = signups.map((c) => c.id);
  const inList = ids.length ? `(${ids.join(',')})` : '(0)';
  const activated = main.all(
    `SELECT DISTINCT company_id FROM analytics_events WHERE company_id IN ${inList} AND kind = 'feature'
     AND name IN ('POST /api/contacts', 'POST /api/whatsapp/connect', 'POST /api/conversations/:id/messages', 'POST /api/appointments', 'POST /api/contacts/import')`,
  ).length;
  const paid = main.all(`SELECT DISTINCT company_id FROM subscription_payments WHERE status = 'pago' AND company_id IN ${inList}`).length;
  const sawPlans = sectionStats.get('planos')?.sessions.size || 0;
  const signupClicks = new Set(ev('cta').filter((e) => /cadastro|grátis|gratis|assinar|começar|comecar/i.test(e.name || '')).map((e) => e.session_id)).size;
  const funnel = [
    { step: 'Visitaram a página', count: sessions },
    { step: 'Chegaram aos planos', count: sawPlans },
    { step: 'Clicaram para começar', count: signupClicks },
    { step: 'Se cadastraram', count: signups.length },
    { step: 'Usaram de verdade', count: activated },
    { step: 'Pagaram', count: paid },
  ].map((s, i, a) => ({ ...s, from_previous: i ? pct(s.count, a[i - 1].count) : 100 }));
  const signupSources = countBy(signups.map((c) => ({ name: c.referred_by ? 'indicação' : c.signup_source || 'direto' })));

  // ---- Uso do sistema
  const pages = ev('app_page');
  const menuMap = new Map();
  for (const e of pages) {
    const m = menuMap.get(e.name) || { ms: 0, users: new Set(), visits: 0 };
    m.ms += e.value || 0; m.users.add(e.user_id); m.visits++;
    menuMap.set(e.name, m);
  }
  const menus = [...menuMap.entries()].map(([id, m]) => ({
    id, label: MENU[id] || id, minutes: Math.round(m.ms / 60000), users: m.users.size, visits: m.visits, avg_seconds: m.visits ? Math.round(m.ms / m.visits / 1000) : 0,
  })).sort((a, b) => b.minutes - a.minutes);
  const featureRows = ev('feature');
  const featMap = new Map();
  for (const e of featureRows) {
    const f = featMap.get(e.name) || { count: 0, companies: new Set() };
    f.count++; f.companies.add(e.company_id);
    featMap.set(e.name, f);
  }
  const features = [...featMap.entries()].map(([name, f]) => ({ name, label: FEATURES[name] || name, count: f.count, companies: f.companies.size }))
    .sort((a, b) => b.companies - a.companies || b.count - a.count).slice(0, 25);

  // ---- Por empresa: quem usa, quem está esfriando, testes acabando
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const companies = main.all(
    `SELECT c.id, c.name, c.plan, c.courtesy_until, c.courtesy_reason, c.created_at, c.status,
       (SELECT MAX(at) FROM analytics_events e WHERE e.company_id = c.id) AS last_at,
       (SELECT COUNT(DISTINCT user_id) FROM analytics_events e WHERE e.company_id = c.id AND e.at >= ?) AS users_7d,
       (SELECT COUNT(*) FROM analytics_events e WHERE e.company_id = c.id AND e.kind = 'feature' AND e.at >= ?) AS actions,
       (SELECT ROUND(SUM(value) / 60000) FROM analytics_events e WHERE e.company_id = c.id AND e.kind = 'app_page' AND e.at >= ?) AS minutes,
       (SELECT name FROM analytics_events e WHERE e.company_id = c.id AND e.kind = 'app_page' AND e.at >= ? GROUP BY name ORDER BY SUM(value) DESC LIMIT 1) AS top_menu
     FROM companies c WHERE c.status = 'ativa' ORDER BY actions DESC, last_at DESC LIMIT 200`,
    weekAgo, since, since, since,
  ).map((c) => ({ ...c, top_menu: MENU[c.top_menu] || c.top_menu || null, plan_label: PLANS[c.plan]?.label || c.plan }));
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const endingTrials = companies.filter((c) => /^(Teste|Indicação)/.test(c.courtesy_reason || '') && c.courtesy_until && c.courtesy_until <= in3);
  const cooling = companies.filter((c) => c.last_at && c.last_at < weekAgo);

  // ---- Indicações
  const shares = ev('share');
  const referral = {
    shares: shares.length, sharers: new Set(shares.map((e) => e.user_id)).size,
    visits: new Set(views.filter((e) => e.source === 'indicação').map((e) => e.visitor_id)).size,
    signups: signups.filter((c) => c.referred_by).length,
    paid: main.all(`SELECT DISTINCT p.company_id FROM subscription_payments p JOIN companies c ON c.id = p.company_id WHERE p.status = 'pago' AND c.referred_by IS NOT NULL AND c.id IN ${inList}`).length,
    channels: countBy(shares),
  };

  // ---- Leitura executiva: o que os números dizem e o que fazer
  const tips = [];
  if (goal.missing_customers) tips.push(`Faltam cerca de ${goal.missing_customers} assinantes no ticket médio atual (R$ ${(avgTicket / 100).toFixed(2).replace('.', ',')}) para a meta de R$ 10 mil/mês.`);
  const plansSec = sections.find((s) => s.id === 'planos');
  if (sessions >= 20 && plansSec && plansSec.seen_percent < 40) tips.push(`Só ${plansSec.seen_percent}% dos visitantes chegam aos Planos: leve preço e o "1 mês grátis por indicação" para mais perto do topo.`);
  if (landing.faq[0]?.count >= 3) tips.push(`A dúvida mais aberta é "${landing.faq[0].name}" (${landing.faq[0].count}×): responda isso no topo da página e na primeira mensagem de vendas.`);
  if (funnel[3].count >= 5 && funnel[4].from_previous < 50) tips.push(`Só ${funnel[4].from_previous}% de quem se cadastra usa de verdade: o passo a passo inicial e a conexão do WhatsApp são o gargalo.`);
  if (funnel[4].count && funnel[5].from_previous < 20 && funnel[4].count >= 5) tips.push(`${funnel[5].from_previous}% de quem usa acaba pagando: avise no 5º dia do teste e ofereça ajuda pelo WhatsApp.`);
  if (endingTrials.length) tips.push(`${endingTrials.length} teste(s) acabam em até 3 dias: é a melhor hora de chamar no WhatsApp.`);
  if (cooling.length) tips.push(`${cooling.length} empresa(s) não entram há mais de 7 dias: risco de cancelar.`);
  if (referral.sharers === 0 && paying > 0) tips.push('Ninguém compartilhou o código de indicação ainda: mostre o "Indique e ganhe" depois de cada resposta boa da IA ou de um agendamento.');
  if (menus[0]?.minutes >= 5) tips.push(`O menu onde passam mais tempo é ${menus[0].label} (${menus[0].minutes} min no período).`);

  return { days, goal, funnel, signup_sources: signupSources, landing, menus, features, companies: companies.slice(0, 50), ending_trials: endingTrials, cooling: cooling.slice(0, 20), referral, tips };
}
