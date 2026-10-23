import { main } from '../db.js';
import { config } from '../config.js';
import { aiKeySource } from './company.js';
import { zonedParts } from './time.js';

// Consumo de tokens da IA por empresa e mês (no fuso da empresa), para cobrar à parte
// quem usa a chave da plataforma. Fica no banco principal, junto das empresas.

/** Soma o consumo de uma resposta da API no mês corrente da empresa. */
export function recordUsage(company, response, requestedModel) {
  const u = response?.usage;
  const source = aiKeySource(company);
  if (!u || !source) return;
  const month = zonedParts(new Date(), company.timezone).date.slice(0, 7);
  main.run(
    `INSERT INTO ai_usage (company_id, month, model, key_source, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (company_id, month, model, key_source) DO UPDATE SET
       requests = requests + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`,
    company.id, month, response.model || requestedModel, source,
    u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0,
  );
}

/** Tokens (entrada + saída) que a empresa gastou neste mês na chave da plataforma. */
export function platformTokensThisMonth(company) {
  const month = zonedParts(new Date(), company.timezone).date.slice(0, 7);
  return main.get(
    "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_usage WHERE company_id = ? AND month = ? AND key_source = 'platform'",
    company.id, month,
  ).n;
}

/** Passou do teto mensal da chave da plataforma (AI_PLATFORM_MONTHLY_TOKENS)? A chave própria não tem teto. */
export function platformQuotaReached(company) {
  const cap = config.aiPlatformMonthlyTokens;
  return Boolean(cap > 0 && aiKeySource(company) === 'platform' && platformTokensThisMonth(company) >= cap);
}

/** Consumo mês a mês (mais recente primeiro), separado por modelo e origem da chave. */
export const usageByMonth = (companyId, months = 6) => main.all(
  `SELECT month, model, key_source, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
   FROM ai_usage WHERE company_id = ? AND month IN (SELECT DISTINCT month FROM ai_usage WHERE company_id = ? ORDER BY month DESC LIMIT ?)
   ORDER BY month DESC, key_source, model`, companyId, companyId, months,
);

/** Tokens consumidos com a chave da plataforma no mês (ex.: '2026-10'), por empresa. */
export const platformUsageIn = (month) => main.all(
  `SELECT company_id, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens
   FROM ai_usage WHERE month = ? AND key_source = 'platform' GROUP BY company_id`, month,
);
