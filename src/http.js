import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

// Roteador mínimo sem dependências: router.get('/api/x/:id', handler)
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, ...handlers) {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
    this.routes.push({ method, pattern, regex, keys, handlers });
  }

  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  patch(p, ...h) { this.add('PATCH', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (m) return { pattern: r.pattern, handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Corpo da requisição muito grande');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  req.rawBody = raw;
  if (!raw) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'JSON inválido'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { return { raw }; }
}

export function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

// Versão de cada arquivo da tela (pelo conteúdo). O HTML aponta para /app.js?v=<versão>: o navegador e o
// Cloudflare podem guardar o arquivo por muito tempo, porque uma publicação nova muda o endereço.
// (O Cloudflare troca o "no-cache" por 4 horas de cache; sem isso, a tela antiga ficava até 4h depois
// de cada publicação, misturando tela velha com servidor novo.)
const versions = new Map();
function versionOf(file) {
  const st = fs.statSync(file);
  const cached = versions.get(file);
  if (cached && cached.mtime === st.mtimeMs) return cached.v;
  const v = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
  versions.set(file, { mtime: st.mtimeMs, v });
  return v;
}
/** Acrescenta ?v=<versão> nos arquivos locais citados no HTML (src/href) e nos imports do JavaScript. */
export function withVersions(root, text, kind) {
  const add = (name) => {
    const file = path.join(root, name);
    return file.startsWith(root) && fs.existsSync(file) ? `${name}?v=${versionOf(file)}` : name;
  };
  if (kind === 'html') return text.replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g, (m, attr, name) => `${attr}="/${add(name)}"`);
  return text.replace(/(from\s+|import\()(['"])\.\/([\w.-]+\.js)\2/g, (m, pre, q, name) => `${pre}${q}./${add(name)}${q}`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

export function serveStatic(root, req, res, pathname) {
  const file = path.normalize(path.join(root, pathname === '/' ? 'landing.html' : pathname));
  if (!file.startsWith(root)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  // Página: sempre a mais nova, com os endereços versionados.
  if (ext === '.html') {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(withVersions(root, fs.readFileSync(file, 'utf8'), 'html'));
    return true;
  }
  // Arquivo pedido com a versão certa: pode guardar por um ano (a próxima publicação muda o endereço).
  const versioned = /[?&]v=/.test(req.url || '');
  const cache = versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  if (ext === '.js') {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(withVersions(root, fs.readFileSync(file, 'utf8'), 'js'));
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  fs.createReadStream(file).pipe(res);
  return true;
}
