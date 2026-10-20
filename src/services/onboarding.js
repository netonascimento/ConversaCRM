import { get } from '../db.js';
import { getCompany, saveSettings } from './company.js';
import { aiAllowed } from './plans.js';

// "Primeiros passos": o que falta para o Conversa CRM atender sozinho. Cada passo é marcado pelo que a
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
      action: 'Preencher', href: '#/comecar/1',
      done: (s.ai.business_description || '').trim().length >= 20,
    },
    {
      id: 'servicos', title: 'Cadastre seus serviços e preços',
      text: 'A IA usa o catálogo para informar valores e agendar o serviço certo.',
      action: 'Cadastrar serviços', href: '#/comecar/2',
      done: one('SELECT COUNT(*) AS n FROM products WHERE company_id = ? AND active = 1'),
    },
    {
      id: 'horarios', title: 'Defina seus horários de atendimento',
      text: 'Os dias e horários em que você atende. A agenda e a IA só oferecem horários livres dentro deles.',
      action: 'Definir horários', href: '#/comecar/3',
      done: Boolean(flags.hours),
    },
    {
      id: 'teste', title: 'Simule um cliente',
      text: aiAllowed(company)
        ? 'Ainda não precisa do WhatsApp: aqui você faz de conta que é um cliente e vê a IA responder, agendar e cobrar. É um teste dentro do Conversa CRM; nenhuma mensagem é enviada.'
        : 'Ainda não precisa do WhatsApp: aqui você faz de conta que é um cliente e responde como a sua equipe. É um teste dentro do Conversa CRM; nenhuma mensagem é enviada.',
      action: 'Simular um cliente', href: '#/comecar/4',
      done: one("SELECT COUNT(*) AS n FROM messages WHERE company_id = ? AND direction = 'in'"),
    },
    {
      id: 'whatsapp', title: 'Conecte o seu WhatsApp',
      text: 'Agora sim, o número de verdade. Use o que você já tem, lendo um QR Code: a partir daí as mensagens dos seus clientes chegam aqui, como no teste.',
      action: 'Conectar WhatsApp', href: '#/comecar/5',
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
