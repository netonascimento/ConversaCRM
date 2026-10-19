// Fechou — painel web (SPA sem dependências)
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
  produtos: '<path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7L12 12l8.7-5M12 22V12"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const STAGE_COLORS = { novo: 'blue', contato: 'purple', qualificado: 'amber', proposta: 'amber', ganho: 'green', perdido: 'red' };
const stageLabel = (id) => state.meta?.stages.find((s) => s.id === id)?.label || id;
const stageBadge = (id) => `<span class="badge ${STAGE_COLORS[id] || ''}">${esc(stageLabel(id))}</span>`;
const SOURCE_LABEL = { whatsapp: 'WhatsApp', manual: 'Manual', google_maps: 'Google Maps', site: 'Site', indicacao: 'Indicação', importacao: 'Importação' };
const CHARGE_BADGE = { pendente: 'amber', pago: 'green', vencido: 'red', cancelado: '' };
const AUTHOR_LABEL = { ai: '🤖 IA', human: '👤 Equipe', followup: '🔁 Follow-up', billing: '💰 Cobrança', system: '⏰ Lembrete', contact: '' };

// ---------------------------------------------------------------------------
// Autenticação
// ---------------------------------------------------------------------------
async function renderAuth(mode = 'login') {
  clearTimers();
  closeAllModals();
  const cfg = await fetch('/api/auth/config').then((r) => r.json()).catch(() => ({ allow_signup: false, segments: [] }));
  if (!cfg.allow_signup) mode = 'login';
  $('#app').innerHTML = `
    <div class="auth"><div>
      <div class="card">
        <div class="brand" style="color:var(--green-dark);padding:0 0 12px"><div class="brand-logo">${icon('agenda').replace('currentColor', '#fff')}</div>Fechou</div>
        <h1>${mode === 'login' ? 'Entrar' : 'Teste grátis'}</h1>
        <p class="muted">${mode === 'login' ? 'Prospecte, atenda, venda e cobre num só lugar.' : 'Crie a conta da sua empresa: 1 usuário e até 10 leads, sem cartão.'}</p>
        <form id="auth-form" class="stack" style="margin-top:16px">
          ${mode === 'register' ? `
            <div><label for="r-company">Nome da empresa</label><input id="r-company" name="companyName" required></div>
            <div><label for="r-segment">Tipo de negócio</label><select id="r-segment" name="segment">${(cfg.segments || []).map((sg) => `<option value="${sg.id}">${esc(sg.label)}</option>`).join('')}</select><div class="hint">Já deixa a IA configurada para o seu segmento. Dá para ajustar depois.</div></div>
            <div><label for="r-name">Seu nome</label><input id="r-name" name="name" required></div>` : ''}
          <div><label for="r-email">E-mail</label><input id="r-email" name="email" type="email" required autocomplete="username"></div>
          <div><label for="r-pass">Senha</label><input id="r-pass" name="password" type="password" required minlength="${mode === 'login' ? 1 : 8}" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">${mode === 'register' ? '<div class="hint">Mínimo de 8 caracteres.</div>' : ''}</div>
          <button class="primary" style="width:100%;justify-content:center">${mode === 'login' ? 'Entrar' : 'Criar conta grátis'}</button>
        </form>
        <p class="small muted" style="margin-top:14px;text-align:center">
          ${mode === 'login' ? (cfg.allow_signup ? 'Ainda não usa? <a href="#cadastro" data-mode="register">Teste grátis</a>' : '') : 'Já tem conta? <a href="#" data-mode="login">Entrar</a>'}
        </p>
        <p class="small muted" style="text-align:center"><a href="/">Conheça o Fechou</a></p>
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
  agent: ['dashboard', 'inbox', 'tarefas', 'crm', 'agenda', 'followup', 'prospeccao', 'produtos'],
  professional: ['dashboard', 'inbox', 'tarefas', 'crm', 'agenda'],
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
    <div class="mobile-top"><button id="menu-btn" aria-label="Abrir menu">☰</button><strong>Fechou</strong></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><div class="brand-logo">${icon('agenda')}</div>Fechou</div>
        <nav class="nav">${allowedPages().map(([id, label]) => `<a href="#/${id}" data-page="${id}">${icon(id)}<span>${label}</span>${id === 'inbox' ? '<span class="badge count hidden" id="unread-badge"></span>' : id === 'tarefas' ? '<span class="badge count hidden" id="tasks-badge"></span>' : ''}</a>`).join('')}</nav>
        <div class="sidebar-foot">
          <div><strong style="color:#fff">${esc(state.me.company.name)}</strong></div>
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
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); renderAuth(); };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
}

function planBanner() {
  const plan = state.meta?.plan;
  if (!plan || plan.max_leads === null || plan.max_leads === undefined || !isOwner()) return '';
  const left = plan.leads_remaining;
  const contact = state.meta.sales_whatsapp ? ` <a href="https://wa.me/${esc(state.meta.sales_whatsapp)}?text=${encodeURIComponent(`Olá! Quero mudar de plano no Fechou (${state.me.company.name}).`)}" target="_blank" rel="noopener">Mudar de plano</a>` : '';
  if (left === 0) return `<div class="banner">Você usou os ${plan.max_leads} leads do plano ${esc(plan.label)}. Novos contatos não entram no CRM até você mudar de plano.${contact}</div>`;
  return `<div class="banner">Plano ${esc(plan.label)}: ${plan.leads_used} de ${plan.max_leads} leads usados.${contact}</div>`;
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
  const def = pages.find((p) => p[0] === page) || pages[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === def[0]));
  $('#sidebar')?.classList.remove('open');
  const el = $('#page');
  el.innerHTML = '<div class="empty">Carregando…</div>';
  try { await def[2](el, rest); } catch (err) { el.innerHTML = `<div class="empty">Erro: ${esc(err.message)}</div>`; }
  every(10000, refreshUnread);
  refreshUnread();
}

async function boot() {
  try {
    state.me = await api('/api/auth/me');
  } catch {
    // O botão "Teste grátis" da página inicial chega em /app#cadastro.
    return renderAuth(location.hash === '#cadastro' ? 'register' : 'login');
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

async function renderDashboard(el) {
  const days = Number(sessionStorage.getItem('dash-days') || 30);
  const d = await api(`/api/dashboard?days=${days}`);
  const m = d.metrics;
  const fin = !d.financial_hidden;
  const maxStage = Math.max(1, ...Object.values(m.stages));
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard de gestão</h1><p class="muted">Visão geral de vendas, atendimento e financeiro</p></div>
      <span class="spacer"></span>
      <select id="days" style="width:auto">${[7, 30, 90, 365].map((n) => `<option value="${n}" ${n === days ? 'selected' : ''}>Últimos ${n} dias</option>`).join('')}</select>
    </div>
    ${!state.meta.ai_configured ? '<div class="banner">A IA está em <strong>modo demonstração</strong> (respostas automáticas simples). Adicione sua chave da API Anthropic em <a href="#/config">Configurações → Integrações</a> para ativar o atendimento inteligente.</div>' : ''}
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
      <div class="card-head"><h2>Insights</h2><span class="spacer"></span><button class="sm" id="insights">Gerar recomendações ${state.meta.ai_configured ? 'com IA' : ''}</button></div>
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
  $('#insights').onclick = async (e) => {
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
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Atendimento</h1><p class="muted">Conversas do WhatsApp com resposta automática da IA</p></div>
      <span class="spacer"></span>
      <span class="badge ${provider === 'simulator' ? 'amber' : 'green'}">WhatsApp: ${provider === 'simulator' ? 'simulador' : provider === 'meta' ? 'Cloud API (Meta)' : 'Evolution API'}</span>
      <button id="simulate">Simular cliente</button>
    </div>
    <div class="card inbox ${selected ? 'has-chat' : ''}" id="inbox">
      <div class="conv-list"><div class="conv-search"><input id="conv-q" placeholder="Buscar conversa…"></div><div id="convs"></div></div>
      <div class="chat" id="chat"><div class="empty">Selecione uma conversa</div></div>
    </div>`;
  let lastId = 0;
  let current = selected ? Number(selected) : null;

  async function loadConvs() {
    const q = $('#conv-q')?.value || '';
    const convs = await api(`/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const box = $('#convs');
    if (!box) return;
    box.innerHTML = convs.map((c) => `
      <div class="conv ${c.id === current ? 'active' : ''}" data-id="${c.id}">
        <div class="avatar">${esc(initials(c.name || c.phone))}</div>
        <div class="body">
          <div class="row"><strong>${esc(c.name || phoneFmt(c.phone))}</strong><span class="spacer"></span><span class="small muted">${ago(c.last_at)}</span></div>
          <div class="row"><span class="preview">${c.last_direction === 'out' ? (c.last_author === 'ai' ? '🤖 ' : '✓ ') : ''}${esc(c.last_body)}</span>
            ${c.unread && c.id !== current ? '<span class="badge count">•</span>' : ''}${!c.ai_enabled ? '<span class="badge amber">humano</span>' : ''}</div>
        </div>
      </div>`).join('') || '<div class="empty">Nenhuma conversa ainda.<br>Use "Simular cliente" para testar.</div>';
    $$('.conv', box).forEach((c) => { c.onclick = () => { location.hash = `#/inbox/${c.dataset.id}`; }; });
  }

  function bubble(m) {
    return `<div class="bubble ${m.direction} ${m.status === 'failed' ? 'failed' : ''}">${esc(m.body)}
      <div class="meta">${m.direction === 'out' ? `${AUTHOR_LABEL[m.author] || ''} · ` : ''}${fmt(m.created_at, { hour: '2-digit', minute: '2-digit' })}${m.status === 'failed' ? ` · ❌ ${esc(m.error || 'falhou')}` : ''}</div></div>`;
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
        <label class="check" title="Quando ligada, a IA responde automaticamente"><input type="checkbox" id="ai-toggle" ${contact.ai_enabled ? 'checked' : ''}> IA respondendo</label>
        <button class="sm" id="ai-now">🤖 Responder com IA</button>
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
    $('#ai-toggle').onchange = async (e) => {
      await api(`/api/conversations/${id}/ai`, { method: 'POST', body: { enabled: e.target.checked } }).catch(fail);
      toast(e.target.checked ? 'IA ativada nesta conversa' : 'Você assumiu a conversa');
    };
    $('#ai-now').onclick = async (e) => {
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
        $('#ai-toggle').checked = false;
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
      toast('Mensagem recebida! A IA vai responder em instantes.');
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

function contactForm(contact, onSaved) {
  const c = contact || {};
  const box = openModal(`${modalHead(contact ? 'Editar contato' : 'Novo lead')}
    <form id="contact-form">
      <div class="fields">
        <div class="field"><label>Nome</label><input name="name" value="${esc(c.name)}"></div>
        <div class="field"><label>WhatsApp / telefone</label><input name="phone" value="${esc(c.phone ? phoneFmt(c.phone) : '')}" placeholder="(11) 99999-9999"></div>
        <div class="field"><label>E-mail</label><input name="email" type="email" value="${esc(c.email)}"></div>
        <div class="field"><label>CPF / CNPJ</label><input name="document" value="${esc(c.document)}"></div>
        <div class="field"><label>Empresa do cliente</label><input name="business_name" value="${esc(c.business_name)}"></div>
        <div class="field"><label>Valor estimado (R$)</label><input name="value" value="${c.value_cents ? reais(c.value_cents) : ''}" inputmode="decimal"></div>
        <div class="field"><label>Etapa</label><select name="stage">${state.meta.stages.map((s) => `<option value="${s.id}" ${s.id === (c.stage || 'novo') ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
        <div class="field"><label>Origem</label><select name="source">${Object.entries(SOURCE_LABEL).map(([k, v]) => `<option value="${k}" ${k === (c.source || 'manual') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Interesse</label><input name="interest" value="${esc(c.interest)}"></div>
      <div class="field"><label>Tags (separadas por vírgula)</label><input name="tags" value="${esc(c.tags)}"></div>
      <div class="field"><label>Observações</label><textarea name="notes">${esc(c.notes)}</textarea></div>
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
        </table>
        ${c.notes ? `<p class="small" style="white-space:pre-wrap">${esc(c.notes)}</p>` : ''}
        ${Object.keys(triagem).length ? `<h3 style="margin-top:12px">Triagem</h3><table class="small">${Object.entries(triagem).map(([k, v]) => `<tr><td class="muted">${esc(intakeLabel(k))}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
      </div>
      <div class="card"><h3>Agendamentos</h3>
        ${c.appointments.map((a) => `<div class="small" style="padding:4px 0">${fmt(a.start_at)} — ${esc(a.title)}${a.professional_name ? ` · ${esc(a.professional_name)}` : ''} <span class="badge">${a.status}</span></div>`).join('') || '<p class="small muted">Nenhum.</p>'}
        <h3 style="margin-top:12px">Cobranças</h3>
        ${c.charges.map((ch) => `<div class="small" style="padding:4px 0">${esc(ch.description)} — ${money(ch.amount_cents)} <span class="badge ${CHARGE_BADGE[ch.status]}">${ch.status}</span></div>`).join('') || '<p class="small muted">Nenhuma.</p>'}
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
    <p class="muted" style="margin-top:0">Conecte uma vez e pronto: cada agendamento feito no Fechou (pela equipe ou pela IA) aparece sozinho no Google Agenda, e o que for marcado direto no Google bloqueia o horário aqui. Ninguém precisa cadastrar nada duas vezes.</p>
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
    ${a.google_event_id ? '<p class="small muted">✓ Sincronizado com o Google Agenda</p>' : a.google_sync === 'erro' ? '<p class="small" style="color:var(--danger)">Não foi possível enviar ao Google Agenda; o Fechou tenta de novo automaticamente.</p>' : ''}
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
        <label class="check small"><input type="checkbox" data-i="${i}" data-k="use_ai" ${st.use_ai ? 'checked' : ''}> Personalizar com IA</label>
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
      <div class="card kpi bad"><div class="label">Vencido</div><div class="value">${money(sum('vencido'))}</div></div>
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
    ${!state.meta.places_configured ? '<div class="banner">Configure a chave da <strong>Google Places API</strong> em <a href="#/config">Configurações → Integrações</a> para buscar empresas.</div>' : ''}
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
  const data = await api('/api/settings');
  const s = data.settings;
  const meta = state.meta = await api('/api/meta');
  const tabs = [['empresa', 'Empresa & IA'], ['ia', 'Comportamento da IA'], ['profissionais', 'Profissionais'], ['usuarios', 'Usuários'], ['agenda', 'Horários & Agenda'], ['whatsapp', 'WhatsApp'], ['cobranca', 'Cobrança'], ['integracoes', 'Integrações']];
  const input = (group, key, label, { type = 'text', hint = '', placeholder = '' } = {}) => `<div class="field"><label>${label}</label>
    <input name="${group}.${key}" type="${type}" value="${esc(s[group][key])}" placeholder="${esc(placeholder)}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const check = (group, key, label) => `<label class="check field"><input type="checkbox" name="${group}.${key}" ${s[group][key] ? 'checked' : ''}> ${label}</label>`;
  const hook = (url) => `<div class="code">${esc(url)}</div>`;
  const bo = meta.behavior_options;
  const select = (group, key, label, options) => `<div class="field"><label>${label}</label><select name="${group}.${key}">${options.map((o) => `<option value="${o.id}" ${s[group][key] === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></div>`;
  let intake = structuredClone(s.ai.intake_questions || []);

  const panels = {
    empresa: `
      <div class="fields">
        <div class="field"><label>Nome da empresa</label><input name="name" value="${esc(data.name)}"></div>
        <div class="field"><label>Fuso horário</label><input name="timezone" value="${esc(data.timezone)}"></div>
      </div>
      <h2 style="margin:8px 0 12px">Atendente virtual (IA)</h2>
      ${check('ai', 'enabled', 'IA responde automaticamente as mensagens do WhatsApp')}
      <div class="fields">${input('ai', 'agent_name', 'Nome da atendente')}${input('ai', 'model', 'Modelo Claude (opcional)', { placeholder: 'claude-opus-5-5' })}</div>
      <div class="field"><label>Sobre a empresa (endereço, formas de pagamento, diferenciais, políticas)</label><textarea name="ai.business_description" rows="5">${esc(s.ai.business_description)}</textarea></div>
      <div class="field"><label>Instruções para a IA (tom de voz, regras de negócio, o que pode ou não prometer)</label><textarea name="ai.instructions" rows="4">${esc(s.ai.instructions)}</textarea></div>`,
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
      ${check('team', 'client_message_on_overdue', 'Se o prazo passar sem resposta, avisar o cliente que ainda estamos verificando')}`,
    integracoes: `
      <div class="card" style="margin-bottom:14px"><h3>Claude (Anthropic) — IA de atendimento ${meta.ai_configured ? '<span class="badge green">conectada</span>' : '<span class="badge amber">modo demonstração</span>'}</h3>
        <p class="hint">Crie sua chave em console.anthropic.com. Sem chave, a IA usa respostas automáticas simples.</p>${input('integrations', 'anthropic_api_key', 'API key', { placeholder: 'sk-ant-...' })}</div>
      <div class="card"><h3>Google Places API — prospecção ${meta.places_configured ? '<span class="badge green">conectada</span>' : ''}</h3>
        <p class="hint">Ative a "Places API (New)" no Google Cloud e crie uma chave de API.</p>${input('integrations', 'google_places_key', 'API key')}</div>`,
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

window.fechou = { boot }; // usado pela demonstração para trocar de empresa
boot();
