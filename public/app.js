// Falaki — painel web (SPA sem dependências)
import { parseDelimited, parseVCard, guessMapping, toContacts, FIELDS } from './import.js';

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const reais = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const phoneFmt = (p) => {
  if (!p) return '';
  const m = String(p).match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
};

const state = { me: null, meta: null, unread: 0, timers: [] };
const tz = () => state.me?.company.timezone || 'America/Sao_Paulo';

function fmt(iso, opts = { dateStyle: 'short', timeStyle: 'short' }) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz(), ...opts }).format(new Date(iso));
}
const fmtDay = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };
function localParts(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute) };
}
const todayStr = () => localParts(new Date().toISOString()).date;
function addDays(d, n) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const WD_LABEL = { dom: 'Domingo', seg: 'Segunda', ter: 'Terça', qua: 'Quarta', qui: 'Quinta', sex: 'Sexta', sab: 'Sábado' };

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return fmt(iso, { day: '2-digit', month: '2-digit' });
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) { state.me = null; renderAuth(); throw new Error(data.error || 'Sessão expirada'); }
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
const fail = (err) => toast(err.message || String(err), 'error');

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

function openModal(html, { wide = false, drawer = false } = {}) {
  const root = $('#modal-root');
  const overlay = document.createElement('div');
  overlay.className = `overlay${drawer ? ' drawer-overlay' : ''}`;
  overlay.innerHTML = `<div class="${drawer ? 'drawer' : `modal${wide ? ' wide' : ''}`}">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) overlay.remove(); });
  root.appendChild(overlay);
  const box = overlay.firstElementChild;
  box.close = () => overlay.remove();
  return box;
}
const closeAllModals = () => { $('#modal-root').innerHTML = ''; };

const modalHead = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><span class="spacer"></span><button class="ghost" data-close aria-label="Fechar">✕</button></div>`;

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  inbox: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.6A8.5 8.5 0 1 1 21 11.5z"/>',
  crm: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  agenda: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
  followup: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5M12 7v5l3 3"/>',
  tarefas: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  cobranca: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  prospeccao: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  clientes: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20"/>',
  produtos: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7L12 12l8.7-5M12 22V12"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const STAGE_COLORS = { novo: 'blue', contato: 'purple', qualificado: 'amber', proposta: 'amber', ganho: 'green', perdido: 'red' };
const stageLabel = (id) => state.meta?.stages.find((s) => s.id === id)?.label || id;
const stageBadge = (id) => `<span class="badge ${STAGE_COLORS[id] || ''}">${esc(stageLabel(id))}</span>`;
const SOURCE_LABEL = { whatsapp: 'WhatsApp', manual: 'Manual', google_maps: 'Google Maps', site: 'Site', indicacao: 'Indicação', importacao: 'Importação' };
const CHARGE_BADGE = { pendente: 'amber', pago: 'green', vencido: 'red', cancelado: '' };
const sessionGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const sessionSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* sem armazenamento */ } };
// Teste grátis: tudo que usa IA aparece com cadeado e leva para a tela de assinatura.
const aiLocked = () => Boolean(state.meta?.ai_locked);
const lockBtn = (label = 'Desbloquear IA') => `<a class="btn sm" href="#/assinar" title="A IA faz parte dos planos pagos">🔒 ${esc(label)}</a>`;
const lockCard = (what) => `<div class="banner">🔒 <strong>${esc(what)}</strong> faz parte dos planos pagos. No teste grátis você usa o atendimento manual, o CRM, a agenda e o resto do sistema. <a href="#/assinar">Desbloquear a IA</a></div>`;
const AUTHOR_LABEL = { ai: '🤖 IA', human: '👤 Equipe', followup: '🔁 Follow-up', billing: '💰 Cobrança', system: '⏰ Lembrete', contact: '' };

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------
// Plano escolhido na página inicial (/app#/assinar/essencial): depois do cadastro ou login, vai direto para o Pix.
const buyingPlanId = () => (location.hash.match(/^#\/assinar\/([a-z]+)/) || [])[1] || null;

async function renderAuth(mode = 'login') {
  clearTimers();
  closeAllModals();
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ allow_signup: false, segments: [] }));
  if (!cfg.allow_signup) mode = 'login';
  const buying = buyingPlanId()
    ? (await fetch('/api/public/info').then((r) => r.json()).catch(() => ({ plans: [] }))).plans.find((p) => p.id === buyingPlanId() && p.price_cents > 0)
    : null;
  const title = buying ? `Assinar o ${buying.label}` : mode === 'login' ? 'Entrar' : 'Teste grátis';
  const intro = buying
    ? `${money(buying.price_cents)}/mês, com IA. ${mode === 'login' ? 'Entre na sua conta' : 'Crie a conta da sua empresa'} e pague por Pix na próxima tela.`
    : mode === 'login' ? 'Fala aqui. Fecha aqui.' : 'Crie a conta da sua empresa: 1 usuário e até 30 clientes, sem cartão. A IA fica disponível nos planos pagos.';
  $('#app').innerHTML = `
    <div class="auth"><div>
      <div class="card">
        <div class="brand" style="color:var(--green-dark);padding:0 0 12px"><div class="brand-logo">${icon('agenda').replace('currentColor', '#fff')}</div>Falaki</div>
        <h1>${esc(title)}</h1>
        <p class="muted">${esc(intro)}</p>
        <form id="auth-form" class="stack" style="margin-top:16px">
          ${mode === 'register' ? `
            <div><label for="r-company">Nome da empresa</label><input id="r-company" name="companyName" required></div>
            <div><label for="r-segment">Tipo de negócio</label><select id="r-segment" name="segment">${(cfg.segments || []).map((sg) => `<option value="${sg.id}">${esc(sg.label)}</option>`).join('')}</select><div class="hint">Já deixa a IA configurada para o seu segmento. Dá para ajustar depois.</div></div>
            <div><label for="r-name">Seu nome</label><input id="r-name" name="name" required></div>` : ''}
          <div><label for="r-email">E-mail</label><input id="r-email" name="email" type="email" required autocomplete="username"></div>
          <div><label for="r-pass">Senha</label><input id="r-pass" name="password" type="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">${mode === 'register' ? '<div class="hint">Mínimo de 8 caracteres.</div>' : ''}</div>
          <button class="primary" style="width:100%;justify-content:center">${mode === 'login' ? (buying ? 'Entrar e continuar' : 'Entrar') : buying ? 'Criar conta e continuar para o Pix' : 'Criar conta grátis'}</button>
        </form>
        <p class="small muted" style="margin-top:14px;text-align:center">
          ${mode === 'login' ? (cfg.allow_signup ? `Ainda não usa? <a href="#cadastro" data-mode="register">${buying ? 'Criar conta' : 'Teste grátis'}</a>` : '') : 'Já tem conta? <a href="#" data-mode="login">Entrar</a>'}
        </p>
        <p class="small muted" style="text-align:center"><a href="/">Conheça o Falaki</a></p>
      </div>
      <p class="features">✓ IA no WhatsApp 24h &nbsp; ✓ Agenda &nbsp; ✓ CRM &nbsp; ✓ Follow-up &nbsp; ✓ Cobrança Pix &nbsp; ✓ Google Maps &nbsp; ✓ Dashboard</p>
    </div></div>`;
  $('[data-mode]')?.addEventListener('click', (e) => { e.preventDefault(); renderAuth(e.target.dataset.mode); });
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/auth/${mode}`, { method: 'POST', body: formData(e.target) });
      await boot();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Layout e rotas
// ---------------------------------------------------------------------------
const PAGES = [
  ['dashboard', 'Dashboard', renderDashboard],
  ['inbox', 'Atendimento', renderInbox],
  ['tarefas', 'Tarefas da equipe', renderTasks],
  ['crm', 'CRM / Funil', renderCrm],
  ['clientes', 'Clientes', renderClients],
  ['agenda', 'Agenda', renderAgenda],
  ['followup', 'Follow-up', renderFollowup],
  ['cobranca', 'Cobrança', renderBilling],
  ['prospeccao', 'Prospecção', renderProspecting],
  ['produtos', 'Produtos', renderProducts],
  ['config', 'Configurações', renderSettings],
];

// O que cada perfil vê no menu (o servidor também bloqueia o acesso).
const ROLE_PAGES = {
  owner: null,
  agent: ['dashboard', 'inbox', 'tarefas', 'crm', 'clientes', 'agenda', 'followup', 'prospeccao', 'produtos'],
  professional: ['dashboard', 'inbox', 'tarefas', 'crm', 'clientes', 'agenda'],
};
const allowedPages = () => {
  const list = ROLE_PAGES[state.me?.user.role];
  return list ? PAGES.filter((p) => list.includes(p[0])) : PAGES;
};
const isOwner = () => state.me?.user.role === 'owner';

function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function every(ms, fn) { state.timers.push(setInterval(fn, ms)); }

function renderLayout() {
  $('#app').innerHTML = `
    <div class="mobile-top"><button id="menu-btn" aria-label="Abrir menu">☰</button><strong>Falaki</strong></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><div class="brand-logo">${icon('agenda')}</div>Falaki</div>
        <nav class="nav">${allowedPages().map(([id, label]) => `<a href="#/${id}" data-page="${id}">${icon(id)}<span>${label}</span>${id === 'inbox' ? '<span class="badge count hidden" id="unread-badge"></span>' : id === 'tarefas' ? '<span class="badge count hidden" id="tasks-badge"></span>' : ''}</a>`).join('')}</nav>
        <div class="sidebar-foot">
          <div><strong style="color:#fff">${esc(state.me.company.name)}</strong></div>
          ${isOwner() && state.meta?.onboarding && !state.meta.onboarding.complete ? `<a class="onboard-pill" href="#/comecar" id="onboard-pill">Primeiros passos · ${state.meta.onboarding.done_count} de ${state.meta.onboarding.total}<div class="onboard-bar"><span style="width:${state.meta.onboarding.percent}%"></span></div></a>` : ''}
          ${isOwner() && state.meta?.plan ? `<div><a href="#/assinar" style="color:inherit">${state.meta.ai_locked ? '🔒 ' : ''}Plano ${esc(state.meta.plan.label)} · assinatura</a></div>` : ''}
          <div>${esc(state.me.user.email)}</div>
          <button class="sm" id="logout">Sair</button>
        </div>
      </aside>
      <main class="main">
        ${state.me.impersonated ? `<div class="banner">Você está acessando <strong>${esc(state.me.company.name)}</strong> como administrador, para suporte. Este acesso fica registrado.</div>` : ''}
        ${planBanner()}
        <div id="page"></div>
      </main>
    </div>`;
  // Voltar aos Primeiros passos pelo menu reabre o painel, mesmo se estava escondido.
  $('#onboard-pill')?.addEventListener('click', () => { if (state.meta.onboarding?.dismissed) api('/api/onboarding/dismiss', { method: 'POST', body: { dismissed: false } }).then((o) => { state.meta.onboarding = o; route(); }).catch(() => {}); });
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); renderAuth(); };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
}

function planBanner() {
  const plan = state.meta?.plan;
  if (!plan || !isOwner()) return '';
  // Pix: lembrete de renovação (vale para qualquer plano pago, inclusive sem limite de leads).
  const sub = state.meta.subscription;
  if (sub?.method === 'pix' && sub.paid_until && ['em_dia', 'vencida'].includes(sub.state)) {
    const days = Math.round((Date.parse(`${sub.paid_until}T12:00:00Z`) - Date.parse(`${todayStr()}T12:00:00Z`)) / 86400000);
    if (days < 0) return `<div class="banner">O mês pago do plano ${esc(plan.label)} terminou em ${fmtDay(sub.paid_until)}. <a href="#/assinar">Pagar com Pix</a></div>`;
    if (days <= 5) return `<div class="banner">Seu plano ${esc(plan.label)} está pago até ${fmtDay(sub.paid_until)} (${days === 0 ? 'vence hoje' : `${days} dia(s)`}). <a href="#/assinar">Pagar o próximo mês</a></div>`;
  }
  if (sub?.state === 'cortesia' && sub.courtesy_until) {
    const days = Math.round((Date.parse(`${sub.courtesy_until}T12:00:00Z`) - Date.parse(`${todayStr()}T12:00:00Z`)) / 86400000);
    if (days <= 5) return `<div class="banner">🎁 Seu acesso de cortesia ao plano ${esc(plan.label)} termina ${days <= 0 ? 'hoje' : `em ${fmtDay(sub.courtesy_until)}`}. <a href="#/assinar">Assine para continuar com a IA</a></div>`;
  }
  if (sub?.state === 'atrasada') return `<div class="banner">O cartão da assinatura foi recusado. <a href="#/assinar">Atualizar o cartão</a> para não perder o plano.</div>`;
  if (plan.max_leads === null || plan.max_leads === undefined) return '';
  const left = plan.leads_remaining;
  const contact = state.meta.sales_whatsapp ? ` <a href="https://wa.me/${esc(state.meta.sales_whatsapp)}?text=${encodeURIComponent(`Olá! Quero mudar de plano no Falaki (${state.me.company.name}).`)}" target="_blank" rel="noopener">Mudar de plano</a>` : ' <a href="#/assinar">Mudar de plano</a>';
  if (left === 0) return `<div class="banner">Você usou os ${plan.max_leads} leads do plano ${esc(plan.label)}. Novos contatos não entram no CRM até você mudar de plano. ${aiLocked() ? '<a href="#/assinar">Assinar</a>' : contact}</div>`;
  if (aiLocked()) return `<div class="banner">Teste grátis: ${plan.leads_used} de ${plan.max_leads} leads usados, sem IA. <a href="#/assinar">🔒 Desbloquear a IA</a></div>`;
  return `<div class="banner">Plano ${esc(plan.label)}: ${plan.leads_used} de ${plan.max_leads} leads usados.${contact}</div>`;
}

// Atualiza o atalho "Primeiros passos" do menu depois de cada tela (o passo pode ter sido concluído nela).
async function refreshOnboardingPill() {
  if (!isOwner() || !state.meta?.onboarding || state.meta.onboarding.complete) return;
  const o = await api('/api/onboarding').catch(() => null);
  if (!o) return;
  const changed = o.done_count !== state.meta.onboarding.done_count || o.complete;
  state.meta.onboarding = o;
  if (o.complete) { $('#onboard-pill')?.remove(); toast('Tudo pronto! O Falaki já pode atender seus clientes. 🎉'); return; }
  const pill = $('#onboard-pill');
  if (pill && changed) pill.innerHTML = `Primeiros passos · ${o.done_count} de ${o.total}<div class="onboard-bar"><span style="width:${o.percent}%"></span></div>`;
}

async function refreshUnread() {
  try {
    const convs = await api('/api/conversations');
    state.unread = convs.reduce((n, c) => n + (c.unread ? 1 : 0), 0);
    const b = $('#unread-badge');
    if (b) { b.textContent = state.unread; b.classList.toggle('hidden', !state.unread); }
    const open = (await api('/api/tasks?status=aberta')).length;
    const tb = $('#tasks-badge');
    if (tb) { tb.textContent = open; tb.classList.toggle('hidden', !open); }
  } catch { /* ignore */ }
}

async function route() {
  if (!state.me) return;
  clearTimers();
  closeAllModals();
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const [, page = 'dashboard', ...rest] = path.split('/');
  // Volta da autorização do Google Agenda.
  const google = new URLSearchParams(query).get('google');
  if (google) {
    const msg = new URLSearchParams(query).get('msg');
    if (google === 'conectado') toast('Google Agenda conectado. Os agendamentos já estão sincronizando.');
    else if (google === 'erro') toast(`Não foi possível conectar o Google Agenda: ${msg || 'tente de novo'}`, 'error');
    history.replaceState(null, '', `#${path}`);
  }
  const pages = allowedPages();
  // Primeira entrada do dono: abre o assistente de configuração uma vez por sessão.
  const ob = state.meta?.onboarding;
  if (isOwner() && ob && !ob.complete && !ob.dismissed && ob.done_count === 0 && (page === 'dashboard' || !page) && !sessionGet('wizard-auto')) {
    sessionSet('wizard-auto', '1');
    location.hash = '#/comecar';
    return;
  }
  // No assistente, um assunto por vez: os avisos do topo saem da frente.
  document.body.classList.toggle('wizard-mode', page === 'comecar');
  const def = page === 'assinar' ? ['assinar', 'Assinatura', renderPaywall]
    : page === 'comecar' && isOwner() ? ['comecar', 'Primeiros passos', renderWizard]
      : pages.find((p) => p[0] === page) || pages[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === def[0]));
  $('#sidebar')?.classList.remove('open');
  const el = $('#page');
  el.innerHTML = '<div class="empty">Carregando…</div>';
  try { await def[2](el, rest); } catch (err) { el.innerHTML = `<div class="empty">Erro: ${esc(err.message)}</div>`; }
  refreshOnboardingPill();
  every(10000, refreshUnread);
  refreshUnread();
}

async function boot() {
  try {
    state.me = await api('/api/auth/me');
  } catch {
    // O botão "Teste grátis" da página inicial chega em /app#cadastro; o de um plano pago, em /app#/assinar/<plano>.
    return renderAuth(location.hash === '#cadastro' || buyingPlanId() ? 'register' : 'login');
  }
  state.meta = await api('/api/meta');
  renderLayout();
  route();
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function barChart(series, key, { color = 'var(--green-700)', format = (v) => v } = {}) {
  const w = 600; const h = 170; const pad = 20;
  const max = Math.max(1, ...series.map((s) => s[key]));
  const bw = (w - pad) / series.length;
  const bars = series.map((s, i) => {
    const bh = (s[key] / max) * (h - 30);
    return `<rect x="${pad + i * bw + 1}" y="${h - 18 - bh}" width="${Math.max(bw - 3, 1)}" height="${bh}" rx="2" style="fill:${color}"><title>${fmtDay(s.date)}: ${esc(format(s[key]))}</title></rect>`;
  }).join('');
  const labels = series.map((s, i) => (i % Math.ceil(series.length / 6) === 0
    ? `<text x="${pad + i * bw + bw / 2}" y="${h - 4}" font-size="10" text-anchor="middle" fill="#66736b">${fmtDay(s.date).slice(0, 5)}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="${pad}" y1="${h - 18}" x2="${w}" y2="${h - 18}" stroke="#e1e7e3"/>
    <text x="0" y="12" font-size="10" fill="#66736b">${esc(format(max))}</text>${bars}${labels}</svg>`;
}

function onboardingCard(o) {
  return `<div class="card" style="margin-bottom:14px" id="onboarding">
    <div class="card-head"><h2>Primeiros passos</h2><span class="spacer"></span><span class="small muted">${o.done_count} de ${o.total}</span></div>
    <p class="muted" style="margin:6px 0 0">Seu Falaki está <strong>${o.percent}% pronto</strong>. ${o.done_count === 0 ? 'São 5 passos rápidos para ele atender sozinho.' : o.total - o.done_count === 1 ? 'Falta só um passo!' : `Faltam ${o.total - o.done_count} passos.`}</p>
    <div class="onboard-bar" role="progressbar" aria-valuenow="${o.percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${o.percent}%"></span></div>
    ${o.steps.map((x, i) => {
      const cls = x.done ? 'done' : x.id === o.next ? 'next' : 'later';
      return `<div class="onboard-step ${cls}">
        <span class="step-num ${x.done ? 'ok' : ''}">${x.done ? '✓' : i + 1}</span>
        <div style="flex:1">
          <div class="onboard-title"><strong>${esc(x.title)}</strong></div>
          ${x.id === o.next ? `<p class="small muted" style="margin:4px 0 12px">${esc(x.text)}</p><a class="btn primary" href="#/comecar">${o.done_count ? 'Continuar configuração' : 'Começar a configuração'} →</a>` : ''}
        </div></div>`;
    }).join('')}
    <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="sm ghost" id="hide-onboarding">Esconder por enquanto</button></div>
  </div>`;
}

async function renderDashboard(el) {
  const days = Number(sessionStorage.getItem('dash-days') || 30);
  const [d, ob] = await Promise.all([api(`/api/dashboard?days=${days}`), isOwner() ? api('/api/onboarding').catch(() => null) : null]);
  const showOnboarding = ob && !ob.complete && !ob.dismissed;
  const m = d.metrics;
  const fin = !d.financial_hidden;
  const maxStage = Math.max(1, ...Object.values(m.stages));
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard de gestão</h1><p class="muted">Visão geral de vendas, atendimento e financeiro</p></div>
      <span class="spacer"></span>
      <select id="days" style="width:auto">${[7, 30, 90, 365].map((n) => `<option value="${n}" ${n === days ? 'selected' : ''}>Últimos ${n} dias</option>`).join('')}</select>
    </div>
    ${showOnboarding ? onboardingCard(ob) : aiLocked() ? lockCard('O atendimento com IA') : !state.meta.ai_configured ? '<div class="banner">A IA está em <strong>modo demonstração</strong> (respostas automáticas simples). Adicione sua chave da API Anthropic em <a href="#/config/avancado">Configurações → Avançado</a> para ativar o atendimento inteligente.</div>' : ''}
    <div class="grid kpis">
      ${fin ? `<div class="card kpi good"><div class="label">Faturamento</div><div class="value">${money(m.revenue_cents)}</div><div class="sub">recebido no período</div></div>
      <div class="card kpi"><div class="label">A receber</div><div class="value">${money(m.receivable_cents)}</div><div class="sub">cobranças pendentes</div></div>
      <div class="card kpi ${m.overdue_cents ? 'bad' : ''}"><div class="label">Inadimplência</div><div class="value">${money(m.overdue_cents)}</div><div class="sub">${m.overdue_count} cobrança(s) vencida(s)</div></div>` : ''}
      <div class="card kpi"><div class="label">Novos leads</div><div class="value">${m.leads_new}</div><div class="sub">${m.won} vendas ganhas</div></div>
      <div class="card kpi"><div class="label">Conversão</div><div class="value">${m.conversion_rate}%</div><div class="sub">leads → vendas</div></div>
      ${fin ? `<div class="card kpi"><div class="label">Pipeline aberto</div><div class="value">${money(m.pipeline_cents)}</div><div class="sub">valor em negociação</div></div>` : ''}
      <div class="card kpi"><div class="label">Agenda</div><div class="value">${m.appointments_today} hoje</div><div class="sub">${m.appointments_upcoming} nos próximos 7 dias · ${m.no_show_rate}% faltas</div></div>
      <div class="card kpi ${m.tasks_overdue ? 'bad' : ''}"><div class="label">Tarefas da equipe</div><div class="value">${m.tasks_open} abertas</div><div class="sub">${m.tasks_overdue} atrasada(s) · ${m.appointments_pending} horário(s) a confirmar</div></div>
      <div class="card kpi"><div class="label">Atendimento IA</div><div class="value">${m.ai_messages}</div><div class="sub">respostas da IA · ${m.messages_in} recebidas</div></div>
    </div>
    <div class="grid two" style="margin-top:14px">
      ${fin ? `<div class="card"><div class="card-head"><h2>Faturamento por dia</h2></div>${barChart(m.series, 'revenue_cents', { format: money })}</div>` : `<div class="card"><div class="card-head"><h2>Novos leads por dia</h2></div>${barChart(m.series, 'leads', { color: 'var(--green-400)' })}</div>`}
      <div class="card"><div class="card-head"><h2>Funil de vendas</h2><span class="spacer"></span><a href="#/crm" class="small">ver CRM →</a></div>
        ${state.meta.stages.map((s) => `<div class="funnel-row"><span class="lbl">${esc(s.label)}</span><div class="funnel-bar" style="width:${(m.stages[s.id] / maxStage) * 60}%;background:${s.id === 'perdido' ? 'var(--danger-soft)' : s.id === 'ganho' ? 'var(--green-700)' : 'var(--green-400)'}"></div><span class="n">${m.stages[s.id]}</span></div>`).join('')}
      </div>
    </div>
    <div class="grid two" style="margin-top:14px">
      ${fin ? `<div class="card"><div class="card-head"><h2>Novos leads por dia</h2></div>${barChart(m.series, 'leads', { color: 'var(--green-400)' })}</div>` : '<div></div>'}
      <div class="card"><div class="card-head"><h2>Origem dos leads</h2></div>
        ${Object.keys(m.sources).length ? Object.entries(m.sources).sort((a, b) => b[1] - a[1]).map(([s, n]) => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(SOURCE_LABEL[s] || s)}</span><span class="spacer"></span><strong>${n}</strong></div>`).join('') : '<p class="muted">Sem leads no período.</p>'}
        <div class="row small muted" style="margin-top:12px">🔁 ${m.followups_active} follow-ups ativos · 💬 ${m.followup_messages} msgs de follow-up · 💰 ${m.billing_messages} msgs de cobrança</div>
      </div>
    </div>
    <div class="card ${fin ? '' : 'hidden'}" style="margin-top:14px">
      <div class="card-head"><h2>Insights</h2><span class="spacer"></span>${aiLocked() ? lockBtn('Recomendações com IA') : `<button class="sm" id="insights">Gerar recomendações ${state.meta.ai_configured ? 'com IA' : ''}</button>`}</div>
      <div id="insights-box" class="muted small">Clique para receber recomendações baseadas nos seus números.</div>
    </div>
    <div class="grid halves" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>Próximos agendamentos</h2><span class="spacer"></span><a href="#/agenda" class="small">agenda →</a></div>
        ${d.upcoming.length ? `<div class="table-wrap"><table>${d.upcoming.map((a) => `<tr><td>${esc(a.title)}</td><td class="nowrap muted">${fmt(a.start_at)}</td><td><span class="badge ${a.status === 'confirmado' ? 'blue' : 'green'}">${a.status}</span></td></tr>`).join('')}</table></div>` : '<p class="muted">Nenhum agendamento futuro.</p>'}
      </div>
      <div class="card ${fin ? '' : 'hidden'}"><div class="card-head"><h2>Cobranças vencidas</h2><span class="spacer"></span><a href="#/cobranca" class="small">cobrança →</a></div>
        ${d.overdue.length ? `<div class="table-wrap"><table>${d.overdue.map((c) => `<tr><td>${esc(c.contact_name || '-')}<div class="small muted">${esc(c.description)}</div></td><td class="nowrap">${money(c.amount_cents)}</td><td class="small muted nowrap">venceu ${fmtDay(c.due_date)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Nenhuma cobrança vencida.</p>'}
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-head"><h2>Atividade recente</h2></div>
      <ul class="feed">${d.activities.map((a) => `<li><span class="muted small">${ago(a.created_at)}</span> · <strong>${esc(a.contact_name || '')}</strong> ${esc(a.description)}</li>`).join('') || '<li class="muted">Nada ainda.</li>'}</ul>
    </div>`;
  $('#days').onchange = (e) => { sessionStorage.setItem('dash-days', e.target.value); route(); };
  $('#hide-onboarding')?.addEventListener('click', async () => {
    await api('/api/onboarding/dismiss', { method: 'POST' }).catch(fail);
    toast('Primeiros passos escondidos. Você pode voltar a eles pelo menu lateral.');
    state.meta.onboarding = { ...state.meta.onboarding, dismissed: true };
    renderLayout(); route();
  });
  if ($('#insights')) $('#insights').onclick = async (e) => {
    e.target.disabled = true;
    $('#insights-box').innerHTML = 'Analisando seus números…';
    try {
      const r = await api('/api/dashboard/insights', { method: 'POST', body: { days } });
      $('#insights-box').className = 'insights';
      $('#insights-box').textContent = r.text;
    } catch (err) { $('#insights-box').textContent = err.message; }
    e.target.disabled = false;
  };
}

// ---------------------------------------------------------------------------
// Atendimento (inbox WhatsApp)
// ---------------------------------------------------------------------------
async function renderInbox(el, [selected]) {
  const provider = state.meta.whatsapp_provider;
  // Profissional só vê os próprios clientes; dono e atendentes dividem as conversas por responsável.
  const canAssign = state.me.user.role !== 'professional';
  let scope = canAssign ? (sessionGet('inbox-scope') ?? '') : '';
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Atendimento</h1><p class="muted">${aiLocked() ? 'Conversas do WhatsApp, atendidas pela sua equipe' : 'Conversas do WhatsApp com resposta automática da IA'}</p></div>
      <span class="spacer"></span>
      <span class="badge ${provider === 'simulator' ? 'amber' : 'green'}">WhatsApp: ${provider === 'simulator' ? 'simulador' : provider === 'meta' ? 'Cloud API (Meta)' : 'Evolution API'}</span>
      <button id="simulate">Simular cliente</button>
    </div>
    <div class="card inbox ${selected ? 'has-chat' : ''}" id="inbox">
      <div class="conv-list"><div class="conv-search"><input id="conv-q" placeholder="Buscar conversa…">
        ${canAssign ? `<div class="segmented" id="conv-scope" style="margin-top:8px;width:100%">${[['', 'Todas'], ['mine', 'Minhas'], ['unassigned', 'Sem responsável']].map(([v, l]) => `<button type="button" data-scope="${v}" class="${scope === v ? 'active' : ''}" style="flex:1">${l}</button>`).join('')}</div>` : ''}
      </div><div id="convs"></div></div>
      <div class="chat" id="chat"><div class="empty">Selecione uma conversa</div></div>
    </div>`;
  let lastId = 0;
  let current = selected ? Number(selected) : null;

  async function loadConvs() {
    const q = $('#conv-q')?.value || '';
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (scope) params.set('scope', scope);
    const convs = await api(`/api/conversations${params.size ? `?${params}` : ''}`);
    const box = $('#convs');
    if (!box) return;
    box.innerHTML = convs.map((c) => `
      <div class="conv ${c.id === current ? 'active' : ''}" data-id="${c.id}">
        <div class="avatar">${esc(initials(c.name || c.phone))}</div>
        <div class="body">
          <div class="row"><strong>${esc(c.name || phoneFmt(c.phone))}</strong><span class="spacer"></span><span class="small muted">${ago(c.last_at)}</span></div>
          <div class="row"><span class="preview">${c.last_direction === 'out' ? (c.last_author === 'ai' ? '🤖 ' : '✓ ') : ''}${esc(c.last_body)}</span>
            ${c.unread && c.id !== current ? '<span class="badge count">•</span>' : ''}${!c.ai_enabled ? '<span class="badge amber">humano</span>' : ''}</div>
          ${canAssign ? `<div class="small muted">${c.assigned_name ? `👤 ${esc(c.assigned_user_id === state.me.user.id ? 'Você' : c.assigned_name)}` : 'Sem responsável'}</div>` : ''}
        </div>
      </div>`).join('') || `<div class="empty">${scope === 'mine' ? 'Nenhuma conversa com você.' : scope === 'unassigned' ? 'Todas as conversas têm responsável.' : 'Nenhuma conversa ainda.<br>Use "Simular cliente" para testar.'}</div>`;
    $$('.conv', box).forEach((c) => { c.onclick = () => { location.hash = `#/inbox/${c.dataset.id}`; }; });
  }

  function bubble(m) {
    return `<div class="bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}">${esc(m.body)}
      <div class="meta">${m.direction === 'out' ? `${m.author === 'human' && m.user_name ? `👤 ${esc(m.user_name)}` : AUTHOR_LABEL[m.author] || ''} · ` : ''}${fmt(m.created_at, { hour: '2-digit', minute: '2-digit' })}${m.status === 'failed' ? ` · ❌ ${esc(m.error || 'falhou')}` : ''}</div></div>`;
  }

  async function openChat(id) {
    const { contact, messages } = await api(`/api/conversations/${id}/messages`);
    lastId = messages.at(-1)?.id || 0;
    $('#chat').innerHTML = `
      <div class="chat-head">
        <button class="sm ghost" id="back" title="Voltar">←</button>
        <div class="avatar">${esc(initials(contact.name || contact.phone))}</div>
        <div><strong>${esc(contact.name || phoneFmt(contact.phone))}</strong><div class="small muted">${phoneFmt(contact.phone)} · ${stageBadge(contact.stage)}</div></div>
        <span class="spacer"></span>
        ${canAssign ? `<select id="assignee" class="sm" style="width:auto" aria-label="Responsável pela conversa" title="Responsável pela conversa">
          <option value="">Sem responsável</option>
          ${state.meta.team.map((u) => `<option value="${u.id}" ${u.id === contact.assigned_user_id ? 'selected' : ''}>${esc(u.id === state.me.user.id ? `${u.name} (você)` : u.name)}</option>`).join('')}
          ${contact.assigned_user_id && !state.meta.team.some((u) => u.id === contact.assigned_user_id) ? `<option value="${contact.assigned_user_id}" selected>${esc(contact.assigned_name || 'Usuário desativado')}</option>` : ''}
        </select>
        ${contact.assigned_user_id !== state.me.user.id ? '<button class="sm" id="take">Assumir</button>' : ''}` : ''}
        ${aiLocked() ? lockBtn('IA no atendimento') : `<label class="check" title="Quando ligada, a IA responde automaticamente"><input type="checkbox" id="ai-toggle" ${contact.ai_enabled ? 'checked' : ''}> IA respondendo</label>
        <button class="sm" id="ai-now">🤖 Responder com IA</button>`}
        <button class="sm" id="open-contact">Ficha</button>
      </div>
      <div class="chat-body" id="msgs">${messages.map(bubble).join('')}</div>
      <form class="chat-input" id="send-form">
        <textarea name="body" placeholder="Digite uma mensagem (ao enviar, a IA pausa nesta conversa)…" required></textarea>
        <button class="primary">Enviar</button>
      </form>`;
    const msgs = $('#msgs');
    msgs.scrollTop = msgs.scrollHeight;
    $('#back').onclick = () => { location.hash = '#/inbox'; };
    $('#open-contact').onclick = () => openContact(contact.id);
    const assign = async (userId) => {
      try {
        const c = await api(`/api/conversations/${id}/assign`, { method: 'POST', body: { user_id: userId || null } });
        toast(!c.assigned_user_id ? 'Conversa sem responsável' : c.assigned_user_id === state.me.user.id ? 'A conversa é sua' : `Conversa passada para ${c.assigned_name}`);
        await openChat(id);
        await loadConvs();
      } catch (err) { fail(err); }
    };
    $('#assignee')?.addEventListener('change', (e) => assign(e.target.value));
    $('#take')?.addEventListener('click', () => {
      // Avisa antes de tirar a conversa de outro atendente.
      if (contact.assigned_user_id && !window.confirm(`Esta conversa está com ${contact.assigned_name}. Assumir mesmo assim?`)) return;
      assign(state.me.user.id);
    });
    if ($('#ai-toggle')) $('#ai-toggle').onchange = async (e) => {
      await api(`/api/conversations/${id}/ai`, { method: 'POST', body: { enabled: e.target.checked } }).catch(fail);
      toast(e.target.checked ? 'IA ativada nesta conversa' : 'Você assumiu a conversa');
    };
    if ($('#ai-now')) $('#ai-now').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const r = await api(`/api/conversations/${id}/ai-reply`, { method: 'POST' });
        if (r.skipped) toast('A IA não tem nada novo para responder (ou está desligada nesta conversa)');
        await poll();
      } catch (err) { fail(err); }
      e.target.disabled = false;
    };
    const ta = $('#send-form textarea');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#send-form').requestSubmit(); } });
    $('#send-form').onsubmit = async (e) => {
      e.preventDefault();
      const body = ta.value.trim();
      if (!body) return;
      ta.value = '';
      try {
        await api(`/api/conversations/${id}/messages`, { method: 'POST', body: { body } });
        if ($('#ai-toggle')) $('#ai-toggle').checked = false;
        // Quem responde uma conversa sem responsável fica com ela.
        if (canAssign && !contact.assigned_user_id) { await openChat(id); await loadConvs(); return; }
        await poll();
      } catch (err) { fail(err); }
    };
  }

  async function poll() {
    if (!current || !$('#msgs')) return;
    const { messages } = await api(`/api/conversations/${current}/messages?after=${lastId}`);
    if (!messages.length) return;
    lastId = messages.at(-1).id;
    const msgs = $('#msgs');
    msgs.insertAdjacentHTML('beforeend', messages.map(bubble).join(''));
    msgs.scrollTop = msgs.scrollHeight;
  }

  $('#conv-q').oninput = () => loadConvs().catch(() => {});
  if (/[?&]simular=1/.test(location.hash)) { history.replaceState(null, '', '#/inbox'); openSimulator(); }
  $$('#conv-scope button').forEach((b) => {
    b.onclick = () => {
      scope = b.dataset.scope;
      sessionSet('inbox-scope', scope);
      $$('#conv-scope button').forEach((x) => x.classList.toggle('active', x === b));
      loadConvs().catch(() => {});
    };
  });
  $('#simulate').onclick = () => openSimulator();
  await loadConvs();
  if (current) await openChat(current);
  every(3000, async () => { await poll().catch(() => {}); await loadConvs().catch(() => {}); });
}

function openSimulator() {
  const box = openModal(`${modalHead('Simular cliente no WhatsApp')}
    <p class="muted small">Envie mensagens como se fosse um cliente. Elas entram no CRM e a IA responde, exatamente como num número real.</p>
    <form id="sim-form">
      <div class="fields">
        <div class="field"><label>Telefone do cliente</label><input name="phone" value="${sessionStorage.getItem('sim-phone') || '11 98888-7777'}" required></div>
        <div class="field"><label>Nome no WhatsApp</label><input name="name" value="${esc(sessionStorage.getItem('sim-name') || 'Cliente Teste')}"></div>
      </div>
      <div class="field"><label>Mensagem</label><textarea name="text" required placeholder="Ex.: Oi! Quanto custa e tem horário amanhã?"></textarea></div>
      <div class="modal-foot"><button type="button" data-close>Fechar</button><button class="primary">Enviar como cliente</button></div>
    </form>`);
  $('#sim-form', box).onsubmit = async (e) => {
    e.preventDefault();
    const data = formData(e.target);
    sessionStorage.setItem('sim-phone', data.phone);
    sessionStorage.setItem('sim-name', data.name);
    try {
      const r = await api('/api/simulator/inbound', { method: 'POST', body: data });
      e.target.text.value = '';
      toast(aiLocked() ? 'Mensagem recebida! Responda pela conversa.' : 'Mensagem recebida! A IA vai responder em instantes.');
      if (r.contact) { box.close(); location.hash = `#/inbox/${r.contact.id}`; }
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------
async function renderCrm(el) {
  const view = sessionStorage.getItem('crm-view') || 'kanban';
  el.innerHTML = `
    <div class="page-head">
      <div><h1>CRM / Funil de vendas</h1><p class="muted">Arraste os cards entre as etapas</p></div>
      <span class="spacer"></span>
      <input id="crm-q" placeholder="Buscar nome, telefone, tag…" style="width:220px">
      <select id="crm-view" style="width:auto"><option value="kanban">Kanban</option><option value="list" ${view === 'list' ? 'selected' : ''}>Lista</option></select>
      ${state.me.user.role !== 'professional' ? '<button id="import-contacts">Importar</button>' : ''}
      <button id="export-contacts">Exportar</button>
      <button class="primary" id="new-contact">+ Novo lead</button>
    </div>
    <div id="crm-body"></div>`;
  const load = async () => {
    const q = $('#crm-q').value;
    const contacts = await api(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const body = $('#crm-body');
    if ($('#crm-view').value === 'list') {
      body.innerHTML = `<div class="card table-wrap"><table>
        <tr><th>Nome</th><th>Telefone</th><th>Etapa</th><th>Origem</th><th>Interesse</th><th class="right">Valor</th><th>Atualizado</th></tr>
        ${contacts.map((c) => `<tr class="clickable" data-id="${c.id}"><td><strong>${esc(c.name || '-')}</strong>${c.business_name && c.business_name !== c.name ? `<div class="small muted">${esc(c.business_name)}</div>` : ''}</td>
          <td class="nowrap">${phoneFmt(c.phone)}</td><td>${stageBadge(c.stage)}</td><td>${esc(SOURCE_LABEL[c.source] || c.source)}</td>
          <td class="small">${esc(c.interest)}</td><td class="right nowrap">${c.value_cents ? money(c.value_cents) : '-'}</td><td class="small muted">${ago(c.updated_at)}</td></tr>`).join('')}
      </table>${contacts.length ? '' : '<div class="empty">Nenhum contato encontrado.</div>'}</div>`;
      $$('tr[data-id]', body).forEach((tr) => { tr.onclick = () => openContact(tr.dataset.id, load); });
      return;
    }
    body.innerHTML = `<div class="kanban">${state.meta.stages.map((s) => {
      const items = contacts.filter((c) => c.stage === s.id);
      const total = items.reduce((n, c) => n + c.value_cents, 0);
      return `<div class="column" data-stage="${s.id}">
        <div class="column-head">${stageBadge(s.id)} <span class="muted small">${items.length}</span><span class="total">${total ? money(total) : ''}</span></div>
        ${items.map((c) => `<div class="deal" draggable="true" data-id="${c.id}">
          <div class="name">${esc(c.name || phoneFmt(c.phone))}</div>
          <div class="meta">${c.value_cents ? `<strong>${money(c.value_cents)}</strong>` : ''}<span>${esc(SOURCE_LABEL[c.source] || c.source)}</span>${c.interest ? `<span>· ${esc(c.interest)}</span>` : ''}</div>
          <div class="meta">${c.unread ? '<span class="badge count">nova msg</span>' : ''}${!c.ai_enabled ? '<span class="badge amber">humano</span>' : ''}<span>${ago(c.updated_at)}</span></div>
        </div>`).join('')}
      </div>`;
    }).join('')}</div>`;
    $$('.deal', body).forEach((d) => {
      d.onclick = () => openContact(d.dataset.id, load);
      d.ondragstart = (e) => e.dataTransfer.setData('text/plain', d.dataset.id);
    });
    $$('.column', body).forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('drag-over'); };
      col.ondragleave = () => col.classList.remove('drag-over');
      col.ondrop = async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        try { await api(`/api/contacts/${id}/stage`, { method: 'POST', body: { stage: col.dataset.stage } }); await load(); } catch (err) { fail(err); }
      };
    });
  };
  let t;
  $('#crm-q').oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $('#crm-view').onchange = (e) => { sessionStorage.setItem('crm-view', e.target.value); load(); };
  $('#new-contact').onclick = () => contactForm(null, load);
  $('#import-contacts')?.addEventListener('click', () => importWizard(load));
  $('#export-contacts').onclick = exportContacts;
  await load();
}

function contactForm(contact, onSaved, { asClient = false } = {}) {
  const c = contact || (asClient ? { stage: 'ganho' } : {});
  const box = openModal(`${modalHead(contact ? 'Editar contato' : asClient ? 'Novo cliente' : 'Novo lead')}
    ${asClient ? '<p class="small muted" style="margin-top:-6px">Entra direto como cliente (etapa "Ganho"). Depois você pode cadastrar contratos e anexar documentos na ficha.</p>' : ''}
    <form id="contact-form">
      ${(() => {
        const origin = `<div class="field"><label>Origem</label><select name="source">${Object.entries(SOURCE_LABEL).map(([k, v]) => `<option value="${k}" ${k === (c.source || 'manual') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
        const extra = `<div class="field"><label>Interesse</label><input name="interest" value="${esc(c.interest)}"></div>
          <div class="field"><label>Tags (separadas por vírgula)</label><input name="tags" value="${esc(c.tags)}"></div>
          <div class="field"><label>Observações</label><textarea name="notes">${esc(c.notes)}</textarea></div>`;
        const basic = `<div class="field"><label>Nome</label><input name="name" value="${esc(c.name)}" ${asClient ? 'required' : ''}></div>
          <div class="field"><label>WhatsApp / telefone</label><input name="phone" value="${esc(c.phone ? phoneFmt(c.phone) : '')}" placeholder="(11) 99999-9999"></div>
          <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(c.email)}"></div>
          <div class="field"><label>CPF / CNPJ</label><input name="document" value="${esc(c.document)}"></div>
          <div class="field"><label>Empresa do cliente</label><input name="business_name" value="${esc(c.business_name)}"></div>`;
        // Cliente novo: só o essencial à vista; o resto fica em "Mais informações".
        if (asClient) {
          return `<input type="hidden" name="stage" value="ganho"><div class="fields">${basic}</div>
            <details style="margin:4px 0 12px"><summary class="small" style="cursor:pointer">Mais informações (origem, interesse, tags, observações)</summary>
              <div style="margin-top:10px"><div class="fields">${origin}</div>${extra}</div></details>`;
        }
        return `<div class="fields">${basic}
          <div class="field"><label>Valor estimado (R$)</label><input name="value" value="${c.value_cents ? reais(c.value_cents) : ''}" inputmode="decimal"></div>
          <div class="field"><label>Etapa</label><select name="stage">${state.meta.stages.map((s) => `<option value="${s.id}" ${s.id === (c.stage || 'novo') ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
          ${origin}</div>${extra}`;
      })()}
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
    </form>`);
  $('#contact-form', box).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = formData(e.target);
      const saved = contact
        ? await api(`/api/contacts/${contact.id}`, { method: 'PUT', body: data })
        : await api('/api/contacts', { method: 'POST', body: data });
      box.close();
      toast('Contato salvo');
      onSaved?.(saved);
    } catch (err) { fail(err); }
  };
}

async function openContact(id, onChange) {
  const [c, cfg] = await Promise.all([api(`/api/contacts/${id}`), api('/api/settings')]);
  const triagem = JSON.parse(c.custom_fields || '{}');
  const intakeLabel = (k) => cfg.settings.ai.intake_questions.find((q) => q.key === k)?.label || k;
  const box = openModal(`
    <div class="modal-head">
      <div class="avatar">${esc(initials(c.name || c.phone))}</div>
      <div><h2>${esc(c.name || phoneFmt(c.phone))}</h2><div class="small muted">${phoneFmt(c.phone)} ${c.email ? `· ${esc(c.email)}` : ''}</div></div>
      <span class="spacer"></span><button class="ghost" data-close aria-label="Fechar">✕</button>
    </div>
    <div class="row wrap" style="margin-bottom:14px">
      <select id="c-stage" style="width:auto">${state.meta.stages.map((s) => `<option value="${s.id}" ${s.id === c.stage ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
      <button class="sm" id="c-chat">💬 Conversa</button>
      <button class="sm" id="c-appt">📅 Agendar</button>
      <button class="sm" id="c-charge">💰 Cobrar</button>
      <button class="sm" id="c-seq">🔁 Follow-up</button>
      <button class="sm" id="c-edit">✏️ Editar</button>
      <button class="sm danger" id="c-del">Excluir</button>
    </div>
    <div class="grid halves">
      <div class="card"><h3>Dados</h3>
        <table class="small">
          <tr><td class="muted">Valor</td><td>${c.value_cents ? money(c.value_cents) : '-'}</td></tr>
          <tr><td class="muted">Origem</td><td>${esc(SOURCE_LABEL[c.source] || c.source)}</td></tr>
          <tr><td class="muted">Interesse</td><td>${esc(c.interest || '-')}</td></tr>
          <tr><td class="muted">Documento</td><td>${esc(c.document || '-')}</td></tr>
          ${c.business_name ? `<tr><td class="muted">Empresa</td><td>${esc(c.business_name)}</td></tr>` : ''}
          ${c.address ? `<tr><td class="muted">Endereço</td><td>${esc(c.address)}</td></tr>` : ''}
          ${c.website ? `<tr><td class="muted">Site</td><td><a href="${esc(c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a></td></tr>` : ''}
          ${c.rating ? `<tr><td class="muted">Google</td><td>⭐ ${c.rating}</td></tr>` : ''}
          <tr><td class="muted">Tags</td><td>${esc(c.tags || '-')}</td></tr>
          <tr><td class="muted">IA</td><td>${c.ai_enabled ? 'respondendo' : 'pausada (humano)'}</td></tr>
          <tr><td class="muted">Responsável</td><td>${c.assigned_user_id ? esc(state.meta.team.find((u) => u.id === c.assigned_user_id)?.name || 'usuário desativado') : 'ninguém'}</td></tr>
        </table>
        ${c.notes ? `<p class="small" style="white-space:pre-wrap">${esc(c.notes)}</p>` : ''}
        ${Object.keys(triagem).length ? `<h3 style="margin-top:12px">Triagem</h3><table class="small">${Object.entries(triagem).map(([k, v]) => `<tr><td class="muted">${esc(intakeLabel(k))}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      </div>
      <div class="card"><h3>Agendamentos</h3>
        ${c.appointments.map((a) => `<div class="small" style="padding:4px 0">${fmt(a.start_at)} — ${esc(a.title)}${a.professional_name ? ` · ${esc(a.professional_name)}` : ''} <span class="badge">${a.status}</span></div>`).join('') || '<p class="small muted">Nenhum.</p>'}
        <h3 style="margin-top:12px">Cobranças</h3>
        ${c.charges.map((ch) => `<div class="small" style="padding:4px 0">${esc(ch.description)} — ${money(ch.amount_cents)} <span class="badge ${CHARGE_BADGE[ch.status]}">${ch.status}</span></div>`).join('') || '<p class="small muted">Nenhuma.</p>'}
        ${canContracts() ? `<div class="card-head" style="margin-top:12px"><h3>Contratos</h3><span class="spacer"></span><button class="sm" id="c-contract">+ Contrato</button></div>
        ${c.contracts.map((k) => `<div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)"><strong>${esc(k.title)}</strong>${k.value_cents ? ` — ${money(k.value_cents)} ${esc(periodLabel(k.period).toLowerCase())}` : ''} ${situationBadge(k)}
          <div class="muted">${fmtDay(k.start_date)} a ${k.end_date ? fmtDay(k.end_date) : 'indeterminado'}</div><div style="margin-top:4px">${contractActions(k)}</div></div>`).join('') || '<p class="small muted">Nenhum.</p>'}` : ''}
        <div class="card-head" style="margin-top:12px"><h3>Documentos</h3><span class="spacer"></span><button class="sm" id="c-doc">Anexar</button></div>
        ${c.documents.map((d) => `<div class="small row" style="padding:4px 0"><span>📄 ${esc(d.name)}${d.category ? ` <span class="badge outline">${esc(d.category)}</span>` : ''}</span><span class="spacer"></span><button class="sm" data-open="${d.id}">${PREVIEWABLE[d.mime] ? 'Abrir' : 'Baixar'}</button></div>`).join('') || '<p class="small muted">Nenhum.</p>'}
        <h3 style="margin-top:12px">Tarefas</h3>
        ${c.tasks.map((t) => `<div class="small" style="padding:4px 0">${esc(t.title)} <span class="badge ${t.status === 'aberta' ? (Date.parse(t.due_at) < Date.now() ? 'red' : 'amber') : ''}">${t.status}</span></div>`).join('') || '<p class="small muted">Nenhuma.</p>'}
        <h3 style="margin-top:12px">Follow-ups</h3>
        ${c.enrollments.map((e) => `<div class="small" style="padding:4px 0">${esc(e.sequence_name)} — passo ${Math.min(e.step_index + 1, e.steps_total)}/${e.steps_total} <span class="badge ${e.status === 'ativo' ? 'green' : ''}">${e.status}</span></div>`).join('') || '<p class="small muted">Nenhum.</p>'}
      </div>
    </div>
    <div class="card" style="margin-top:14px"><h3>Histórico</h3>
      <form id="note-form" class="row" style="margin:10px 0"><input name="text" placeholder="Adicionar nota…" required><button class="sm">Salvar</button></form>
      <ul class="feed">${c.activities.map((a) => `<li><span class="small muted">${fmt(a.created_at)}</span> — ${esc(a.description)}</li>`).join('')}</ul>
    </div>`, { drawer: true });
  const refresh = () => { box.close(); onChange?.(); openContact(id, onChange); };
  $('#c-stage', box).onchange = async (e) => {
    try { await api(`/api/contacts/${id}/stage`, { method: 'POST', body: { stage: e.target.value } }); toast('Etapa atualizada'); refresh(); } catch (err) { fail(err); }
  };
  $('#c-chat', box).onclick = () => { closeAllModals(); location.hash = `#/inbox/${id}`; };
  $('#c-edit', box).onclick = () => contactForm(c, refresh);
  $('#c-appt', box).onclick = () => appointmentForm({ contact_id: c.id }, refresh);
  $('#c-charge', box).onclick = () => chargeForm({ contact_id: c.id }, refresh);
  $('#c-seq', box).onclick = () => enrollForm([c.id], refresh);
  $('#c-contract', box)?.addEventListener('click', () => contractForm({ contact_id: c.id }, refresh));
  $('#c-doc', box).onclick = () => uploadForm({ contact_id: c.id }, refresh);
  bindContractActions(box, c.contracts, refresh);
  bindDocuments(box, c.documents, refresh);
  $('#c-del', box).onclick = async () => {
    if (!confirm(`Excluir ${c.name || 'este contato'} e todo o histórico?`)) return;
    await api(`/api/contacts/${id}`, { method: 'DELETE' }).catch(fail);
    box.close(); onChange?.();
  };
  $('#note-form', box).onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/contacts/${id}/notes`, { method: 'POST', body: formData(e.target) }); refresh(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Clientes, contratos e documentos
// ---------------------------------------------------------------------------
const SITUATION = {
  vigente: ['green', 'vigente'], vencendo: ['amber', 'vencendo'], vencido: ['red', 'vencido'], sem_vencimento: ['outline', 'sem vencimento'],
  renovado: ['blue', 'renovado'], encerrado: ['', 'encerrado'], cancelado: ['', 'cancelado'],
};
const situationBadge = (k) => {
  const [color, label] = SITUATION[k.situation] || ['', k.situation];
  const extra = k.situation === 'vencendo' ? ` · ${k.days_left === 0 ? 'hoje' : `${k.days_left}d`}` : k.situation === 'vencido' ? ` · há ${-k.days_left}d` : '';
  return `<span class="badge ${color}">${label}${extra}</span>`;
};
const periodLabel = (id) => state.meta.contract_periods.find((p) => p.id === id)?.label || id;
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const canContracts = () => state.me.user.role !== 'professional';

/** Próximo vencimento do cliente, com cor pela proximidade. */
function nextEndBadge(date) {
  if (!date) return '<span class="muted">-</span>';
  const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${todayStr()}T12:00:00Z`)) / 86400000);
  const color = days < 0 ? 'red' : days <= 30 ? 'amber' : '';
  return `<span class="badge ${color}">${fmtDay(date)}</span>`;
}

async function renderClients(el, [tab = 'lista']) {
  const tabs = [['lista', 'Clientes'], ...(canContracts() ? [['contratos', 'Contratos']] : []), ['documentos', 'Documentos']];
  if (!tabs.some((t) => t[0] === tab)) tab = 'lista';
  const summary = canContracts() ? await api('/api/clients/summary') : null;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Clientes</h1><p class="muted">Quem já fechou com você. Quem ainda está negociando fica no <a href="#/crm">CRM / Funil</a>.</p></div>
      <span class="spacer"></span>
      <button id="new-doc">Anexar documento</button>
      ${canContracts() ? '<button id="new-contract">+ Contrato</button>' : ''}
      <button class="primary" id="new-client">+ Novo cliente</button>
    </div>
    ${summary ? `<div class="grid kpis" style="margin-bottom:14px">
      <div class="card kpi"><div class="label">Clientes</div><div class="value">${summary.clients}</div></div>
      <div class="card kpi"><div class="label">Contratos ativos</div><div class="value">${summary.active}</div></div>
      <div class="card kpi"><div class="label">Vencendo</div><div class="value">${summary.expiring}</div><div class="sub">dentro do prazo de aviso</div></div>
      <div class="card kpi ${summary.expired ? 'bad' : ''}"><div class="label">Vencidos</div><div class="value">${summary.expired}</div></div>
      ${summary.monthly_recurring_cents !== null ? `<div class="card kpi good"><div class="label">Recorrente / mês</div><div class="value">${money(summary.monthly_recurring_cents)}</div></div>` : ''}
    </div>` : ''}
    <div class="card">
      <div class="tabs">${tabs.map(([id, label]) => `<a href="#/clientes/${id}" class="${id === tab ? 'active' : ''}">${label}</a>`).join('')}</div>
      <div id="clients-body"></div>
    </div>`;
  $('#new-contract')?.addEventListener('click', () => contractForm({}, route));
  $('#new-client').onclick = () => contactForm(null, (saved) => { route(); if (saved?.id) openContact(saved.id, route); }, { asClient: true });
  $('#new-doc').onclick = () => uploadForm({}, route);
  const body = $('#clients-body');
  if (tab === 'contratos') return renderContractsTab(body);
  if (tab === 'documentos') return renderDocumentsTab(body);
  return renderClientsTab(body);
}

async function renderClientsTab(body) {
  body.innerHTML = `<div class="row" style="margin-bottom:12px"><input id="cl-q" placeholder="Buscar por nome, telefone, e-mail, CPF/CNPJ…" style="max-width:360px"></div><div id="cl-list"></div>`;
  const draw = async () => {
    const q = $('#cl-q')?.value || '';
    const list = await api(`/api/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const box = $('#cl-list');
    if (!box) return;
    box.innerHTML = list.length ? `<div class="table-wrap"><table>
      <tr><th>Cliente</th><th>Contato</th>${canContracts() ? '<th>Contratos ativos</th><th>Próximo vencimento</th>' : ''}<th>Documentos</th><th>Responsável</th><th>Cliente desde</th></tr>
      ${list.map((c) => `<tr class="clickable" data-id="${c.id}">
        <td><strong>${esc(c.name || phoneFmt(c.phone))}</strong>${c.business_name || c.document ? `<div class="small muted">${esc([c.business_name, c.document].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td class="nowrap small">${phoneFmt(c.phone)}${c.email ? `<div class="muted">${esc(c.email)}</div>` : ''}</td>
        ${canContracts() ? `<td>${c.active_contracts || '<span class="muted">0</span>'}</td><td>${nextEndBadge(c.next_end_date)}</td>` : ''}
        <td>${c.documents || '<span class="muted">0</span>'}</td>
        <td class="small">${esc(c.assigned_name || '-')}</td>
        <td class="small nowrap">${c.won_at ? fmt(c.won_at, { dateStyle: 'short' }) : '-'}</td></tr>`).join('')}
    </table></div>` : q ? '<div class="empty">Nenhum cliente encontrado.</div>'
      : '<div class="empty">Nenhum cliente ainda.<br><button class="primary" id="empty-new-client" style="margin-top:12px">+ Cadastrar o primeiro cliente</button><div class="small muted" style="margin-top:8px">Quem você marcar como "Ganho" no CRM também aparece aqui.</div></div>';
    $('#empty-new-client', box)?.addEventListener('click', () => $('#new-client')?.click());
    $$('tr[data-id]', box).forEach((tr) => { tr.onclick = () => openContact(Number(tr.dataset.id), draw); });
  };
  $('#cl-q').oninput = () => draw().catch(() => {});
  await draw();
}

async function renderContractsTab(body) {
  const filter = sessionGet('contract-filter') || 'ativos';
  const list = await api(`/api/contracts?filter=${filter}`);
  const owner = isOwner();
  body.innerHTML = `
    <div class="segmented" style="margin-bottom:12px">${[['ativos', 'Ativos'], ['vencendo', 'Vencendo'], ['vencido', 'Vencidos'], ['encerrados', 'Encerrados'], ['todos', 'Todos']].map(([k, v]) => `<button type="button" data-f="${k}" class="${k === filter ? 'active' : ''}">${v}</button>`).join('')}</div>
    ${list.length ? `<div class="table-wrap"><table>
      <tr><th>Cliente</th><th>Contrato</th>${owner ? '<th class="right">Valor</th>' : ''}<th>Início</th><th>Vencimento</th><th>Situação</th><th></th></tr>
      ${list.map((k) => `<tr>
        <td><a href="#" data-contact="${k.contact_id}">${esc(k.contact_name || phoneFmt(k.contact_phone))}</a></td>
        <td><strong>${esc(k.title)}</strong><div class="small muted">${esc(periodLabel(k.period))}${k.auto_renew ? ' · renova sozinho' : ''}</div></td>
        ${owner ? `<td class="right nowrap">${k.value_cents ? money(k.value_cents) : '-'}</td>` : ''}
        <td class="nowrap">${fmtDay(k.start_date)}</td>
        <td class="nowrap">${k.end_date ? fmtDay(k.end_date) : '<span class="muted">indeterminado</span>'}<div class="small muted">aviso ${k.notice_days}d antes</div></td>
        <td>${situationBadge(k)}</td>
        <td class="nowrap">${contractActions(k)}</td></tr>`).join('')}
    </table></div>` : `<div class="empty">${filter === 'vencendo' ? 'Nenhum contrato vencendo. 🎉' : filter === 'vencido' ? 'Nenhum contrato vencido.' : 'Nenhum contrato aqui.'}</div>`}`;
  $$('[data-f]', body).forEach((b) => { b.onclick = () => { sessionSet('contract-filter', b.dataset.f); route(); }; });
  $$('[data-contact]', body).forEach((a) => { a.onclick = (e) => { e.preventDefault(); openContact(Number(a.dataset.contact), route); }; });
  bindContractActions(body, list, route);
}

function contractActions(k) {
  const active = k.status === 'ativo';
  return `${active && k.end_date ? `<button class="sm primary" data-renew="${k.id}">Renovar</button>` : ''}
    <button class="sm" data-kdocs="${k.id}">Docs</button>
    ${active ? `<button class="sm" data-kedit="${k.id}">Editar</button><button class="sm ghost" data-kclose="${k.id}">Encerrar</button>` : ''}
    ${isOwner() ? `<button class="sm ghost danger" data-kdel="${k.id}" aria-label="Excluir contrato">✕</button>` : ''}`;
}

function bindContractActions(root, list, onChange) {
  const find = (id) => list.find((k) => String(k.id) === String(id));
  $$('[data-renew]', root).forEach((b) => { b.onclick = () => renewForm(find(b.dataset.renew), onChange); });
  $$('[data-kedit]', root).forEach((b) => { b.onclick = () => contractForm(find(b.dataset.kedit), onChange); });
  $$('[data-kdocs]', root).forEach((b) => { b.onclick = () => contractDocs(find(b.dataset.kdocs), onChange); });
  $$('[data-kclose]', root).forEach((b) => { b.onclick = () => closeContractForm(find(b.dataset.kclose), onChange); });
  $$('[data-kdel]', root).forEach((b) => { b.onclick = async () => {
    const k = find(b.dataset.kdel);
    if (!confirm(`Excluir o contrato "${k.title}"? Para manter o histórico, prefira "Encerrar".`)) return;
    try { await api(`/api/contracts/${k.id}`, { method: 'DELETE' }); toast('Contrato excluído'); onChange?.(); } catch (err) { fail(err); }
  }; });
}

async function contractForm(k, onSaved) {
  const editing = Boolean(k.id);
  const contactsHtml = editing ? '' : await contactOptions(k.contact_id);
  const box = openModal(`${modalHead(editing ? 'Editar contrato' : 'Novo contrato')}
    <form id="contract-form">
      ${editing ? `<p class="muted">Cliente: <strong>${esc(k.contact_name)}</strong></p>` : `<div class="field"><label for="k-contact">Cliente</label><select id="k-contact" name="contact_id" required>${contactsHtml}</select><div class="hint">Ao cadastrar o contrato, o contato passa para "Ganho" e aparece em Clientes.</div></div>`}
      <div class="field"><label for="k-title">Contrato</label><input id="k-title" name="title" required value="${esc(k.title || '')}" placeholder="Ex.: Plano de manutenção, Honorários mensais, Locação"></div>
      <div class="fields">
        ${isOwner() ? `<div class="field"><label for="k-value">Valor (R$)</label><input id="k-value" name="value" inputmode="decimal" placeholder="0,00" value="${k.value_cents ? reais(k.value_cents) : ''}"></div>` : ''}
        <div class="field"><label for="k-period">Periodicidade do valor</label><select id="k-period" name="period">${state.meta.contract_periods.map((p) => `<option value="${p.id}" ${p.id === (k.period || 'mensal') ? 'selected' : ''}>${p.label}</option>`).join('')}</select></div>
        <div class="field"><label for="k-start">Início</label><input id="k-start" type="date" name="start_date" required value="${k.start_date || todayStr()}"></div>
        <div class="field"><label for="k-end">Vencimento</label><input id="k-end" type="date" name="end_date" value="${k.end_date || (editing ? '' : addDays(todayStr(), 364))}"><div class="hint">Vazio = prazo indeterminado.</div></div>
        <div class="field"><label for="k-notice">Avisar a equipe quantos dias antes</label><input id="k-notice" type="number" min="0" max="365" name="notice_days" value="${k.notice_days ?? 30}"></div>
      </div>
      <label class="check field"><input type="checkbox" name="auto_renew" ${k.auto_renew ? 'checked' : ''}> Renovar automaticamente no vencimento (pelo mesmo prazo)</label>
      <div class="field"><label for="k-notes">Observações</label><textarea id="k-notes" name="notes" placeholder="Cláusulas importantes, reajuste, multa…">${esc(k.notes || '')}</textarea></div>
      ${editing ? '' : '<div class="field"><label for="k-file">Anexar o contrato assinado (opcional)</label><input id="k-file" type="file" name="file"></div>'}
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">${editing ? 'Salvar' : 'Cadastrar contrato'}</button></div>
    </form>`, { wide: true });
  const form = $('#contract-form', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = formData(form);
    delete data.file;
    try {
      const saved = await api(editing ? `/api/contracts/${k.id}` : '/api/contracts', { method: editing ? 'PUT' : 'POST', body: data });
      const file = form.file?.files[0];
      if (file) await uploadFile(file, { contact_id: saved.contact_id, contract_id: saved.id, category: 'Contrato' });
      box.close();
      toast(editing ? 'Contrato atualizado' : 'Contrato cadastrado');
      onSaved?.();
    } catch (err) { fail(err); }
  };
}

function renewForm(k, onSaved) {
  const box = openModal(`${modalHead('Renovar contrato')}
    <form id="renew-form">
      <p><strong>${esc(k.title)}</strong> — ${esc(k.contact_name)}<br><span class="muted small">Período atual: ${fmtDay(k.start_date)} a ${fmtDay(k.end_date)}</span></p>
      <div class="fields">
        <div class="field"><label for="r-end">Novo vencimento</label><input id="r-end" type="date" name="end_date"><div class="hint">Vazio = mesmo prazo do período atual, começando em ${fmtDay(addDays(k.end_date, 1))}.</div></div>
        ${isOwner() ? `<div class="field"><label for="r-value">Novo valor (R$)</label><input id="r-value" name="value" inputmode="decimal" placeholder="${k.value_cents ? reais(k.value_cents) : '0,00'}"><div class="hint">Vazio = mantém o valor (use para reajuste).</div></div>` : ''}
      </div>
      <p class="hint">O contrato atual fica no histórico como "renovado" e a tarefa de renovação é concluída.</p>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Renovar</button></div>
    </form>`);
  $('#renew-form', box).onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/contracts/${k.id}/renew`, { method: 'POST', body: formData(e.target) }); box.close(); toast('Contrato renovado'); onSaved?.(); } catch (err) { fail(err); }
  };
}

function closeContractForm(k, onSaved) {
  const box = openModal(`${modalHead('Encerrar contrato')}
    <p><strong>${esc(k.title)}</strong> — ${esc(k.contact_name)}</p>
    <div class="field"><label for="x-status">Motivo</label><select id="x-status"><option value="encerrado">Encerrado (chegou ao fim, sem renovar)</option><option value="cancelado">Cancelado (rescisão antes do fim)</option></select></div>
    <p class="hint">O contrato fica no histórico do cliente e para de gerar avisos.</p>
    <div class="modal-foot"><button type="button" data-close>Voltar</button><button class="danger" id="x-ok">Encerrar contrato</button></div>`);
  $('#x-ok', box).onclick = async () => {
    try { await api(`/api/contracts/${k.id}/close`, { method: 'POST', body: { status: $('#x-status', box).value } }); box.close(); toast('Contrato encerrado'); onSaved?.(); } catch (err) { fail(err); }
  };
}

async function contractDocs(k, onChange) {
  const docs = await api(`/api/documents?contract_id=${k.id}`);
  const box = openModal(`${modalHead(`Documentos — ${k.title}`)}
    ${documentsTable(docs, { showClient: false })}
    <div class="modal-foot"><button type="button" data-close>Fechar</button><button class="primary" id="kd-add">Anexar documento</button></div>`, { wide: true });
  bindDocuments(box, docs, () => { box.close(); contractDocs(k, onChange); });
  $('#kd-add', box).onclick = () => uploadForm({ contact_id: k.contact_id, contract_id: k.id, category: 'Contrato' }, () => { box.close(); contractDocs(k, onChange); });
}

async function renderDocumentsTab(body) {
  const scope = canContracts() ? sessionGet('doc-scope') || '' : '';
  body.innerHTML = `
    <div class="row wrap" style="margin-bottom:12px">
      ${canContracts() ? `<div class="segmented">${[['', 'Todos'], ['company', 'Gerais da empresa']].map(([k, v]) => `<button type="button" data-scope="${k}" class="${k === scope ? 'active' : ''}">${v}</button>`).join('')}</div>` : ''}
      <input id="doc-q" placeholder="Buscar por nome, categoria ou cliente…" style="max-width:320px">
    </div>
    <div id="doc-list"></div>`;
  const draw = async () => {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    const q = $('#doc-q')?.value;
    if (q) params.set('q', q);
    const docs = await api(`/api/documents${params.size ? `?${params}` : ''}`);
    const box = $('#doc-list');
    if (!box) return;
    box.innerHTML = documentsTable(docs, { showClient: true });
    bindDocuments(box, docs, draw);
  };
  $$('[data-scope]', body).forEach((b) => { b.onclick = () => { sessionSet('doc-scope', b.dataset.scope); route(); }; });
  $('#doc-q').oninput = () => draw().catch(() => {});
  await draw();
}

function documentsTable(docs, { showClient }) {
  if (!docs.length) return '<div class="empty">Nenhum documento.</div>';
  return `<div class="table-wrap"><table>
    <tr><th>Documento</th><th>Categoria</th>${showClient ? '<th>Cliente</th>' : ''}<th>Contrato</th><th>Enviado</th><th></th></tr>
    ${docs.map((d) => `<tr>
      <td><strong>${esc(d.name)}</strong><div class="small muted">${fileSize(d.size)}</div></td>
      <td>${d.category ? `<span class="badge outline">${esc(d.category)}</span>` : '<span class="muted">-</span>'}</td>
      ${showClient ? `<td>${d.contact_id ? `<a href="#" data-contact="${d.contact_id}">${esc(d.contact_name || 'cliente')}</a>` : '<span class="muted">geral da empresa</span>'}</td>` : ''}
      <td class="small">${esc(d.contract_title || '-')}</td>
      <td class="small nowrap">${fmt(d.created_at, { dateStyle: 'short' })}<div class="muted">${esc(d.uploaded_by)}</div></td>
      <td class="nowrap"><button class="sm" data-open="${d.id}">${PREVIEWABLE[d.mime] ? 'Abrir' : 'Baixar'}</button>${state.me.user.role !== 'professional' ? `<button class="sm ghost danger" data-ddel="${d.id}" aria-label="Excluir documento">✕</button>` : ''}</td></tr>`).join('')}
  </table></div>`;
}

// Só PDF e imagens abrem no navegador; o resto é sempre baixado.
const PREVIEWABLE = { 'application/pdf': true, 'image/png': true, 'image/jpeg': true, 'image/webp': true, 'image/gif': true };

function bindDocuments(root, docs, onChange) {
  $$('[data-contact]', root).forEach((a) => { a.onclick = (e) => { e.preventDefault(); openContact(Number(a.dataset.contact), onChange); }; });
  $$('[data-open]', root).forEach((b) => { b.onclick = () => openDocument(docs.find((d) => String(d.id) === b.dataset.open)); });
  $$('[data-ddel]', root).forEach((b) => { b.onclick = async () => {
    const d = docs.find((x) => String(x.id) === b.dataset.ddel);
    if (!confirm(`Excluir "${d.name}"? Não tem volta.`)) return;
    try { await api(`/api/documents/${d.id}`, { method: 'DELETE' }); toast('Documento excluído'); onChange?.(); } catch (err) { fail(err); }
  }; });
}

async function openDocument(d) {
  const preview = PREVIEWABLE[d.mime];
  // A janela abre já no clique, para o navegador não bloquear como pop-up.
  const win = preview ? window.open('', '_blank') : null;
  try {
    const { data } = await api(`/api/documents/${d.id}/content`);
    const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: preview ? d.mime : 'application/octet-stream' }));
    if (win) win.location = url;
    else {
      const a = document.createElement('a');
      a.href = url;
      a.download = d.name;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { win?.close(); fail(err); }
}

const readBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error(`Não foi possível ler ${file.name}`));
  r.readAsDataURL(file);
});

async function uploadFile(file, { contact_id, contract_id, category }) {
  if (file.size > state.meta.document_max_bytes) throw new Error(`${file.name} passa de ${fileSize(state.meta.document_max_bytes)}`);
  return api('/api/documents', { method: 'POST', body: { name: file.name, data: await readBase64(file), contact_id: contact_id || null, contract_id: contract_id || null, category } });
}

async function uploadForm(defaults, onSaved) {
  const pro = state.me.user.role === 'professional';
  const contactsHtml = defaults.contact_id ? '' : await contactOptions('');
  const box = openModal(`${modalHead('Anexar documento')}
    <form id="upload-form">
      <div class="field"><label for="u-file">Arquivos</label><input id="u-file" type="file" name="files" multiple required accept="${state.meta.document_types.map((t) => `.${t}`).join(',')}">
        <div class="hint">Até ${fileSize(state.meta.document_max_bytes)} por arquivo. PDF, imagens, Word, Excel, PowerPoint, texto, CSV e ZIP.</div></div>
      ${defaults.contact_id ? '' : `<div class="field"><label for="u-contact">Cliente</label><select id="u-contact" name="contact_id" ${pro ? 'required' : ''}>${contactsHtml.replace('— selecione —', pro ? '— selecione —' : '— nenhum (documento geral da empresa) —')}</select></div>`}
      <div class="field"><label for="u-cat">Categoria</label><select id="u-cat" name="category"><option value="">—</option>${state.meta.document_categories.map((c) => `<option ${c === defaults.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary" id="u-send">Enviar</button></div>
    </form>`);
  const form = $('#upload-form', box);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const files = [...form.files.files];
    const target = { contact_id: defaults.contact_id || form.contact_id?.value || null, contract_id: defaults.contract_id || null, category: form.category.value };
    $('#u-send', box).disabled = true;
    let sent = 0;
    try {
      for (const f of files) { await uploadFile(f, target); sent++; }
      box.close();
      toast(sent === 1 ? 'Documento enviado' : `${sent} documentos enviados`);
      onSaved?.();
    } catch (err) {
      fail(err);
      $('#u-send', box).disabled = false;
      if (sent) onSaved?.();
    }
  };
}

// ---------------------------------------------------------------------------
// Assinatura (paywall): Pix na chave da plataforma + comprovante por e-mail
// ---------------------------------------------------------------------------
const PLAN_PERKS = [
  'IA responde no WhatsApp 24h, com o seu catálogo',
  'Agenda, remarca e cancela sozinha',
  'Faz a triagem e gera a cobrança',
  'Follow-up personalizado pela IA',
  'Recomendações com IA no dashboard',
];

async function renderPaywall(el, [planId] = []) {
  const info = await api('/api/upgrade');
  const usersText = (n) => (n === 1 ? '1 usuário' : `até ${n} usuários`);
  const leadsText = (n) => (n === null || n === undefined ? 'leads ilimitados' : `até ${n} leads`);
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${info.ai_locked ? '🔒 Desbloqueie a IA do Falaki' : 'Assinatura'}</h1>
        <p class="muted">${info.ai_locked ? 'No teste grátis tudo que usa IA fica bloqueado. Escolha um plano para a atendente virtual começar a trabalhar.' : 'Mude de plano quando precisar de mais usuários ou leads.'}</p></div>
    </div>
    ${subscriptionCard(info)}
    <div class="grid halves">
      ${info.plans.map((p) => `<div class="card" style="${p.recommended ? 'border-color:var(--green-700)' : ''}">
        <div class="card-head"><h2>${esc(p.label)}</h2>${p.recommended ? '<span class="badge green">mais escolhido</span>' : ''}${p.id === info.current_plan ? '<span class="badge outline">seu plano</span>' : ''}</div>
        <div class="kpi" style="padding:6px 0 0"><div class="value">${money(p.price_cents)}<span class="small muted"> /mês</span></div></div>
        <p class="muted">${esc(p.description || '')}</p>
        <ul class="small" style="padding-left:18px;margin:10px 0">
          <li><strong>${usersText(p.max_users)} · ${leadsText(p.max_leads)}</strong></li>
          ${PLAN_PERKS.map((x) => `<li>${esc(x)}</li>`).join('')}
        </ul>
        ${p.id === info.current_plan && info.subscription.paying ? ''
          : info.subscription.method === 'cartao' && info.subscription.paying && info.card_enabled
            ? `<button class="${p.price_cents > (info.plans.find((x) => x.id === info.current_plan)?.price_cents || 0) ? 'primary' : ''}" data-change="${p.id}" style="width:100%">Mudar para o ${esc(p.label)}</button>
               <div class="hint" style="text-align:center;margin-top:6px">No mesmo cartão. A diferença do mês é proporcional.</div>`
          : info.card_enabled && !(info.subscription.method === 'cartao' && info.subscription.state !== 'cancelada')
          ? `<div class="stack"><button class="primary" data-card="${p.id}" style="width:100%">💳 Assinar com cartão</button>
             <button data-pix="${p.id}" style="width:100%">Pagar com Pix (1 mês)</button><div class="hint" style="text-align:center">Cartão: cobrança mensal automática, cancele quando quiser. Pix: você paga a cada mês.</div></div>`
          : `<button class="${p.recommended ? 'primary' : ''}" data-buy="${p.id}" style="width:100%">Comprar o ${esc(p.label)}</button>`}
      </div>`).join('')}
    </div>
    <div id="checkout" style="margin-top:14px"></div>`;
  $$('[data-buy]', el).forEach((b) => { b.onclick = () => checkout(info, info.plans.find((p) => p.id === b.dataset.buy)); });
  $$('[data-card]', el).forEach((b) => { b.onclick = async () => {
    b.disabled = true;
    try { location.href = (await api('/api/upgrade/card', { method: 'POST', body: { plan: b.dataset.card } })).url; } catch (err) { fail(err); b.disabled = false; }
  }; });
  $$('[data-change]', el).forEach((b) => { b.onclick = async () => {
    const target = info.plans.find((p) => p.id === b.dataset.change);
    const current = info.plans.find((p) => p.id === info.current_plan);
    const down = target.price_cents < (current?.price_cents || 0);
    const msg = `Mudar para o plano ${target.label} (${money(target.price_cents)}/mês)? A diferença proporcional deste mês ${down ? 'vira crédito nas próximas faturas' : 'é cobrada agora no cartão'}.${down ? `\n\nO ${target.label} permite ${target.max_users} usuário(s) e ${target.max_leads ?? 'leads ilimitados'} leads.` : ''}`;
    if (!confirm(msg)) return;
    b.disabled = true;
    try { await api('/api/upgrade/change', { method: 'POST', body: { plan: target.id } }); state.meta = await api('/api/meta'); toast(`Plano ${target.label} ativo`); renderLayout(); route(); } catch (err) { fail(err); b.disabled = false; }
  }; });
  // Pix pelo Stripe: página com QR Code e copia e cola; a confirmação chega sozinha.
  $$('[data-pix]', el).forEach((b) => { b.onclick = async () => {
    b.disabled = true;
    try { location.href = (await api('/api/upgrade/pix', { method: 'POST', body: { plan: b.dataset.pix } })).url; } catch (err) { fail(err); b.disabled = false; }
  }; });
  $('#portal')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { location.href = (await api('/api/upgrade/portal', { method: 'POST' })).url; } catch (err) { fail(err); e.target.disabled = false; }
  });
  // Volta do Stripe: espera o aviso de pagamento (webhook) liberar o plano.
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const back = qs.get('cartao') || qs.get('pix');
  if (back) history.replaceState(null, '', '#/assinar');
  if (back === 'cancelado') toast('Pagamento não concluído. Você pode tentar de novo quando quiser.');
  if (back === 'ok') {
    toast('Pagamento recebido! Liberando o seu plano…');
    const before = info.subscription.paid_until;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const m = await api('/api/meta').catch(() => null);
      if (m && (m.plan.id !== info.current_plan || m.subscription.paid_until !== before)) {
        state.meta = m;
        toast(`Plano ${m.plan.label} ativo${m.subscription.paid_until ? ` até ${m.subscription.paid_until.split('-').reverse().join('/')}` : ''}.`);
        renderLayout();
        return route();
      }
    }
    toast('O pagamento está sendo confirmado pelo cartão. O plano aparece aqui em instantes.');
  }
  // Veio da página inicial com um plano escolhido: já abre o pagamento dele.
  const chosen = info.plans.find((p) => p.id === planId && p.id !== info.current_plan);
  if (chosen) checkout(info, chosen);
}

function subscriptionCard(info) {
  const sub = info.subscription;
  if (sub.state === 'cortesia') {
    const current = info.plans.find((p) => p.id === info.current_plan);
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-head"><h3>Sua assinatura</h3><span class="spacer"></span><span class="badge purple">🎁 cortesia</span></div>
      <p style="margin:6px 0">Plano <strong>${esc(current?.label || info.current_plan)}</strong> liberado como cortesia${sub.courtesy_until ? ` até <strong>${sub.courtesy_until.split('-').reverse().join('/')}</strong>` : ''}, sem cobrança.</p>
      ${sub.courtesy_until ? '<p class="small muted">Depois dessa data a conta volta para o teste grátis. Para continuar com a IA, assine abaixo quando quiser.</p>' : ''}
    </div>`;
  }
  if (!sub.method) return '';
  const current = info.plans.find((p) => p.id === info.current_plan);
  const label = { em_dia: ['green', 'em dia'], vencida: ['red', 'Pix vencido'], atrasada: ['red', 'pagamento recusado'], cancelada: ['', 'cancelada'] }[sub.state] || ['', sub.state];
  return `<div class="card" style="margin-bottom:14px">
    <div class="card-head"><h3>Sua assinatura</h3><span class="spacer"></span><span class="badge ${label[0]}">${label[1]}</span></div>
    <p style="margin:6px 0">${current ? `Plano <strong>${esc(current.label)}</strong> · ${money(current.price_cents)}/mês · ` : ''}${sub.method === 'cartao' ? '💳 cartão (renova sozinho)' : 'Pix'}${sub.paid_until ? ` · pago até ${sub.paid_until.split('-').reverse().join('/')}` : ''}</p>
    ${sub.cancel_at_period_end ? '<p class="small">Cancelamento agendado: o plano vale até o fim do período pago e depois volta para o teste grátis.</p>' : ''}
    ${sub.state === 'atrasada' ? '<p class="small">O cartão foi recusado. Atualize o cartão para não perder o plano.</p>' : ''}
    ${sub.state === 'vencida' ? '<p class="small">O mês pago por Pix terminou. Pague o Pix do plano abaixo para continuar.</p>' : ''}
    ${sub.method === 'pix' && info.card_enabled && current && sub.state !== 'cancelada' ? `<button class="sm primary" data-pix="${current.id}">Pagar o próximo mês com Pix</button> <button class="sm" data-card="${current.id}">Passar para o cartão (automático)</button>` : ''}
    ${sub.method === 'cartao' && sub.has_card ? '<button class="sm" id="portal">Gerenciar assinatura (cartão, faturas, cancelar)</button>' : ''}
  </div>`;
}

function checkout(info, plan) {
  const box = $('#checkout');
  if (!plan.pix_code) {
    box.innerHTML = `<div class="card"><h3>Pagamento por Pix indisponível no momento</h3>
      <p class="muted">Fale com a gente${info.sales_whatsapp ? ` pelo <a href="https://wa.me/${esc(info.sales_whatsapp)}" target="_blank" rel="noopener">WhatsApp</a> ou` : ''} pelo e-mail <a href="mailto:${esc(info.email)}">${esc(info.email)}</a> para assinar.</p></div>`;
    box.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const company = state.me.company.name;
  const subject = `Comprovante Falaki — ${company} — plano ${plan.label}`;
  const bodyText = `Olá! Segue o comprovante do Pix de ${money(plan.price_cents)} do plano ${plan.label}.\n\nEmpresa: ${company}\nE-mail de acesso: ${state.me.user.email}\nIdentificador do Pix: ${info.txid}\n`;
  const mailto = `mailto:${info.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
  box.innerHTML = `<div class="card">
    <div class="card-head"><h2>Pagar o plano ${esc(plan.label)} — ${money(plan.price_cents)}</h2></div>
    <ol style="padding-left:18px;margin:10px 0" class="stack">
      <li><strong>Pague pelo Pix copia e cola.</strong> Abra o app do seu banco, escolha Pix → Copia e cola e cole o código:
        <div class="pix" style="margin:8px 0">${esc(plan.pix_code)}</div>
        <button class="primary sm" id="copy-pix">Copiar código Pix</button>
        <div class="small muted" style="margin-top:8px">Recebedor: ${esc(info.pix_name)} · chave aleatória ${esc(info.pix_key)} · identificador ${esc(info.txid)}</div></li>
      <li><strong>Envie o comprovante para <a href="${esc(mailto)}">${esc(info.email)}</a></strong>, com o nome da sua empresa. <a class="btn sm" href="${esc(mailto)}">Abrir e-mail pronto</a></li>
      <li><strong>Pronto:</strong> assim que confirmarmos o pagamento, o plano ${esc(plan.label)} é liberado na sua conta e a IA começa a responder.</li>
    </ol>
    <button id="sent">Já enviei o comprovante</button>
  </div>`;
  $('#copy-pix').onclick = () => navigator.clipboard.writeText(plan.pix_code).then(() => toast('Código Pix copiado'), () => toast('Selecione o código e copie', 'error'));
  $('#sent').onclick = async (e) => {
    e.target.disabled = true;
    try {
      await api('/api/upgrade/notify', { method: 'POST', body: { plan: plan.id } });
      toast('Obrigado! Avisamos a equipe. A liberação acontece assim que o pagamento for confirmado.');
      e.target.textContent = 'Aviso enviado ✓';
    } catch (err) { fail(err); e.target.disabled = false; }
  };
  box.scrollIntoView({ behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Assistente de configuração ("Primeiros passos"): um fluxo contínuo, uma pergunta por tela
// ---------------------------------------------------------------------------
const WZ_DAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const WZ_TEST_PHONE = '11900000001';

async function renderWizard(el, [n]) {
  const [ob, cfg] = await Promise.all([api('/api/onboarding'), api('/api/settings')]);
  const total = ob.steps.length;
  const firstOpen = Math.max(0, ob.steps.findIndex((x) => !x.done));
  let i = n === 'fim' ? total : Math.min(Math.max((Number(n) || firstOpen + 1) - 1, 0), total);
  const go = (to) => { location.hash = to >= total ? '#/comecar/fim' : `#/comecar/${to + 1}`; };

  if (i >= total) return wizardDone(el, ob);
  const step = ob.steps[i];
  el.innerHTML = `
    <div class="wizard">
      <div class="row small muted"><span>Passo ${i + 1} de ${total}</span><span class="spacer"></span><a href="#/dashboard">Sair e continuar depois</a></div>
      <div class="onboard-bar"><span style="width:${Math.round(((i + (step.done ? 1 : 0)) / total) * 100)}%"></span></div>
      <ol class="wizard-dots">${ob.steps.map((x, k) => `<li class="${k === i ? 'now' : x.done ? 'ok' : ''}"><a href="#/comecar/${k + 1}" title="${esc(x.title)}">${x.done && k !== i ? '✓' : k + 1}</a></li>`).join('')}</ol>
      <div class="card wizard-card">
        <h1>${esc(step.title)}</h1>
        <p class="muted" style="margin:6px 0 18px">${esc(step.text)}</p>
        <div id="wz-body"></div>
        <div class="wizard-foot">
          ${i > 0 ? '<button type="button" id="wz-back">← Voltar</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="ghost" id="wz-skip">${i === total - 1 ? 'Fazer depois' : 'Pular'}</button>
          <button type="button" class="primary" id="wz-next">${i === total - 1 ? 'Concluir' : 'Continuar →'}</button>
        </div>
      </div>
    </div>`;
  $('#wz-back')?.addEventListener('click', () => go(i - 1));
  $('#wz-skip').onclick = () => go(i + 1);
  const body = $('#wz-body');
  const save = await ({ empresa: wzCompany, servicos: wzServices, horarios: wzHours, teste: wzTest, whatsapp: wzWhatsapp })[step.id](body, cfg);
  $('#wz-next').onclick = async (e) => {
    e.target.disabled = true;
    try {
      if (await save() !== false) go(i + 1);
    } catch (err) { fail(err); }
    e.target.disabled = false;
  };
  body.querySelector('input, textarea')?.focus();
}

// 1. Sobre a empresa
function wzCompany(body, cfg) {
  body.innerHTML = `
    <div class="field"><label for="wz-desc">O que você faz, endereço, formas de pagamento e diferenciais</label>
      <textarea id="wz-desc" rows="6" placeholder="Ex.: Barbearia no centro de Campinas (Rua das Flores, 123). Corte, barba e sobrancelha. Aceitamos Pix e cartão em até 3x. Atendemos com hora marcada.">${esc(cfg.settings.ai.business_description)}</textarea>
      <div class="hint" id="wz-count"></div></div>
    <div class="field"><label for="wz-tone">Como a atendente deve falar <span class="muted">(opcional)</span></label>
      <textarea id="wz-tone" rows="2" placeholder="Ex.: simpática e objetiva, mensagens curtas.">${esc(cfg.settings.ai.instructions)}</textarea></div>`;
  const desc = $('#wz-desc', body);
  const count = () => { const n = desc.value.trim().length; $('#wz-count', body).textContent = n >= 20 ? '✓ Ótimo, a IA já tem o que precisa.' : `Escreva pelo menos uma frase (${n}/20).`; };
  desc.oninput = count; count();
  return async () => {
    if (desc.value.trim().length < 20) { toast('Escreva um pouco sobre a empresa (pelo menos uma frase) ou clique em Pular.', 'error'); return false; }
    await api('/api/settings', { method: 'PUT', body: { settings: { ai: { business_description: desc.value.trim(), instructions: $('#wz-tone', body).value.trim() } } } });
    return true;
  };
}

// 2. Serviços e preços (lista contínua: adiciona um embaixo do outro)
async function wzServices(body) {
  let items = (await api('/api/products')).filter((p) => p.active);
  const draw = () => {
    body.innerHTML = `
      <div id="wz-list">${items.length ? items.map((p) => `<div class="wizard-item"><strong>${esc(p.name)}</strong><span class="muted">${money(p.price_cents)}${p.duration_min ? ` · ${p.duration_min} min` : ''}</span><span class="spacer"></span><button type="button" class="sm ghost danger" data-rm="${p.id}" aria-label="Remover ${esc(p.name)}">✕</button></div>`).join('')
        : '<p class="small muted" style="margin:0 0 10px">Nenhum serviço ainda. Comece pelo mais procurado.</p>'}</div>
      <form id="wz-add" class="wizard-add">
        <div class="field" style="flex:2"><label for="wz-pname">Serviço</label><input id="wz-pname" name="name" required placeholder="Ex.: Corte masculino"></div>
        <div class="field" style="flex:1"><label for="wz-pprice">Preço (R$)</label><input id="wz-pprice" name="price" inputmode="decimal" required placeholder="50,00"></div>
        <div class="field" style="flex:1"><label for="wz-pdur">Duração (min)</label><input id="wz-pdur" name="duration_min" type="number" min="0" placeholder="30"></div>
        <button class="primary" style="align-self:flex-end;margin-bottom:var(--s-4)">+ Adicionar</button>
      </form>`;
    $('#wz-add', body).onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/products', { method: 'POST', body: { ...formData(e.target), kind: 'servico' } });
        items = (await api('/api/products')).filter((p) => p.active);
        draw();
        $('#wz-pname', body).focus();
      } catch (err) { fail(err); }
    };
    $$('[data-rm]', body).forEach((b) => { b.onclick = async () => {
      await api(`/api/products/${b.dataset.rm}`, { method: 'DELETE' }).catch(fail);
      items = items.filter((p) => String(p.id) !== b.dataset.rm);
      draw();
    }; });
  };
  draw();
  return async () => {
    // Digitou um serviço e clicou em Continuar sem adicionar: adiciona por ele.
    const f = $('#wz-add', body);
    if (f.name.value.trim() && f.price.value.trim()) await api('/api/products', { method: 'POST', body: { ...formData(f), kind: 'servico' } });
    else if (!items.length) { toast('Adicione pelo menos um serviço ou clique em Pular.', 'error'); return false; }
    return true;
  };
}

// 3. Horários: dia a dia, com abre/fecha e pausa para almoço (sem digitar formatos)
function wzHours(body, cfg) {
  const h = cfg.settings.business_hours;
  const first = WZ_DAYS.map((d) => h[d]).find((r) => r?.length) || [['09:00', '18:00']];
  const lunch = first.length > 1 ? [first[0][1], first[1][0]] : ['12:00', '13:00'];
  body.innerHTML = `
    <div class="row wrap" style="margin-bottom:12px"><span class="small muted">Atalhos:</span>
      <button type="button" class="sm" data-preset="semana">Seg a sex, 9h às 18h</button>
      <button type="button" class="sm" data-preset="sabado">Seg a sáb, 9h às 18h</button></div>
    <div class="wizard-hours">${WZ_DAYS.map((d) => {
      const r = h[d] || [];
      return `<div class="wizard-hour" data-day="${d}">
        <label class="check"><input type="checkbox" data-open ${r.length ? 'checked' : ''}> ${WD_LABEL[d]}</label>
        <input type="time" data-from value="${r[0]?.[0] || '09:00'}" aria-label="${WD_LABEL[d]}: abre">
        <span class="small muted">às</span>
        <input type="time" data-to value="${r.at(-1)?.[1] || '18:00'}" aria-label="${WD_LABEL[d]}: fecha">
      </div>`;
    }).join('')}</div>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="wz-lunch" ${first.length > 1 ? 'checked' : ''}> Pausa para almoço das
      <input type="time" id="wz-l1" value="${lunch[0]}" style="width:auto"> às <input type="time" id="wz-l2" value="${lunch[1]}" style="width:auto"></label>`;
  const sync = () => $$('.wizard-hour', body).forEach((row) => row.classList.toggle('closed', !$('[data-open]', row).checked));
  $$('[data-open]', body).forEach((c) => { c.onchange = sync; });
  $$('[data-preset]', body).forEach((b) => { b.onclick = () => {
    $$('.wizard-hour', body).forEach((row) => {
      const d = row.dataset.day;
      $('[data-open]', row).checked = b.dataset.preset === 'sabado' ? d !== 'dom' : !['sab', 'dom'].includes(d);
      $('[data-from]', row).value = '09:00';
      $('[data-to]', row).value = '18:00';
    });
    sync();
  }; });
  sync();
  return async () => {
    const withLunch = $('#wz-lunch', body).checked;
    const [l1, l2] = [$('#wz-l1', body).value, $('#wz-l2', body).value];
    const hours = {};
    for (const row of $$('.wizard-hour', body)) {
      const from = $('[data-from]', row).value;
      const to = $('[data-to]', row).value;
      if (!$('[data-open]', row).checked) { hours[row.dataset.day] = []; continue; }
      if (!from || !to || from >= to) { toast(`${WD_LABEL[row.dataset.day]}: o horário de fechar precisa ser depois do de abrir.`, 'error'); return false; }
      hours[row.dataset.day] = withLunch && l1 > from && l2 < to && l1 < l2 ? [[from, l1], [l2, to]] : [[from, to]];
    }
    if (!Object.values(hours).some((r) => r.length)) { toast('Marque pelo menos um dia de atendimento.', 'error'); return false; }
    await api('/api/settings', { method: 'PUT', body: { settings: { business_hours: hours } } });
    return true;
  };
}

// 4. Teste: um chat aqui dentro; a pessoa escreve como cliente e vê a resposta
function wzTest(body) {
  const locked = aiLocked();
  let contactId = null;
  let lastId = 0;
  body.innerHTML = `
    <div class="wizard-chat" id="wz-chat"><div class="small muted" style="text-align:center;padding:24px 0">Escreva como se fosse um cliente chegando pelo WhatsApp.</div></div>
    <div class="row wrap" style="margin:10px 0" id="wz-suggest">
      ${['Oi! Quanto custa?', 'Tem horário amanhã?', 'Vocês aceitam Pix?'].map((t) => `<button type="button" class="sm" data-say="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    <form class="row" id="wz-say"><input name="text" placeholder="Mensagem do cliente…" aria-label="Mensagem do cliente" autocomplete="off"><button class="primary">Enviar como cliente</button></form>
    ${locked ? `<div id="wz-reply-box" class="hidden" style="margin-top:12px">
        <p class="small muted" style="margin:0 0 6px">No teste grátis a IA não responde: quem responde é a sua equipe. Responda você:</p>
        <form class="row" id="wz-reply"><input name="text" placeholder="Sua resposta…" aria-label="Sua resposta" autocomplete="off"><button>Responder como equipe</button></form>
        <p class="small" style="margin-top:8px">🔒 Com um plano pago, a IA responde, agenda e cobra sozinha. <a href="#/assinar">Ver planos</a></p></div>` : ''}
    <p class="hint" style="margin-top:10px">O cliente de teste aparece no Atendimento e no CRM como "Cliente teste". Pode apagar depois.</p>`;
  const chat = $('#wz-chat', body);
  const draw = (msgs, reset) => {
    if (reset) chat.innerHTML = '';
    chat.insertAdjacentHTML('beforeend', msgs.map((m) => `<div class="bubble ${m.direction}">${esc(m.body)}<div class="meta">${m.direction === 'out' ? (m.author === 'ai' ? '🤖 IA' : '👤 Equipe') : 'Cliente'}</div></div>`).join(''));
    chat.scrollTop = chat.scrollHeight;
  };
  const poll = async () => {
    if (!contactId || !$('#wz-chat')) return;
    const { messages } = await api(`/api/conversations/${contactId}/messages?after=${lastId}`).catch(() => ({ messages: [] }));
    if (messages.length) { lastId = messages.at(-1).id; draw(messages); }
  };
  every(1500, poll);
  const say = async (text) => {
    if (!text.trim()) return;
    const r = await api('/api/simulator/inbound', { method: 'POST', body: { phone: WZ_TEST_PHONE, name: 'Cliente teste', text } });
    if (r.contact && !contactId) { contactId = r.contact.id; chat.innerHTML = ''; }
    $('#wz-reply-box')?.classList.remove('hidden');
    await poll();
  };
  $$('[data-say]', body).forEach((b) => { b.onclick = () => say(b.dataset.say).catch(fail); });
  $('#wz-say', body).onsubmit = async (e) => { e.preventDefault(); const t = e.target.text.value; e.target.text.value = ''; await say(t).catch(fail); };
  $('#wz-reply', body)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = e.target.text.value.trim();
    if (!t || !contactId) return;
    e.target.text.value = '';
    await api(`/api/conversations/${contactId}/messages`, { method: 'POST', body: { body: t } }).catch(fail);
    await poll();
  });
  return async () => {
    if (!contactId) { toast('Mande pelo menos uma mensagem de teste, ou clique em Pular.', 'error'); return false; }
    return true;
  };
}

// 5. WhatsApp: conectar agora ou depois
function wzWhatsapp(body, cfg) {
  const w = cfg.settings.whatsapp;
  const webhook = state.meta.webhooks?.evolution || '';
  body.innerHTML = `
    ${w.provider !== 'simulator' ? `<div class="banner" style="margin-bottom:14px">✓ WhatsApp já conectado (${w.provider === 'meta' ? 'API oficial' : 'QR Code'}).</div>` : ''}
    <div class="wizard-choice">
      <label class="card wizard-option"><input type="radio" name="wz-wa" value="later" ${w.provider === 'simulator' ? 'checked' : ''}>
        <strong>Conectar depois</strong><span class="small muted">Continue testando com o simulador. Você conecta quando quiser em Configurações → WhatsApp.</span></label>
      <label class="card wizard-option"><input type="radio" name="wz-wa" value="evolution" ${w.provider === 'evolution' ? 'checked' : ''}>
        <strong>Conectar meu número por QR Code</strong><span class="small muted">Use o número que você já tem. Precisa dos dados do servidor de conexão (Evolution API).</span></label>
    </div>
    <div id="wz-evo" class="hidden" style="margin-top:14px">
      <div class="fields">
        <div class="field"><label for="wz-eurl">Endereço do servidor</label><input id="wz-eurl" value="${esc(w.evolution_url)}" placeholder="https://evolution.seudominio.com"></div>
        <div class="field"><label for="wz-einst">Nome da instância</label><input id="wz-einst" value="${esc(w.evolution_instance)}"></div>
        <div class="field"><label for="wz-ekey">Chave (API key)</label><input id="wz-ekey" value="${esc(w.evolution_api_key)}"></div>
      </div>
      <p class="hint">No servidor de conexão, aponte o webhook (evento MESSAGES_UPSERT) para:</p><div class="code">${esc(webhook)}</div>
      <p class="hint">Não tem esses dados? Fale com a gente em <a href="mailto:contato@falaki.me">contato@falaki.me</a> que ajudamos a conectar.</p>
    </div>`;
  const evo = $('#wz-evo', body);
  const sync = () => evo.classList.toggle('hidden', $('[name="wz-wa"]:checked', body)?.value !== 'evolution');
  $$('[name="wz-wa"]', body).forEach((r) => { r.onchange = sync; });
  sync();
  return async () => {
    if ($('[name="wz-wa"]:checked', body)?.value !== 'evolution') return true;
    const url = $('#wz-eurl', body).value.trim();
    const instance = $('#wz-einst', body).value.trim();
    const key = $('#wz-ekey', body).value.trim();
    if (!url || !instance || !key) { toast('Preencha os três dados de conexão, ou escolha "Conectar depois".', 'error'); return false; }
    await api('/api/settings', { method: 'PUT', body: { settings: { whatsapp: { provider: 'evolution', evolution_url: url, evolution_instance: instance, evolution_api_key: key } } } });
    return true;
  };
}

async function wizardDone(el) {
  const ob = await api('/api/onboarding');
  state.meta.onboarding = ob;
  const pending = ob.steps.filter((x) => !x.done);
  el.innerHTML = `
    <div class="wizard">
      <div class="onboard-bar"><span style="width:${ob.percent}%"></span></div>
      <div class="card wizard-card" style="text-align:center">
        <div style="font-size:42px">${pending.length ? '👏' : '🎉'}</div>
        <h1>${pending.length ? 'Quase lá!' : 'Tudo pronto!'}</h1>
        <p class="muted">${pending.length ? `Seu Falaki está ${ob.percent}% pronto. Falta${pending.length > 1 ? 'm' : ''}: ${pending.map((x) => esc(x.title.charAt(0).toLowerCase() + x.title.slice(1))).join(', ')}.` : 'O Falaki já pode atender os seus clientes.'}</p>
        <div class="row wrap" style="justify-content:center;margin-top:18px;gap:10px">
          ${pending.length ? `<a class="btn" href="#/comecar/${ob.steps.indexOf(pending[0]) + 1}">Terminar agora</a>` : ''}
          <a class="btn primary" href="#/inbox">Ir para o Atendimento →</a>
          ${aiLocked() ? '<a class="btn" href="#/assinar">🔒 Desbloquear a IA</a>' : ''}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Importar e exportar contatos
// ---------------------------------------------------------------------------
async function exportContacts() {
  const contacts = await api('/api/contacts?limit=100000');
  const cols = [['Nome', 'name'], ['Telefone', 'phone'], ['E-mail', 'email'], ['Empresa', 'business_name'], ['Etapa', 'stage'],
    ['Origem', 'source'], ['Interesse', 'interest'], ['Etiquetas', 'tags'], ['Valor', 'value_cents'], ['Observações', 'notes'], ['Criado em', 'created_at']];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const value = (c, k) => (k === 'stage' ? stageLabel(c.stage) : k === 'source' ? (SOURCE_LABEL[c.source] || c.source)
    : k === 'value_cents' ? (c.value_cents ? reais(c.value_cents) : '') : k === 'phone' ? (c.phone ? `+${c.phone}` : '') : c[k]);
  const csv = [cols.map(([h]) => cell(h)).join(';'), ...contacts.map((c) => cols.map(([, k]) => cell(value(c, k))).join(';'))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
  a.download = `contatos-${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${contacts.length} contato(s) exportado(s)`);
}

function importWizard(onDone) {
  let rows = null;
  let header = null;
  let mapping = {};
  const box = openModal(`${modalHead('Importar contatos')}<div id="imp-body"></div>`, { wide: true });
  const body = $('#imp-body', box);

  const stepSource = () => {
    body.innerHTML = `
      <p class="muted" style="margin-top:0">Traga seus clientes de uma planilha, do celular ou de outro sistema. Contatos repetidos (mesmo telefone ou e-mail) não são duplicados.</p>
      <div class="grid halves">
        <label class="card dropzone" id="imp-drop" for="imp-file" style="cursor:pointer;text-align:center;border-style:dashed">
          <strong>Escolher arquivo</strong>
          <div class="small muted" style="margin-top:6px">ou arraste aqui · CSV, TXT ou VCF</div>
          <input type="file" id="imp-file" accept=".csv,.tsv,.txt,.vcf,text/csv,text/vcard" class="hidden">
        </label>
        <div>
          <label for="imp-paste">Ou cole direto da planilha</label>
          <textarea id="imp-paste" rows="5" placeholder="Selecione as linhas no Excel ou Google Planilhas, copie (Ctrl+C) e cole aqui"></textarea>
          <button class="sm" id="imp-paste-go" style="margin-top:8px">Continuar</button>
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h3>Como exportar seus contatos</h3>
        <ul class="small" style="margin:8px 0 0;padding-left:18px;line-height:1.7">
          <li><strong>Excel:</strong> Arquivo → Salvar como → CSV (separado por vírgula ou ponto e vírgula).</li>
          <li><strong>Google Planilhas:</strong> Arquivo → Fazer download → CSV.</li>
          <li><strong>Contatos do celular (Android/Google):</strong> contacts.google.com → Exportar → vCard (.vcf) ou CSV do Google.</li>
          <li><strong>iPhone:</strong> icloud.com/contacts → selecione todos → Exportar vCard.</li>
        </ul>
      </div>`;
    const load = (text, name = '') => {
      rows = /\.vcf$/i.test(name) || /BEGIN:VCARD/i.test(text) ? parseVCard(text) : parseDelimited(text);
      if (!rows.length) return toast('Não encontramos contatos nesse conteúdo', 'error');
      const g = guessMapping(rows);
      mapping = g.mapping;
      header = g.header;
      stepMap();
    };
    const readFile = (file) => {
      if (!file) return;
      if (/\.xlsx?$/i.test(file.name)) return toast('Salve a planilha como CSV antes de importar (Arquivo → Salvar como → CSV).', 'error');
      const reader = new FileReader();
      reader.onload = () => {
        let text = String(reader.result);
        // Planilhas antigas do Excel costumam vir em Latin-1: relê se aparecerem caracteres quebrados.
        if (text.includes('\uFFFD')) {
          const r2 = new FileReader();
          r2.onload = () => load(String(r2.result), file.name);
          r2.readAsText(file, 'windows-1252');
          return;
        }
        load(text, file.name);
      };
      reader.readAsText(file, 'utf-8');
    };
    $('#imp-file', box).onchange = (e) => readFile(e.target.files[0]);
    const drop = $('#imp-drop', box);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag-over'); };
    drop.ondragleave = () => drop.classList.remove('drag-over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag-over'); readFile(e.dataTransfer.files[0]); };
    $('#imp-paste-go', box).onclick = () => { const t = $('#imp-paste', box).value; if (t.trim()) load(t); };
  };

  const stepMap = async () => {
    const seqs = state.me.user.role === 'owner' || state.me.user.role === 'agent' ? (await api('/api/sequences').catch(() => [])).filter((x) => x.active) : [];
    const cols = Math.max(...rows.map((r) => r.length));
    const colName = (i) => (header ? header[i] || `Coluna ${i + 1}` : `Coluna ${i + 1}`);
    const render = () => {
      const contacts = toContacts(rows, mapping, { header: Boolean(header) });
      const plan = state.meta.plan;
      body.innerHTML = `
        <p class="muted" style="margin-top:0">Encontramos <strong>${contacts.length}</strong> contato(s). Confira de qual coluna vem cada informação:</p>
        <div class="fields">${FIELDS.map((f) => `<div class="field"><label for="map-${f.id}">${f.label}</label>
          <select id="map-${f.id}" data-field="${f.id}"><option value="">— não importar —</option>${Array.from({ length: cols }, (_, i) => `<option value="${i}" ${mapping[f.id] === i ? 'selected' : ''}>${esc(colName(i))}</option>`).join('')}</select></div>`).join('')}</div>
        <div class="table-wrap card" style="padding:0;margin:4px 0 14px"><table>
          <tr><th>Nome</th><th>Telefone</th><th>E-mail</th><th>Empresa</th></tr>
          ${contacts.slice(0, 5).map((c) => `<tr><td>${esc(c.name || '—')}</td><td>${esc(c.phone || '—')}</td><td>${esc(c.email || '—')}</td><td>${esc(c.business_name || '—')}</td></tr>`).join('')}
        </table></div>
        <div class="fields">
          <div class="field"><label for="imp-stage">Etapa no funil</label><select id="imp-stage">${state.meta.stages.filter((st) => !['ganho', 'perdido'].includes(st.id)).map((st) => `<option value="${st.id}">${esc(st.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="imp-tags">Etiqueta para identificar esta importação</label><input id="imp-tags" value="importado ${fmtDay(todayStr())}"></div>
          ${seqs.length ? `<div class="field"><label for="imp-seq">Colocar num follow-up (opcional)</label><select id="imp-seq"><option value="">Não</option>${seqs.map((q) => `<option value="${q.id}">${esc(q.name)}</option>`).join('')}</select><div class="hint">Os contatos começam a receber as mensagens da sequência no horário comercial.</div></div>` : ''}
        </div>
        <label class="check"><input type="checkbox" id="imp-update"> Se o contato já existir, completar os dados que estiverem faltando</label>
        ${plan?.max_leads ? `<div class="banner" style="margin-top:12px">Seu plano permite mais ${plan.leads_remaining} lead(s). O que passar disso não será importado.</div>` : ''}
        <div class="modal-foot"><button type="button" id="imp-back">Voltar</button><button class="primary" id="imp-go" ${contacts.length ? '' : 'disabled'}>Importar ${contacts.length} contato(s)</button></div>`;
      $$('[data-field]', body).forEach((sel) => { sel.onchange = () => { mapping[sel.dataset.field] = sel.value === '' ? undefined : Number(sel.value); render(); }; });
      $('#imp-back', body).onclick = stepSource;
      $('#imp-go', body).onclick = async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Importando…';
        try {
          const r = await api('/api/contacts/import', { method: 'POST', body: {
            contacts, stage: $('#imp-stage', body).value, tags: $('#imp-tags', body).value,
            sequence_id: $('#imp-seq', body)?.value || null, update_existing: $('#imp-update', body).checked,
          } });
          state.meta = await api('/api/meta');
          stepDone(r);
          onDone?.();
        } catch (err) { fail(err); e.target.disabled = false; e.target.textContent = 'Importar'; }
      };
    };
    render();
  };

  const stepDone = (r) => {
    const line = (n, text) => (n ? `<li><strong>${n}</strong> ${text}</li>` : '');
    body.innerHTML = `
      <h3 style="margin-top:0">Importação concluída</h3>
      <ul style="line-height:1.9">
        ${line(r.created, 'contato(s) novo(s) no CRM')}
        ${line(r.updated, 'contato(s) já existente(s) atualizado(s)')}
        ${line(r.duplicates, 'repetido(s), que já estavam no CRM ou apareciam mais de uma vez')}
        ${line(r.invalid, 'linha(s) sem nome, telefone ou e-mail')}
        ${line(r.limit_skipped, 'não importado(s) por causa do limite de leads do plano')}
      </ul>
      <div class="modal-foot"><button class="primary" data-close>Ver contatos</button></div>`;
  };

  stepSource();
}

async function contactOptions(selected) {
  const contacts = await api('/api/contacts');
  return `<option value="">— selecione —</option>${contacts.map((c) => `<option value="${c.id}" ${String(c.id) === String(selected) ? 'selected' : ''}>${esc(c.name || phoneFmt(c.phone))}${c.phone ? ` · ${phoneFmt(c.phone)}` : ''}</option>`).join('')}`;
}
async function productOptions(selected, { onlyServices = false } = {}) {
  const products = (await api('/api/products')).filter((p) => p.active && (!onlyServices || p.kind === 'servico'));
  return { products, html: `<option value="">— nenhum —</option>${products.map((p) => `<option value="${p.id}" ${String(p.id) === String(selected) ? 'selected' : ''}>${esc(p.name)} · ${money(p.price_cents)}${p.duration_min ? ` · ${p.duration_min}min` : ''}</option>`).join('')}` };
}

async function enrollForm(contactIds, onDone) {
  const seqs = (await api('/api/sequences')).filter((s) => s.active);
  const box = openModal(`${modalHead('Colocar em follow-up')}
    ${seqs.length ? `<form id="enroll-form">
      <div class="field"><label>Sequência</label><select name="sequence_id">${seqs.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.steps.length} passos)</option>`).join('')}</select></div>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Iniciar follow-up</button></div>
    </form>` : '<p>Nenhuma sequência ativa. Crie uma em <a href="#/followup" data-close>Follow-up</a>.</p>'}`);
  const form = $('#enroll-form', box);
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/sequences/${e.target.sequence_id.value}/enroll`, { method: 'POST', body: { contact_ids: contactIds } });
      toast(`${r.enrolled} contato(s) no follow-up`);
      box.close(); onDone?.();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Tarefas da equipe
// ---------------------------------------------------------------------------
async function renderTasks(el) {
  const filter = sessionStorage.getItem('task-filter') ?? 'aberta';
  const tasks = await api(`/api/tasks${filter ? `?status=${filter}` : ''}`);
  const typeLabel = (t) => state.meta.task_types.find((x) => x.id === t)?.label || t;
  const typeColor = { urgente: 'red', horario: 'blue', confirmar_agendamento: 'blue', orcamento: 'purple', aprovar_cobranca: 'amber' };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Tarefas da equipe</h1><p class="muted">O que a IA não pode concluir sozinha chega aqui com prazo: enviar horários, confirmar agendamentos, orçamentos, aprovações e urgências</p></div>
      <span class="spacer"></span><button class="primary" id="new-task">+ Nova tarefa</button>
    </div>
    <div class="card">
      <div class="tabs">${[['aberta', 'Abertas'], ['concluida', 'Concluídas'], ['cancelada', 'Canceladas'], ['', 'Todas']].map(([k, v]) => `<button class="${k === filter ? 'active' : ''}" data-f="${k}">${v}</button>`).join('')}</div>
      <div class="table-wrap"><table>
        <tr><th>Tarefa</th><th>Cliente</th><th>Prazo</th><th>Origem</th><th></th></tr>
        ${tasks.map((t) => {
          const late = t.status === 'aberta' && Date.parse(t.due_at) < Date.now();
          const actions = t.status !== 'aberta' ? '' : t.type === 'aprovar_cobranca'
            ? `<button class="sm primary" data-approve="${t.id}">Aprovar e enviar</button><button class="sm" data-reject="${t.id}">Recusar</button>`
            : t.type === 'confirmar_agendamento'
              ? `<button class="sm primary" data-approve="${t.id}">Confirmar horário</button><button class="sm" data-reject="${t.id}">Recusar</button>`
              : `<button class="sm primary" data-done="${t.id}">Concluir</button><button class="sm ghost" data-cancel="${t.id}">✕</button>`;
          return `<tr>
            <td><span class="badge ${typeColor[t.type] || ''}">${esc(typeLabel(t.type))}</span> <strong>${esc(t.title)}</strong>${t.details ? `<div class="small muted" style="white-space:pre-wrap;margin-top:4px">${esc(t.details)}</div>` : ''}</td>
            <td class="nowrap">${t.contact_id ? `<a href="#/inbox/${t.contact_id}">${esc(t.contact_name || phoneFmt(t.contact_phone))}</a>` : '-'}</td>
            <td class="nowrap">${t.status === 'aberta' ? `<span class="badge ${late ? 'red' : 'green'}">${late ? 'atrasada' : 'no prazo'}</span><div class="small muted">${fmt(t.due_at)}</div>` : `<span class="badge">${t.status}</span>`}</td>
            <td class="small muted">${t.created_by === 'ai' ? '🤖 IA' : 'Equipe'}</td>
            <td class="nowrap">${actions}</td></tr>`;
        }).join('')}
      </table>${tasks.length ? '' : `<div class="empty">${filter === 'aberta' ? 'Nenhuma tarefa aberta. 🎉' : 'Nada por aqui.'}</div>`}</div>
    </div>`;
  $$('[data-f]').forEach((b) => { b.onclick = () => { sessionStorage.setItem('task-filter', b.dataset.f); route(); }; });
  const act = (attr, path, msg) => $$(`[data-${attr}]`).forEach((b) => { b.onclick = async () => {
    try { await api(`/api/tasks/${b.dataset[attr]}/${path}`, { method: 'POST' }); toast(msg); route(); } catch (err) { fail(err); }
  }; });
  act('approve', 'approve', 'Feito! O cliente foi avisado pelo WhatsApp.');
  act('reject', 'reject', 'Recusado');
  act('done', 'complete', 'Tarefa concluída');
  act('cancel', 'cancel', 'Tarefa cancelada');
  $('#new-task').onclick = async () => {
    const contactsHtml = await contactOptions();
    const box = openModal(`${modalHead('Nova tarefa')}
      <form id="task-form">
        <div class="field"><label>Título</label><input name="title" required></div>
        <div class="fields">
          <div class="field"><label>Tipo</label><select name="type">${state.meta.task_types.filter((t) => !['aprovar_cobranca', 'confirmar_agendamento'].includes(t.id)).map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Cliente</label><select name="contact_id">${contactsHtml}</select></div>
        </div>
        <div class="field"><label>Detalhes</label><textarea name="details"></textarea></div>
        <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Criar tarefa</button></div>
      </form>`);
    $('#task-form', box).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/tasks', { method: 'POST', body: formData(e.target) }); box.close(); toast('Tarefa criada'); route(); } catch (err) { fail(err); }
    };
  };
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------
async function renderAgenda(el) {
  const [{ settings }, pros] = await Promise.all([api('/api/settings'), api('/api/professionals')]);
  const activePros = pros.filter((p) => p.active);
  const proFilter = Number(sessionStorage.getItem('agenda-pro') || 0) || null;
  const selectedPro = activePros.find((p) => p.id === proFilter) || null;
  const hoursFor = selectedPro?.business_hours || settings.business_hours;
  let weekStart = sessionStorage.getItem('agenda-week');
  if (!weekStart) { const t = todayStr(); weekStart = addDays(t, -((weekday(t) + 6) % 7)); }
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const allRanges = [settings.business_hours, ...activePros.map((p) => p.business_hours).filter(Boolean)].flatMap((h) => Object.values(h).flat());
  const startH = Math.min(8, ...allRanges.map((r) => Number(r[0].split(':')[0])));
  const endH = Math.max(18, ...allRanges.map((r) => Math.ceil(Number(r[1].split(':')[0]) + Number(r[1].split(':')[1]) / 60)));
  const appts = await api(`/api/appointments?from=${addDays(weekStart, -1)}T00:00:00Z&to=${addDays(weekStart, 8)}T00:00:00Z${proFilter ? `&professional_id=${proFilter}` : ''}`);
  const H = 48;
  const isOpen = (day, h) => !(selectedPro?.blocked_dates || []).includes(day) && (hoursFor[WD[weekday(day)]] || []).some(([a, b]) => h * 60 >= toMin(a) && h * 60 < toMin(b));

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Agenda</h1><p class="muted">Agendamentos feitos pela equipe e pela IA no WhatsApp</p></div>
      <span class="spacer"></span>
      <button id="prev" aria-label="Semana anterior">←</button><button id="today">Hoje</button><button id="next" aria-label="Próxima semana">→</button>
      <strong>${fmtDay(days[0]).slice(0, 5)} – ${fmtDay(days[6])}</strong>
      ${activePros.length ? `<select id="pro-filter" style="width:auto"><option value="">Todos os profissionais</option>${activePros.map((p) => `<option value="${p.id}" ${p.id === proFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
      <button id="google-cal">Google Agenda</button>
      <button class="primary" id="new-appt">+ Agendar</button>
    </div>
    ${activePros.length && !proFilter ? `<div class="row wrap small" style="margin-bottom:10px">${activePros.map((p) => `<span class="row" style="gap:4px"><span style="width:10px;height:10px;border-radius:3px;background:${esc(p.color)}"></span>${esc(p.name)}${p.role ? ` <span class="muted">· ${esc(p.role)}</span>` : ''}</span>`).join('')}</div>` : ''}
    <div class="week">
      <div class="dh"></div>
      ${days.map((d) => `<div class="dh ${d === todayStr() ? 'today' : ''}">${WD[weekday(d)]} ${fmtDay(d).slice(0, 5)}</div>`).join('')}
      <div class="hours">${Array.from({ length: endH - startH }, (_, i) => `<div class="hour">${String(startH + i).padStart(2, '0')}:00</div>`).join('')}</div>
      ${days.map((d) => `<div class="day" data-day="${d}">
        ${Array.from({ length: endH - startH }, (_, i) => `<div class="slot ${isOpen(d, startH + i) ? '' : 'closed'}" data-h="${startH + i}"></div>`).join('')}
        ${appts.filter((a) => localParts(a.start_at).date === d).map((a) => {
          const p = localParts(a.start_at);
          const top = (p.h - startH + p.m / 60) * H;
          const height = Math.max(((Date.parse(a.end_at) - Date.parse(a.start_at)) / 3600000) * H - 2, 18);
          const color = a.professional_color && !['solicitado', 'cancelado', 'faltou'].includes(a.status) ? `border-left-color:${esc(a.professional_color)};` : '';
          return `<div class="appt ${a.status}" style="top:${top}px;height:${height}px;${color}" data-id="${a.id}" title="${esc(a.title)}${a.professional_name ? ` · ${esc(a.professional_name)}` : ''}"><strong>${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}</strong> ${esc(a.contact_name || a.title)}${a.created_by === 'ai' ? ' 🤖' : ''}${a.status === 'solicitado' ? ' ⏳' : ''}<br>${esc(a.professional_name && !proFilter ? a.professional_name : a.product_name || '')}</div>`;
        }).join('')}
      </div>`).join('')}
    </div>
    <p class="small muted" style="margin-top:8px">Clique em um horário vazio para agendar. 🤖 = agendado pela IA. ⏳ = aguardando sua confirmação. Lembretes automáticos são enviados ${settings.scheduling.reminder_hours_before}h antes.</p>`;
  const go = (d) => { sessionStorage.setItem('agenda-week', d); route(); };
  $('#prev').onclick = () => go(addDays(weekStart, -7));
  $('#next').onclick = () => go(addDays(weekStart, 7));
  $('#today').onclick = () => { sessionStorage.removeItem('agenda-week'); route(); };
  $('#new-appt').onclick = () => appointmentForm({ professional_id: proFilter }, route);
  $('#google-cal').onclick = () => googleCalendarModal(activePros);
  const pf = $('#pro-filter');
  if (pf) pf.onchange = () => { sessionStorage.setItem('agenda-pro', pf.value); route(); };
  $$('.slot').forEach((s) => { s.onclick = () => appointmentForm({ date: s.parentElement.dataset.day, time: `${String(s.dataset.h).padStart(2, '0')}:00`, professional_id: proFilter }, route); });
  $$('.appt').forEach((a) => { a.onclick = (e) => { e.stopPropagation(); appointmentDetail(appts.find((x) => String(x.id) === a.dataset.id)); }; });
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

async function googleCalendarModal(pros) {
  const st = await api('/api/google/status');
  const role = state.me.user.role;
  // Quem tem agenda no Google: cada profissional, ou a empresa quando não há profissionais.
  const targets = pros.length
    ? pros.filter((p) => role === 'owner' || p.id === state.me.user.professional_id).map((p) => ({ id: p.id, name: p.name }))
    : role === 'owner' ? [{ id: null, name: 'Agenda da empresa' }] : [];
  const conn = (id) => st.connections.find((c) => (c.professional_id ?? null) === id);
  const box = openModal(`${modalHead('Google Agenda')}
    <p class="muted" style="margin-top:0">Conecte uma vez e pronto: cada agendamento feito no Falaki (pela equipe ou pela IA) aparece sozinho no Google Agenda, e o que for marcado direto no Google bloqueia o horário aqui. Ninguém precisa cadastrar nada duas vezes.</p>
    ${!st.configured ? '<div class="banner">A conexão com o Google ainda não foi ativada nesta plataforma. Peça ao administrador para configurar as credenciais do Google Cloud.</div>' : ''}
    ${targets.length ? `<div class="table-wrap"><table>
      <tr><th>Agenda</th><th>Conta Google</th><th></th></tr>
      ${targets.map((t) => {
        const c = conn(t.id);
        return `<tr><td><strong>${esc(t.name)}</strong></td>
          <td>${c ? `${esc(c.email || 'conectada')} ${c.status === 'ok' ? `<span class="badge green">sincronizando</span><div class="small muted">horários do Google lidos ${c.busy_synced_at ? ago(c.busy_synced_at) : '—'}</div>` : `<span class="badge red">reconectar</span><div class="small muted">${esc(c.last_error || '')}</div>`}` : '<span class="muted">não conectada</span>'}</td>
          <td class="nowrap">${c ? `<button class="sm" data-gdisc="${c.id}">Desconectar</button>${c.status !== 'ok' ? ` <button class="sm primary" data-gconn="${t.id ?? ''}">Reconectar</button>` : ''}` : `<button class="sm primary" data-gconn="${t.id ?? ''}" ${st.configured ? '' : 'disabled'}>Conectar</button>`}</td></tr>`;
      }).join('')}
    </table></div>` : '<p class="muted">Nenhuma agenda disponível para o seu perfil.</p>'}
    <div class="modal-foot">${st.connections.length ? '<button id="gsync">Atualizar agora</button>' : ''}<button class="primary" data-close>Fechar</button></div>`);
  $$('[data-gconn]', box).forEach((b) => { b.onclick = async () => {
    try {
      const { url } = await api('/api/google/connect', { method: 'POST', body: { professional_id: b.dataset.gconn || null } });
      location.href = url;
    } catch (err) { fail(err); }
  }; });
  $$('[data-gdisc]', box).forEach((b) => { b.onclick = async () => {
    if (!confirm('Desconectar esta agenda do Google? Os eventos já criados continuam lá.')) return;
    try { await api(`/api/google/connections/${b.dataset.gdisc}`, { method: 'DELETE' }); box.close(); toast('Agenda desconectada'); } catch (err) { fail(err); }
  }; });
  $('#gsync', box)?.addEventListener('click', async () => {
    try { await api('/api/google/sync', { method: 'POST' }); box.close(); toast('Horários do Google atualizados'); route(); } catch (err) { fail(err); }
  });
}

function appointmentDetail(a) {
  const box = openModal(`${modalHead(a.title)}
    <p><strong>${fmt(a.start_at, { dateStyle: 'full', timeStyle: 'short' })}</strong> até ${fmt(a.end_at, { timeStyle: 'short' })}</p>
    <p class="muted">${a.contact_name ? `Cliente: ${esc(a.contact_name)} · ${phoneFmt(a.contact_phone)}` : 'Sem cliente vinculado'}${a.created_by === 'ai' ? ' · agendado pela IA 🤖' : ''}</p>
    ${a.professional_name ? `<p>Profissional: <strong>${esc(a.professional_name)}</strong></p>` : ''}
    ${a.google_event_id ? '<p class="small muted">✓ Sincronizado com o Google Agenda</p>' : a.google_sync === 'erro' ? '<p class="small" style="color:var(--danger)">Não foi possível enviar ao Google Agenda; o Falaki tenta de novo automaticamente.</p>' : ''}
    ${a.notes ? `<p>${esc(a.notes)}</p>` : ''}
    <label>Status</label>
    ${a.status === 'solicitado' ? `<div class="banner">Horário reservado pela IA e <strong>aguardando sua confirmação</strong>. Ao confirmar ou recusar, o cliente é avisado pelo WhatsApp.</div>
    <div class="row wrap" style="margin-bottom:12px"><button class="primary" data-status="confirmado">✓ Confirmar horário</button><button class="danger" data-status="cancelado">Recusar</button></div>` : ''}
    <div class="row wrap">${['agendado', 'confirmado', 'concluido', 'faltou', 'cancelado'].map((s) => `<button class="sm ${a.status === s ? 'primary' : ''}" data-status="${s}">${s}</button>`).join('')}</div>
    <div class="modal-foot">
      ${a.contact_id ? '<button id="a-contact">Ver cliente</button>' : ''}
      <button class="danger" id="a-del">Excluir</button><button data-close>Fechar</button>
    </div>`);
  $$('[data-status]', box).forEach((b) => { b.onclick = async () => {
    try { await api(`/api/appointments/${a.id}`, { method: 'PUT', body: { status: b.dataset.status } }); box.close(); toast('Status atualizado'); route(); } catch (err) { fail(err); }
  }; });
  $('#a-del', box).onclick = async () => { if (!confirm('Excluir agendamento?')) return; await api(`/api/appointments/${a.id}`, { method: 'DELETE' }).catch(fail); box.close(); route(); };
  const ac = $('#a-contact', box);
  if (ac) ac.onclick = () => { box.close(); openContact(a.contact_id); };
}

async function appointmentForm(defaults, onSaved) {
  const [contactsHtml, prod, pros] = await Promise.all([contactOptions(defaults.contact_id), productOptions(defaults.product_id, { onlyServices: true }), api('/api/professionals')]);
  const activePros = pros.filter((p) => p.active);
  const box = openModal(`${modalHead('Novo agendamento')}
    <form id="appt-form">
      <div class="fields">
        <div class="field"><label>Cliente</label><select name="contact_id">${contactsHtml}</select></div>
        <div class="field"><label>Serviço</label><select name="product_id">${prod.html}</select></div>
        ${activePros.length ? `<div class="field"><label>Profissional</label><select name="professional_id"><option value="">Qualquer um disponível</option>${activePros.map((p) => `<option value="${p.id}" ${String(p.id) === String(defaults.professional_id) ? 'selected' : ''}>${esc(p.name)}${p.role ? ` · ${esc(p.role)}` : ''}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Data</label><input type="date" name="date" value="${defaults.date || todayStr()}" required></div>
        <div class="field"><label>Hora</label><input type="time" name="time" value="${defaults.time || ''}" required></div>
      </div>
      <div class="field"><label>Horários livres neste dia</label><div class="slots" id="slots"><span class="muted small">Carregando…</span></div></div>
      <div class="field"><label>Título (opcional)</label><input name="title" placeholder="Gerado automaticamente"></div>
      <div class="field"><label>Observações</label><textarea name="notes"></textarea></div>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Agendar</button></div>
    </form>`);
  const form = $('#appt-form', box);
  const loadSlots = async () => {
    const pro = form.professional_id?.value;
    const slots = await api(`/api/slots?date=${form.date.value}${form.product_id.value ? `&product_id=${form.product_id.value}` : ''}${pro ? `&professional_id=${pro}` : ''}`).catch(() => []);
    $('#slots', box).innerHTML = slots.map((s) => `<button type="button" class="sm ${s.time === form.time.value ? 'selected' : ''}" data-t="${s.time}" title="${esc((s.professionals || []).map((p) => p.name).join(', '))}">${s.time}</button>`).join('') || '<span class="muted small">Nenhum horário livre (você ainda pode forçar um horário manualmente).</span>';
    $$('[data-t]', box).forEach((b) => { b.onclick = () => { form.time.value = b.dataset.t; $$('[data-t]', box).forEach((x) => x.classList.toggle('selected', x === b)); }; });
  };
  form.date.onchange = loadSlots;
  form.product_id.onchange = loadSlots;
  if (form.professional_id) form.professional_id.onchange = loadSlots;
  loadSlots();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/appointments', { method: 'POST', body: formData(form) }); box.close(); toast('Agendado!'); onSaved?.(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------
async function renderFollowup(el) {
  const [seqs, enrollments] = await Promise.all([api('/api/sequences'), api('/api/enrollments')]);
  const trig = (id) => state.meta.triggers.find((t) => t.id === id)?.label || id;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Follow-up automático</h1><p class="muted">Sequências de mensagens que acompanham o lead até a venda — param sozinhas quando o cliente responde</p></div>
      <span class="spacer"></span><button id="run-now" title="Processa agora os envios vencidos">▶ Executar agora</button><button class="primary" id="new-seq">+ Nova sequência</button>
    </div>
    <div class="grid halves">
      ${seqs.map((s) => `<div class="card">
        <div class="card-head"><h2>${esc(s.name)}</h2><span class="spacer"></span><span class="badge ${s.active ? 'green' : ''}">${s.active ? 'ativa' : 'pausada'}</span></div>
        <p class="small muted">Gatilho: ${esc(trig(s.trigger))} · ${s.steps.length} passos · ${s.active_count} em andamento · ${s.total_count} no total${s.stop_on_reply ? ' · para quando responde' : ''}</p>
        <ol class="small" style="padding-left:18px">${s.steps.map((st) => `<li style="margin-bottom:4px"><span class="muted">após ${st.delay_hours}h${st.use_ai ? ' · personalizada por IA' : ''}:</span> ${esc(st.message.slice(0, 110))}${st.message.length > 110 ? '…' : ''}</li>`).join('')}</ol>
        <div class="row"><button class="sm" data-edit="${s.id}">Editar</button><button class="sm" data-toggle="${s.id}">${s.active ? 'Pausar' : 'Ativar'}</button><button class="sm danger" data-del="${s.id}">Excluir</button></div>
      </div>`).join('') || '<div class="card empty">Nenhuma sequência. Crie a primeira!</div>'}
    </div>
    <div class="card" style="margin-top:14px"><div class="card-head"><h2>Leads em follow-up</h2></div>
      <div class="table-wrap"><table>
        <tr><th>Contato</th><th>Sequência</th><th>Passo</th><th>Próximo envio</th><th>Status</th><th></th></tr>
        ${enrollments.map((e) => `<tr><td>${esc(e.contact_name || phoneFmt(e.contact_phone))}</td><td>${esc(e.sequence_name)}</td>
          <td>${Math.min(e.step_index + 1, e.steps_total)}/${e.steps_total}</td><td class="small">${e.status === 'ativo' ? fmt(e.next_run_at) : '-'}</td>
          <td><span class="badge ${e.status === 'ativo' ? 'green' : e.status === 'concluido' ? 'blue' : ''}">${e.status}</span>${e.stop_reason ? `<div class="small muted">${esc(e.stop_reason)}</div>` : ''}</td>
          <td>${e.status === 'ativo' ? `<button class="sm" data-stop="${e.id}">Parar</button>` : ''}</td></tr>`).join('')}
      </table>${enrollments.length ? '' : '<div class="empty">Ninguém em follow-up ainda.</div>'}</div>
    </div>`;
  $('#new-seq').onclick = () => sequenceForm(null);
  $('#run-now').onclick = async () => { await api('/api/automations/run', { method: 'POST' }).catch(fail); toast('Automações executadas'); route(); };
  $$('[data-edit]').forEach((b) => { b.onclick = () => sequenceForm(seqs.find((s) => String(s.id) === b.dataset.edit)); });
  $$('[data-toggle]').forEach((b) => { b.onclick = async () => {
    const s = seqs.find((x) => String(x.id) === b.dataset.toggle);
    await api(`/api/sequences/${s.id}`, { method: 'PUT', body: { active: !s.active } }).catch(fail); route();
  }; });
  $$('[data-del]').forEach((b) => { b.onclick = async () => { if (!confirm('Excluir sequência?')) return; await api(`/api/sequences/${b.dataset.del}`, { method: 'DELETE' }).catch(fail); route(); }; });
  $$('[data-stop]').forEach((b) => { b.onclick = async () => { await api(`/api/enrollments/${b.dataset.stop}/stop`, { method: 'POST' }).catch(fail); route(); }; });
}

function sequenceForm(seq) {
  const s = seq || { name: '', trigger: 'manual', stop_on_reply: 1, active: 1, steps: [{ delay_hours: 1, message: 'Oi {{nome}}! ', use_ai: false }] };
  let steps = structuredClone(s.steps);
  const box = openModal(`${modalHead(seq ? 'Editar sequência' : 'Nova sequência de follow-up')}
    <form id="seq-form">
      <div class="fields">
        <div class="field"><label>Nome</label><input name="name" value="${esc(s.name)}" required></div>
        <div class="field"><label>Quando iniciar</label><select name="trigger">${state.meta.triggers.map((t) => `<option value="${t.id}" ${t.id === s.trigger ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
      </div>
      <label class="check field"><input type="checkbox" name="stop_on_reply" ${s.stop_on_reply ? 'checked' : ''}> Parar a sequência quando o cliente responder</label>
      <p class="hint">Variáveis: <span class="code">{{nome}}</span> <span class="code">{{nome_completo}}</span> <span class="code">{{empresa}}</span> <span class="code">{{interesse}}</span> <span class="code">{{negocio}}</span>. Mensagens só saem no horário comercial.</p>
      <div id="steps"></div>
      <button type="button" class="sm" id="add-step">+ Adicionar passo</button>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
    </form>`, { wide: true });
  const renderSteps = () => {
    $('#steps', box).innerHTML = steps.map((st, i) => `<div class="step">
      <div class="step-head"><span class="step-num">${i + 1}</span><span class="small">Enviar após</span>
        <input type="number" min="0" step="0.5" value="${st.delay_hours}" data-i="${i}" data-k="delay_hours" style="width:80px">
        <span class="small">horas ${i === 0 ? 'da entrada na sequência' : 'do passo anterior'}</span><span class="spacer"></span>
        ${aiLocked() ? '<a class="small" href="#/assinar" title="A IA faz parte dos planos pagos">🔒 Personalizar com IA</a>' : `<label class="check small"><input type="checkbox" data-i="${i}" data-k="use_ai" ${st.use_ai ? 'checked' : ''}> Personalizar com IA</label>`}
        <button type="button" class="sm ghost danger" data-rm="${i}">✕</button></div>
      <textarea data-i="${i}" data-k="message" rows="3">${esc(st.message)}</textarea></div>`).join('');
    $$('[data-k]', box).forEach((inp) => { inp.oninput = inp.onchange = () => {
      const st = steps[inp.dataset.i];
      st[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.dataset.k === 'delay_hours' ? Number(inp.value) : inp.value;
    }; });
    $$('[data-rm]', box).forEach((b) => { b.onclick = () => { steps.splice(Number(b.dataset.rm), 1); renderSteps(); }; });
  };
  renderSteps();
  $('#add-step', box).onclick = () => { steps.push({ delay_hours: 24, message: '', use_ai: false }); renderSteps(); };
  $('#seq-form', box).onsubmit = async (e) => {
    e.preventDefault();
    const data = { ...formData(e.target), steps };
    try {
      await api(seq ? `/api/sequences/${seq.id}` : '/api/sequences', { method: seq ? 'PUT' : 'POST', body: data });
      box.close(); toast('Sequência salva'); route();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Cobrança
// ---------------------------------------------------------------------------
async function renderBilling(el) {
  const filter = sessionStorage.getItem('charge-filter') || '';
  const charges = await api(`/api/charges${filter ? `?status=${filter}` : ''}`);
  const all = filter ? await api('/api/charges') : charges;
  const sum = (st) => all.filter((c) => c.status === st).reduce((n, c) => n + c.amount_cents, 0);
  const prov = { pix_manual: 'Pix (chave própria)', asaas: 'Asaas', mercadopago: 'Mercado Pago' }[state.meta.billing_provider];
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Cobrança</h1><p class="muted">Gere cobranças, envie pelo WhatsApp e deixe a régua de lembretes trabalhar — com educação, sem constranger</p></div>
      <span class="spacer"></span><span class="badge green">${prov}</span><button class="primary" id="new-charge">+ Nova cobrança</button>
    </div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Pendente</div><div class="value">${money(sum('pendente'))}</div></div>
      <div class="card kpi ${sum('vencido') ? 'bad' : ''}"><div class="label">Vencido</div><div class="value">${money(sum('vencido'))}</div></div>
      <div class="card kpi good"><div class="label">Recebido (total)</div><div class="value">${money(sum('pago'))}</div></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="tabs">${[['', 'Todas'], ['pendente', 'Pendentes'], ['vencido', 'Vencidas'], ['pago', 'Pagas'], ['cancelado', 'Canceladas']].map(([k, v]) => `<button class="${k === filter ? 'active' : ''}" data-f="${k}">${v}</button>`).join('')}</div>
      <div class="table-wrap"><table>
        <tr><th>Cliente</th><th>Descrição</th><th class="right">Valor</th><th>Vencimento</th><th>Status</th><th>Lembretes</th><th></th></tr>
        ${charges.map((c) => `<tr>
          <td>${esc(c.contact_name || '-')}<div class="small muted">${phoneFmt(c.contact_phone)}</div></td>
          <td>${esc(c.description)}</td><td class="right nowrap"><strong>${money(c.amount_cents)}</strong></td>
          <td class="nowrap">${fmtDay(c.due_date)}</td>
          <td><span class="badge ${CHARGE_BADGE[c.status]}">${c.status}</span>${c.paid_at ? `<div class="small muted">${fmt(c.paid_at, { dateStyle: 'short' })}</div>` : ''}</td>
          <td class="small muted">${JSON.parse(c.reminders || '[]').map((r) => (r === 'created' ? 'enviada' : r.toUpperCase())).join(', ') || '-'}</td>
          <td class="nowrap">
            ${c.payment_url ? `<a class="btn sm" href="${esc(c.payment_url)}" target="_blank" rel="noopener">Link</a>` : ''}
            ${c.pix_code ? `<button class="sm" data-pix="${c.id}">Pix</button>` : ''}
            ${['pendente', 'vencido'].includes(c.status) ? `<button class="sm" data-resend="${c.id}">Reenviar</button><button class="sm" data-paid="${c.id}">Recebido</button><button class="sm ghost danger" data-cancel="${c.id}" aria-label="Cancelar cobrança">✕</button>` : ''}
          </td></tr>`).join('')}
      </table>${charges.length ? '' : '<div class="empty">Nenhuma cobrança.</div>'}</div>
    </div>`;
  $('#new-charge').onclick = () => chargeForm({}, route);
  $$('[data-f]').forEach((b) => { b.onclick = () => { sessionStorage.setItem('charge-filter', b.dataset.f); route(); }; });
  const act = (attr, path, msg) => $$(`[data-${attr}]`).forEach((b) => { b.onclick = async () => {
    if (attr === 'cancel' && !confirm('Cancelar cobrança?')) return;
    try { await api(`/api/charges/${b.dataset[attr]}/${path}`, { method: 'POST' }); toast(msg); route(); } catch (err) { fail(err); }
  }; });
  act('paid', 'paid', 'Pagamento registrado e cliente notificado');
  act('resend', 'resend', 'Cobrança reenviada pelo WhatsApp');
  act('cancel', 'cancel', 'Cobrança cancelada');
  $$('[data-pix]').forEach((b) => { b.onclick = () => {
    const c = charges.find((x) => String(x.id) === b.dataset.pix);
    const box = openModal(`${modalHead('Pix copia e cola')}<p>${esc(c.description)} — <strong>${money(c.amount_cents)}</strong></p><div class="pix">${esc(c.pix_code)}</div><div class="modal-foot"><button id="copy" class="primary">Copiar</button></div>`);
    $('#copy', box).onclick = () => navigator.clipboard.writeText(c.pix_code).then(() => toast('Copiado!'));
  }; });
}

async function chargeForm(defaults, onSaved) {
  const [contactsHtml, prod] = await Promise.all([contactOptions(defaults.contact_id), productOptions()]);
  const box = openModal(`${modalHead('Nova cobrança')}
    <form id="charge-form">
      <div class="field"><label>Cliente</label><select name="contact_id" required>${contactsHtml}</select></div>
      <div class="field"><label>Produto / serviço (preenche descrição e valor)</label><select name="product_id">${prod.html}</select></div>
      <div class="fields">
        <div class="field"><label>Descrição</label><input name="description"></div>
        <div class="field"><label>Valor (R$)</label><input name="amount" inputmode="decimal" placeholder="0,00"></div>
        <div class="field"><label>Vencimento</label><input type="date" name="due_date" value="${todayStr()}" required></div>
      </div>
      <label class="check"><input type="checkbox" name="send" checked> Enviar agora pelo WhatsApp</label>
      <p class="hint">Lembretes automáticos são enviados antes e depois do vencimento, conforme Configurações → Cobrança.</p>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Gerar cobrança</button></div>
    </form>`);
  const form = $('#charge-form', box);
  form.product_id.onchange = () => {
    const p = prod.products.find((x) => String(x.id) === form.product_id.value);
    if (p) { form.description.value = p.name; form.amount.value = reais(p.price_cents); }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/charges', { method: 'POST', body: formData(form) }); box.close(); toast('Cobrança criada'); onSaved?.(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Prospecção Google Maps
// ---------------------------------------------------------------------------
async function renderProspecting(el, [searchId]) {
  const [searches, seqs] = await Promise.all([api('/api/prospecting/searches'), api('/api/sequences')]);
  const current = searchId ? await api(`/api/prospecting/searches/${searchId}`) : null;
  el.innerHTML = `
    <div class="page-head"><div><h1>Prospecção Google Maps</h1><p class="muted">Encontre empresas locais, importe para o CRM e inicie a abordagem automática</p></div></div>
    ${!state.meta.places_configured ? '<div class="banner">Configure a chave da <strong>Google Places API</strong> em <a href="#/config/avancado">Configurações → Avançado</a> para buscar empresas.</div>' : ''}
    <div class="card">
      <form id="search-form" class="row wrap">
        <input name="query" placeholder='Ex.: "academias em Campinas", "pet shop zona sul São Paulo"' required style="flex:1;min-width:240px">
        <button class="primary">🔎 Buscar empresas</button>
      </form>
      <p class="hint">Até 60 resultados por busca, com telefone, site, endereço e nota no Google.</p>
    </div>
    <div class="grid two" style="margin-top:14px">
      <div class="card" id="results">${current ? '' : '<div class="empty">Faça uma busca ou abra uma busca anterior.</div>'}</div>
      <div class="card"><h2>Buscas anteriores</h2>
        <ul class="feed">${searches.map((s) => `<li><a href="#/prospeccao/${s.id}">${esc(s.query)}</a><div class="small muted">${s.results_count} resultados · ${fmt(s.created_at)}</div></li>`).join('') || '<li class="muted">Nenhuma ainda.</li>'}</ul>
      </div>
    </div>`;
  $('#search-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Buscando…';
    try {
      const r = await api('/api/prospecting/search', { method: 'POST', body: formData(e.target) });
      location.hash = `#/prospeccao/${r.id}`;
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = '🔎 Buscar empresas'; }
  };
  if (!current) return;
  const withPhone = current.results.filter((r) => r.phone);
  $('#results').innerHTML = `
    <div class="card-head"><h2>${esc(current.query)}</h2><span class="muted small">${current.results.length} empresas · ${withPhone.length} com telefone</span></div>
    <div class="row wrap" style="margin-bottom:10px">
      <label class="check small"><input type="checkbox" id="sel-all"> Selecionar todos com telefone</label><span class="spacer"></span>
      <select id="imp-seq" style="width:auto"><option value="">Sem follow-up</option>${seqs.filter((s) => s.active).map((s) => `<option value="${s.id}">Follow-up: ${esc(s.name)}</option>`).join('')}</select>
      <button class="primary sm" id="import">Importar selecionados</button>
    </div>
    <div class="table-wrap"><table>
      <tr><th></th><th>Empresa</th><th>Telefone</th><th>Nota</th><th>Site</th></tr>
      ${current.results.map((r) => `<tr>
        <td>${r.contact_id ? '<span class="badge green">no CRM</span>' : `<input type="checkbox" data-p="${r.id}" ${r.phone ? '' : 'disabled'}>`}</td>
        <td><strong>${esc(r.name)}</strong><div class="small muted">${esc(r.category || '')} ${r.address ? `· ${esc(r.address)}` : ''}</div>${r.maps_url ? `<a class="small" href="${esc(r.maps_url)}" target="_blank" rel="noopener">ver no Maps</a>` : ''}</td>
        <td class="nowrap">${esc(r.phone || '-')}</td>
        <td class="nowrap">${r.rating ? `⭐ ${r.rating} <span class="muted small">(${r.reviews})</span>` : '-'}</td>
        <td>${r.website ? `<a href="${esc(r.website)}" target="_blank" rel="noopener" class="small">site</a>` : '<span class="badge amber">sem site</span>'}</td>
      </tr>`).join('')}
    </table></div>`;
  $('#sel-all').onchange = (e) => $$('[data-p]:not(:disabled)').forEach((c) => { c.checked = e.target.checked; });
  $('#import').onclick = async () => {
    const ids = $$('[data-p]:checked').map((c) => Number(c.dataset.p));
    if (!ids.length) return toast('Selecione pelo menos uma empresa');
    try {
      const r = await api('/api/prospecting/import', { method: 'POST', body: { prospect_ids: ids, sequence_id: $('#imp-seq').value || null } });
      toast(`${r.imported} empresa(s) importada(s) para o CRM`);
      route();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------
async function renderProducts(el) {
  const products = await api('/api/products');
  el.innerHTML = `
    <div class="page-head"><div><h1>Produtos e serviços</h1><p class="muted">O que você vende — a IA usa este catálogo para responder preços e agendar</p></div>
      <span class="spacer"></span><button class="primary" id="new-prod">+ Novo</button></div>
    <div class="card table-wrap"><table>
      <tr><th>Nome</th><th>Tipo</th><th class="right">Preço</th><th>Duração</th><th>Status</th></tr>
      ${products.map((p) => `<tr class="clickable" data-id="${p.id}"><td><strong>${esc(p.name)}</strong><div class="small muted">${esc(p.description)}</div></td>
        <td>${p.kind === 'servico' ? 'Serviço' : 'Produto'}</td><td class="right">${money(p.price_cents)}</td><td>${p.duration_min ? `${p.duration_min} min` : '-'}</td>
        <td><span class="badge ${p.active ? 'green' : ''}">${p.active ? 'ativo' : 'inativo'}</span></td></tr>`).join('')}
    </table>${products.length ? '' : '<div class="empty">Cadastre o que você vende.</div>'}</div>`;
  $('#new-prod').onclick = () => productForm(null);
  $$('tr[data-id]').forEach((tr) => { tr.onclick = () => productForm(products.find((p) => String(p.id) === tr.dataset.id)); });
}

function productForm(p) {
  const x = p || { kind: 'servico', active: 1 };
  const box = openModal(`${modalHead(p ? 'Editar' : 'Novo produto/serviço')}
    <form id="prod-form">
      <div class="field"><label>Nome</label><input name="name" value="${esc(x.name)}" required></div>
      <div class="field"><label>Descrição (a IA usa para explicar ao cliente)</label><textarea name="description">${esc(x.description)}</textarea></div>
      <div class="fields">
        <div class="field"><label>Preço (R$)</label><input name="price" value="${x.price_cents !== undefined ? reais(x.price_cents) : ''}" inputmode="decimal" required></div>
        <div class="field"><label>Tipo</label><select name="kind"><option value="servico">Serviço (agendável)</option><option value="produto" ${x.kind === 'produto' ? 'selected' : ''}>Produto</option></select></div>
        <div class="field"><label>Duração (min, para serviços)</label><input type="number" name="duration_min" value="${x.duration_min || ''}"></div>
      </div>
      <label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Ativo</label>
      <div class="modal-foot">${p ? '<button type="button" class="danger" id="del">Excluir</button><span class="spacer"></span>' : ''}<button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
    </form>`);
  $('#prod-form', box).onsubmit = async (e) => {
    e.preventDefault();
    try { await api(p ? `/api/products/${p.id}` : '/api/products', { method: p ? 'PUT' : 'POST', body: formData(e.target) }); box.close(); route(); } catch (err) { fail(err); }
  };
  const del = $('#del', box);
  if (del) del.onclick = async () => { if (!confirm('Excluir?')) return; await api(`/api/products/${p.id}`, { method: 'DELETE' }).catch(fail); box.close(); route(); };
}

// ---------------------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------------------
async function renderSettings(el, [tab = 'empresa']) {
  if (tab === 'integracoes') tab = 'avancado'; // a antiga aba Integrações agora fica em Avançado
  const data = await api('/api/settings');
  const s = data.settings;
  const meta = state.meta = await api('/api/meta');
  const tabs = [['empresa', 'Empresa'], ['ia', 'Comportamento da IA'], ['profissionais', 'Profissionais'], ['usuarios', 'Usuários'], ['agenda', 'Horários & Agenda'], ['whatsapp', 'WhatsApp'], ['cobranca', 'Cobrança'], ['avancado', 'Avançado']];
  const input = (group, key, label, { type = 'text', hint = '', placeholder = '' } = {}) => `<div class="field"><label>${label}</label>
    <input name="${group}.${key}" type="${type}" value="${esc(s[group][key])}" placeholder="${esc(placeholder)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const check = (group, key, label) => `<label class="check field"><input type="checkbox" name="${group}.${key}" ${s[group][key] ? 'checked' : ''}> ${label}</label>`;
  const hook = (url) => `<div class="code">${esc(url)}</div>`;
  const bo = meta.behavior_options;
  const select = (group, key, label, options) => `<div class="field"><label>${label}</label><select name="${group}.${key}">${options.map((o) => `<option value="${o.id}" ${s[group][key] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
  let intake = structuredClone(s.ai.intake_questions || []);

  const panels = {
    empresa: `
      <div class="field"><label>Nome da empresa</label><input name="name" value="${esc(data.name)}"></div>
      <h2 style="margin:8px 0 4px">Sobre a sua empresa</h2>
      <p class="hint" style="margin-bottom:10px">É com isso que a atendente responde os seus clientes no WhatsApp.${aiLocked() ? ' Pode preencher já: a IA passa a usar quando você assinar.' : ''}</p>
      <div class="field"><label>O que você faz, endereço, formas de pagamento, diferenciais e políticas</label><textarea name="ai.business_description" rows="6" placeholder="Ex.: Barbearia no centro de Campinas (Rua das Flores, 123). Corte, barba e sobrancelha. Aceitamos Pix e cartão em até 3x. Atendemos com hora marcada; tolerância de 10 minutos.">${esc(s.ai.business_description)}</textarea></div>
      <div class="field"><label>Como a atendente deve falar</label><textarea name="ai.instructions" rows="3" placeholder="Ex.: simpática e objetiva, mensagens curtas; nunca prometa desconto sem falar com a equipe.">${esc(s.ai.instructions)}</textarea></div>`,
    avancado: `
      <p class="muted" style="margin-bottom:14px">Ajustes que a maioria das empresas não precisa mexer.</p>
      <h2 style="margin:0 0 12px">Atendente virtual (IA)</h2>
      ${aiLocked() ? `<p class="hint" style="margin-bottom:12px">🔒 A IA faz parte dos planos pagos. <a href="#/assinar">Desbloquear</a></p>` : check('ai', 'enabled', 'IA responde automaticamente as mensagens do WhatsApp')}
      <div class="fields">${input('ai', 'agent_name', 'Nome da atendente', { hint: 'Como ela se apresenta aos clientes.' })}${input('ai', 'model', 'Modelo Claude', { placeholder: 'claude-opus-5-5', hint: 'Deixe vazio para usar o padrão.' })}</div>
      <div class="card" style="margin:6px 0 14px"><h3>Chave da IA (Anthropic) ${aiLocked() ? '<span class="badge">🔒 bloqueada no teste grátis</span>' : meta.ai_configured ? '<span class="badge green">conectada</span>' : '<span class="badge amber">sem chave</span>'}</h3>
        ${aiLocked() ? `<p class="hint">A IA faz parte dos planos pagos.</p>${lockBtn()}` : meta.ai_key_source === 'platform'
          ? '<p class="hint">A IA desta conta usa a chave do Falaki, configurada pela nossa equipe. Você não precisa fazer nada.</p>'
          : `<p class="hint">Crie sua chave em console.anthropic.com. O consumo da IA é cobrado pela Anthropic direto na sua conta. Sem chave, a IA usa respostas automáticas simples.</p>${input('integrations', 'anthropic_api_key', 'API key', { placeholder: 'sk-ant-...' })}`}</div>
      <div class="card" style="margin-bottom:14px"><h3>Google Maps (prospecção) ${meta.places_configured ? '<span class="badge green">conectada</span>' : ''}</h3>
        <p class="hint">Só se você usar a Prospecção com uma chave própria. Ative a "Places API (New)" no Google Cloud e crie uma chave de API.</p>${input('integrations', 'google_places_key', 'API key')}</div>
      <h2 style="margin:8px 0 12px">Região</h2>
      <div class="fields"><div class="field"><label>Fuso horário</label><input name="timezone" value="${esc(data.timezone)}"><div class="hint">Padrão: America/Sao_Paulo (horário de Brasília).</div></div></div>`,
    agenda: `
      <h2 style="margin-bottom:12px">Horário de funcionamento</h2>
      <p class="hint" style="margin-bottom:10px">Usado pela agenda, pela IA e para só enviar follow-ups e cobranças em horário comercial. Formato: <span class="code">09:00-12:00, 13:00-18:00</span> — vazio = fechado.</p>
      <div class="fields">${Object.keys(WD_LABEL).map((d) => `<div class="field"><label>${WD_LABEL[d]}</label><input data-hours="${d}" value="${s.business_hours[d].map((r) => r.join('-')).join(', ')}"></div>`).join('')}</div>
      <h2 style="margin:8px 0 12px">Agendamento</h2>
      <div class="fields">
        ${input('scheduling', 'slot_interval_min', 'Intervalo entre horários (min)', { type: 'number' })}
        ${input('scheduling', 'default_duration_min', 'Duração padrão (min)', { type: 'number' })}
        ${input('scheduling', 'min_notice_min', 'Antecedência mínima (min)', { type: 'number' })}
        ${input('scheduling', 'capacity', 'Atendimentos simultâneos', { type: 'number' })}
        ${input('scheduling', 'reminder_hours_before', 'Lembrete WhatsApp (horas antes, 0 = desligado)', { type: 'number' })}
        <div class="field"><label>Dias bloqueados (feriados)</label><input name="scheduling.blocked_dates" value="${esc(s.scheduling.blocked_dates.join(', '))}" placeholder="2026-12-25, 2027-01-01"></div>
      </div>`,
    whatsapp: `
      <div class="field"><label>Provedor</label><select name="whatsapp.provider">
        <option value="simulator">Simulador (testes, sem número)</option>
        <option value="evolution" ${s.whatsapp.provider === 'evolution' ? 'selected' : ''}>Evolution API (conecta por QR Code)</option>
        <option value="meta" ${s.whatsapp.provider === 'meta' ? 'selected' : ''}>WhatsApp Cloud API oficial (Meta)</option>
      </select></div>
      <div class="card" style="margin-bottom:14px"><h3>Evolution API</h3><p class="hint">Configure o webhook da instância (evento MESSAGES_UPSERT) para:</p>${hook(`${meta.webhooks.evolution}${s.whatsapp.evolution_webhook_secret ? '?token=SEU_TOKEN' : ''}`)}
        <div class="fields" style="margin-top:12px">${input('whatsapp', 'evolution_url', 'URL do servidor', { placeholder: 'https://evolution.seudominio.com' })}${input('whatsapp', 'evolution_instance', 'Nome da instância')}
        ${input('whatsapp', 'evolution_api_key', 'API key')}${input('whatsapp', 'evolution_webhook_secret', 'Token do webhook (opcional)', { hint: 'Se preenchido, adicione ?token=... na URL do webhook' })}</div></div>
      <div class="card"><h3>WhatsApp Cloud API (Meta)</h3><p class="hint">URL de callback do webhook (assine o campo "messages"):</p>${hook(meta.webhooks.meta)}
        <div class="fields" style="margin-top:12px">${input('whatsapp', 'meta_phone_number_id', 'Phone number ID')}${input('whatsapp', 'meta_token', 'Access token permanente')}
        ${input('whatsapp', 'meta_verify_token', 'Verify token (você escolhe)')}${input('whatsapp', 'meta_app_secret', 'App secret (valida a assinatura)')}
        ${input('whatsapp', 'meta_template_name', 'Template aprovado para iniciar conversa', { hint: 'Usado fora da janela de 24h (follow-up, prospecção). Deve ter 1 variável no corpo: o nome.' })}${input('whatsapp', 'meta_template_lang', 'Idioma do template')}</div></div>`,
    cobranca: `
      <div class="field"><label>Como receber</label><select name="billing.provider">
        <option value="pix_manual">Pix com minha chave (copia e cola, baixa manual)</option>
        <option value="asaas" ${s.billing.provider === 'asaas' ? 'selected' : ''}>Asaas (Pix, boleto e cartão com baixa automática)</option>
        <option value="mercadopago" ${s.billing.provider === 'mercadopago' ? 'selected' : ''}>Mercado Pago (link de pagamento com baixa automática)</option>
      </select></div>
      <div class="card" style="margin-bottom:14px"><h3>Pix próprio</h3><div class="fields">${input('billing', 'pix_key', 'Chave Pix')}${input('billing', 'pix_name', 'Nome do recebedor')}${input('billing', 'pix_city', 'Cidade')}</div></div>
      <div class="card" style="margin-bottom:14px"><h3>Asaas</h3><p class="hint">Webhook de cobranças:</p>${hook(meta.webhooks.asaas)}
        <div class="fields" style="margin-top:12px">${input('billing', 'asaas_api_key', 'API key')}${input('billing', 'asaas_webhook_token', 'Token de autenticação do webhook')}</div>${check('billing', 'asaas_sandbox', 'Usar sandbox (testes)')}</div>
      <div class="card" style="margin-bottom:14px"><h3>Mercado Pago</h3><p class="hint">A URL de notificação é enviada automaticamente em cada cobrança:</p>${hook(meta.webhooks.mercadopago)}
        <div style="margin-top:12px">${input('billing', 'mercadopago_token', 'Access token')}</div></div>
      <h2 style="margin:8px 0 12px">Régua de cobrança</h2>
      <div class="fields">
        <div class="field"><label>Lembrar antes do vencimento (dias)</label><input name="billing.reminder_days_before" value="${s.billing.reminder_days_before.join(', ')}"><div class="hint">0 = no dia do vencimento</div></div>
        <div class="field"><label>Cobrar depois do vencimento (dias)</label><input name="billing.reminder_days_after" value="${s.billing.reminder_days_after.join(', ')}"></div>
      </div>
      ${check('billing', 'auto_win_on_payment', 'Mover lead para "Ganho" quando o pagamento for confirmado')}`,
    ia: `
      ${aiLocked() ? lockCard('O comportamento da IA') : ''}
      <p class="muted" style="margin-bottom:14px">Defina o que a IA deve conseguir em cada conversa e o que ela pode fazer sozinha. O que ela não puder concluir vira uma <a href="#/tarefas">tarefa para a equipe</a>, com prazo.</p>
      <div class="fields">
        ${select('ai', 'objective', 'Objetivo principal da conversa', bo.objectives)}
        ${select('ai', 'scheduling_mode', 'Agenda', bo.scheduling_modes)}
        ${select('ai', 'price_mode', 'Preços', bo.price_modes)}
        ${select('ai', 'charge_mode', 'Cobrança', bo.charge_modes)}
      </div>
      ${input('ai', 'external_booking_link', 'Link de agendamento externo (modo "Link externo")', { placeholder: 'https://calendly.com/seu-escritorio', hint: 'Sem link cadastrado, a IA usa o modo "Sem agenda" e a equipe retorna com os horários.' })}
      <h2 style="margin:8px 0 6px">Perguntas de triagem</h2>
      <p class="hint" style="margin-bottom:10px">A IA faz estas perguntas ao longo da conversa, uma por vez, e salva cada resposta na ficha do cliente.</p>
      <div id="intake"></div>
      <button type="button" class="sm" id="add-intake">+ Adicionar pergunta</button>
      <div class="fields" style="margin-top:16px">
        <div class="field"><label>Situações urgentes (a IA chama a equipe na hora)</label><textarea name="ai.urgency_rules" rows="4" placeholder="Ex.: audiência marcada para os próximos dias; cliente preso; dor forte ou sangramento">${esc(s.ai.urgency_rules)}</textarea></div>
        <div class="field"><label>A IA nunca deve…</label><textarea name="ai.never_say" rows="4" placeholder="Ex.: dar parecer jurídico ou diagnóstico; prometer resultado; falar de prazos processuais">${esc(s.ai.never_say)}</textarea></div>
      </div>
      <h2 style="margin:8px 0 12px">Tarefas e avisos para a equipe</h2>
      <div class="fields">
        ${input('team', 'notify_phone', 'WhatsApp da equipe para avisos', { placeholder: '(11) 99999-9999', hint: 'Recebe aviso de tarefa nova, urgência e atraso.' })}
        ${input('team', 'task_sla_hours', 'Prazo para a equipe responder (horas úteis)', { type: 'number' })}
      </div>
      ${check('team', 'notify_on_new_task', 'Avisar a equipe a cada tarefa nova (urgências são sempre avisadas)')}
      ${check('team', 'client_message_on_overdue', 'Se o prazo passar sem resposta, avisar o cliente que ainda estamos verificando')}
      ${check('team', 'auto_assign', 'Distribuir automaticamente entre os atendentes as conversas que precisam de humano (rodízio)')}
      <p class="hint">Vale para conversas sem IA e para as que a IA passa para a equipe. Sem atendentes cadastrados, vão para o dono. Cada um pode assumir ou passar a conversa no Atendimento.</p>`,
  };

  if (tab === 'profissionais') return renderProfessionals(el, tabs);
  if (tab === 'usuarios') return renderUsers(el, tabs);
  el.innerHTML = `
    <div class="page-head"><div><h1>Configurações</h1><p class="muted">Personalize o sistema para o seu negócio</p></div></div>
    <div class="card">
      <div class="tabs">${tabs.map(([k, v]) => `<button class="${k === tab ? 'active' : ''}" data-tab="${k}">${v}</button>`).join('')}</div>
      <form id="settings-form">${panels[tab]}<div class="modal-foot"><button class="primary">Salvar configurações</button></div></form>
    </div>`;
  $$('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/config/${b.dataset.tab}`; }; });
  const renderIntake = () => {
    const box = $('#intake');
    if (!box) return;
    box.innerHTML = intake.map((q, i) => `<div class="row" style="margin-bottom:8px;align-items:flex-start">
      <input data-iq="${i}" data-k="label" value="${esc(q.label)}" placeholder="Campo (ex.: Área do caso)" style="max-width:220px">
      <input data-iq="${i}" data-k="question" value="${esc(q.question)}" placeholder="Pergunta (ex.: Seu caso é trabalhista, de família ou outro?)">
      <button type="button" class="sm ghost danger" data-rmq="${i}">✕</button></div>`).join('') || '<p class="small muted">Nenhuma pergunta. Ex.: "Área do caso", "Queixa principal", "Bairro".</p>';
    $$('[data-iq]', box).forEach((el) => { el.oninput = () => { intake[el.dataset.iq][el.dataset.k] = el.value; }; });
    $$('[data-rmq]', box).forEach((b) => { b.onclick = () => { intake.splice(Number(b.dataset.rmq), 1); renderIntake(); }; });
  };
  renderIntake();
  const addIntake = $('#add-intake');
  if (addIntake) addIntake.onclick = () => { intake.push({ label: '', question: '' }); renderIntake(); };
  $('#settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = { settings: {} };
    for (const elx of e.target.elements) {
      if (!elx.name && !elx.dataset.hours) continue;
      if (elx.dataset.hours) {
        body.settings.business_hours ||= {};
        body.settings.business_hours[elx.dataset.hours] = elx.value.split(',').map((r) => r.trim()).filter(Boolean).map((r) => r.split('-').map((t) => t.trim().padStart(5, '0')));
        continue;
      }
      if (!elx.name.includes('.')) { body[elx.name] = elx.value; continue; }
      const [g, k] = elx.name.split('.');
      let v = elx.type === 'checkbox' ? elx.checked : elx.value;
      if (elx.type === 'number') v = Number(v);
      if (['reminder_days_before', 'reminder_days_after'].includes(k)) v = v.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
      if (k === 'blocked_dates') v = v.split(',').map((x) => x.trim()).filter(Boolean);
      (body.settings[g] ||= {})[k] = v;
    }
    if (tab === 'ia') {
      const slug = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      body.settings.ai.intake_questions = intake.filter((q) => q.label.trim() && q.question.trim())
        .map((q) => ({ key: q.key || slug(q.label), label: q.label.trim(), question: q.question.trim() }));
    }
    try {
      await api('/api/settings', { method: 'PUT', body });
      state.me = await api('/api/auth/me');
      state.meta = await api('/api/meta');
      toast('Configurações salvas');
      route();
    } catch (err) { fail(err); }
  };
}

async function renderUsers(el, tabs) {
  const [{ users, roles, max_users: maxUsers }, pros] = await Promise.all([api('/api/users'), api('/api/professionals')]);
  const roleLabel = (id) => roles.find((r) => r.id === id)?.label || id;
  const activeCount = users.filter((u) => u.active).length;
  const plan = state.meta.plan;
  el.innerHTML = `
    <div class="page-head"><div><h1>Configurações</h1><p class="muted">Personalize o sistema para o seu negócio</p></div></div>
    <div class="card">
      <div class="tabs">${tabs.map(([k, v]) => `<button class="${k === 'usuarios' ? 'active' : ''}" data-tab="${k}">${v}</button>`).join('')}</div>
      <div class="row wrap" style="margin-bottom:12px">
        <p class="muted" style="margin:0">Plano <strong>${esc(plan?.label || '')}</strong>: ${activeCount} de ${maxUsers} usuários ativos${plan?.max_leads ? ` · ${plan.leads_used} de ${plan.max_leads} leads` : ' · leads ilimitados'}.</p>
        <span class="spacer"></span><button class="primary" id="new-user" ${activeCount >= maxUsers ? 'disabled title="Limite de usuários do plano atingido"' : ''}>+ Novo usuário</button>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Nome</th><th>Perfil</th><th>Último acesso</th><th>Situação</th></tr>
        ${users.map((u) => `<tr class="clickable" data-id="${u.id}"><td><strong>${esc(u.name)}</strong><div class="small muted">${esc(u.email)}</div></td>
          <td>${esc(roleLabel(u.role))}${u.professional_id ? `<div class="small muted">${esc(pros.find((p) => p.id === u.professional_id)?.name || '')}</div>` : ''}</td>
          <td class="small">${u.last_login_at ? fmt(u.last_login_at) : 'nunca'}</td>
          <td><span class="badge ${u.active ? 'green' : ''}">${u.active ? 'ativo' : 'desativado'}</span></td></tr>`).join('')}
      </table></div>
    </div>`;
  $$('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/config/${b.dataset.tab}`; }; });
  const open = (u) => {
    const x = u || { name: '', email: '', role: 'agent', active: 1, professional_id: null };
    const box = openModal(`${modalHead(u ? 'Editar usuário' : 'Novo usuário')}
      <form id="user-form">
        <div class="fields">
          <div class="field"><label for="uf-name">Nome</label><input id="uf-name" name="name" value="${esc(x.name)}" required></div>
          <div class="field"><label for="uf-email">E-mail de acesso</label><input id="uf-email" name="email" type="email" value="${esc(x.email)}" required></div>
          <div class="field"><label for="uf-role">Perfil</label><select id="uf-role" name="role">${roles.map((r) => `<option value="${r.id}" ${r.id === x.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
          <div class="field" id="uf-pro"><label for="uf-pro-s">Profissional na agenda</label><select id="uf-pro-s" name="professional_id"><option value="">—</option>${pros.filter((p) => p.active).map((p) => `<option value="${p.id}" ${p.id === x.professional_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><div class="hint">O usuário vê só a agenda e os clientes deste profissional.</div></div>
          <div class="field"><label for="uf-pass">${u ? 'Nova senha (vazio = manter)' : 'Senha inicial (mín. 8)'}</label><input id="uf-pass" name="password" type="text" minlength="8" ${u ? '' : 'required'}></div>
        </div>
        ${u ? `<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Acesso ativo</label>` : ''}
        <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
      </form>`);
    const form = $('#user-form', box);
    const toggle = () => $('#uf-pro', box).classList.toggle('hidden', form.role.value !== 'professional');
    form.role.onchange = toggle;
    toggle();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(form);
      if (!body.password) delete body.password;
      try {
        await api(u ? `/api/users/${u.id}` : '/api/users', { method: u ? 'PUT' : 'POST', body });
        box.close(); toast('Usuário salvo'); route();
      } catch (err) { fail(err); }
    };
  };
  $('#new-user').onclick = () => open(null);
  $$('tr[data-id]').forEach((tr) => { tr.onclick = () => open(users.find((u) => String(u.id) === tr.dataset.id)); });
}

const PRO_COLORS = ['#1f7a45', '#2563eb', '#7c3aed', '#b7791f', '#c0392b', '#0e7490', '#be185d'];

async function renderProfessionals(el, tabs) {
  const [pros, products, { settings }] = await Promise.all([api('/api/professionals'), api('/api/products'), api('/api/settings')]);
  const services = products.filter((p) => p.kind === 'servico');
  const serviceName = (id) => services.find((p) => p.id === id)?.name;
  const hoursText = (h) => Object.entries(h).filter(([, r]) => r.length).map(([d, r]) => `${d} ${r.map((x) => x.join('-')).join(', ')}`).join(' · ') || 'sem horários';
  el.innerHTML = `
    <div class="page-head"><div><h1>Configurações</h1><p class="muted">Personalize o sistema para o seu negócio</p></div></div>
    <div class="card">
      <div class="tabs">${tabs.map(([k, v]) => `<button class="${k === 'profissionais' ? 'active' : ''}" data-tab="${k}">${v}</button>`).join('')}</div>
      <div class="row" style="margin-bottom:12px"><p class="muted" style="margin:0">Cada profissional tem seus horários e os serviços que atende. A IA marca com quem estiver livre para aquele serviço. Sem profissionais cadastrados, a agenda é única para a empresa.</p><span class="spacer"></span><button class="primary" id="new-pro">+ Novo profissional</button></div>
      <div class="table-wrap"><table>
        <tr><th>Profissional</th><th>Atende</th><th>Horários</th><th>WhatsApp</th><th></th></tr>
        ${pros.map((p) => `<tr class="clickable" data-id="${p.id}">
          <td><span class="row" style="gap:8px"><span style="width:12px;height:12px;border-radius:4px;background:${esc(p.color)}"></span><span><strong>${esc(p.name)}</strong><div class="small muted">${esc(p.role)}</div></span></span></td>
          <td class="small">${p.services.length ? p.services.map(serviceName).filter(Boolean).map(esc).join(', ') : 'Todos os serviços'}</td>
          <td class="small">${p.business_hours ? esc(hoursText(p.business_hours)) : 'Horário da empresa'}${p.blocked_dates.length ? `<div class="muted">folgas: ${p.blocked_dates.map(fmtDay).join(', ')}</div>` : ''}</td>
          <td class="small nowrap">${p.phone ? phoneFmt(p.phone) : '-'}</td>
          <td><span class="badge ${p.active ? 'green' : ''}">${p.active ? 'ativo' : 'inativo'}</span></td></tr>`).join('')}
      </table>${pros.length ? '' : '<div class="empty">Nenhum profissional. A agenda funciona como uma agenda única da empresa.</div>'}</div>
    </div>`;
  $$('[data-tab]').forEach((b) => { b.onclick = () => { location.hash = `#/config/${b.dataset.tab}`; }; });
  const open = (p) => {
    const x = p || { name: '', role: '', phone: '', color: PRO_COLORS[pros.length % PRO_COLORS.length], services: [], business_hours: null, blocked_dates: [], active: 1 };
    const hours = x.business_hours || settings.business_hours;
    const box = openModal(`${modalHead(p ? 'Editar profissional' : 'Novo profissional')}
      <form id="pro-form">
        <div class="fields">
          <div class="field"><label>Nome</label><input name="name" value="${esc(x.name)}" required placeholder="Dra. Ana Martins"></div>
          <div class="field"><label>Especialidade / função</label><input name="role" value="${esc(x.role)}" placeholder="Advogada trabalhista"></div>
          <div class="field"><label>WhatsApp (recebe avisos de agendamento)</label><input name="phone" value="${esc(x.phone ? phoneFmt(x.phone) : '')}"></div>
          <div class="field"><label>Cor na agenda</label><div class="row">${PRO_COLORS.map((c) => `<label style="margin:0"><input type="radio" name="color" value="${c}" ${c === x.color ? 'checked' : ''} style="width:auto"> <span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${c};vertical-align:middle"></span></label>`).join('')}</div></div>
        </div>
        <div class="field"><label>Serviços que atende (nenhum marcado = todos)</label>
          <div class="row wrap">${services.map((sv) => `<label class="check" style="margin:0 12px 6px 0"><input type="checkbox" data-sv="${sv.id}" ${x.services.includes(sv.id) ? 'checked' : ''}> ${esc(sv.name)}</label>`).join('') || '<span class="small muted">Cadastre serviços em Produtos.</span>'}</div></div>
        <label class="check field"><input type="checkbox" id="own-hours" ${x.business_hours ? 'checked' : ''}> Tem horário próprio (senão, usa o horário da empresa)</label>
        <div id="pro-hours" class="fields ${x.business_hours ? '' : 'hidden'}">${Object.keys(WD_LABEL).map((d) => `<div class="field"><label>${WD_LABEL[d]}</label><input data-ph="${d}" value="${hours[d].map((r) => r.join('-')).join(', ')}" placeholder="fechado"></div>`).join('')}</div>
        <div class="field"><label>Folgas / ausências (datas)</label><input name="blocked" value="${x.blocked_dates.join(', ')}" placeholder="2026-11-02, 2026-11-20"></div>
        <label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}> Ativo</label>
        <div class="modal-foot">${p ? '<button type="button" class="danger" id="del-pro">Excluir</button><span class="spacer"></span>' : ''}<button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
      </form>`);
    const form = $('#pro-form', box);
    $('#own-hours', box).onchange = (e) => $('#pro-hours', box).classList.toggle('hidden', !e.target.checked);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const own = $('#own-hours', box).checked;
      const body = {
        name: form.name.value, role: form.role.value, phone: form.phone.value,
        color: form.querySelector('input[name=color]:checked')?.value,
        services: $$('[data-sv]', box).filter((c) => c.checked).map((c) => Number(c.dataset.sv)),
        business_hours: own ? Object.fromEntries($$('[data-ph]', box).map((i) => [i.dataset.ph, i.value.split(',').map((r) => r.trim()).filter(Boolean).map((r) => r.split('-').map((t) => t.trim().padStart(5, '0')))])) : null,
        blocked_dates: form.blocked.value.split(',').map((d) => d.trim()).filter(Boolean),
        active: form.active.checked,
      };
      try {
        await api(p ? `/api/professionals/${p.id}` : '/api/professionals', { method: p ? 'PUT' : 'POST', body });
        box.close(); toast('Profissional salvo'); route();
      } catch (err) { fail(err); }
    };
    const del = $('#del-pro', box);
    if (del) del.onclick = async () => { if (!confirm(`Excluir ${p.name}? Os agendamentos dele ficam sem profissional.`)) return; await api(`/api/professionals/${p.id}`, { method: 'DELETE' }).catch(fail); box.close(); route(); };
  };
  $('#new-pro').onclick = () => open(null);
  $$('tr[data-id]').forEach((tr) => { tr.onclick = () => open(pros.find((p) => String(p.id) === tr.dataset.id)); });
}

window.falaki = { boot }; // usado pela demonstração para trocar de empresa
boot();
