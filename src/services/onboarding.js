import { get } from '../db.js';
import { getCompany, saveSettings } from './company.js';
import { aiAllowed } from './plans.js';

// "Primeiros passos": o que falta para o Falaki atender sozinho. Cada passo é marcado pelo que a
// empresa já configurou de verdade (não por clique), e o painel some quando tudo estiver pronto.
export function onboarding(companyId) {
  const company = getCompany(companyId);
  const s = company.settings;
  const flags = s.onboarding || {};
  const one = (sql) => get(sql, companyId).n > 0;
  const steps = [
    {
      id: 'empresa', title: 'Conte sobre a sua empresa',
      text: 'O que você faz, endereço, formas de pagamento e diferenciais. É com isso que a IA responde os clientes.',
      action: 'Preencher', href: '#/config/empresa',
      done: (s.ai.business_description || '').trim().length >= 20,
    },
    {
      id: 'servicos', title: 'Cadastre seus serviços e preços',
      text: 'A IA usa o catálogo para informar valores e agendar o serviço certo.',
      action: 'Cadastrar serviços', href: '#/produtos',
      done: one('SELECT COUNT(*) AS n FROM products WHERE company_id = ? AND active = 1'),
    },
    {
      id: 'horarios', title: 'Defina seus horários de atendimento',
      text: 'Os dias e horários em que você atende. A agenda e a IA só oferecem horários livres dentro deles.',
      action: 'Definir horários', href: '#/config/agenda',
      done: Boolean(flags.hours),
    },
    {
      id: 'teste', title: 'Teste o atendimento',
      text: aiAllowed(company)
        ? 'Mande uma mensagem como se fosse um cliente e veja a IA responder, agendar e cobrar.'
        : 'Mande uma mensagem como se fosse um cliente e responda pela tela de Atendimento.',
      action: 'Fazer um teste', href: '#/inbox?simular=1',
      done: one("SELECT COUNT(*) AS n FROM messages WHERE company_id = ? AND direction = 'in'"),
    },
    {
      id: 'whatsapp', title: 'Conecte o seu WhatsApp',
      text: 'Use o número que você já tem, lendo um QR Code. A partir daí os clientes de verdade são atendidos.',
      action: 'Conectar WhatsApp', href: '#/config/whatsapp',
      done: s.whatsapp.provider !== 'simulator',
    },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  return {
    steps, done_count: doneCount, total: steps.length,
    percent: Math.round((doneCount / steps.length) * 100),
    complete: doneCount === steps.length,
    dismissed: Boolean(flags.dismissed),
    next: steps.find((x) => !x.done)?.id || null,
  };
}

export const markOnboarding = (companyId, patch) => saveSettings(companyId, { onboarding: { ...(getCompany(companyId).settings.onboarding || {}), ...patch } });
