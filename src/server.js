import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { Router, HttpError, send, readBody, serveStatic } from './http.js';
import { registerApi } from './routes/api.js';
import { registerWebhooks } from './routes/webhooks.js';
import { registerAdmin, ensureAdminFromEnv } from './routes/admin.js';
import { withCompanyDb } from './db.js';
import { startScheduler } from './services/scheduler.js';

const router = new Router();
registerApi(router);
registerWebhooks(router);
registerAdmin(router);
router.get('/health', () => ({ ok: true }));

const PUBLIC = path.join(ROOT, 'public');

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const match = router.match(req.method, url.pathname);
    if (!match) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        // Página inicial (landing), sistema (/app) e painel do administrador (/admin).
        const pages = { '/': '/landing.html', '/app': '/app.html', '/admin': '/admin.html' };
        const page = pages[url.pathname.replace(/\/$/, '') || '/'];
        if (page && serveStatic(PUBLIC, req, res, page)) return;
        if (serveStatic(PUBLIC, req, res, url.pathname)) return;
      }
      return send(res, 404, { error: 'Rota não encontrada' });
    }
    try {
      const ctx = {
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {},
      };
      let result;
      // Depois do login, cada rota roda no banco da empresa do usuário (compartilhado ou dedicado).
      for (const handler of match.handlers) {
        result = req.companyId ? await withCompanyDb(req.companyId, () => handler(req, res, ctx)) : await handler(req, res, ctx);
      }
      if (res.writableEnded) return;
      send(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erro interno' : err.message });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'src', 'server.js')) {
  ensureAdminFromEnv();
  createServer().listen(config.port, () => {
    console.log(`Fechou rodando em ${config.publicUrl} (porta ${config.port})`);
    if (!config.disableScheduler) startScheduler(config.schedulerIntervalMs);
  });
}
