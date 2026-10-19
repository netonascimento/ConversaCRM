// Fechou — painel do administrador da plataforma (cadastro de empresas, usuários e planos)

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const fmt = (iso) => (iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—');

const state = { me: null };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/admin/login') { renderLogin(); throw new Error(data.error || 'Sessão expirada'); }
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
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function openModal(html, { wide = false, drawer = false } = {}) {
  const overlay = document.createElement('div');
  overlay.className = `overlay${drawer ? ' drawer-overlay' : ''}`;
  overlay.innerHTML = `<div class="${drawer ? 'drawer' : `modal${wide ? ' wide' : ''}`}" role="dialog" aria-modal="true">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) overlay.remove(); });
  $('#modal-root').appendChild(overlay);
  const box = overlay.firstElementChild;
  box.close = () => overlay.remove();
  return box;
}
const modalHead = (title) => `<div class="modal-head"><h2>${esc(title)}</h2><span class="spacer"></span><button class="ghost" data-close aria-label="Fechar">✕</button></div>`;

const STATUS_BADGE = (s) => `<span class="badge ${s === 'ativa' ? 'green' : 'red'}">${s === 'ativa' ? 'ativa' : 'suspensa'}</span>`;
const STORAGE_BADGE = (s) => (s === 'dedicated' ? '<span class="badge purple">banco separado</span>' : '<span class="badge">compartilhado</span>');
const planLabel = (id) => state.me?.plans.find((p) => p.id === id)?.label || id || 'Personalizado';
const roleLabel = (id) => state.me?.roles.find((r) => r.id === id)?.label.split(' (')[0] || id;
const leadsText = (max) => (max === null || max === undefined ? 'ilimitados' : `até ${num(max)}`);
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
function renderLogin() {
  $('#modal-root').innerHTML = '';
  $('#app').innerHTML = `
    <div class="auth"><div>
      <div class="card">
        <div class="brand" style="color:var(--green-dark);padding:0 0 12px">Fechou</div>
        <h1>Administração</h1>
        <p class="muted">Acesso restrito ao responsável pela plataforma.</p>
        <form id="login" class="stack" style="margin-top:16px">
          <div><label for="a-email">E-mail</label><input id="a-email" name="email" type="email" required autocomplete="username"></div>
          <div><label for="a-pass">Senha</label><input id="a-pass" name="password" type="password" required autocomplete="current-password"></div>
          <button class="primary" style="width:100%;justify-content:center">Entrar</button>
        </form>
      </div>
    </div></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/login', { method: 'POST', body: formData(e.target) }); boot(); } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const PAGES = [
  ['visao', 'Visão geral', renderOverview],
  ['empresas', 'Empresas', renderCompanies],
  ['historico', 'Histórico', renderAudit],
  ['admins', 'Administradores', renderAdmins],
];

function renderLayout() {
  $('#app').innerHTML = `
    <div class="mobile-top"><button id="menu-btn" aria-label="Menu">☰</button><strong>Fechou · Admin</strong></div>
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">Fechou <span class="badge" style="margin-left:4px">admin</span></div>
        <nav class="nav">${PAGES.map(([id, label]) => `<a href="#/${id}" data-page="${id}"><span>${label}</span></a>`).join('')}</nav>
        <div class="sidebar-foot">
          <div><strong style="color:#fff">${esc(state.me.admin.name)}</strong></div>
          <div>${esc(state.me.admin.email)}</div>
          <button class="sm" id="logout">Sair</button>
        </div>
      </aside>
      <main class="main" id="page"></main>
    </div>`;
  $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
}

async function route() {
  if (!state.me) return;
  const [, page = 'visao', ...rest] = location.hash.replace(/^#/, '').split('/');
  const def = PAGES.find((p) => p[0] === page) || PAGES[0];
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === def[0]));
  $('#sidebar')?.classList.remove('open');
  const el = $('#page');
  el.innerHTML = '<div class="empty">Carregando…</div>';
  try { await def[2](el, rest); } catch (err) { el.innerHTML = `<div class="empty">Erro: ${esc(err.message)}</div>`; }
}

async function boot() {
  try { state.me = await api('/api/admin/me'); } catch { return renderLogin(); }
  renderLayout();
  route();
}
// Trocar de página fecha as janelas abertas; atualizar a lista (route()) não.
window.addEventListener('hashchange', () => { $('#modal-root').innerHTML = ''; route(); });

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------
async function renderOverview(el) {
  const o = await api('/api/admin/overview');
  const mrr = o.list.filter((c) => c.status === 'ativa').reduce((n, c) => n + (state.me.plans.find((p) => p.id === c.plan)?.price_cents || 0), 0);
  el.innerHTML = `
    <div class="page-head"><div><h1>Visão geral</h1><p class="muted">Todas as empresas que usam o Fechou</p></div>
      <span class="spacer"></span><button class="primary" id="new-company">+ Nova empresa</button></div>
    <div class="grid kpis">
      <div class="card kpi"><div class="label">Empresas ativas</div><div class="value">${num(o.active)}</div><div class="sub">${num(o.suspended)} suspensa(s) · ${num(o.dedicated)} com banco separado</div></div>
      <div class="card kpi good"><div class="label">Receita mensal (planos)</div><div class="value">${money(mrr)}</div><div class="sub">soma dos planos das empresas ativas</div></div>
      <div class="card kpi"><div class="label">Usuários ativos</div><div class="value">${num(o.users)}</div></div>
      <div class="card kpi"><div class="label">Mensagens (30 dias)</div><div class="value">${num(o.messages_30d)}</div><div class="sub">${num(o.ai_messages_30d)} respostas da IA</div></div>
      <div class="card kpi"><div class="label">Leads (30 dias)</div><div class="value">${num(o.leads_30d)}</div></div>
    </div>
    <div class="card" style="margin-top:14px">${companiesTable(o.list)}</div>`;
  $('#new-company').onclick = companyForm;
  bindCompanyRows(el);
}

function companiesTable(list) {
  if (!list.length) return '<div class="empty">Nenhuma empresa ainda. Clique em "Nova empresa" para cadastrar a primeira.</div>';
  return `<div class="table-wrap"><table>
    <tr><th>Empresa</th><th>Plano</th><th>Usuários</th><th>Leads</th><th>Mensagens 30d</th><th>Último acesso</th><th>Situação</th></tr>
    ${list.map((c) => {
      const nearUsers = c.usage.active_users >= c.max_users;
      const nearLeads = c.max_leads !== null && c.usage.contacts >= c.max_leads;
      return `<tr class="clickable" data-id="${c.id}">
        <td><strong>${esc(c.name)}</strong><div class="small muted">${esc(state.me.presets.find((p) => p.id === c.segment)?.label || c.segment)}</div></td>
        <td>${esc(planLabel(c.plan))}</td>
        <td class="nowrap">${num(c.usage.active_users)} / ${num(c.max_users)} ${nearUsers ? '<span class="badge amber">no limite</span>' : ''}</td>
        <td class="nowrap">${num(c.usage.contacts)}${c.max_leads !== null ? ` / ${num(c.max_leads)}` : ''} ${nearLeads ? '<span class="badge amber">no limite</span>' : ''}</td>
        <td>${num(c.usage.messages_30d)}<div class="small muted">${num(c.usage.ai_messages_30d)} da IA</div></td>
        <td class="small">${fmt(c.usage.last_login_at)}</td>
        <td>${STATUS_BADGE(c.status)} ${STORAGE_BADGE(c.storage)}</td></tr>`;
    }).join('')}
  </table></div>`;
}

function bindCompanyRows(root) {
  $$('tr[data-id]', root).forEach((tr) => { tr.onclick = () => openCompany(Number(tr.dataset.id)); });
}

// ---------------------------------------------------------------------------
// Empresas
// ---------------------------------------------------------------------------
async function renderCompanies(el) {
  const list = await api('/api/admin/companies');
  el.innerHTML = `
    <div class="page-head"><div><h1>Empresas</h1><p class="muted">Cada empresa tem seus próprios usuários, dados, WhatsApp e integrações</p></div>
      <span class="spacer"></span><input id="q" placeholder="Buscar empresa…" style="width:220px" aria-label="Buscar empresa"><button class="primary" id="new-company">+ Nova empresa</button></div>
    <div class="card" id="list">${companiesTable(list)}</div>`;
  $('#new-company').onclick = companyForm;
  bindCompanyRows(el);
  $('#q').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $('#list').innerHTML = companiesTable(list.filter((c) => c.name.toLowerCase().includes(q)));
    bindCompanyRows(el);
  };
}

function planOptions(selected) {
  // Empresa com plano fora da tabela (limites combinados à parte) aparece como "Personalizado".
  const custom = !state.me.plans.some((p) => p.id === selected) ? '<option value="" selected>Personalizado</option>' : '';
  return custom + state.me.plans.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)} — ${p.price_cents ? `${money(p.price_cents)}/mês` : 'grátis'} · ${p.max_users} usuário(s) · leads ${leadsText(p.max_leads)}</option>`).join('');
}

function companyForm() {
  const firstPlan = state.me.plans[0];
  const box = openModal(`${modalHead('Nova empresa')}
    <form id="company-form">
      <div class="fields">
        <div class="field"><label for="c-name">Nome da empresa</label><input id="c-name" name="name" required></div>
        <div class="field"><label for="c-seg">Segmento (configura a IA)</label><select id="c-seg" name="segment">${state.me.presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="c-plan">Plano</label><select id="c-plan" name="plan">${planOptions(firstPlan.id)}</select></div>
        <div class="field"><label for="c-users">Limite de usuários</label><input id="c-users" name="max_users" type="number" min="1" value="${firstPlan.max_users}"></div>
        <div class="field"><label for="c-leads">Limite de leads</label><input id="c-leads" name="max_leads" type="number" min="1" value="${firstPlan.max_leads ?? ''}" placeholder="vazio = ilimitado"></div>
        <div class="field"><label for="c-storage">Onde guardar os dados</label><select id="c-storage" name="storage"><option value="shared">Banco compartilhado (padrão)</option><option value="dedicated">Banco separado (casos especiais)</option></select></div>
      </div>
      <h3 style="margin:6px 0 10px">Primeiro usuário (dono da conta)</h3>
      <div class="fields">
        <div class="field"><label for="o-name">Nome</label><input id="o-name" name="owner_name" required></div>
        <div class="field"><label for="o-email">E-mail de acesso</label><input id="o-email" name="owner_email" type="email" required></div>
        <div class="field"><label for="o-pass">Senha inicial</label><div class="row"><input id="o-pass" name="owner_password" required minlength="8" value="${randomPassword()}"><button type="button" class="sm" id="gen">Gerar</button></div><div class="hint">Envie para o cliente; ele pode pedir a troca depois.</div></div>
      </div>
      <div class="field"><label for="c-notes">Observações internas</label><textarea id="c-notes" name="notes" placeholder="Ex.: contrato anual, contato do financeiro…"></textarea></div>
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Criar empresa</button></div>
    </form>`, { wide: true });
  const form = $('#company-form', box);
  form.plan.onchange = () => {
    const p = state.me.plans.find((x) => x.id === form.plan.value);
    form.max_users.value = p.max_users;
    form.max_leads.value = p.max_leads ?? '';
  };
  $('#gen', box).onclick = () => { form.owner_password.value = randomPassword(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(form);
    try {
      const c = await api('/api/admin/companies', { method: 'POST', body });
      box.close();
      showCredentials(c.name, body.owner_email, body.owner_password);
      route();
    } catch (err) { fail(err); }
  };
}

function showCredentials(company, email, password) {
  const text = `Acesso ao Fechou — ${company}\nEndereço: ${location.origin}/app\nE-mail: ${email}\nSenha: ${password}`;
  const box = openModal(`${modalHead('Acesso criado')}
    <p>Envie estes dados para o cliente:</p>
    <pre class="pix" style="white-space:pre-wrap">${esc(text)}</pre>
    <div class="modal-foot"><button data-close>Fechar</button><button class="primary" id="copy">Copiar</button></div>`);
  $('#copy', box).onclick = () => navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('Selecione o texto e copie', 'error'));
}

async function openCompany(id) {
  const c = await api(`/api/admin/companies/${id}`);
  const u = c.usage;
  const box = openModal(`
    <div class="modal-head">
      <div><h2>${esc(c.name)}</h2><div class="small muted">${esc(state.me.presets.find((p) => p.id === c.segment)?.label || c.segment)} · desde ${fmt(c.created_at)}</div></div>
      <span class="spacer"></span><button class="ghost" data-close aria-label="Fechar">✕</button>
    </div>
    <div class="row wrap" style="margin-bottom:14px">
      ${STATUS_BADGE(c.status)} ${STORAGE_BADGE(c.storage)}
      <span class="spacer"></span>
      <button class="sm" id="imp">Entrar como a empresa</button>
      <button class="sm" id="exp">Exportar dados</button>
      ${c.status === 'ativa' ? '<button class="sm danger" id="sus">Suspender</button>' : '<button class="sm primary" id="rea">Reativar</button>'}
    </div>
    <div class="grid halves">
      <div class="card">
        <h3>Plano e limites</h3>
        <form id="plan-form" style="margin-top:10px">
          <div class="field"><label for="p-name">Nome</label><input id="p-name" name="name" value="${esc(c.name)}"></div>
          <div class="field"><label for="p-plan">Plano</label><select id="p-plan" name="plan">${planOptions(c.plan)}</select></div>
          <div class="fields">
            <div class="field"><label for="p-users">Usuários</label><input id="p-users" name="max_users" type="number" min="1" value="${c.max_users}"></div>
            <div class="field"><label for="p-leads">Leads</label><input id="p-leads" name="max_leads" type="number" min="1" value="${c.max_leads ?? ''}" placeholder="ilimitado"></div>
          </div>
          <div class="field"><label for="p-notes">Observações internas</label><textarea id="p-notes" name="notes">${esc(c.notes)}</textarea></div>
          <button class="primary sm">Salvar</button>
        </form>
      </div>
      <div class="card">
        <h3>Uso (30 dias)</h3>
        <table class="small" style="margin-top:6px">
          <tr><td class="muted">Leads no total</td><td>${num(u.contacts)}${c.max_leads !== null ? ` de ${num(c.max_leads)}` : ''}</td></tr>
          <tr><td class="muted">Novos leads</td><td>${num(u.leads_30d)}</td></tr>
          <tr><td class="muted">Mensagens</td><td>${num(u.messages_30d)} (${num(u.ai_messages_30d)} da IA)</td></tr>
          <tr><td class="muted">Agendamentos criados</td><td>${num(u.appointments_30d)}</td></tr>
          <tr><td class="muted">Recebido pela empresa</td><td>${money(u.revenue_30d_cents)}</td></tr>
          <tr><td class="muted">WhatsApp</td><td>${esc({ simulator: 'não conectado', evolution: 'QR Code (Evolution)', meta: 'API oficial' }[c.whatsapp_provider] || c.whatsapp_provider)}</td></tr>
          <tr><td class="muted">Último acesso</td><td>${fmt(u.last_login_at)}</td></tr>
        </table>
        ${c.storage !== 'dedicated' ? `<div class="hint" style="margin-top:12px">Precisa de isolamento físico (ex.: política de sigilo do cliente)?</div><button class="sm" id="ded" style="margin-top:6px">Mover para banco separado</button>` : '<p class="hint" style="margin-top:12px">Os dados desta empresa ficam num arquivo de banco só dela.</p>'}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><h3>Usuários (${num(u.active_users)} de ${num(c.max_users)} ativos)</h3><span class="spacer"></span><button class="sm primary" id="add-user">+ Usuário</button></div>
      <div class="table-wrap"><table>
        <tr><th>Nome</th><th>Perfil</th><th>Último acesso</th><th>Situação</th><th></th></tr>
        ${c.users.map((x) => `<tr>
          <td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.email)}</div></td>
          <td>${esc(roleLabel(x.role))}${x.professional_id ? `<div class="small muted">${esc(c.professionals.find((p) => p.id === x.professional_id)?.name || '')}</div>` : ''}</td>
          <td class="small">${fmt(x.last_login_at)}</td>
          <td><span class="badge ${x.active ? 'green' : ''}">${x.active ? 'ativo' : 'desativado'}</span></td>
          <td class="nowrap"><button class="sm" data-edit-user="${x.id}">Editar</button></td></tr>`).join('')}
      </table></div>
    </div>
    <div class="card" style="margin-top:14px;border-color:var(--red-soft)">
      <h3>Excluir empresa</h3>
      <p class="small muted">Apaga a empresa, os usuários e todos os dados (contatos, conversas, agenda, cobranças). Não tem volta. Exporte os dados antes, se precisar.</p>
      <div class="row"><input id="confirm-name" placeholder="Digite o nome da empresa para confirmar" aria-label="Nome da empresa para confirmar"><button class="danger" id="del">Excluir</button></div>
    </div>`, { drawer: true });

  const reopen = async () => { box.close(); await route(); openCompany(id); };
  const post = async (path, msg) => { try { await api(path, { method: 'POST' }); toast(msg); reopen(); } catch (err) { fail(err); } };
  $('#plan-form', box).plan.onchange = (e) => {
    const p = state.me.plans.find((x) => x.id === e.target.value);
    if (!p) return;
    const f = $('#plan-form', box);
    f.max_users.value = p.max_users;
    f.max_leads.value = p.max_leads ?? '';
  };
  $('#plan-form', box).onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/api/admin/companies/${id}`, { method: 'PUT', body: formData(e.target) }); toast('Empresa atualizada'); reopen(); } catch (err) { fail(err); }
  };
  $('#sus', box)?.addEventListener('click', () => post(`/api/admin/companies/${id}/suspend`, 'Empresa suspensa: os usuários não conseguem mais entrar'));
  $('#rea', box)?.addEventListener('click', () => post(`/api/admin/companies/${id}/reactivate`, 'Empresa reativada'));
  $('#ded', box)?.addEventListener('click', () => post(`/api/admin/companies/${id}/dedicated`, 'Dados movidos para um banco separado'));
  $('#imp', box).onclick = async () => {
    try { await api(`/api/admin/companies/${id}/impersonate`, { method: 'POST' }); window.open('/app', '_blank'); toast('Aberto em outra aba (acesso registrado no histórico)'); } catch (err) { fail(err); }
  };
  $('#exp', box).onclick = async () => {
    try {
      const data = await api(`/api/admin/companies/${id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `fechou-${c.name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) { fail(err); }
  };
  $('#del', box).onclick = async () => {
    try {
      await api(`/api/admin/companies/${id}`, { method: 'DELETE', body: { confirm_name: $('#confirm-name', box).value } });
      box.close(); toast('Empresa excluída'); route();
    } catch (err) { fail(err); }
  };
  $('#add-user', box).onclick = () => userForm(c, null, reopen);
  $$('[data-edit-user]', box).forEach((b) => { b.onclick = () => userForm(c, c.users.find((x) => x.id === Number(b.dataset.editUser)), reopen); });
}

function userForm(company, user, onDone) {
  const u = user || { name: '', email: '', role: 'agent', active: 1, professional_id: null };
  const box = openModal(`${modalHead(user ? 'Editar usuário' : 'Novo usuário')}
    <form id="user-form">
      <div class="fields">
        <div class="field"><label for="u-name">Nome</label><input id="u-name" name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label for="u-email">E-mail de acesso</label><input id="u-email" name="email" type="email" value="${esc(u.email)}" required></div>
        <div class="field"><label for="u-role">Perfil</label><select id="u-role" name="role">${state.me.roles.map((r) => `<option value="${r.id}" ${r.id === u.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
        <div class="field" id="pro-field"><label for="u-pro">Profissional na agenda</label><select id="u-pro" name="professional_id"><option value="">—</option>${company.professionals.map((p) => `<option value="${p.id}" ${p.id === u.professional_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>${company.professionals.length ? '' : '<div class="hint">A empresa ainda não cadastrou profissionais.</div>'}</div>
        <div class="field"><label for="u-pass">${user ? 'Nova senha (deixe vazio para manter)' : 'Senha inicial'}</label><div class="row"><input id="u-pass" name="password" ${user ? '' : 'required'} minlength="8" value="${user ? '' : randomPassword()}"><button type="button" class="sm" id="gen">Gerar</button></div></div>
      </div>
      ${user ? `<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Acesso ativo</label>` : ''}
      <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Salvar</button></div>
    </form>`);
  const form = $('#user-form', box);
  const togglePro = () => { $('#pro-field', box).classList.toggle('hidden', form.role.value !== 'professional'); };
  form.role.onchange = togglePro;
  togglePro();
  $('#gen', box).onclick = () => { form.password.value = randomPassword(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = formData(form);
    if (!body.password) delete body.password;
    try {
      if (user) await api(`/api/admin/companies/${company.id}/users/${user.id}`, { method: 'PUT', body });
      else await api(`/api/admin/companies/${company.id}/users`, { method: 'POST', body });
      box.close();
      if (body.password) showCredentials(company.name, body.email, body.password);
      else toast('Usuário salvo');
      onDone();
    } catch (err) { fail(err); }
  };
}

// ---------------------------------------------------------------------------
// Histórico e administradores
// ---------------------------------------------------------------------------
async function renderAudit(el) {
  const rows = await api('/api/admin/audit');
  el.innerHTML = `
    <div class="page-head"><div><h1>Histórico</h1><p class="muted">Tudo o que os administradores fizeram: criação de empresas, acessos de suporte, exportações e exclusões</p></div></div>
    <div class="card table-wrap"><table>
      <tr><th>Quando</th><th>Quem</th><th>O quê</th><th>Empresa</th><th>Detalhes</th></tr>
      ${rows.map((r) => `<tr><td class="small nowrap">${fmt(r.created_at)}</td><td class="small">${esc(r.actor.replace('admin:', ''))}</td><td>${esc(r.action)}</td><td>${esc(r.company_name || '—')}</td><td class="small muted">${esc(r.details)}</td></tr>`).join('')}
    </table>${rows.length ? '' : '<div class="empty">Nada registrado ainda.</div>'}</div>`;
}

async function renderAdmins(el) {
  const admins = await api('/api/admin/admins');
  el.innerHTML = `
    <div class="page-head"><div><h1>Administradores</h1><p class="muted">Pessoas com acesso a este painel</p></div><span class="spacer"></span><button class="primary" id="new-admin">+ Administrador</button></div>
    <div class="card table-wrap"><table>
      <tr><th>Nome</th><th>E-mail</th><th>Desde</th></tr>
      ${admins.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.email)}</td><td class="small">${fmt(a.created_at)}</td></tr>`).join('')}
    </table></div>`;
  $('#new-admin').onclick = () => {
    const box = openModal(`${modalHead('Novo administrador')}
      <form id="admin-form">
        <div class="field"><label for="ad-name">Nome</label><input id="ad-name" name="name" required></div>
        <div class="field"><label for="ad-email">E-mail</label><input id="ad-email" name="email" type="email" required></div>
        <div class="field"><label for="ad-pass">Senha (mínimo 8 caracteres)</label><input id="ad-pass" name="password" type="password" minlength="8" required></div>
        <div class="modal-foot"><button type="button" data-close>Cancelar</button><button class="primary">Criar</button></div>
      </form>`);
    $('#admin-form', box).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/admin/admins', { method: 'POST', body: formData(e.target) }); box.close(); toast('Administrador criado'); route(); } catch (err) { fail(err); }
    };
  };
}

boot();
