// Modelos por segmento: configurações iniciais do comportamento da IA ao criar uma empresa.
// Só ajustam a configuração; nenhum dado de exemplo é criado.

const weekdays = (ranges) => ({ dom: [], seg: ranges, ter: ranges, qua: ranges, qui: ranges, sex: ranges, sab: [] });

export const PRESETS = {
  generico: { label: 'Genérico', settings: {} },
  clinica: {
    label: 'Clínica / consultório (dentista, estética, saúde)',
    settings: {
      ai: {
        objective: 'agendar', scheduling_mode: 'auto', price_mode: 'from', charge_mode: 'never',
        intake_questions: [{ key: 'queixa_principal', label: 'Queixa principal', question: 'O que você gostaria de tratar ou avaliar?' }],
        urgency_rules: 'Dor forte\nInchaço no rosto\nSangramento que não para',
        never_say: 'Dar diagnóstico\nIndicar medicamento',
      },
    },
  },
  advocacia: {
    label: 'Escritório de advocacia',
    settings: {
      business_hours: weekdays([['09:00', '12:00'], ['13:00', '18:00']]),
      scheduling: { slot_interval_min: 60, default_duration_min: 60 },
      ai: {
        objective: 'qualificar', scheduling_mode: 'confirm', price_mode: 'hide', charge_mode: 'never',
        intake_questions: [
          { key: 'area', label: 'Área do caso', question: 'Para eu te direcionar ao advogado certo: qual é a área do seu caso (trabalhista, família, previdenciário, consumidor...)?' },
          { key: 'resumo', label: 'Resumo do caso', question: 'Pode me contar em poucas palavras o que aconteceu?' },
          { key: 'processo', label: 'Já existe processo?', question: 'Já existe algum processo em andamento sobre isso?' },
        ],
        urgency_rules: 'Audiência marcada para os próximos dias\nPrisão ou alguém preso\nPrazo vencendo ou intimação recebida',
        never_say: 'Dar parecer jurídico ou opinião sobre as chances do caso\nPrometer resultado\nFalar de honorários ou valores',
      },
    },
  },
  salao: {
    label: 'Salão de beleza / barbearia',
    settings: { ai: { objective: 'agendar', scheduling_mode: 'auto', price_mode: 'show', charge_mode: 'never' } },
  },
  loja: {
    label: 'Loja / venda de produtos',
    settings: { ai: { objective: 'vender', scheduling_mode: 'off', price_mode: 'show', charge_mode: 'auto' } },
  },
  servicos: {
    label: 'Prestador de serviços (orçamento)',
    settings: {
      ai: {
        objective: 'orcamento', scheduling_mode: 'request', price_mode: 'describe', charge_mode: 'approval',
        intake_questions: [
          { key: 'servico', label: 'Serviço', question: 'Qual serviço você precisa?' },
          { key: 'endereco', label: 'Bairro / endereço', question: 'Em qual bairro ou endereço seria o serviço?' },
          { key: 'prazo', label: 'Prazo', question: 'Para quando você precisa?' },
        ],
      },
    },
  },
  imobiliaria: {
    label: 'Imobiliária / corretor',
    settings: {
      ai: {
        objective: 'qualificar', scheduling_mode: 'confirm', price_mode: 'show', charge_mode: 'never',
        intake_questions: [
          { key: 'interesse', label: 'Compra ou aluguel', question: 'Você procura imóvel para comprar ou alugar?' },
          { key: 'regiao', label: 'Região', question: 'Em qual região ou bairro?' },
          { key: 'orcamento', label: 'Faixa de valor', question: 'Qual faixa de valor você tem em mente?' },
        ],
      },
    },
  },
};
