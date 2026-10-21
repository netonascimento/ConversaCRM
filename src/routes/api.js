import { all, get, run, now, main, transaction } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import {
  registerCompany, login, createSession, sessionCookie, requireAuth, requireRole, ownerOnly, ROLES, listUsers, createUser, updateUser, userFromRequest,
} from '../auth.js';
import { getCompany, saveSettings, maskSettings, anthropicKeyFor, aiKeySource, placesKeyFor } from '../services/company.js';
import {
  STAGES, listContacts, createContact, getContact, updateContact, changeStage, logActivity, PlanLimitError, leadsRemaining, normalizePhone, normalizeBirthDate,
} from '../services/crm.js';
import { PLANS, publicPlans, aiAllowed, accessExpired, UPGRADE_PLAN, RECOMMENDED_PLAN, upgradeTxid } from '../services/plans.js';
import { pixPayload } from '../services/billing.js';
import { stripeEnabled, createCheckout, createPixCheckout, createPortal, changeCardPlan } from '../services/stripe.js';
import { subscriptionState } from '../services/subscriptions.js';
import { audit } from '../services/admin.js';
import { PRESETS } from '../services/presets.js';
import { sendMessage, handleInbound, coldBlocked, COLD_DAILY_LIMIT, coldSentToday } from '../services/messaging.js';
import { managedEnabled, startConnection, connectionState, disconnect as disconnectWhatsapp, numbersOverview, addNumber, removeNumber, listNumbers } from '../services/whatsapp-connect.js';
import { replyNow } from '../services/ai.js';
import { assignContact, assignableUsers, userNames, releaseAssignments } from '../services/assignment.js';
import { onboarding, markOnboarding } from '../services/onboarding.js';
import { listBirthdays, birthdaysSoon } from '../services/birthdays.js';
import {
  PERIODS, listContracts, getContract, createContract, updateContract, renewContract, closeContract, deleteContract, listClients, contractsSummary,
} from '../services/contracts.js';
import {
  CATEGORIES, ALLOWED_EXTENSIONS, MAX_DOCUMENT_BYTES, listDocuments, getDocument, addDocument, documentContent, updateDocument, deleteDocument,
} from '../services/documents.js';
import {
  availableSlots, createAppointment, listAppointments, updateAppointment, getAppointment,
} from '../services/scheduling.js';
import { TRIGGERS, listSequences, parseSequence, enroll } from '../services/followup.js';
import { listCharges, createCharge, markPaid, cancelCharge, getCharge, chargeMessage } from '../services/billing.js';
import { searchPlaces, listSearches, getSearch, importProspects, searchQuota } from '../services/prospecting.js';
import { presentMessage, friendlyBody, retryMedia, mediaFile } from '../services/media.js';
import { startSignupTrial, referralOverview, redeemCode, ownerOfCode } from '../services/referrals.js';
import { meiStatus, submitMei } from '../services/mei.js';
import { track, recordSignup } from '../services/analytics.js';
import {
  processesEnabled, parseCnj, listOabs, saveOab, deleteOab, caseLimit, createCase, updateCase, deleteCase, refreshCase,
  listCases, getCase, listNews, listUnlinked, getEvent, markRead, unreadCount,
} from '../services/legal.js';
import { getDashboard, getMetrics } from '../services/dashboard.js';
import { generateInsights } from '../services/ai.js';
import { tick } from '../services/scheduler.js';
import { TASK_TYPES, listTasks, getTask, createTask, completeTask } from '../services/tasks.js';
import { listProfessionals, getProfessional, saveProfessional, deleteProfessional } from '../services/professionals.js';
import { OBJECTIVES, SCHEDULING_MODES, PRICE_MODES, CHARGE_MODES } from '../services/ai.js';
import {
  googleConfigured, startConnect, consumeState, finishConnect, listConnections, disconnect, refreshBusy, removeAppointmentEvent, GoogleError,
} from '../services/google.js';
import { withCompanyDb } from '../db.js';

const int = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
// Aceita valores no formato brasileiro ("1.500", "1.500,90", "250,00") ou com ponto decimal ("250.5").
export function cents(value) {
  if (typeof value === 'number') return Math.round(value * 100);
  let s = String(value ?? '').trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function need(row, what = 'Registro') {
  if (!row) throw new HttpError(404, `${what} não encontrado`);
  return row;
}

// Profissional só enxerga os clientes que têm atendimento com ele.
const proScope = (req) => (req.user.role === 'professional' ? req.user.professional_id || -1 : null);
const ownContacts = (req) => new Set(all(
  'SELECT DISTINCT contact_id FROM appointments WHERE company_id = ? AND professional_id = ? AND contact_id IS NOT NULL',
  req.companyId, proScope(req),
).map((r) => r.contact_id));
const visible = (req, contactId) => proScope(req) === null || ownContacts(req).has(Number(contactId));

// Teste encerrado sem assinatura: a conta continua entrando e vendo tudo, mas não edita, altera
// nem cadastra nada. Só passam a assinatura, as promoções (indicação e MEI), sair e a medição de uso.
const EXPIRED_ALLOWED = [/^\/api\/auth\//, /^\/api\/upgrade/, /^\/api\/referral/, /^\/api\/mei/, /^\/api\/t$/];
export const EXPIRED_MESSAGE = 'Seu teste grátis terminou. Você continua vendo tudo, mas para editar, alterar ou cadastrar é preciso assinar um plano.';

// Pix do Stripe recusado (não ativado na conta): por uma hora, nem tenta; vai direto para o Pix manual.
let stripePixBlockedUntil = 0;

export function registerApi(router) {
  const auth = (req) => {
    requireAuth(req);
    if (req.method === 'GET' || req.user.impersonated_by) return;
    const path = String(req.url || '').split('?')[0];
    if (EXPIRED_ALLOWED.some((r) => r.test(path))) return;
    if (accessExpired(getCompany(req.companyId))) throw new HttpError(402, EXPIRED_MESSAGE);
  };
  const staff = requireRole('agent');
  const contactGuard = (req, res, { params }) => {
    if (!visible(req, params.id)) throw new HttpError(404, 'Contato não encontrado');
  };

  // ---- Autenticação ----------------------------------------------------------
  router.post('/api/auth/register', (req, res, { body }) => {
    if (!config.allowSignup) throw new HttpError(403, 'Cadastro desativado');
    // Cadastro pela página inicial: teste do Básico (7 dias; 30 com código de indicação).
    const { userId, companyId } = registerCompany({ ...body, plan: 'basico', maxUsers: undefined, maxLeads: undefined });
    startSignupTrial(companyId, body.ref);
    recordSignup(companyId, { visitor: body.vid, source: body.ref ? 'indicação' : body.src });
    res.setHeader('Set-Cookie', sessionCookie(createSession(userId), req));
    return { ok: true };
  });
  router.post('/api/auth/login', (req, res, { body }) => {
    const user = login(body.email, body.password, req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '');
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id), req));
    return { ok: true };
  });
  router.post('/api/auth/logout', auth, (req, res) => {
    main.run('DELETE FROM sessions WHERE token = ?', req.user.token);
    res.setHeader('Set-Cookie', sessionCookie('', req));
    return { ok: true };
  });
  router.get('/api/auth/config', () => ({
    allow_signup: config.allowSignup,
    segments: Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label })),
  }));
  // Página inicial (landing): planos e contato de vendas.
  // Medição (página inicial e sistema). Com sessão, o evento fica ligado ao usuário e à empresa.
  router.post('/api/t', (req, res, { body }) => {
    const user = userFromRequest(req);
    return { n: track(body, { userId: user?.id || null, companyId: user?.company_id || null }) };
  });
  // Página inicial com ?ref=CÓDIGO: mostra quem indicou (só o primeiro nome) e o mês grátis.
  router.get('/api/public/referral/:code', (req, res, { params }) => {
    const r = ownerOfCode(params.code);
    return r && r.status === 'ativa' ? { valid: true, code: r.code, by: String(r.user_name).split(' ')[0] } : { valid: false };
  });
  router.get('/api/public/info', () => ({ plans: publicPlans(), sales_whatsapp: config.salesWhatsapp, allow_signup: config.allowSignup }));
  router.get('/api/auth/me', auth, (req) => {
    const company = getCompany(req.companyId);
    return {
      user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, professional_id: req.user.professional_id },
      company: { id: company.id, name: company.name, timezone: company.timezone, status: company.status },
      impersonated: Boolean(req.user.impersonated_by),
      allow_signup: config.allowSignup,
    };
  });

  // ---- Usuários da empresa (o dono gerencia a própria equipe) ---------------
  router.get('/api/users', auth, ownerOnly, (req) => ({
    users: listUsers(req.companyId), roles: ROLES, max_users: getCompany(req.companyId).max_users,
  }));
  router.post('/api/users', auth, ownerOnly, (req, res, { body }) => createUser(req.companyId, body));
  router.put('/api/users/:id', auth, ownerOnly, (req, res, { params, body }) => {
    const user = updateUser(req.companyId, Number(params.id), body);
    releaseAssignments(req.companyId, user);
    return user;
  });

  // ---- Configurações ---------------------------------------------------------
  router.get('/api/meta', auth, (req) => {
    const company = getCompany(req.companyId);
    const base = config.publicUrl;
    return {
      stages: STAGES,
      triggers: TRIGGERS,
      task_types: TASK_TYPES,
      behavior_options: {
        objectives: OBJECTIVES.map(({ id, label }) => ({ id, label })),
        scheduling_modes: SCHEDULING_MODES, price_modes: PRICE_MODES, charge_modes: CHARGE_MODES,
      },
      open_tasks: get("SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND status = 'aberta'", company.id).n,
      plan: {
        id: company.plan, label: PLANS[company.plan]?.label || company.plan || 'Personalizado',
        max_users: company.max_users, max_leads: company.max_leads, leads_remaining: leadsRemaining(company.id),
        leads_used: get('SELECT COUNT(*) AS n FROM contacts WHERE company_id = ?', company.id).n,
        // Plano mais barato acima do atual que permite mais usuários (para o convite na aba Usuários).
        next_users: (() => {
          const price = PLANS[company.plan]?.price_cents ?? 0;
          const [id, p] = Object.entries(PLANS).filter(([, x]) => x.price_cents > price && x.max_users > company.max_users)
            .sort(([, a], [, b]) => a.price_cents - b.price_cents)[0] || [];
          return id ? { id, label: p.label, max_users: p.max_users } : null;
        })(),
      },
      sales_whatsapp: config.salesWhatsapp,
      ai_configured: Boolean(anthropicKeyFor(company)),
      ai_key_source: aiKeySource(company),
      ai_locked: !aiAllowed(company),
      onboarding: req.user.role === 'owner' ? onboarding(company.id) : null,
      whatsapp_managed: managedEnabled(),
      whatsapp_state: company.settings.whatsapp.connection_state || null,
      // Só aparece com mais de um número: com um número só, nenhuma tela muda.
      whatsapp_numbers: (() => {
        const extras = listNumbers(company.id);
        return extras.length ? [{ id: null, label: 'Principal' }, ...extras.map((n) => ({ id: n.id, label: n.label, state: n.connection_state }))] : null;
      })(),
      prospecting_limit: company.settings.whatsapp.provider === 'evolution' ? { limit: COLD_DAILY_LIMIT, used: coldSentToday(company) } : null,
      subscription: { method: company.billing_method, paid_until: company.paid_until, ...subscriptionState(company) },
      // Teste encerrado: só leitura até assinar.
      expired: accessExpired(company),
      team: assignableUsers(company.id),
      contract_periods: PERIODS,
      document_categories: CATEGORIES,
      document_types: ALLOWED_EXTENSIONS,
      document_max_bytes: MAX_DOCUMENT_BYTES,
      places_configured: Boolean(placesKeyFor(company)),
      // Processos (advocacia): aba no menu e contador de novidades.
      processes_enabled: processesEnabled(company),
      legal_unread: processesEnabled(company) ? unreadCount(company.id) : 0,
      // Google Agenda só aparece quando a plataforma tiver as credenciais do Google Cloud.
      google_calendar: googleConfigured(),
      prospecting_searches: searchQuota(company),
      whatsapp_provider: company.settings.whatsapp.provider,
      billing_provider: company.settings.billing.provider,
      webhooks: {
        meta: `${base}/webhooks/whatsapp/meta/${company.public_id}`,
        evolution: `${base}/webhooks/whatsapp/evolution/${company.public_id}?token=${company.webhook_token}`,
        asaas: `${base}/webhooks/billing/asaas/${company.public_id}`,
        mercadopago: `${base}/webhooks/billing/mercadopago/${company.public_id}?token=${company.webhook_token}`,
      },
    };
  });
  router.get('/api/settings', auth, (req) => {
    const c = getCompany(req.companyId);
    return { name: c.name, timezone: c.timezone, settings: maskSettings(c.settings) };
  });
  router.put('/api/settings', auth, ownerOnly, (req, res, { body }) => {
    if (body.name) main.run('UPDATE companies SET name = ? WHERE id = ?', body.name, req.companyId);
    if (body.timezone) {
      try { new Intl.DateTimeFormat('pt-BR', { timeZone: body.timezone }); } catch { throw new HttpError(400, 'Fuso horário inválido'); }
      main.run('UPDATE companies SET timezone = ? WHERE id = ?', body.timezone, req.companyId);
    }
    let c = body.settings ? saveSettings(req.companyId, body.settings) : getCompany(req.companyId);
    // Salvou os horários: o passo "Defina seus horários" dos Primeiros passos está feito.
    if (body.settings?.business_hours) c = markOnboarding(req.companyId, { hours: true });
    return { name: c.name, timezone: c.timezone, settings: maskSettings(c.settings) };
  });
  router.get('/api/onboarding', auth, ownerOnly, (req) => onboarding(req.companyId));

  // WhatsApp por QR Code gerenciado pelo Conversa CRM (o cliente só lê o QR Code no celular).
  const waError = (e) => new HttpError(502, e.message);
  // number_id vazio = número principal (como sempre foi); com número = um dos números extras.
  const numberId = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  router.post('/api/whatsapp/connect', auth, ownerOnly, async (req, res, { body }) => { try { return await startConnection(req.companyId, numberId(body.number_id)); } catch (e) { throw waError(e); } });
  router.get('/api/whatsapp/state', auth, ownerOnly, async (req, res, { query }) => { try { return await connectionState(req.companyId, numberId(query.number_id)); } catch (e) { throw waError(e); } });
  router.post('/api/whatsapp/disconnect', auth, ownerOnly, async (req, res, { body }) => disconnectWhatsapp(req.companyId, numberId(body.number_id)));
  router.get('/api/whatsapp/numbers', auth, ownerOnly, (req) => numbersOverview(req.companyId));
  router.post('/api/whatsapp/numbers', auth, ownerOnly, (req, res, { body }) => { try { return addNumber(req.companyId, body.label); } catch (e) { throw new HttpError(400, e.message); } });
  router.delete('/api/whatsapp/numbers/:id', auth, ownerOnly, async (req, res, { params }) => ({ ok: await removeNumber(req.companyId, Number(params.id)) }));

  // ---- CRM -------------------------------------------------------------------
  router.get('/api/contacts', auth, (req, res, { query }) => {
    const list = listContacts(req.companyId, query);
    if (proScope(req) === null) return list;
    const own = ownContacts(req);
    return list.filter((c) => own.has(c.id));
  });
  router.post('/api/contacts', auth, (req, res, { body }) => {
    if (!body.name && !body.phone) throw new HttpError(400, 'Informe nome ou telefone');
    if (body.value !== undefined) body.value_cents = cents(body.value || 0);
    try { return createContact(req.companyId, body); } catch (e) {
      if (e instanceof PlanLimitError) throw new HttpError(403, e.message);
      if (/nascimento/.test(e.message)) throw new HttpError(400, e.message);
      throw e;
    }
  });
  // Importação em lote (planilha, contatos do celular ou texto colado; a leitura do arquivo é feita no navegador).
  // Na importação, data de nascimento inválida é ignorada (não derruba a linha).
  const safeBirth = (v) => { try { return normalizeBirthDate(v); } catch { return null; } };
  router.post('/api/contacts/import', auth, staff, (req, res, { body }) => {
    const rows = Array.isArray(body.contacts) ? body.contacts : [];
    if (!rows.length) throw new HttpError(400, 'Nenhum contato para importar');
    if (rows.length > 5000) throw new HttpError(400, 'Importe no máximo 5.000 contatos por vez');
    const stage = STAGES.some((st) => st.id === body.stage) ? body.stage : 'novo';
    const extraTags = String(body.tags || '').trim();
    const sequenceId = int(body.sequence_id);
    if (sequenceId) need(get('SELECT id FROM sequences WHERE id = ? AND company_id = ?', sequenceId, req.companyId), 'Sequência');
    const result = { created: 0, updated: 0, duplicates: 0, invalid: 0, limit_skipped: 0 };
    const seen = new Set();
    transaction(() => {
      for (const r of rows) {
        const phone = normalizePhone(r.phone);
        const validPhone = phone && phone.length >= 10 && phone.length <= 15 ? phone : null;
        const email = String(r.email || '').trim().toLowerCase() || null;
        const name = String(r.name || '').trim();
        if (!name && !validPhone && !email) { result.invalid++; continue; }
        const key = validPhone || email || name.toLowerCase();
        if (seen.has(key)) { result.duplicates++; continue; }
        seen.add(key);
        const existing = (validPhone && get('SELECT * FROM contacts WHERE company_id = ? AND phone = ?', req.companyId, validPhone))
          || (email && get('SELECT * FROM contacts WHERE company_id = ? AND lower(email) = ?', req.companyId, email));
        const tags = [r.tags, extraTags].filter(Boolean).join(', ');
        if (existing) {
          if (!body.update_existing) { result.duplicates++; continue; }
          // Completa só o que está vazio; etiquetas são somadas.
          updateContact(req.companyId, existing.id, {
            name: existing.name || name || undefined, email: existing.email || email || undefined,
            business_name: existing.business_name || r.business_name || undefined, document: existing.document || r.document || undefined,
            birth_date: existing.birth_date || safeBirth(r.birth_date) || undefined,
            tags: [existing.tags, tags].filter(Boolean).join(', ') || undefined,
          });
          result.updated++;
          continue;
        }
        if (leadsRemaining(req.companyId) === 0) { result.limit_skipped++; continue; }
        const c = createContact(req.companyId, {
          name, phone: validPhone, email, business_name: r.business_name, document: r.document, interest: r.interest, birth_date: safeBirth(r.birth_date),
          notes: r.notes, tags, value_cents: r.value ? cents(r.value) : undefined, stage, source: 'importacao',
        }, { trigger: false });
        if (sequenceId) enroll(req.companyId, sequenceId, c.id);
        result.created++;
      }
    });
    return result;
  });

  router.get('/api/contacts/:id', auth, contactGuard, (req, res, { params }) => {
    const contact = need(getContact(req.companyId, params.id), 'Contato');
    return {
      ...contact,
      activities: all('SELECT * FROM activities WHERE contact_id = ? ORDER BY id DESC LIMIT 100', contact.id),
      appointments: listAppointments(req.companyId, { contactId: contact.id }),
      charges: listCharges(req.companyId, { contactId: contact.id }),
      tasks: listTasks(req.companyId, { contactId: contact.id }),
      contracts: req.user.role === 'professional' ? [] : listContracts(req.companyId, { contactId: contact.id, filter: 'todos' })
        .map((k) => (req.user.role === 'owner' ? k : { ...k, value_cents: null })),
      documents: listDocuments(req.companyId, { contactId: contact.id }),
      enrollments: all(
        `SELECT e.*, s.name AS sequence_name, json_array_length(s.steps) AS steps_total FROM enrollments e
         JOIN sequences s ON s.id = e.sequence_id WHERE e.contact_id = ? ORDER BY e.id DESC`, contact.id),
    };
  });
  router.put('/api/contacts/:id', auth, contactGuard, (req, res, { params, body }) => {
    if (body.value !== undefined) body.value_cents = cents(body.value || 0);
    try { return need(updateContact(req.companyId, params.id, body), 'Contato'); } catch (e) {
      if (/nascimento/.test(e.message)) throw new HttpError(400, e.message);
      throw e;
    }
  });
  router.delete('/api/contacts/:id', auth, staff, contactGuard, (req, res, { params }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    run('DELETE FROM contacts WHERE id = ? AND company_id = ?', params.id, req.companyId);
    return { ok: true };
  });
  router.post('/api/contacts/:id/stage', auth, contactGuard, (req, res, { params, body }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    try { return changeStage(req.companyId, Number(params.id), body.stage); } catch (e) { throw new HttpError(400, e.message); }
  });
  router.post('/api/contacts/:id/notes', auth, contactGuard, (req, res, { params, body }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    if (!body.text) throw new HttpError(400, 'Nota vazia');
    logActivity(req.companyId, Number(params.id), 'nota', `${req.user.name}: ${body.text}`);
    return { ok: true };
  });

  // ---- Produtos / serviços ---------------------------------------------------
  router.get('/api/products', auth, (req) => all('SELECT * FROM products WHERE company_id = ? ORDER BY active DESC, name', req.companyId));
  router.post('/api/products', auth, ownerOnly, (req, res, { body }) => {
    if (!body.name) throw new HttpError(400, 'Nome obrigatório');
    const { id } = run(
      'INSERT INTO products (company_id, name, description, price_cents, kind, duration_min, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.companyId, body.name, body.description || '', cents(body.price || 0), body.kind === 'produto' ? 'produto' : 'servico',
      int(body.duration_min) || 0, body.active === false ? 0 : 1,
    );
    return get('SELECT * FROM products WHERE id = ?', id);
  });
  router.put('/api/products/:id', auth, ownerOnly, (req, res, { params, body }) => {
    const p = need(get('SELECT * FROM products WHERE id = ? AND company_id = ?', params.id, req.companyId), 'Produto');
    run('UPDATE products SET name = ?, description = ?, price_cents = ?, kind = ?, duration_min = ?, active = ? WHERE id = ?',
      body.name ?? p.name, body.description ?? p.description, body.price !== undefined ? cents(body.price) : p.price_cents,
      body.kind ?? p.kind, body.duration_min !== undefined ? int(body.duration_min) || 0 : p.duration_min,
      body.active === undefined ? p.active : body.active ? 1 : 0, p.id);
    return get('SELECT * FROM products WHERE id = ?', p.id);
  });
  router.delete('/api/products/:id', auth, ownerOnly, (req, res, { params }) => {
    run('DELETE FROM products WHERE id = ? AND company_id = ?', params.id, req.companyId);
    return { ok: true };
  });

  // ---- Agenda ----------------------------------------------------------------
  router.get('/api/slots', auth, (req, res, { query }) => {
    if (!query.date) throw new HttpError(400, 'Informe a data');
    return availableSlots(req.companyId, query.date, int(query.product_id), int(query.professional_id));
  });
  router.get('/api/appointments', auth, (req, res, { query }) => listAppointments(req.companyId, { ...query, professionalId: proScope(req) ?? int(query.professional_id) }));
  router.post('/api/appointments', auth, (req, res, { body }) => {
    if (body.contact_id) need(getContact(req.companyId, body.contact_id), 'Contato');
    if (body.product_id) need(get('SELECT id FROM products WHERE id = ? AND company_id = ?', body.product_id, req.companyId), 'Produto');
    try {
      return createAppointment(req.companyId, {
        contactId: int(body.contact_id), productId: int(body.product_id), professionalId: proScope(req) ?? int(body.professional_id), title: body.title,
        date: body.date, time: body.time, durationMin: int(body.duration_min), notes: body.notes, force: true,
      });
    } catch (e) { throw new HttpError(400, e.message); }
  });
  const apptGuard = (req, res, { params }) => {
    const appt = getAppointment(req.companyId, params.id);
    if (appt && proScope(req) !== null && appt.professional_id !== proScope(req)) throw new HttpError(404, 'Agendamento não encontrado');
  };
  router.put('/api/appointments/:id', auth, apptGuard, (req, res, { params, body }) => {
    try { return need(updateAppointment(req.companyId, Number(params.id), body), 'Agendamento'); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, e.message);
    }
  });
  router.delete('/api/appointments/:id', auth, apptGuard, async (req, res, { params }) => {
    need(getAppointment(req.companyId, params.id), 'Agendamento');
    await removeAppointmentEvent(req.companyId, Number(params.id));
    run('DELETE FROM appointments WHERE id = ? AND company_id = ?', params.id, req.companyId);
    return { ok: true };
  });

  // ---- Profissionais ---------------------------------------------------------
  router.get('/api/professionals', auth, (req) => listProfessionals(req.companyId));
  router.post('/api/professionals', auth, ownerOnly, (req, res, { body }) => {
    try { return saveProfessional(req.companyId, body); } catch (e) { throw new HttpError(400, e.message); }
  });
  router.put('/api/professionals/:id', auth, ownerOnly, (req, res, { params, body }) => {
    need(getProfessional(req.companyId, Number(params.id)), 'Profissional');
    try { return saveProfessional(req.companyId, body, Number(params.id)); } catch (e) { throw new HttpError(400, e.message); }
  });
  router.delete('/api/professionals/:id', auth, ownerOnly, (req, res, { params }) => {
    deleteProfessional(req.companyId, Number(params.id));
    return { ok: true };
  });

  // ---- Google Agenda ---------------------------------------------------------
  // Dono conecta qualquer profissional (ou a agenda da empresa); o profissional conecta a própria agenda.
  const canManageCalendar = (req, professionalId) => req.user.role === 'owner'
    || (req.user.role === 'professional' && professionalId && Number(professionalId) === req.user.professional_id);
  router.get('/api/google/status', auth, (req) => ({
    configured: googleConfigured(),
    connections: listConnections(req.companyId).filter((c) => req.user.role === 'owner' || c.professional_id === req.user.professional_id),
  }));
  router.post('/api/google/connect', auth, (req, res, { body }) => {
    const professionalId = int(body.professional_id);
    if (!canManageCalendar(req, professionalId)) throw new HttpError(403, 'Seu perfil não pode conectar esta agenda.');
    if (professionalId) need(getProfessional(req.companyId, professionalId), 'Profissional');
    try { return { url: startConnect(req.companyId, { professionalId, userId: req.user.id }) }; } catch (e) {
      if (e instanceof GoogleError) throw new HttpError(400, e.message);
      throw e;
    }
  });
  // O Google devolve a pessoa para cá depois da autorização.
  router.get('/api/google/callback', async (req, res, { query }) => {
    const back = (status, msg = '') => {
      res.writeHead(302, { Location: `/app#/agenda?google=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}` });
      res.end();
    };
    if (query.error) return back('cancelado');
    try {
      const row = consumeState(query.state);
      await withCompanyDb(row.company_id, () => finishConnect(row, query.code));
      return back('conectado');
    } catch (e) {
      return back('erro', e.message);
    }
  });
  router.delete('/api/google/connections/:id', auth, async (req, res, { params }) => {
    const conn = need(listConnections(req.companyId).find((c) => c.id === Number(params.id)), 'Conexão');
    if (!canManageCalendar(req, conn.professional_id)) throw new HttpError(403, 'Seu perfil não pode desconectar esta agenda.');
    await disconnect(req.companyId, conn.id);
    return { ok: true };
  });
  router.post('/api/google/sync', auth, async (req) => {
    for (const c of all("SELECT * FROM google_connections WHERE company_id = ? AND status = 'ok'", req.companyId)) {
      if (canManageCalendar(req, c.professional_id)) await refreshBusy(c).catch(() => {});
    }
    return { ok: true, connections: listConnections(req.companyId) };
  });

  // ---- Atendimento (inbox) ---------------------------------------------------
  // Filtro por responsável: scope=mine (minhas), unassigned (sem responsável) ou todas.
  router.get('/api/conversations', auth, (req, res, { query }) => {
    const where = ['c.company_id = ?'];
    const params = [req.companyId];
    if (query.q) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${query.q}%`, `%${query.q}%`); }
    if (query.scope === 'mine') { where.push('c.assigned_user_id = ?'); params.push(req.user.id); }
    if (query.scope === 'unassigned') where.push('c.assigned_user_id IS NULL');
    // Número por onde o cliente falou por último (vazio = principal).
    const lastChannel = "(SELECT channel_id FROM messages WHERE contact_id = c.id AND direction = 'in' ORDER BY id DESC LIMIT 1)";
    if (query.number === 'principal') where.push(`${lastChannel} IS NULL`);
    else if (query.number) { where.push(`${lastChannel} = ?`); params.push(Number(query.number)); }
    const names = userNames(req.companyId);
    return all(
      `SELECT c.id, c.name, c.phone, c.stage, c.ai_enabled, c.unread, c.assigned_user_id, m.body AS last_body, m.direction AS last_direction,
              m.author AS last_author, m.created_at AS last_at, ${lastChannel} AS channel_id
       FROM contacts c JOIN messages m ON m.id = (SELECT MAX(id) FROM messages WHERE contact_id = c.id)
       WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 200`, ...params,
    ).filter((c) => visible(req, c.id)).map((c) => ({ ...c, last_body: friendlyBody(c.last_body), assigned_name: names[c.assigned_user_id] || null }));
  });
  router.get('/api/conversations/:id/messages', auth, contactGuard, (req, res, { params, query }) => {
    const contact = need(getContact(req.companyId, params.id), 'Contato');
    // ?ids=1,2: só estas mensagens (a tela acompanha as mídias que ainda estão baixando).
    if (query.ids) {
      const ids = String(query.ids).split(',').map(Number).filter(Boolean).slice(0, 50);
      return { messages: ids.length ? all(`SELECT * FROM messages WHERE contact_id = ? AND id IN (${ids.map(() => '?').join(',')})`, contact.id, ...ids).map(presentMessage) : [] };
    }
    run('UPDATE contacts SET unread = 0 WHERE id = ?', contact.id);
    const after = int(query.after) || 0;
    return {
      contact: { ...contact, assigned_name: userNames(req.companyId)[contact.assigned_user_id] || null },
      messages: all('SELECT * FROM messages WHERE contact_id = ? AND id > ? ORDER BY id DESC LIMIT 300', contact.id, after).reverse().map(presentMessage),
    };
  });
  // Foto, áudio, vídeo ou documento recebido: só para quem pode ver a conversa.
  const messageGuard = (req, res, { params }) => {
    const m = get('SELECT contact_id FROM messages WHERE id = ? AND company_id = ?', Number(params.id), req.companyId);
    if (!m || !visible(req, m.contact_id)) throw new HttpError(404, 'Mensagem não encontrada');
  };
  router.get('/api/messages/:id/media', auth, messageGuard, (req, res, { params }) => {
    const file = need(mediaFile(req.companyId, Number(params.id)), 'Arquivo');
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': file.data.length,
      'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    res.end(file.data);
  });
  router.post('/api/messages/:id/media/retry', auth, messageGuard, async (req, res, { params }) => presentMessage(need(await retryMedia(req.companyId, Number(params.id)), 'Mensagem')));

  router.post('/api/conversations/:id/messages', auth, contactGuard, async (req, res, { params, body }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    if (!body.body?.trim()) throw new HttpError(400, 'Mensagem vazia');
    if (coldBlocked(getCompany(req.companyId), Number(params.id), 'human')) {
      throw new HttpError(429, `Limite de ${COLD_DAILY_LIMIT} primeiras mensagens por dia para quem ainda não falou com você (protege o seu número de bloqueio no WhatsApp). Continua amanhã.`);
    }
    // Quando alguém da equipe responde, a IA sai da conversa para não atropelar o humano.
    if (run('UPDATE contacts SET ai_enabled = 0 WHERE id = ? AND ai_enabled = 1', params.id).changes) {
      logActivity(req.companyId, Number(params.id), 'ia', `${req.user.name} assumiu a conversa`);
    }
    // Conversa sem responsável fica com quem respondeu.
    if (!getContact(req.companyId, params.id).assigned_user_id && req.user.role !== 'professional') {
      assignContact(req.companyId, Number(params.id), req.user.id, req.user);
    }
    return sendMessage(req.companyId, Number(params.id), body.body.trim(), 'human', { user: req.user });
  });
  // Assumir, passar para outro atendente ou tirar o responsável (user_id vazio).
  router.post('/api/conversations/:id/assign', auth, staff, contactGuard, (req, res, { params, body }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    try {
      const contact = assignContact(req.companyId, Number(params.id), int(body.user_id), req.user);
      return { ...contact, assigned_name: userNames(req.companyId)[contact.assigned_user_id] || null };
    } catch (e) { throw new HttpError(400, e.message); }
  });
  // Teste grátis: IA bloqueada (o front mostra o cadeado que leva para a assinatura).
  const needAi = (req) => {
    if (!aiAllowed(getCompany(req.companyId))) throw new HttpError(402, `A IA faz parte do plano ${PLANS[UPGRADE_PLAN].label}. Assine para desbloquear.`);
  };
  router.post('/api/conversations/:id/ai', auth, contactGuard, (req, res, { params, body }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    if (body.enabled) needAi(req);
    run('UPDATE contacts SET ai_enabled = ? WHERE id = ?', body.enabled ? 1 : 0, params.id);
    logActivity(req.companyId, Number(params.id), 'ia', body.enabled ? 'IA reativada na conversa' : `${req.user.name} assumiu a conversa`);
    return getContact(req.companyId, params.id);
  });
  router.post('/api/conversations/:id/ai-reply', auth, contactGuard, async (req, res, { params }) => {
    need(getContact(req.companyId, params.id), 'Contato');
    needAi(req);
    return (await replyNow(req.companyId, Number(params.id))) || { skipped: true };
  });
  // Simula uma mensagem chegando do WhatsApp (para testar sem conectar um número).
  router.post('/api/simulator/inbound', auth, (req, res, { body }) => {
    if (!body.phone || !body.text) throw new HttpError(400, 'Informe telefone e mensagem');
    const r = handleInbound(req.companyId, { phone: body.phone, name: body.name, text: body.text });
    return r || { duplicated: true };
  });

  // ---- Clientes, contratos e documentos ---------------------------------------
  //
  // Dono e atendentes gerenciam contratos (valores só para o dono, como no resto do financeiro).
  // Profissional vê os próprios clientes e os documentos deles, sem contratos.
  const hideValues = (req, k) => (req.user.role === 'owner' ? k : { ...k, value_cents: null });
  const by = (req) => req.user.name;
  const contractGuard = (req, res, { params }) => {
    const k = need(getContract(req.companyId, Number(params.id)), 'Contrato');
    if (!visible(req, k.contact_id)) throw new HttpError(404, 'Contrato não encontrado');
    return undefined;
  };
  const tryIt = (fn) => { try { return fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); } };

  router.get('/api/clients', auth, (req, res, { query }) => {
    const names = userNames(req.companyId);
    return listClients(req.companyId, { q: query.q }).filter((c) => visible(req, c.id))
      .map((c) => ({ ...c, assigned_name: names[c.assigned_user_id] || null }));
  });
  // Aniversariantes (todos os contatos, leads e clientes): do mês e dos próximos 7 dias.
  router.get('/api/birthdays', auth, (req, res, { query }) => {
    const month = Math.min(Math.max(int(query.month) || Number(new Date().toISOString().slice(5, 7)), 1), 12);
    return { month, list: listBirthdays(req.companyId, month).filter((c) => visible(req, c.id)), soon: birthdaysSoon(req.companyId).filter((c) => visible(req, c.id)) };
  });
  router.get('/api/clients/summary', auth, staff, (req) => {
    const s = contractsSummary(req.companyId);
    return req.user.role === 'owner' ? s : { ...s, monthly_recurring_cents: null };
  });

  router.get('/api/contracts', auth, staff, (req, res, { query }) => listContracts(req.companyId, { contactId: int(query.contact_id), filter: query.filter })
    .map((k) => hideValues(req, k)));
  router.post('/api/contracts', auth, staff, (req, res, { body }) => {
    if (body.value !== undefined && req.user.role === 'owner') body.value_cents = cents(body.value || 0);
    else delete body.value_cents;
    return hideValues(req, tryIt(() => createContract(req.companyId, { ...body, contact_id: int(body.contact_id) }, { by: by(req) })));
  });
  router.put('/api/contracts/:id', auth, staff, contractGuard, (req, res, { params, body }) => {
    // Atendente não vê nem altera valores.
    if (body.value !== undefined && req.user.role === 'owner') body.value_cents = cents(body.value || 0);
    else delete body.value_cents;
    return hideValues(req, tryIt(() => updateContract(req.companyId, Number(params.id), body, { by: by(req) })));
  });
  router.post('/api/contracts/:id/renew', auth, staff, contractGuard, (req, res, { params, body }) => hideValues(req, tryIt(() => renewContract(req.companyId, Number(params.id), {
    endDate: body.end_date || undefined, valueCents: req.user.role === 'owner' && body.value ? cents(body.value) : undefined, by: by(req),
  }))));
  router.post('/api/contracts/:id/close', auth, staff, contractGuard, (req, res, { params, body }) => hideValues(req, tryIt(() => closeContract(req.companyId, Number(params.id), body.status || 'encerrado', { by: by(req) }))));
  router.delete('/api/contracts/:id', auth, ownerOnly, contractGuard, (req, res, { params }) => ({ ok: deleteContract(req.companyId, Number(params.id)) }));

  // Documentos gerais (sem cliente) são só de dono e atendentes.
  const docGuard = (req, res, { params }) => {
    const d = need(getDocument(req.companyId, Number(params.id)), 'Documento');
    if (d.contact_id ? !visible(req, d.contact_id) : req.user.role === 'professional') throw new HttpError(404, 'Documento não encontrado');
    return undefined;
  };
  router.get('/api/documents', auth, (req, res, { query }) => {
    if (query.contact_id && !visible(req, query.contact_id)) throw new HttpError(404, 'Contato não encontrado');
    return listDocuments(req.companyId, {
      contactId: int(query.contact_id), contractId: int(query.contract_id), q: query.q, scope: query.scope,
      contactIds: proScope(req) === null ? null : ownContacts(req),
    });
  });
  router.post('/api/documents', auth, (req, res, { body }) => {
    const contactId = int(body.contact_id);
    if (contactId ? !visible(req, contactId) : req.user.role === 'professional') throw new HttpError(403, 'Seu perfil só anexa documentos aos próprios clientes.');
    if (body.contract_id && req.user.role === 'professional') throw new HttpError(403, 'Seu perfil não tem acesso a contratos.');
    return tryIt(() => addDocument(req.companyId, { ...body, contactId, contractId: int(body.contract_id) }, { by: by(req) }));
  });
  router.get('/api/documents/:id/content', auth, docGuard, (req, res, { params }) => documentContent(req.companyId, Number(params.id)));
  router.put('/api/documents/:id', auth, staff, docGuard, (req, res, { params, body }) => tryIt(() => updateDocument(req.companyId, Number(params.id), {
    category: body.category, contractId: body.contract_id === undefined ? undefined : int(body.contract_id),
  })));
  router.delete('/api/documents/:id', auth, staff, docGuard, (req, res, { params }) => ({ ok: deleteDocument(req.companyId, Number(params.id), { by: by(req) }) }));

  // ---- Follow-up -------------------------------------------------------------
  const cleanSteps = (steps) => (Array.isArray(steps) ? steps : []).filter((s) => s.message?.trim()).map((s) => ({
    delay_hours: Math.max(0, Number(s.delay_hours) || 0), message: s.message.trim(), use_ai: Boolean(s.use_ai),
  }));
  router.get('/api/sequences', auth, staff, (req) => listSequences(req.companyId));
  router.post('/api/sequences', auth, staff, (req, res, { body }) => {
    if (!body.name) throw new HttpError(400, 'Nome obrigatório');
    const { id } = run('INSERT INTO sequences (company_id, name, trigger, steps, stop_on_reply, active) VALUES (?, ?, ?, ?, ?, ?)',
      req.companyId, body.name, body.trigger || 'manual', JSON.stringify(cleanSteps(body.steps)), body.stop_on_reply === false ? 0 : 1, body.active === false ? 0 : 1);
    return parseSequence(get('SELECT * FROM sequences WHERE id = ?', id));
  });
  router.put('/api/sequences/:id', auth, staff, (req, res, { params, body }) => {
    const s = need(parseSequence(get('SELECT * FROM sequences WHERE id = ? AND company_id = ?', params.id, req.companyId)), 'Sequência');
    run('UPDATE sequences SET name = ?, trigger = ?, steps = ?, stop_on_reply = ?, active = ? WHERE id = ?',
      body.name ?? s.name, body.trigger ?? s.trigger, JSON.stringify(body.steps ? cleanSteps(body.steps) : s.steps),
      body.stop_on_reply === undefined ? s.stop_on_reply : body.stop_on_reply ? 1 : 0,
      body.active === undefined ? s.active : body.active ? 1 : 0, s.id);
    return parseSequence(get('SELECT * FROM sequences WHERE id = ?', s.id));
  });
  router.delete('/api/sequences/:id', auth, staff, (req, res, { params }) => {
    run('DELETE FROM sequences WHERE id = ? AND company_id = ?', params.id, req.companyId);
    return { ok: true };
  });
  router.post('/api/sequences/:id/enroll', auth, staff, (req, res, { params, body }) => {
    need(get('SELECT id FROM sequences WHERE id = ? AND company_id = ?', params.id, req.companyId), 'Sequência');
    const ids = (body.contact_ids || []).map(Number).filter((id) => getContact(req.companyId, id));
    return { enrolled: ids.map((id) => enroll(req.companyId, Number(params.id), id)).filter(Boolean).length };
  });
  router.get('/api/enrollments', auth, staff, (req, res, { query }) => all(
    `SELECT e.*, c.name AS contact_name, c.phone AS contact_phone, s.name AS sequence_name, json_array_length(s.steps) AS steps_total
     FROM enrollments e JOIN contacts c ON c.id = e.contact_id JOIN sequences s ON s.id = e.sequence_id
     WHERE e.company_id = ? ${query.sequence_id ? 'AND e.sequence_id = ?' : ''} ORDER BY e.id DESC LIMIT 300`,
    req.companyId, ...(query.sequence_id ? [query.sequence_id] : []),
  ));
  router.post('/api/enrollments/:id/stop', auth, staff, (req, res, { params }) => {
    run("UPDATE enrollments SET status = 'parado', stop_reason = 'parado manualmente' WHERE id = ? AND company_id = ? AND status = 'ativo'", params.id, req.companyId);
    return { ok: true };
  });

  // ---- Cobrança --------------------------------------------------------------
  router.get('/api/charges', auth, ownerOnly, (req, res, { query }) => listCharges(req.companyId, query));
  router.post('/api/charges', auth, ownerOnly, async (req, res, { body }) => {
    let description = body.description;
    let amountCents = body.amount ? cents(body.amount) : 0;
    if (body.product_id) {
      const p = need(get('SELECT * FROM products WHERE id = ? AND company_id = ?', body.product_id, req.companyId), 'Produto');
      description = description || p.name;
      amountCents = amountCents || p.price_cents;
    }
    if (body.contact_id) need(getContact(req.companyId, body.contact_id), 'Contato');
    try {
      return await createCharge(req.companyId, {
        contactId: int(body.contact_id), productId: int(body.product_id), description, amountCents,
        dueDate: body.due_date, send: body.send !== false,
      });
    } catch (e) { throw new HttpError(400, e.message); }
  });
  router.post('/api/charges/:id/paid', auth, ownerOnly, async (req, res, { params }) => {
    need(getCharge(req.companyId, params.id), 'Cobrança');
    return markPaid(req.companyId, Number(params.id), { via: 'baixa manual' });
  });
  router.post('/api/charges/:id/cancel', auth, ownerOnly, (req, res, { params }) => need(cancelCharge(req.companyId, Number(params.id)), 'Cobrança'));
  router.post('/api/charges/:id/resend', auth, ownerOnly, async (req, res, { params }) => {
    const charge = need(getCharge(req.companyId, params.id), 'Cobrança');
    if (!charge.contact_id) throw new HttpError(400, 'Cobrança sem contato');
    const contact = getContact(req.companyId, charge.contact_id);
    return sendMessage(req.companyId, contact.id, chargeMessage(charge.status === 'vencido' ? 'after' : 'new', charge, contact), 'billing');
  });

  // ---- Tarefas da equipe -----------------------------------------------------
  router.get('/api/tasks', auth, (req, res, { query }) => {
    const tasks = listTasks(req.companyId, query);
    if (proScope(req) === null) return tasks;
    const own = ownContacts(req);
    return tasks.filter((t) => t.contact_id && own.has(t.contact_id));
  });
  const taskGuard = (req, res, { params }) => {
    const task = getTask(req.companyId, Number(params.id));
    if (task && proScope(req) !== null && !visible(req, task.contact_id)) throw new HttpError(404, 'Tarefa não encontrada');
    if (task?.type === 'aprovar_cobranca' && req.user.role !== 'owner') throw new HttpError(403, 'Só o dono da conta aprova cobranças.');
  };
  router.post('/api/tasks', auth, async (req, res, { body }) => {
    if (!body.title) throw new HttpError(400, 'Informe o título da tarefa');
    if (body.contact_id) need(getContact(req.companyId, body.contact_id), 'Contato');
    return createTask(req.companyId, {
      contactId: int(body.contact_id), type: TASK_TYPES.some((t) => t.id === body.type) ? body.type : 'outro',
      title: body.title, details: body.details || '', dueAt: body.due_at || undefined,
    });
  });
  router.post('/api/tasks/:id/complete', auth, taskGuard, (req, res, { params }) => need(completeTask(req.companyId, Number(params.id)), 'Tarefa'));
  router.post('/api/tasks/:id/cancel', auth, taskGuard, (req, res, { params }) => need(completeTask(req.companyId, Number(params.id), 'cancelada'), 'Tarefa'));
  // Aprovar: executa o que a IA pediu (enviar cobrança ou confirmar o horário reservado).
  router.post('/api/tasks/:id/approve', auth, taskGuard, async (req, res, { params }) => {
    const task = need(getTask(req.companyId, Number(params.id)), 'Tarefa');
    if (task.status !== 'aberta') throw new HttpError(400, 'Tarefa já encerrada');
    if (task.type === 'aprovar_cobranca') {
      const p = task.payload;
      try {
        await createCharge(req.companyId, { contactId: task.contact_id, productId: p.product_id, description: p.description, amountCents: p.amount_cents, dueDate: p.due_date || undefined, send: true });
      } catch (e) { throw new HttpError(400, e.message); }
    } else if (task.type === 'confirmar_agendamento') {
      updateAppointment(req.companyId, task.payload.appointment_id, { status: 'confirmado' });
    } else {
      throw new HttpError(400, 'Esta tarefa não tem aprovação');
    }
    return completeTask(req.companyId, task.id);
  });
  router.post('/api/tasks/:id/reject', auth, taskGuard, async (req, res, { params }) => {
    const task = need(getTask(req.companyId, Number(params.id)), 'Tarefa');
    if (task.type === 'confirmar_agendamento' && task.status === 'aberta') {
      updateAppointment(req.companyId, task.payload.appointment_id, { status: 'cancelado' });
    }
    return completeTask(req.companyId, task.id, 'cancelada');
  });

  // ---- Descontos e promoções: indique e ganhe, MEI -------------------------------
  router.get('/api/referral', auth, (req) => referralOverview(req.companyId, req.user.id));
  router.post('/api/referral/redeem', auth, ownerOnly, (req, res, { body }) => tryIt(() => redeemCode(req.companyId, body.code)));
  router.get('/api/mei', auth, ownerOnly, (req) => meiStatus(req.companyId));
  router.post('/api/mei', auth, ownerOnly, async (req, res, { body }) => {
    try { return await submitMei(req.companyId, req.user, body); } catch (e) { throw new HttpError(400, e.message); }
  });

  // ---- Processos (advocacia) -------------------------------------------------
  // Só com o módulo ligado; quem atende (dono e atendentes) acompanha os processos.
  const legal = (req) => {
    if (!processesEnabled(getCompany(req.companyId))) throw new HttpError(404, 'O módulo de Processos não está ligado para esta empresa.');
  };
  router.get('/api/legal/overview', auth, staff, legal, (req) => ({
    limit: caseLimit(req.companyId), oabs: listOabs(req.companyId), cases: listCases(req.companyId),
    news: listNews(req.companyId), unlinked: listUnlinked(req.companyId), unread: unreadCount(req.companyId),
  }));
  router.get('/api/legal/unread', auth, staff, legal, (req) => ({ unread: unreadCount(req.companyId) }));
  router.post('/api/legal/check-cnj', auth, staff, legal, (req, res, { body }) => tryIt(() => parseCnj(body.cnj)));
  router.get('/api/legal/cases', auth, staff, legal, (req, res, { query }) => listCases(req.companyId, { contactId: int(query.contact_id) }));
  router.post('/api/legal/cases', auth, staff, legal, (req, res, { body }) => tryIt(() => createCase(req.companyId, body)));
  router.get('/api/legal/cases/:id', auth, staff, legal, (req, res, { params }) => need(getCase(req.companyId, Number(params.id)), 'Processo'));
  router.put('/api/legal/cases/:id', auth, staff, legal, (req, res, { params, body }) => need(tryIt(() => updateCase(req.companyId, Number(params.id), body)), 'Processo'));
  router.delete('/api/legal/cases/:id', auth, staff, legal, (req, res, { params }) => ({ ok: deleteCase(req.companyId, Number(params.id)) }));
  router.post('/api/legal/cases/:id/refresh', auth, staff, legal, (req, res, { params }) => need(tryIt(() => refreshCase(req.companyId, Number(params.id))), 'Processo'));
  router.get('/api/legal/events/:id', auth, staff, legal, (req, res, { params }) => need(getEvent(req.companyId, Number(params.id)), 'Intimação'));
  router.post('/api/legal/read', auth, staff, legal, (req, res, { body }) => ({ marked: markRead(req.companyId, { ids: body.ids, caseId: int(body.case_id) }) }));
  router.get('/api/legal/oabs', auth, staff, legal, (req) => listOabs(req.companyId));
  router.post('/api/legal/oabs', auth, ownerOnly, legal, (req, res, { body }) => tryIt(() => saveOab(req.companyId, body)));
  router.put('/api/legal/oabs/:id', auth, ownerOnly, legal, (req, res, { params, body }) => need(tryIt(() => saveOab(req.companyId, body, Number(params.id))), 'OAB'));
  router.delete('/api/legal/oabs/:id', auth, ownerOnly, legal, (req, res, { params }) => ({ ok: deleteOab(req.companyId, Number(params.id)) }));

  // ---- Prospecção ------------------------------------------------------------
  router.post('/api/prospecting/search', auth, staff, async (req, res, { body }) => {
    try { return await searchPlaces(req.companyId, body.query, { maxResults: Math.min(int(body.max) || 60, 60) }); } catch (e) {
      throw new HttpError(400, e.message);
    }
  });
  router.get('/api/prospecting/searches', auth, staff, (req) => listSearches(req.companyId));
  router.get('/api/prospecting/searches/:id', auth, staff, (req, res, { params }) => need(getSearch(req.companyId, Number(params.id)), 'Busca'));
  router.post('/api/prospecting/import', auth, staff, (req, res, { body }) => {
    try {
      const ids = importProspects(req.companyId, (body.prospect_ids || []).map(Number), { sequenceId: int(body.sequence_id) });
      return { imported: ids.length };
    } catch (e) {
      if (e instanceof PlanLimitError) throw new HttpError(403, e.message);
      throw e;
    }
  });

  // ---- Dashboard -------------------------------------------------------------
  router.get('/api/dashboard', auth, (req, res, { query }) => {
    const data = getDashboard(req.companyId, Math.min(Math.max(int(query.days) || 30, 7), 365));
    if (req.user.role === 'owner') return data;
    // Atendentes e profissionais não veem os números financeiros.
    for (const k of ['revenue_cents', 'receivable_cents', 'overdue_cents', 'overdue_count', 'pipeline_cents']) data.metrics[k] = null;
    data.metrics.series = data.metrics.series.map((x) => ({ ...x, revenue_cents: null }));
    data.overdue = [];
    return { ...data, financial_hidden: true };
  });
  router.post('/api/dashboard/insights', auth, ownerOnly, async (req, res, { body }) => {
    needAi(req);
    const company = getCompany(req.companyId);
    const metrics = getMetrics(req.companyId, int(body.days) || 30);
    delete metrics.series;
    try { return { text: await generateInsights(company, metrics) }; } catch (e) { throw new HttpError(502, `Falha na IA: ${e.message}`); }
  });

  // ---- Assinatura (paywall do teste grátis) ------------------------------------
  //
  // Pagamento por Pix na chave da plataforma; o cliente envia o comprovante por e-mail e o
  // administrador muda o plano no painel. O identificador do Pix aponta qual empresa pagou.
  router.get('/api/upgrade', auth, (req) => {
    const company = getCompany(req.companyId);
    const txid = upgradeTxid(company);
    // Planos pagos, cada um com o Pix do valor dele (mesma chave, identificador da empresa).
    const plans = publicPlans().filter((p) => p.price_cents > 0).map((p) => ({
      ...p,
      recommended: p.id === RECOMMENDED_PLAN,
      pix_code: config.platformPixKey
        ? pixPayload({ key: config.platformPixKey, name: config.platformPixName, city: config.platformPixCity, amountCents: p.price_cents, txid })
        : null,
    }));
    return {
      plans, current_plan: company.plan, ai_locked: !aiAllowed(company), expired: accessExpired(company), txid, requested_plan: company.upgrade_plan || null,
      card_enabled: stripeEnabled(),
      stripe_pix: stripePixBlockedUntil <= Date.now(),
      subscription: {
        method: company.billing_method, status: company.subscription_status, paid_until: company.paid_until,
        cancel_at_period_end: Boolean(company.cancel_at_period_end), has_card: Boolean(company.stripe_customer_id), ...subscriptionState(company),
      },
      pix_key: config.platformPixKey || null, pix_name: config.platformPixName, email: config.salesEmail, sales_whatsapp: config.salesWhatsapp,
    };
  });
  // Cartão: abre a página de pagamento do Stripe; depois, a área do cliente para trocar cartão ou cancelar.
  router.post('/api/upgrade/card', auth, ownerOnly, async (req, res, { body }) => {
    try { return await createCheckout(getCompany(req.companyId), req.user, body.plan); } catch (e) { throw new HttpError(400, e.message); }
  });
  // Pix pelo Stripe. Se a conta do Stripe ainda não tem o Pix ativado, a tela usa o Pix pela chave da
  // plataforma (copia e cola + comprovante), em vez de mostrar o erro do Stripe ao cliente.
  router.post('/api/upgrade/pix', auth, ownerOnly, async (req, res, { body }) => {
    if (stripePixBlockedUntil > Date.now()) return { manual: true };
    try { return await createPixCheckout(getCompany(req.companyId), req.user, body.plan); } catch (e) {
      if (/pix/i.test(e.message) && /invalid|activated|not enabled|not available/i.test(e.message)) {
        if (!stripePixBlockedUntil) console.error('[assinatura] O Stripe recusou o Pix (não ativado na conta). Usando o Pix pela chave da plataforma. Detalhe:', e.message);
        stripePixBlockedUntil = Date.now() + 3600000;
        return { manual: true };
      }
      throw new HttpError(400, e.message);
    }
  });
  router.post('/api/upgrade/change', auth, ownerOnly, async (req, res, { body }) => {
    try { return await changeCardPlan(getCompany(req.companyId), body.plan); } catch (e) { throw new HttpError(400, e.message); }
  });
  router.post('/api/upgrade/portal', auth, ownerOnly, async (req) => {
    try { return await createPortal(getCompany(req.companyId)); } catch (e) { throw new HttpError(400, e.message); }
  });
  // "Já enviei o comprovante": fica no histórico do painel do administrador.
  router.post('/api/upgrade/notify', auth, (req, res, { body }) => {
    const company = getCompany(req.companyId);
    const planId = PLANS[body.plan]?.price_cents > 0 ? body.plan : UPGRADE_PLAN;
    const plan = PLANS[planId];
    // Fica marcado na empresa até o administrador ativar (ou mudar) o plano.
    main.run('UPDATE companies SET upgrade_plan = ?, upgrade_requested_at = ? WHERE id = ?', planId, now(), company.id);
    audit(`usuario:${req.user.email}`, 'pedido de assinatura', company.id,
      `plano ${plan.label} (${(plan.price_cents / 100).toFixed(2).replace('.', ',')}/mês) via Pix, identificador ${upgradeTxid(company)}; comprovante enviado para ${config.salesEmail}`);
    return { ok: true };
  });

  // Executa as automações agora (útil para testar follow-ups e lembretes).
  router.post('/api/automations/run', auth, staff, async () => {
    await tick();
    return { ok: true, at: now() };
  });
}
