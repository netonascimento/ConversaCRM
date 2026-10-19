// Planos da plataforma. max_leads = null significa leads ilimitados.
// O administrador pode ajustar os limites de uma empresa específica no painel.
export const PLANS = {
  gratis: {
    label: 'Teste grátis', price_cents: 0, max_users: 1, max_leads: 10,
    description: 'Para conhecer o sistema com seus próprios clientes.',
  },
  essencial: {
    label: 'Essencial', price_cents: 10000, max_users: 2, max_leads: null,
    description: 'Para quem atende sozinho ou em dupla.',
  },
  profissional: {
    label: 'Profissional', price_cents: 24900, max_users: 10, max_leads: null,
    description: 'Para equipes com vários atendentes e profissionais.',
  },
};

export const DEFAULT_PLAN = 'gratis';
export const planOf = (id) => PLANS[id] || null;
export const publicPlans = () => Object.entries(PLANS).map(([id, p]) => ({ id, ...p }));
