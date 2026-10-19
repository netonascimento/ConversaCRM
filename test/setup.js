// Ambiente isolado para os testes: banco em memória e sem atraso na IA.
process.env.DB_PATH = ':memory:';
process.env.AI_DEBOUNCE_MS = '10';
process.env.ANTHROPIC_API_KEY = '';
process.env.GOOGLE_PLACES_API_KEY = '';
process.env.ALLOW_SIGNUP = 'true';

const { registerCompany } = await import('../src/auth.js');
const { saveSettings } = await import('../src/services/company.js');

let n = 0;
// Cria uma empresa aberta 24h (para os testes não dependerem do horário em que rodam).
export function makeCompany(settings = {}) {
  n++;
  const { companyId } = registerCompany({ companyName: `Empresa ${n}`, name: 'Dono', email: `dono${n}-${Date.now()}@teste.com`, password: 'segredo123', plan: 'profissional' });
  const allDay = [['00:00', '23:59']];
  saveSettings(companyId, {
    business_hours: { dom: allDay, seg: allDay, ter: allDay, qua: allDay, qui: allDay, sex: allDay, sab: allDay },
    scheduling: { min_notice_min: 0 },
    billing: { pix_key: 'chave@pix.com', pix_name: 'Empresa Teste', pix_city: 'Sao Paulo' },
    ...settings,
  });
  return companyId;
}
