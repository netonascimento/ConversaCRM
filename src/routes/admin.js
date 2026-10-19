import { main } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import {
  requireAdmin, adminLogin, adminCookie, createAdmin, registerCompany, createUser, updateUser,
  createSession, sessionCookie, ROLES, checkPassword,
} from '../auth.js';
import { PRESETS } from '../services/presets.js';
import { publicPlans } from '../services/plans.js';
import { releaseAssignments } from '../services/assignment.js';
import { stripeMode } from '../services/stripe.js';
import {
  audit, listAudit, listCompanies, companyDetail, updateCompany, setStatus, exportCompany,
  moveToDedicated, deleteCompany, platformOverview, activatePlan, financeOverview, setCourtesy, removeCourtesy,
} from '../services/admin.js';

const need = (row, what) => {
  if (!row) throw new HttpError(404, `${what} não encontrado(a)`);
  return row;
};
const actor = (req) => `admin:${req.admin.email}`;
const companyName = (id) => main.get('SELECT name FROM companies WHERE id = ?', id)?.name;

/** Cria o primeiro administrador a partir de ADMIN_EMAIL e ADMIN_PASSWORD, se ainda não existir. */
export function ensureAdminFromEnv() {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_NAME: name } = process.env;
  if (!email || !password) return;
  if (main.get('SELECT id FROM admins WHERE email = ?', email.trim().toLowerCase())) return;
  createAdmin({ name: name || 'Administrador', email, password });
  console.log(`Administrador criado: ${email}`);
}

export function registerAdmin(router) {
  const admin = requireAdmin;

  router.post('/api/admin/login', (req, res, { body }) => {
    const { admin: a, token } = adminLogin(body.email, body.password, req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
    res.setHeader('Set-Cookie', adminCookie(token, req));
    audit(`admin:${a.email}`, 'login');
    return { ok: true };
  });
  router.post('/api/admin/logout', admin, (req, res) => {
    main.run('DELETE FROM admin_sessions WHERE token = ?', req.admin.token);
    res.setHeader('Set-Cookie', adminCookie('', req));
    return { ok: true };
  });
  router.get('/api/admin/me', admin, (req) => ({
    admin: { id: req.admin.id, name: req.admin.name, email: req.admin.email },
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
    plans: publicPlans(),
    roles: ROLES,
    platform_ai_key: Boolean(config.anthropicKey),
  }));

  router.get('/api/admin/overview', admin, () => platformOverview());
  router.get('/api/admin/finance', admin, () => ({ ...financeOverview(), stripe_mode: stripeMode() }));
  router.get('/api/admin/companies', admin, () => listCompanies());

  router.post('/api/admin/companies', admin, (req, res, { body }) => {
    checkPassword(body.owner_password);
    const { companyId } = registerCompany({
      companyName: body.name, name: body.owner_name, email: body.owner_email, password: body.owner_password,
      segment: body.segment, plan: body.plan, maxUsers: body.max_users, maxLeads: body.max_leads, notes: body.notes || '',
    });
    audit(actor(req), 'empresa criada', companyId, `${body.name} (modelo: ${body.segment || 'generico'})`);
    if (body.storage === 'dedicated') {
      moveToDedicated(companyId);
      audit(actor(req), 'banco separado', companyId, 'criada com banco separado');
    }
    return companyDetail(companyId);
  });

  router.get('/api/admin/companies/:id', admin, (req, res, { params }) => need(companyDetail(Number(params.id)), 'Empresa'));
  router.put('/api/admin/companies/:id', admin, (req, res, { params, body }) => {
    const before = main.get('SELECT ai_platform_key FROM companies WHERE id = ?', Number(params.id));
    const out = need(updateCompany(Number(params.id), body), 'Empresa');
    audit(actor(req), 'empresa editada', out.id, `plano: ${out.plan || '-'}, usuários: ${out.max_users}, leads: ${out.max_leads ?? 'ilimitados'}`);
    if (Boolean(before?.ai_platform_key) !== out.ai_platform_key) {
      audit(actor(req), out.ai_platform_key ? 'IA com chave da plataforma' : 'IA com chave da empresa', out.id,
        out.ai_platform_key ? 'consumo de tokens cobrado à parte' : 'a empresa usa a própria chave');
    }
    return out;
  });
  router.post('/api/admin/companies/:id/activate-plan', admin, (req, res, { params, body }) => {
    need(companyName(Number(params.id)), 'Empresa');
    try {
      const out = activatePlan(Number(params.id), body.plan);
      audit(actor(req), 'assinatura ativada', out.id, `plano ${out.plan}: Pix confirmado, pago até ${out.subscription.paid_until}`);
      return out;
    } catch (e) { throw new HttpError(400, e.message); }
  });
  // Cortesia: plano pago liberado sem cobrança, com motivo e prazo opcional.
  router.post('/api/admin/companies/:id/courtesy', admin, (req, res, { params, body }) => {
    need(companyName(Number(params.id)), 'Empresa');
    try {
      const out = setCourtesy(Number(params.id), body);
      audit(actor(req), 'cortesia liberada', out.id, `plano ${out.plan}${body.until ? ` até ${body.until.split('-').reverse().join('/')}` : ' sem prazo'} · motivo: ${out.subscription.courtesy_reason}`);
      return out;
    } catch (e) { throw new HttpError(400, e.message); }
  });
  router.delete('/api/admin/companies/:id/courtesy', admin, (req, res, { params }) => {
    need(companyName(Number(params.id)), 'Empresa');
    const out = removeCourtesy(Number(params.id));
    audit(actor(req), 'cortesia encerrada', out.id, 'encerrada pelo administrador; voltou para o teste grátis');
    return out;
  });
  router.post('/api/admin/companies/:id/suspend', admin, (req, res, { params }) => {
    need(companyName(Number(params.id)), 'Empresa');
    setStatus(Number(params.id), 'suspensa');
    audit(actor(req), 'empresa suspensa', Number(params.id));
    return companyDetail(Number(params.id));
  });
  router.post('/api/admin/companies/:id/reactivate', admin, (req, res, { params }) => {
    need(companyName(Number(params.id)), 'Empresa');
    setStatus(Number(params.id), 'ativa');
    audit(actor(req), 'empresa reativada', Number(params.id));
    return companyDetail(Number(params.id));
  });

  router.post('/api/admin/companies/:id/users', admin, (req, res, { params, body }) => {
    const user = createUser(Number(params.id), body);
    audit(actor(req), 'usuário criado', Number(params.id), `${user.email} (${user.role})`);
    return user;
  });
  router.put('/api/admin/companies/:id/users/:userId', admin, (req, res, { params, body }) => {
    const user = updateUser(Number(params.id), Number(params.userId), body);
    releaseAssignments(Number(params.id), user);
    const what = [body.password && 'senha redefinida', body.active === false && 'desativado', body.active === true && 'ativado', body.role && `perfil ${body.role}`].filter(Boolean).join(', ');
    audit(actor(req), 'usuário alterado', Number(params.id), `${user.email}${what ? `: ${what}` : ''}`);
    return user;
  });

  // Suporte: abre o sistema como o dono da empresa (sessão curta, registrada no histórico).
  router.post('/api/admin/companies/:id/impersonate', admin, (req, res, { params }) => {
    const id = Number(params.id);
    const owner = main.get("SELECT id, email FROM users WHERE company_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1", id);
    if (!owner) throw new HttpError(400, 'Esta empresa não tem um dono ativo');
    res.setHeader('Set-Cookie', sessionCookie(createSession(owner.id, { impersonatedBy: req.admin.id }), req));
    audit(actor(req), 'acesso de suporte', id, `entrou como ${owner.email}`);
    return { ok: true };
  });

  router.get('/api/admin/companies/:id/export', admin, (req, res, { params }) => {
    need(companyName(Number(params.id)), 'Empresa');
    audit(actor(req), 'dados exportados', Number(params.id));
    return exportCompany(Number(params.id));
  });

  router.post('/api/admin/companies/:id/dedicated', admin, (req, res, { params }) => {
    need(companyName(Number(params.id)), 'Empresa');
    try {
      const out = moveToDedicated(Number(params.id));
      audit(actor(req), 'banco separado', Number(params.id), 'dados movidos para um banco só da empresa');
      return out;
    } catch (e) { throw new HttpError(400, e.message); }
  });

  router.delete('/api/admin/companies/:id', admin, (req, res, { params, body, query }) => {
    const id = Number(params.id);
    const name = need(companyName(id), 'Empresa');
    // Confirmação: é preciso digitar o nome exato da empresa.
    if ((body.confirm_name || query.confirm_name) !== name) throw new HttpError(400, 'Digite o nome exato da empresa para confirmar');
    deleteCompany(id);
    audit(actor(req), 'empresa excluída', null, name);
    return { ok: true };
  });

  router.get('/api/admin/audit', admin, (req, res, { query }) => listAudit(query.company_id ? Number(query.company_id) : null));
  router.get('/api/admin/admins', admin, () => main.all('SELECT id, name, email, created_at FROM admins ORDER BY name'));
  router.post('/api/admin/admins', admin, (req, res, { body }) => {
    const a = createAdmin(body);
    audit(actor(req), 'administrador criado', null, a.email);
    return a;
  });
}
