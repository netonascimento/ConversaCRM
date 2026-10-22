import { main } from '../db.js';
import { config } from '../config.js';

// Empresas e configurações ficam sempre no banco principal.
const { get, run } = main;

export const DEFAULT_SETTINGS = {
  ai: {
    enabled: true,
    agent_name: 'Ana',
    business_description: '',
    instructions: 'Seja simpática, objetiva e use mensagens curtas, como no WhatsApp.',
    model: '',
    // Comportamento: o que é sucesso na conversa e como cada capacidade funciona.
    objective: 'agendar', // agendar | vender | qualificar | orcamento | duvidas
    scheduling_mode: 'auto', // auto | confirm | request | link | off
    external_booking_link: '',
    price_mode: 'show', // show | from | describe | hide
    charge_mode: 'auto', // auto | approval | never
    deposit_percent: 0, // sinal para garantir o horário (% do valor do serviço); 0 = sem sinal
    intake_questions: [], // [{ key, label, question }]
    urgency_rules: '',
    never_say: '',
  },
  team: {
    notify_phone: '',
    task_sla_hours: 4,
    notify_on_new_task: true,
    client_message_on_overdue: true,
    auto_assign: false, // distribui as conversas que precisam de humano entre os atendentes
  },
  business_hours: {
    dom: [], seg: [['09:00', '18:00']], ter: [['09:00', '18:00']], qua: [['09:00', '18:00']],
    qui: [['09:00', '18:00']], sex: [['09:00', '18:00']], sab: [['09:00', '12:00']],
  },
  scheduling: {
    slot_interval_min: 30,
    default_duration_min: 60,
    min_notice_min: 60,
    capacity: 1,
    blocked_dates: [],
    reminder_hours_before: 24,
  },
  whatsapp: {
    provider: 'simulator', // simulator | meta | evolution
    meta_token: '', meta_phone_number_id: '', meta_verify_token: '', meta_app_secret: '', meta_template_name: '', meta_template_lang: 'pt_BR',
    evolution_url: '', evolution_api_key: '', evolution_instance: '', evolution_webhook_secret: '',
  },
  billing: {
    provider: 'pix_manual', // pix_manual | asaas | mercadopago
    pix_key: '', pix_name: '', pix_city: '',
    asaas_api_key: '', asaas_sandbox: true, asaas_webhook_token: '',
    mercadopago_token: '',
    reminder_days_before: [3, 0],
    reminder_days_after: [1, 3, 7],
    auto_win_on_payment: true,
  },
  integrations: {
    anthropic_api_key: '',
    google_places_key: '',
  },
};

const SECRET_FIELDS = [
  'whatsapp.meta_token', 'whatsapp.meta_app_secret', 'whatsapp.evolution_api_key', 'whatsapp.evolution_webhook_secret',
  'billing.asaas_api_key', 'billing.asaas_webhook_token', 'billing.mercadopago_token',
  'integrations.anthropic_api_key', 'integrations.google_places_key',
];

function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = k in base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function getCompany(companyId) {
  const row = get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!row) return null;
  const stored = JSON.parse(row.settings || '{}');
  const settings = deepMerge(DEFAULT_SETTINGS, stored);
  // Compatibilidade com a configuração antiga (can_create_charges = false).
  if (stored.ai?.can_create_charges === false && !stored.ai?.charge_mode) settings.ai.charge_mode = 'never';
  delete settings.ai.can_create_charges;
  return { ...row, settings };
}

export function saveSettings(companyId, patch) {
  const current = JSON.parse(get('SELECT settings FROM companies WHERE id = ?', companyId).settings || '{}');
  // Campos secretos vêm mascarados ("••••") do front: nesse caso mantemos o valor salvo.
  for (const field of SECRET_FIELDS) {
    const [group, key] = field.split('.');
    if (patch[group] && typeof patch[group][key] === 'string' && patch[group][key].startsWith('••••')) delete patch[group][key];
  }
  const merged = deepMerge(deepMerge(DEFAULT_SETTINGS, current), patch);
  run('UPDATE companies SET settings = ? WHERE id = ?', JSON.stringify(merged), companyId);
  return getCompany(companyId);
}

export function maskSettings(settings) {
  const copy = structuredClone(settings);
  for (const field of SECRET_FIELDS) {
    const [group, key] = field.split('.');
    const v = copy[group]?.[key];
    if (v) copy[group][key] = `••••${String(v).slice(-4)}`;
  }
  return copy;
}

/**
 * De onde vem a chave da IA: 'platform' (chave do .env, só para empresas liberadas pelo
 * administrador, consumo cobrado à parte), 'company' (chave da própria empresa) ou null.
 */
export function aiKeySource(company) {
  if (company.ai_platform_key && config.anthropicKey) return 'platform';
  if (company.settings.integrations.anthropic_api_key) return 'company';
  return null;
}
export function anthropicKeyFor(company) {
  const source = aiKeySource(company);
  if (source === 'platform') return config.anthropicKey;
  return source === 'company' ? company.settings.integrations.anthropic_api_key : '';
}
export const placesKeyFor = (company) => company.settings.integrations.google_places_key || config.googlePlacesKey;
export const aiModelFor = (company) => company.settings.ai.model || config.aiModel;
