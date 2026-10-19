import './init-sql.js';

const { Router, HttpError } = await import('../src/http.js');
const { registerApi } = await import('../src/routes/api.js');
const { seedDemo, seedLawFirm } = await import('../src/seed.js');
const { createSession } = await import('../src/auth.js');
const { get } = await import('../src/db.js');
const { tick } = await import('../src/services/scheduler.js');

// Duas empresas de exemplo geradas na hora, com datas relativas a hoje.
seedDemo();
await seedLawFirm();
const DEMOS = [
  { id: 'clinica', label: 'Clínica odontológica', email: 'demo@falaki.me' },
  { id: 'advocacia', label: 'Escritório de advocacia', email: 'advocacia@falaki.me' },
];
const tokens = Object.fromEntries(DEMOS.map((d) => [d.id, createSession(get('SELECT id FROM users WHERE email = ?', d.email).id)]));
// O link pode abrir direto no escritório: ...#advocacia
let current = location.hash.replace('#', '') === 'advocacia' ? 'advocacia' : 'clinica';
const startedOnLanding = !['#advocacia', '#app'].includes(location.hash);
if (!location.hash.startsWith('#/')) history.replaceState(null, '', '#/dashboard');
let token = tokens[current];

const router = new Router();
registerApi(router);

// Automações (follow-ups, lembretes, tarefas atrasadas) rodando no navegador.
setInterval(tick, 20000);

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const match = router.match(method, url.pathname);
  if (!match) return json(404, { error: 'Rota não encontrada' });
  const headers = {};
  const req = { method, headers: { authorization: token ? `Bearer ${token}` : '' } };
  const res = { headersSent: false, writableEnded: false, setHeader: (k, v) => { headers[k.toLowerCase()] = v; } };
  try {
    const ctx = { params: match.params, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : {} };
    let result;
    for (const handler of match.handlers) result = await handler(req, res, ctx);
    const cookie = headers['set-cookie'];
    if (cookie) token = (cookie.match(/vf_session=([^;]*)/) || [])[1] || null;
    return json(200, result ?? { ok: true });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return json(status, { error: status === 500 ? 'Erro interno' : err.message });
  }
};

window.confirm = () => true; // o visualizador bloqueia diálogos
try { sessionStorage.getItem('x'); } catch {
  const mem = {};
  Object.defineProperty(window, 'sessionStorage', { value: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } } });
}

// Seletor de empresa no menu lateral (cada empresa mantém seus próprios dados enquanto a página estiver aberta).
function switcher() {
  const foot = document.querySelector('.sidebar-foot');
  if (!foot || document.getElementById('demo-switch')) return;
  const box = document.createElement('div');
  box.id = 'demo-switch';
  box.innerHTML = `<div class="demo-switch-label">Demonstração</div>${DEMOS.map((d) => `<button type="button" data-demo="${d.id}" class="${d.id === current ? 'on' : ''}">${d.label}</button>`).join('')}`;
  box.insertAdjacentHTML('beforeend', '<button type="button" id="demo-home">← Página inicial</button>');
  foot.before(box);
  box.querySelector('#demo-home').onclick = showLanding;
  box.querySelectorAll('[data-demo]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.demo === current) return;
      current = b.dataset.demo;
      token = tokens[current];
      for (const k of ['agenda-pro', 'agenda-week', 'task-filter', 'charge-filter', 'sim-phone', 'sim-name']) sessionStorage.removeItem(k);
      location.hash = '#/dashboard';
      window.falaki.boot();
    };
  });
}
new MutationObserver(switcher).observe(document.getElementById('app'), { childList: true, subtree: true });

// Página inicial (landing) por cima do sistema; "Entrar" e "Começar grátis" abrem o sistema.
const frame = document.getElementById('landing-frame');
function showLanding() {
  frame.hidden = false;
  frame.contentWindow?.scrollTo(0, 0);
}
function openApp(hash) {
  frame.hidden = true;
  if (hash === '#cadastro') {
    // Teste grátis de verdade: cria uma conta nova dentro da demonstração.
    token = null;
    current = null;
    history.replaceState(null, '', '#cadastro');
  } else {
    if (!token) { current = current || 'clinica'; token = tokens[current]; }
    history.replaceState(null, '', '#/dashboard');
  }
  window.falaki.boot();
}
window.addEventListener('message', (e) => { if (e.data?.falaki === 'open-app') openApp(e.data.hash || ''); });
if (startedOnLanding) frame.hidden = false;

await import('../public/app.js');
