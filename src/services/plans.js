// Planos da plataforma. max_leads = null significa leads ilimitados; ai = false bloqueia tudo que usa IA.
// O administrador pode ajustar os limites de uma empresa específica no painel.
export const PLANS = {
  gratis: {
    label: 'Teste grátis', price_cents: 0, max_users: 1, max_leads: 30, ai: false,
    description: 'Para conhecer o sistema com seus próprios clientes.',
  },
  essencial: {
    label: 'Essencial', price_cents: 10000, max_users: 2, max_leads: 100, ai: true,
    description: 'Para quem atende sozinho ou em dupla.',
  },
  profissional: {
    label: 'Profissional', price_cents: 24900, max_users: 10, max_leads: null, ai: true,
    description: 'Para equipes com vários atendentes e profissionais.',
  },
};

export const DEFAULT_PLAN = 'gratis';
// Plano oferecido para desbloquear a IA a partir do teste grátis.
export const UPGRADE_PLAN = 'essencial';
/** A empresa pode usar IA? Planos personalizados (fora da tabela) podem. */
export const aiAllowed = (company) => PLANS[company?.plan]?.ai !== false;
export const planOf = (id) => PLANS[id] || null;
/** Identificador do Pix da assinatura: aponta qual empresa pagou. */
export const upgradeTxid = (company) => `FALAKI${String(company.public_id).replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 25);
export const publicPlans = () => Object.entries(PLANS).map(([id, p]) => ({ id, ...p }));
