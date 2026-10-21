// Planos da plataforma. max_leads = null significa leads ilimitados; ai = false bloqueia tudo que usa IA.
// O administrador pode ajustar os limites de uma empresa específica no painel.
//
// Não há plano grátis à venda: quem se cadastra ganha um teste do Básico (7 dias, ou 30 com código de
// indicação). "gratis" é a situação de quem terminou o teste sem assinar: o sistema pede a assinatura.
export const PLANS = {
  gratis: {
    label: 'Teste encerrado', price_cents: 0, hidden: true, max_users: 1, max_leads: 30, ai: false, max_whatsapp: 1, max_searches: 3, searches_period: 'total', max_processes: 5,
    description: 'O teste terminou. Assine um plano para continuar.',
  },
  basico: {
    label: 'Básico', price_cents: 4990, max_users: 1, max_leads: 50, ai: true, max_whatsapp: 1, max_searches: 10, searches_period: 'month', max_processes: 10,
    description: 'Para quem atende sozinho e está começando.',
  },
  essencial: {
    label: 'Essencial', price_cents: 9990, max_users: 2, max_leads: 100, ai: true, max_whatsapp: 1, max_searches: 30, searches_period: 'month', max_processes: 20,
    description: 'Para quem atende sozinho ou em dupla.',
  },
  profissional: {
    label: 'Profissional', price_cents: 24990, max_users: 10, max_leads: null, ai: true, max_whatsapp: 3, max_searches: 50, searches_period: 'month', max_processes: null,
    description: 'Para equipes com vários atendentes e profissionais.',
  },
};

// Plano de quem se cadastra (em teste) e para onde vai quem termina o teste sem assinar.
export const DEFAULT_PLAN = 'basico';
export const EXPIRED_PLAN = 'gratis';
export const TRIAL_DAYS = 7;
export const REFERRAL_TRIAL_DAYS = 30;
// Plano de entrada (desbloqueia a IA) e o destacado como "mais escolhido".
export const UPGRADE_PLAN = 'basico';
export const RECOMMENDED_PLAN = 'essencial';
/** A empresa pode usar IA? Planos personalizados (fora da tabela) podem. */
export const aiAllowed = (company) => PLANS[company?.plan]?.ai !== false;
/** Terminou o teste sem assinar: o sistema só deixa assinar (e ver as promoções). */
export const accessExpired = (company) => company?.plan === EXPIRED_PLAN;
export const planOf = (id) => PLANS[id] || null;
/** Quantos números de WhatsApp a empresa pode ter (o principal conta). Plano fora da tabela: 1. */
export const maxWhatsapp = (company) => PLANS[company?.plan]?.max_whatsapp ?? 1;
/** Identificador do Pix da assinatura: aponta qual empresa pagou. */
export const upgradeTxid = (company) => `CONVERSA${String(company.public_id).replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 25);
/** Planos à venda (sem a situação interna "teste encerrado"). */
export const publicPlans = () => Object.entries(PLANS).filter(([, p]) => !p.hidden).map(([id, p]) => ({ id, ...p }));
