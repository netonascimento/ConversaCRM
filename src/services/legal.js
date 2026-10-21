import crypto from 'node:crypto';
import { all, get, run, now, forEachDatabase } from '../db.js';
import { config } from '../config.js';
import { getCompany } from './company.js';
import { PLANS, accessExpired } from './plans.js';
import { sendToPhone } from './messaging.js';
import { summarizeLegalEvent } from './ai.js';
import { zonedParts } from './time.js';

// Processos (advocacia): o escritório cadastra os processos e a OAB dos advogados, e o Conversa CRM
// avisa quando sai intimação no Diário (DJEN) ou movimentação no tribunal (DataJud).
//
// Fontes públicas e gratuitas do CNJ, por trás de "provedores" com o mesmo formato de evento, para
// dar para acrescentar um fornecedor pago depois sem mexer no resto:
// - DJEN (Comunica API): intimações e publicações, em dia; por OAB/UF ou número do processo.
//   Limite de 20 consultas por minuto para a plataforma toda: todas passam por uma fila.
// - DataJud: capa e movimentações. Costuma ter semanas de atraso e não traz processos em segredo.
//
// O histórico que já existia quando o processo (ou a OAB) é cadastrado entra sem alerta.
// O sistema nunca afirma prazo final: no máximo aponta o prazo mencionado, pedindo conferência.

const DJEN_URL = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const DATAJUD_URL = 'https://api-publica.datajud.cnj.jus.br';
const OAB_EVERY_H = 3; // intimações por OAB: várias vezes ao dia
const CASE_EVERY_H = 12; // processo: intimações pelo número e movimentações
const OAB_FIRST_DAYS = 30; // ao cadastrar a OAB, traz o último mês (sem alerta)
const OAB_WINDOW_DAYS = 3; // nas verificações seguintes, os últimos dias
const DIGEST_HOUR = 18; // resumo diário das novidades que não são urgentes

let fetchImpl = (...args) => fetch(...args);
/** Permite simular as APIs do CNJ nos testes. */
export function setLegalFetch(fn) { fetchImpl = fn; }
let notifyImpl = sendToPhone;
/** Permite capturar os avisos nos testes. */
export function setLegalNotify(fn) { notifyImpl = fn; }

// ---- Módulo e limites -------------------------------------------------------------------

/** O módulo aparece sozinho para Advocacia; para as outras empresas, só o administrador libera (painel admin). */
export const processesEnabled = (company) => company.segment === 'advocacia' || Boolean(company.processes_module);
/** Processos que o plano permite acompanhar (null = sem limite; plano fora da tabela: sem limite). */
export const maxProcesses = (company) => (PLANS[company.plan] ? PLANS[company.plan].max_processes ?? null : null);
const maxOabs = (company) => Math.max(1, company.max_users || 1);

// ---- Número CNJ -------------------------------------------------------------------------

const UF = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SE', 'SP', 'TO'];
const MILITARY = { 13: 'TJMMG', 21: 'TJMRS', 26: 'TJMSP' };

/** Tribunal pelo segmento (J) e código do tribunal (TR) do número. alias = endpoint no DataJud. */
function courtOf(j, tr) {
  const n = Number(tr);
  if (j === '8' && UF[n - 1]) return UF[n - 1] === 'DF' ? { court: 'TJDFT', alias: 'tjdft' } : { court: `TJ${UF[n - 1]}`, alias: `tj${UF[n - 1].toLowerCase()}` };
  if (j === '4' && n >= 1 && n <= 6) return { court: `TRF${n}`, alias: `trf${n}` };
  if (j === '5') return n === 0 ? { court: 'TST', alias: 'tst' } : n <= 24 ? { court: `TRT${n}`, alias: `trt${n}` } : null;
  if (j === '6') return n === 0 ? { court: 'TSE', alias: 'tse' } : UF[n - 1] ? { court: `TRE-${UF[n - 1]}`, alias: `tre-${UF[n - 1].toLowerCase()}` } : null;
  if (j === '9' && MILITARY[n]) return { court: MILITARY[n], alias: MILITARY[n].toLowerCase() };
  if (j === '7') return { court: 'STM', alias: 'stm' };
  if (j === '3') return { court: 'STJ', alias: 'stj' };
  if (j === '1') return { court: 'STF', alias: null };
  return null;
}

export const maskCnj = (d) => (d && d.length === 20 ? `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}` : d);

/** Confere o número (dígito verificador, módulo 97) e descobre o tribunal. Lança erro com a explicação. */
export function parseCnj(input) {
  const d = String(input || '').replace(/\D/g, '');
  if (d.length !== 20) throw new Error('O número do processo tem 20 dígitos (ex.: 0001234-56.2024.8.26.0100).');
  const [n, dd, year, j, tr, origin] = [d.slice(0, 7), d.slice(7, 9), d.slice(9, 13), d.slice(13, 14), d.slice(14, 16), d.slice(16)];
  const check = 98n - (BigInt(`${n}${year}${j}${tr}${origin}00`) % 97n);
  if (check !== BigInt(dd)) throw new Error('Número do processo inválido: o dígito verificador não confere. Confira se digitou certo.');
  const court = courtOf(j, tr);
  if (!court) throw new Error('Não reconhecemos o tribunal deste número de processo.');
  return { cnj: d, masked: maskCnj(d), ...court };
}

// ---- Fila de consultas -------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let djenNext = 0;
let datajudNext = 0;
const DJEN_GAP_MS = Number(process.env.DJEN_GAP_MS ?? 3500); // ~17 por minuto, abaixo do limite de 20
const DATAJUD_GAP_MS = Number(process.env.DATAJUD_GAP_MS ?? 1000);

// Erro de fonte: a mensagem é para a tela (amigável); o detalhe técnico vai só para o log.
class SourceError extends Error {}
const DJEN_DOWN = 'Não conseguimos consultar o Diário (DJEN) agora. Tentamos de novo sozinhos nas próximas horas.';
const DATAJUD_DOWN = 'Não conseguimos consultar o tribunal (DataJud) agora. Tentamos de novo sozinhos nas próximas horas.';

// Situação da última consulta ao Diário, para o /health: ok, bloqueado (fora do Brasil) ou fora do ar.
let djenStatus = 'sem_consulta';
export const djenHealth = () => djenStatus;
const logged = new Set();
const logOnce = (key, ...msg) => { if (!logged.has(key)) { logged.add(key); console.error(...msg); } };

async function djenGet(params) {
  const wait = djenNext - Date.now();
  if (wait > 0) await sleep(wait);
  djenNext = Date.now() + DJEN_GAP_MS;
  const qs = new URLSearchParams(params);
  // Ponto de saída no Brasil (o Diário recusa consultas de fora do país).
  const url = config.djenProxyUrl ? `${config.djenProxyUrl}?${qs}` : `${DJEN_URL}?${qs}`;
  const headers = config.djenProxyUrl ? { Accept: 'application/json', 'x-proxy-token': config.djenProxyToken, 'x-region': 'sa-east-1' } : { Accept: 'application/json' };
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    djenStatus = 'fora_do_ar';
    logOnce(`djen-net-${err.name}`, `[processos] DJEN sem resposta (${err.name === 'TimeoutError' ? 'demorou mais de 30s' : err.message})`);
    throw new SourceError(DJEN_DOWN);
  }
  // Chegou no limite: a próxima consulta espera um minuto.
  if (res.status === 429 || res.headers?.get?.('x-ratelimit-remaining') === '0') djenNext = Date.now() + 60000;
  if (res.status === 403) {
    djenStatus = 'bloqueado';
    logOnce('djen-403', `[processos] DJEN recusou a consulta (HTTP 403).${config.djenProxyUrl ? ' Confira o ponto de saída (DJEN_PROXY_URL/DJEN_PROXY_TOKEN).' : ' O Diário só aceita consultas do Brasil: configure DJEN_PROXY_URL.'}`);
    throw new SourceError(DJEN_DOWN);
  }
  if (!res.ok) {
    djenStatus = 'fora_do_ar';
    logOnce(`djen-${res.status}`, `[processos] DJEN respondeu HTTP ${res.status}`);
    throw new SourceError(DJEN_DOWN);
  }
  const data = await res.json().catch(() => ({}));
  if (data.status && data.status !== 'success') {
    logOnce(`djen-msg-${data.message}`, `[processos] DJEN: ${data.message || 'erro'}`);
    throw new SourceError(DJEN_DOWN);
  }
  djenStatus = 'ok';
  return data.items || [];
}

/** Todas as páginas de uma consulta ao DJEN (até 10 páginas de 100). */
async function djenAll(params) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const items = await djenGet({ ...params, itensPorPagina: 100, pagina: page });
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

let datajudAuthFailed = false;
async function datajudSearch(alias, cnj) {
  const wait = datajudNext - Date.now();
  if (wait > 0) await sleep(wait);
  datajudNext = Date.now() + DATAJUD_GAP_MS;
  const res = await fetchImpl(`${DATAJUD_URL}/api_publica_${alias}/_search`, {
    method: 'POST',
    headers: { Authorization: `APIKey ${config.datajudApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { match: { numeroProcesso: cnj } }, size: 10 }),
    signal: AbortSignal.timeout(60000),
  }).catch((err) => {
    logOnce(`datajud-net-${err.name}`, `[processos] DataJud sem resposta (${err.name === 'TimeoutError' ? 'demorou mais de 60s' : err.message})`);
    throw new SourceError(DATAJUD_DOWN);
  });
  if (res.status === 401 || res.status === 403) {
    // Sinal de que o CNJ trocou a chave pública: avisa no log uma vez (o admin define DATAJUD_API_KEY).
    if (!datajudAuthFailed) console.error('[processos] DataJud recusou a chave (HTTP %d). Atualize DATAJUD_API_KEY com a chave da wiki do CNJ.', res.status);
    datajudAuthFailed = true;
    throw new SourceError(DATAJUD_DOWN);
  }
  if (res.status === 404) throw new SourceError('Este tribunal ainda não está disponível no DataJud (as intimações do Diário continuam chegando).');
  if (!res.ok) {
    logOnce(`datajud-${res.status}`, `[processos] DataJud respondeu HTTP ${res.status}`);
    throw new SourceError(DATAJUD_DOWN);
  }
  datajudAuthFailed = false;
  const data = await res.json().catch(() => ({}));
  return (data.hits?.hits || []).map((h) => h._source);
}
/** Para a tela do admin/saúde: a chave do DataJud está funcionando? */
export const datajudKeyProblem = () => datajudAuthFailed;

// ---- Provedores: tudo vira o mesmo formato de evento ----------------------------------------

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);
const cleanText = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

const HIGH = /senten|julgad|julgamento|decis[ãa]o|liminar|tutela|audi[eê]ncia|penhora|bloqueio|arresto|sequestro|cita[çc][ãa]o|intima[çc][ãa]o|tr[âa]nsito em julgado|ac[óo]rd[ãa]o|homolog|extin[çc]|procedente|condena|prazo/i;
const LOW = /conclus|juntada|remessa|recebiment|expedi[çc]|peti[çc][ãa]o|apensa|distribu|autua|certid|mero expediente|ato ordinat|redistribu|arquiv|baixa|vista|carga/i;
const severityOf = (text) => (HIGH.test(text) ? 'alta' : LOW.test(text) ? 'baixa' : 'media');

/** Prazo mencionado no texto, sempre como sugestão para conferir. */
export function deadlineHint(text) {
  const m = String(text || '').match(/prazo\s+(?:legal\s+|comum\s+)?de\s+(\d{1,3})\s*(?:\([^)]{1,30}\)\s*)?(dias?\s+[úu]teis|dias?\s+corridos|dias?|horas)/i);
  return m ? `${m[1]} ${m[2].toLowerCase()}` : null;
}

/** Publicação do DJEN → evento. Cancelada: ignorada. */
function djenEvent(item) {
  if (item.ativo === false || item.data_cancelamento) return null;
  const text = cleanText(item.texto);
  const kind = item.tipoComunicacao || item.tipoDocumento || 'Publicação';
  return {
    kind: 'publication', provider: 'djen', cnj: String(item.numero_processo || '').replace(/\D/g, '') || null,
    occurred_at: item.data_disponibilizacao, event_hash: `djen:${item.id}`, title: kind,
    body: text.slice(0, 20000), court: item.siglaTribunal || null, court_unit: item.nomeOrgao || null, link: item.link || null,
    severity: /intima|cita/i.test(kind) || /prazo/i.test(text) ? 'alta' : 'media',
    summary: text.replace(/^Processo\s+[\d.-]+\s*-\s*/i, '').slice(0, 280) || null,
    deadline_hint: deadlineHint(text),
  };
}

/** Registros do DataJud (um por grau) → movimentações. */
function datajudEvents(cnj, sources) {
  const many = new Set(sources.map((s) => s.grau)).size > 1;
  const out = [];
  for (const s of sources) {
    const grau = s.grau === 'G2' ? '2º grau' : s.grau === 'G1' ? '1º grau' : s.grau || '';
    for (const m of s.movimentos || []) {
      if (!m?.nome || !m.dataHora) continue;
      const extra = (m.complementosTabelados || []).map((c) => c.nome).filter(Boolean).join(', ');
      const title = `${many && grau ? `${grau}: ` : ''}${m.nome}${extra ? ` · ${extra}` : ''}`;
      out.push({
        kind: 'movement', provider: 'datajud', cnj, occurred_at: new Date(m.dataHora).toISOString(),
        event_hash: `datajud:${hash(`${cnj}|${s.grau}|${m.dataHora}|${m.codigo}|${title}`)}`, title: title.slice(0, 300),
        body: null, court: s.tribunal || null, court_unit: s.orgaoJulgador?.nome || null, link: null,
        severity: severityOf(`${m.nome} ${extra}`), summary: null, deadline_hint: null,
      });
    }
  }
  return out;
}

/** Grava o evento (sem duplicar). Retorna o id se for novo. */
function saveEvent(companyId, ev, { caseId = null, oabId = null, baseline = false }) {
  const r = run(
    `INSERT OR IGNORE INTO legal_events (company_id, case_id, oab_id, cnj, kind, provider, occurred_at, event_hash, title, body, court, court_unit,
       severity, summary, deadline_hint, link, baseline, read_at, notified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    companyId, caseId, oabId, ev.cnj, ev.kind, ev.provider, ev.occurred_at, ev.event_hash, ev.title, ev.body, ev.court, ev.court_unit,
    ev.severity, ev.summary, ev.deadline_hint, ev.link, baseline ? 1 : 0, baseline ? now() : null, baseline ? now() : null,
  );
  if (!r.changes) {
    // Já existia (veio pela OAB antes): só liga ao processo, se ainda não estiver ligado.
    if (caseId) run('UPDATE legal_events SET case_id = ? WHERE company_id = ? AND event_hash = ? AND case_id IS NULL', caseId, companyId, ev.event_hash);
    return null;
  }
  if (caseId) run('UPDATE legal_cases SET last_event_at = MAX(COALESCE(last_event_at, \'\'), ?) WHERE id = ?', ev.occurred_at, caseId);
  return r.id;
}

const caseByCnj = (companyId, cnj) => (cnj ? get('SELECT id FROM legal_cases WHERE company_id = ? AND cnj = ?', companyId, cnj) : null);

// ---- Verificações -----------------------------------------------------------------------

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => isoDay(new Date(Date.now() - n * 86400000));

/** Intimações publicadas em nome da OAB (inclusive de processos que não foram cadastrados). */
export async function checkOab(companyId, oabId) {
  const oab = get('SELECT * FROM legal_oabs WHERE id = ? AND company_id = ?', oabId, companyId);
  if (!oab) return [];
  const first = !oab.checked_at;
  const fresh = [];
  try {
    const items = await djenAll({
      numeroOab: oab.oab_number, ufOab: oab.oab_uf,
      dataDisponibilizacaoInicio: daysAgo(first ? OAB_FIRST_DAYS : OAB_WINDOW_DAYS), dataDisponibilizacaoFim: isoDay(new Date()),
    });
    for (const item of items) {
      const ev = djenEvent(item);
      if (!ev) continue;
      const id = saveEvent(companyId, ev, { caseId: caseByCnj(companyId, ev.cnj)?.id || null, oabId: oab.id, baseline: first });
      if (id) fresh.push(id);
    }
    run('UPDATE legal_oabs SET checked_at = ?, error = NULL WHERE id = ?', now(), oab.id);
  } catch (err) {
    run('UPDATE legal_oabs SET checked_at = ?, error = ? WHERE id = ?', now(), err instanceof SourceError ? err.message : DJEN_DOWN, oab.id);
    if (!(err instanceof SourceError)) console.error(`[processos] OAB ${oab.id}:`, err.message);
  }
  return fresh;
}

/** Intimações pelo número e movimentações no DataJud. Na primeira vez, tudo entra como histórico. */
export async function checkCase(companyId, caseId) {
  const c = get('SELECT * FROM legal_cases WHERE id = ? AND company_id = ?', caseId, companyId);
  if (!c) return [];
  const baseline = !c.baseline_done;
  const fresh = [];
  const errors = [];
  try {
    for (const item of await djenAll({ numeroProcesso: c.cnj })) {
      const ev = djenEvent(item);
      if (!ev) continue;
      const id = saveEvent(companyId, { ...ev, cnj: c.cnj }, { caseId: c.id, baseline });
      if (id) fresh.push(id);
    }
    run('UPDATE legal_cases SET djen_checked_at = ? WHERE id = ?', now(), c.id);
  } catch (err) { errors.push(err instanceof SourceError ? err.message : DJEN_DOWN); if (!(err instanceof SourceError)) console.error('[processos] DJEN:', err.message); }
  if (c.datajud_alias) {
    try {
      const sources = await datajudSearch(c.datajud_alias, c.cnj);
      const updated = sources.map((s) => s.dataHoraUltimaAtualizacao).filter(Boolean).sort().at(-1) || null;
      if (sources.length && (baseline || updated !== c.datajud_updated_at)) {
        for (const ev of datajudEvents(c.cnj, sources)) {
          const id = saveEvent(companyId, ev, { caseId: c.id, baseline });
          if (id) fresh.push(id);
        }
        const main = sources.find((s) => s.grau === 'G1') || sources[0];
        run('UPDATE legal_cases SET class_name = ?, court_unit = ?, subjects = ?, datajud_updated_at = ? WHERE id = ?',
          main.classe?.nome || c.class_name, main.orgaoJulgador?.nome || c.court_unit,
          (main.assuntos || []).map((a) => a.nome).filter(Boolean).join(', ').slice(0, 300) || c.subjects, updated, c.id);
      }
      if (!sources.length && baseline) errors.push('Este processo ainda não aparece no DataJud (o CNJ costuma levar semanas, e processos em segredo de justiça não aparecem).');
      run('UPDATE legal_cases SET datajud_checked_at = ? WHERE id = ?', now(), c.id);
    } catch (err) {
      errors.push(err instanceof SourceError ? err.message : DATAJUD_DOWN);
      if (!(err instanceof SourceError)) console.error('[processos] DataJud:', err.message);
      run('UPDATE legal_cases SET datajud_checked_at = ? WHERE id = ?', now(), c.id);
    }
  } else {
    run('UPDATE legal_cases SET datajud_checked_at = ? WHERE id = ?', now(), c.id);
  }
  run('UPDATE legal_cases SET baseline_done = 1, error = ? WHERE id = ?', errors.join(' · ').slice(0, 300) || null, c.id);
  return fresh;
}

// ---- Resumo com IA e avisos -------------------------------------------------------------

/** Novidade de verdade (não histórico): resumo da IA nas publicações, quando o plano tem IA. */
async function enrich(company, ids) {
  for (const id of ids) {
    const ev = get('SELECT * FROM legal_events WHERE id = ?', id);
    if (!ev || ev.kind !== 'publication' || !ev.body) continue;
    try {
      const ai = await summarizeLegalEvent(company, { title: ev.title, text: ev.body, court: ev.court, date: ev.occurred_at });
      if (ai) run('UPDATE legal_events SET summary = COALESCE(?, summary), severity = COALESCE(?, severity), deadline_hint = COALESCE(?, deadline_hint) WHERE id = ?', ai.summary, ai.severity, ai.deadline, id);
    } catch (err) {
      console.error(`[processos] resumo da IA falhou (evento ${id}):`, err.message);
    }
  }
}

const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const eventLink = (ev) => `${config.publicUrl}/app#/processos/${ev.case_id || `intimacao-${ev.id}`}`;

/** Celular que recebe o aviso: do advogado da OAB, do advogado responsável pelo processo ou da equipe. */
function phoneFor(company, ev) {
  const oab = ev.oab_id && get('SELECT phone FROM legal_oabs WHERE id = ?', ev.oab_id);
  const owner = ev.case_id && get('SELECT o.phone FROM legal_cases c JOIN legal_oabs o ON o.id = c.oab_id WHERE c.id = ?', ev.case_id);
  return oab?.phone || owner?.phone || company.settings.team.notify_phone || '';
}

function eventLine(ev) {
  const c = ev.case_id ? get('SELECT label, cnj FROM legal_cases WHERE id = ?', ev.case_id) : null;
  return `${c?.label ? `${c.label} · ` : ''}${maskCnj(c?.cnj || ev.cnj) || 'Processo'} (${ev.court || ''})`;
}

function alertText(ev) {
  const what = ev.kind === 'publication' ? `⚖️ *${ev.title} publicada no Diário*` : '⚖️ *Movimentação importante no processo*';
  return [
    what,
    eventLine(ev),
    `${ev.kind === 'publication' ? 'Disponibilizada em' : 'Em'} ${fmtDate(ev.occurred_at)}${ev.court_unit ? ` · ${ev.court_unit}` : ''}`,
    ev.summary ? `\n${ev.summary}` : `\n${ev.title}`,
    ev.deadline_hint ? `\nPrazo mencionado: ${ev.deadline_hint}. Confira a contagem (a publicação considera-se feita no 1º dia útil após a disponibilização).` : '',
    `\nVer no Conversa CRM: ${eventLink(ev)}`,
  ].filter(Boolean).join('\n');
}

async function deliver(company, phone, text) {
  if (!phone) return;
  try { await notifyImpl(company, phone, text); } catch (err) { console.error(`[processos] aviso não enviado (empresa ${company.id}):`, err.message); }
}

/** Urgente (prioridade alta) sai na hora; o resto vai no resumo diário. */
async function notifyUrgent(company, ids) {
  for (const id of ids) {
    const ev = get('SELECT * FROM legal_events WHERE id = ? AND notified_at IS NULL', id);
    if (!ev || ev.severity !== 'alta') continue;
    run('UPDATE legal_events SET notified_at = ? WHERE id = ?', now(), ev.id);
    await deliver(company, phoneFor(company, ev), alertText(ev));
  }
}

/** Resumo diário (a partir das 18h, no fuso da empresa) das novidades ainda não avisadas. */
export async function sendDigests(force = false) {
  const pending = all("SELECT * FROM legal_events WHERE notified_at IS NULL AND baseline = 0 AND severity != 'alta' ORDER BY company_id, occurred_at");
  const byCompany = new Map();
  for (const ev of pending) (byCompany.get(ev.company_id) || byCompany.set(ev.company_id, []).get(ev.company_id)).push(ev);
  let sent = 0;
  for (const [companyId, events] of byCompany) {
    const company = getCompany(companyId);
    if (!company || company.status !== 'ativa' || !processesEnabled(company)) continue;
    if (!force && Number(zonedParts(new Date(), company.timezone).time.slice(0, 2)) !== DIGEST_HOUR) continue;
    const byPhone = new Map();
    for (const ev of events) {
      run('UPDATE legal_events SET notified_at = ? WHERE id = ?', now(), ev.id);
      const phone = phoneFor(company, ev);
      (byPhone.get(phone) || byPhone.set(phone, []).get(phone)).push(ev);
    }
    for (const [phone, list] of byPhone) {
      const lines = list.slice(0, 15).map((ev) => `• ${eventLine(ev)}: ${ev.title}`);
      if (list.length > 15) lines.push(`• e mais ${list.length - 15}`);
      await deliver(company, phone, `⚖️ *Resumo do dia nos processos* (${list.length} ${list.length === 1 ? 'novidade' : 'novidades'})\n${lines.join('\n')}\n\nVer no Conversa CRM: ${config.publicUrl}/app#/processos`);
      sent++;
    }
  }
  return sent;
}

/** Depois de cada verificação: resumo da IA e aviso imediato do que é urgente. */
async function afterCheck(companyId, ids) {
  if (!ids.length) return;
  const company = getCompany(companyId);
  await enrich(company, ids);
  await notifyUrgent(company, ids);
}

// ---- Agendador (separado do agendador geral, porque as consultas são lentas) --------------

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
let running = false;
let timer = null;

/** Uma rodada: poucas consultas por vez, as mais atrasadas primeiro. */
export async function monitorOnce() {
  if (running) return;
  running = true;
  try {
    await forEachDatabase(async () => {
      const usable = (companyId) => {
        const company = getCompany(companyId);
        return company && company.status === 'ativa' && !accessExpired(company) && processesEnabled(company) ? company : null;
      };
      const oabs = all('SELECT id, company_id FROM legal_oabs WHERE active = 1 AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at IS NOT NULL, checked_at LIMIT 5', hoursAgo(OAB_EVERY_H));
      for (const o of oabs) if (usable(o.company_id)) await afterCheck(o.company_id, await checkOab(o.company_id, o.id));
      const cases = all(
        `SELECT id, company_id FROM legal_cases WHERE active = 1 AND (baseline_done = 0 OR djen_checked_at IS NULL OR djen_checked_at < ?)
         ORDER BY baseline_done, djen_checked_at LIMIT 4`, hoursAgo(CASE_EVERY_H),
      );
      for (const c of cases) if (usable(c.company_id)) await afterCheck(c.company_id, await checkCase(c.company_id, c.id));
      await sendDigests();
    });
  } catch (err) {
    console.error('[processos] rodada falhou:', err.message);
  } finally {
    running = false;
  }
}

/** Liga o acompanhamento (a cada minuto). */
export function startLegalMonitor(intervalMs = 60000) {
  if (timer) return;
  timer = setInterval(() => { monitorOnce(); }, intervalMs);
  timer.unref?.();
  setTimeout(() => monitorOnce(), 5000).unref?.();
}
/** Processo ou OAB acabou de ser cadastrado: verifica já, sem esperar a próxima rodada. */
export function kickMonitor() {
  if (timer) setImmediate(() => monitorOnce());
}

// ---- Cadastro e telas ---------------------------------------------------------------------

const OAB_UFS = new Set(UF);

export function listOabs(companyId) {
  return all('SELECT * FROM legal_oabs WHERE company_id = ? ORDER BY name', companyId);
}

export function saveOab(companyId, data, id = null) {
  const company = getCompany(companyId);
  const name = String(data.name || '').trim().slice(0, 80);
  const number = String(data.oab_number || '').replace(/\D/g, '').replace(/^0+/, '');
  const uf = String(data.oab_uf || '').trim().toUpperCase();
  const phone = String(data.phone || '').replace(/\D/g, '').slice(0, 15) || null;
  if (!name) throw new Error('Informe o nome do advogado.');
  if (!number || number.length > 7) throw new Error('Informe o número da OAB (só os números).');
  if (!OAB_UFS.has(uf)) throw new Error('Escolha a UF da OAB.');
  if (id) {
    const cur = get('SELECT * FROM legal_oabs WHERE id = ? AND company_id = ?', id, companyId);
    if (!cur) return null;
    const changed = cur.oab_number !== number || cur.oab_uf !== uf;
    run('UPDATE legal_oabs SET name = ?, oab_number = ?, oab_uf = ?, phone = ?, active = ?, checked_at = CASE WHEN ? THEN NULL ELSE checked_at END WHERE id = ?',
      name, number, uf, phone, data.active === false ? 0 : 1, changed ? 1 : 0, id);
  } else {
    if (get('SELECT 1 AS x FROM legal_oabs WHERE company_id = ? AND oab_number = ? AND oab_uf = ?', companyId, number, uf)) throw new Error('Esta OAB já está cadastrada.');
    const count = get('SELECT COUNT(*) AS n FROM legal_oabs WHERE company_id = ?', companyId).n;
    if (count >= maxOabs(company)) throw new Error(`O seu plano permite ${maxOabs(company)} ${maxOabs(company) === 1 ? 'OAB' : 'OABs'} (uma por usuário).`);
    ({ id } = run('INSERT INTO legal_oabs (company_id, name, oab_number, oab_uf, phone) VALUES (?, ?, ?, ?, ?)', companyId, name, number, uf, phone));
  }
  kickMonitor();
  return get('SELECT * FROM legal_oabs WHERE id = ?', id);
}

export function deleteOab(companyId, id) {
  return run('DELETE FROM legal_oabs WHERE id = ? AND company_id = ?', id, companyId).changes > 0;
}

export function caseLimit(companyId) {
  const company = getCompany(companyId);
  return { max: maxProcesses(company), used: get('SELECT COUNT(*) AS n FROM legal_cases WHERE company_id = ?', companyId).n };
}

export function createCase(companyId, data) {
  const parsed = parseCnj(data.cnj);
  if (get('SELECT 1 AS x FROM legal_cases WHERE company_id = ? AND cnj = ?', companyId, parsed.cnj)) throw new Error('Este processo já está cadastrado.');
  const { max, used } = caseLimit(companyId);
  if (max != null && used >= max) throw new Error(`O seu plano acompanha até ${max} processos. ${max < 20 ? 'No Essencial são 20, e no Profissional não há limite.' : 'No Profissional não há limite.'}`);
  const contactId = data.contact_id ? get('SELECT id FROM contacts WHERE id = ? AND company_id = ?', Number(data.contact_id), companyId)?.id || null : null;
  const oabId = data.oab_id ? get('SELECT id FROM legal_oabs WHERE id = ? AND company_id = ?', Number(data.oab_id), companyId)?.id || null : null;
  const { id } = run(
    'INSERT INTO legal_cases (company_id, cnj, court, datajud_alias, label, contact_id, oab_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    companyId, parsed.cnj, parsed.court, parsed.alias, String(data.label || '').trim().slice(0, 120), contactId, oabId,
  );
  // Intimações que já tinham chegado pela OAB passam a aparecer no processo.
  run('UPDATE legal_events SET case_id = ? WHERE company_id = ? AND cnj = ? AND case_id IS NULL', id, companyId, parsed.cnj);
  kickMonitor();
  return getCase(companyId, id);
}

export function updateCase(companyId, id, data) {
  const c = get('SELECT * FROM legal_cases WHERE id = ? AND company_id = ?', id, companyId);
  if (!c) return null;
  const contactId = data.contact_id === undefined ? c.contact_id : data.contact_id ? get('SELECT id FROM contacts WHERE id = ? AND company_id = ?', Number(data.contact_id), companyId)?.id || null : null;
  const oabId = data.oab_id === undefined ? c.oab_id : data.oab_id ? get('SELECT id FROM legal_oabs WHERE id = ? AND company_id = ?', Number(data.oab_id), companyId)?.id || null : null;
  run('UPDATE legal_cases SET label = ?, contact_id = ?, oab_id = ?, active = ? WHERE id = ?',
    data.label === undefined ? c.label : String(data.label).trim().slice(0, 120), contactId, oabId, data.active === undefined ? c.active : data.active ? 1 : 0, id);
  return getCase(companyId, id);
}

/** Remove o processo: as movimentações vão junto; as intimações da OAB continuam na lista geral. */
export function deleteCase(companyId, id) {
  run("DELETE FROM legal_events WHERE company_id = ? AND case_id = ? AND (oab_id IS NULL OR kind = 'movement')", companyId, id);
  return run('DELETE FROM legal_cases WHERE id = ? AND company_id = ?', id, companyId).changes > 0;
}

/** Pede uma nova verificação (no máximo uma a cada 10 minutos por processo). */
export function refreshCase(companyId, id) {
  const c = get('SELECT * FROM legal_cases WHERE id = ? AND company_id = ?', id, companyId);
  if (!c) return null;
  if (c.djen_checked_at && Date.now() - Date.parse(c.djen_checked_at) < 10 * 60000) throw new Error('Este processo foi verificado há menos de 10 minutos. Tente daqui a pouco.');
  run('UPDATE legal_cases SET djen_checked_at = NULL WHERE id = ?', id);
  kickMonitor();
  return getCase(companyId, id);
}

const CASE_COLUMNS = `c.*, ct.name AS contact_name, o.name AS oab_name,
  (SELECT COUNT(*) FROM legal_events e WHERE e.case_id = c.id AND e.baseline = 0 AND e.read_at IS NULL) AS unread`;

export function listCases(companyId, { contactId = null } = {}) {
  return all(
    `SELECT ${CASE_COLUMNS} FROM legal_cases c LEFT JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN legal_oabs o ON o.id = c.oab_id
     WHERE c.company_id = ? ${contactId ? 'AND c.contact_id = ?' : ''} ORDER BY COALESCE(c.last_event_at, c.created_at) DESC`,
    ...(contactId ? [companyId, contactId] : [companyId]),
  ).map((c) => ({ ...c, cnj_masked: maskCnj(c.cnj) }));
}

export function getCase(companyId, id) {
  const c = get(`SELECT ${CASE_COLUMNS} FROM legal_cases c LEFT JOIN contacts ct ON ct.id = c.contact_id LEFT JOIN legal_oabs o ON o.id = c.oab_id WHERE c.id = ? AND c.company_id = ?`, id, companyId);
  if (!c) return null;
  const events = all('SELECT * FROM legal_events WHERE company_id = ? AND case_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 500', companyId, id);
  return { ...c, cnj_masked: maskCnj(c.cnj), events };
}

/** Novidades (o que chegou depois do cadastro), mais recentes primeiro. */
export function listNews(companyId, { limit = 100 } = {}) {
  return all(
    `SELECT e.*, c.label AS case_label, c.cnj AS case_cnj FROM legal_events e LEFT JOIN legal_cases c ON c.id = e.case_id
     WHERE e.company_id = ? AND e.baseline = 0 ORDER BY e.id DESC LIMIT ?`, companyId, limit,
  ).map((e) => ({ ...e, cnj_masked: maskCnj(e.case_cnj || e.cnj) }));
}

/** Intimações da OAB de processos que ainda não foram cadastrados (um item por processo). */
export function listUnlinked(companyId) {
  return all(
    `SELECT e.cnj, MAX(e.occurred_at) AS last_at, COUNT(*) AS total, MAX(e.court) AS court, MAX(e.court_unit) AS court_unit, MAX(e.id) AS last_id
     FROM legal_events e WHERE e.company_id = ? AND e.case_id IS NULL AND e.kind = 'publication' AND e.cnj IS NOT NULL
     GROUP BY e.cnj ORDER BY last_at DESC LIMIT 200`, companyId,
  ).map((r) => ({ ...r, cnj_masked: maskCnj(r.cnj) }));
}

export function getEvent(companyId, id) {
  const e = get('SELECT * FROM legal_events WHERE id = ? AND company_id = ?', id, companyId);
  return e ? { ...e, cnj_masked: maskCnj(e.cnj) } : null;
}

export function markRead(companyId, { ids = null, caseId = null } = {}) {
  if (caseId) return run('UPDATE legal_events SET read_at = ? WHERE company_id = ? AND case_id = ? AND read_at IS NULL', now(), companyId, caseId).changes;
  if (ids?.length) {
    const list = ids.map(Number).filter(Boolean).slice(0, 500);
    return run(`UPDATE legal_events SET read_at = ? WHERE company_id = ? AND read_at IS NULL AND id IN (${list.map(() => '?').join(',')})`, now(), companyId, ...list).changes;
  }
  return run('UPDATE legal_events SET read_at = ? WHERE company_id = ? AND read_at IS NULL', now(), companyId).changes;
}

export const unreadCount = (companyId) => get('SELECT COUNT(*) AS n FROM legal_events WHERE company_id = ? AND baseline = 0 AND read_at IS NULL', companyId).n;
