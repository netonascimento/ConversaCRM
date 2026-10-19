import * as esbuild from 'esbuild';
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
fs.mkdirSync(here + '../dist', { recursive: true });
const map = {
  'node:sqlite': 'shims/sqlite.js', 'node:fs': 'shims/fs.js', fs: 'shims/fs.js', 'node:path': 'shims/path.js', path: 'shims/path.js',
  'node:url': 'shims/url.js', 'node:async_hooks': 'shims/async_hooks.js', 'node:crypto': 'shims/crypto.js', crypto: 'shims/crypto.js', '@anthropic-ai/sdk': 'shims/anthropic.js',
};
const shimPlugin = {
  name: 'shims',
  setup(build) {
    build.onResolve({ filter: /^(node:[a-z_]+|fs|path|crypto|@anthropic-ai\/sdk)$/ }, (args) => ({ path: here + (map[args.path] || 'shims/empty.js') }));
  },
};
await esbuild.build({
  entryPoints: [here + 'entry.js'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: here + '../dist/bundle.js', inject: [here + 'shims/globals.js'], loader: { '.wasm': 'binary' },
  plugins: [shimPlugin], minify: true, logLevel: 'warning',
});
const V = here + '../public/';
const css = fs.readFileSync(V + 'ds.css', 'utf8') + fs.readFileSync(V + 'app.css', 'utf8');
// A landing roda num iframe (CSS isolado); cliques em links do sistema avisam a página principal.
const landing = fs.readFileSync(V + 'landing.html', 'utf8').replace('</body>', `<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a'); if (!a) return;
  var h = a.getAttribute('href') || '';
  if (h.indexOf('/app') === 0) { e.preventDefault(); parent.postMessage({ falaki: 'open-app', hash: h.slice(4) }, '*'); }
}, true);
</script></body>`);
const js = fs.readFileSync(here + '../dist/bundle.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const extra = `
:root { color-scheme: light; }
.main::before { content: "Demonstração interativa · troque entre a clínica e o escritório no menu lateral · o sistema roda inteiro no seu navegador, nenhuma mensagem é enviada de verdade"; display: block; background: var(--green-soft); color: var(--green-dark); border: 1px solid #cfe5d6; border-radius: 10px; padding: 8px 12px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
.inbox { height: calc(100vh - 180px); }
#landing-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 1000; background: #f7f5ef; }
#demo-switch { margin-top: auto; padding: 10px; border-radius: 10px; background: rgba(255, 255, 255, .08); display: grid; gap: 6px; }
.demo-switch-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #a9cbb4; font-weight: 700; }
#demo-switch button { background: transparent; color: #e3f2e8; border-color: rgba(255, 255, 255, .25); justify-content: flex-start; font-size: 13px; }
#demo-switch button.on { background: #fff; color: var(--green-dark); border-color: #fff; }
#demo-switch + .sidebar-foot { margin-top: 8px; }
#vf-loading { min-height: 100vh; display: grid; place-items: center; color: var(--muted); font-size: 15px; }
`;
const html = `<title>Falaki</title>
<style>${css}${extra}</style>
<iframe id="landing-frame" title="Falaki — página inicial" hidden></iframe>
<script>document.getElementById('landing-frame').srcdoc = ${JSON.stringify(landing).replace(/<\/script/gi, '<\\/script')};</script>
<div id="app"><div id="vf-loading">Carregando o Falaki…</div></div>
<div id="modal-root"></div>
<div id="toast-root"></div>
<script type="module">${js}</script>
`;
fs.writeFileSync(here + '../dist/falaki-demo.html', html);
console.log('ok', (html.length / 1024).toFixed(0) + ' KB');
