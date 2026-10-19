// Cria empresas de demonstração com dados realistas:
//   npm run seed              -> clínica odontológica
//   npm run seed -- advocacia -> escritório de advocacia
import { get, run, main } from './db.js';
import { registerCompany } from './auth.js';
import { createContact, changeStage, saveCustomFields } from './services/crm.js';
import { saveProfessional } from './services/professionals.js';
import { createAppointment } from './services/scheduling.js';
import { createTask } from './services/tasks.js';
import { saveSettings, getCompany } from './services/company.js';
import { pixPayload } from './services/billing.js';
import { zonedToUtc, todayIn, addDays } from './services/time.js';

const EMAIL = process.env.SEED_EMAIL || 'demo@fechou.app';
const PASSWORD = process.env.SEED_PASSWORD || 'demo1234';

export function seedDemo() {
  if (main.get('SELECT id FROM users WHERE email = ?', EMAIL)) {
    console.log(`Empresa demo já existe (login: ${EMAIL})`);
    return null;
  }
  const { companyId } = registerCompany({ companyName: 'Clínica Sorriso (demo)', name: 'Dono da Clínica', email: EMAIL, password: PASSWORD, plan: 'profissional', segment: 'clinica' });
  saveSettings(companyId, {
    ai: {
      agent_name: 'Ana',
      business_description: 'Clínica odontológica em Campinas/SP. Rua das Flores, 123 — Centro. Estacionamento conveniado. Aceitamos Pix, cartão em até 10x e boleto. Não atendemos convênios.',
      instructions: 'Seja acolhedora e objetiva. Avaliação inicial custa R$ 99 e é abatida do tratamento. Sempre ofereça a avaliação para quem não sabe qual tratamento precisa.',
      objective: 'agendar',
      scheduling_mode: 'auto',
      price_mode: 'show',
      charge_mode: 'auto',
      intake_questions: [{ key: 'queixa_principal', label: 'Queixa principal', question: 'O que está te incomodando ou o que você gostaria de melhorar no sorriso?' }],
      urgency_rules: 'Dor forte, inchaço no rosto, sangramento que não para ou dente quebrado/arrancado.',
      never_say: 'Dar diagnóstico ou indicar medicamento.',
    },
    billing: { provider: 'pix_manual', pix_key: 'financeiro@clinicasorriso.com.br', pix_name: 'Clinica Sorriso', pix_city: 'Campinas' },
  });
  const company = getCompany(companyId);
  const tz = company.timezone;
  const today = todayIn(tz);

  const products = [
    ['Avaliação odontológica', 'Consulta inicial com diagnóstico e plano de tratamento', 9900, 'servico', 30],
    ['Limpeza (profilaxia)', 'Limpeza completa com remoção de tártaro', 18000, 'servico', 60],
    ['Clareamento a laser', 'Sessão de clareamento em consultório', 89000, 'servico', 90],
    ['Restauração em resina', 'Por dente', 25000, 'servico', 60],
    ['Kit clareamento caseiro', 'Moldeiras + gel para 15 dias', 45000, 'produto', 0],
  ].map(([name, description, price, kind, duration]) => run(
    'INSERT INTO products (company_id, name, description, price_cents, kind, duration_min) VALUES (?, ?, ?, ?, ?, ?)',
    companyId, name, description, price, kind, duration,
  ).id);

  const seq = (name, trigger, steps) => run(
    'INSERT INTO sequences (company_id, name, trigger, steps) VALUES (?, ?, ?, ?)', companyId, name, trigger, JSON.stringify(steps),
  ).id;
  seq('Boas-vindas para novos leads', 'manual', [
    { delay_hours: 2, message: 'Oi {{nome}}! Aqui é a Ana da {{empresa}}. Vi que você entrou em contato. Posso te ajudar a agendar uma avaliação? 😊', use_ai: true },
    { delay_hours: 24, message: 'Oi {{nome}}, ainda está procurando um dentista? Tenho horários essa semana, quer que eu reserve um para você?', use_ai: true },
    { delay_hours: 72, message: '{{nome}}, vou deixar seu atendimento em aberto por aqui. Quando quiser agendar é só responder essa mensagem!', use_ai: false },
  ]);
  seq('Proposta enviada — não respondeu', 'stage:proposta', [
    { delay_hours: 24, message: 'Oi {{nome}}! Conseguiu ver a proposta que te enviei? Ficou alguma dúvida?', use_ai: true },
    { delay_hours: 72, message: '{{nome}}, consigo parcelar em até 10x sem juros. Quer que eu gere o link de pagamento?', use_ai: true },
  ]);
  seq('Prospecção Google Maps (B2B)', 'manual', [
    { delay_hours: 0, message: 'Olá, tudo bem? Vi a {{negocio}} no Google Maps e gostaria de apresentar uma parceria. Posso te mandar mais detalhes?', use_ai: false },
    { delay_hours: 48, message: 'Oi! Passando para saber se você viu minha mensagem sobre a parceria. Posso te explicar em 2 minutos?', use_ai: false },
  ]);
  seq('Reativação de perdidos', 'stage:perdido', [
    { delay_hours: 24 * 30, message: 'Oi {{nome}}! Faz um tempinho que conversamos. Este mês estamos com condição especial na avaliação. Quer agendar?', use_ai: true },
  ]);

  const people = [
    ['Mariana Costa', '11987654321', 'ganho', 'whatsapp', 89000, 'Clareamento'],
    ['João Pereira', '19991234567', 'proposta', 'whatsapp', 25000, 'Restauração'],
    ['Fernanda Lima', '19988776655', 'qualificado', 'site', 18000, 'Limpeza'],
    ['Carlos Souza', '11976543210', 'contato', 'whatsapp', 0, ''],
    ['Patrícia Alves', '19981112233', 'novo', 'manual', 0, ''],
    ['Ricardo Gomes', '19982223344', 'ganho', 'indicacao', 45000, 'Kit clareamento'],
    ['Beatriz Rocha', '19983334455', 'perdido', 'whatsapp', 0, 'Achou caro'],
    ['Lucas Martins', '19984445566', 'novo', 'whatsapp', 0, ''],
    ['Juliana Nunes', '19985556677', 'proposta', 'site', 89000, 'Clareamento'],
    ['Pedro Henrique', '19986667788', 'qualificado', 'whatsapp', 9900, 'Avaliação'],
  ];
  const ids = people.map(([name, phone, stage, source, value, interest], i) => {
    const c = createContact(companyId, { name, phone, source, value_cents: value, interest }, { trigger: false });
    const created = new Date(Date.now() - (i * 2.5 + 1) * 86400000).toISOString();
    run('UPDATE contacts SET created_at = ?, updated_at = ? WHERE id = ?', created, created, c.id);
    if (stage !== 'novo') changeStage(companyId, c.id, stage);
    if (stage === 'ganho') run('UPDATE contacts SET won_at = ? WHERE id = ?', new Date(Date.now() - i * 86400000).toISOString(), c.id);
    return c.id;
  });

  const msg = (cid, direction, author, body, minutesAgo) => run(
    'INSERT INTO messages (company_id, contact_id, direction, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    companyId, cid, direction, author, body, new Date(Date.now() - minutesAgo * 60000).toISOString(),
  );
  msg(ids[1], 'in', 'contact', 'Oi, quanto custa uma restauração?', 300);
  msg(ids[1], 'out', 'ai', 'Oi, João! A restauração em resina custa R$ 250,00 por dente. Quer agendar uma avaliação para vermos quantos dentes precisam? 😊', 299);
  msg(ids[1], 'in', 'contact', 'Vou ver e te falo', 290);
  msg(ids[3], 'in', 'contact', 'Bom dia! Vocês atendem sábado?', 45);
  msg(ids[3], 'out', 'ai', 'Bom dia, Carlos! Atendemos sim, aos sábados das 9h às 12h. Quer que eu veja um horário para você?', 44);
  msg(ids[7], 'in', 'contact', 'Olá, queria fazer clareamento', 8);
  run('UPDATE contacts SET unread = 1, last_inbound_at = ? WHERE id = ?', new Date().toISOString(), ids[7]);

  const appt = (cid, pid, title, dayOffset, time, status = 'agendado') => {
    const start = zonedToUtc(addDays(today, dayOffset), time, tz);
    const dur = pid ? get('SELECT duration_min FROM products WHERE id = ?', pid).duration_min || 60 : 60;
    run('INSERT INTO appointments (company_id, contact_id, product_id, title, start_at, end_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      companyId, cid, pid, title, start.toISOString(), new Date(start.getTime() + dur * 60000).toISOString(), status, 'ai');
  };
  appt(ids[2], products[1], 'Limpeza — Fernanda Lima', 1, '10:00');
  appt(ids[9], products[0], 'Avaliação — Pedro Henrique', 1, '14:30', 'confirmado');
  appt(ids[1], products[0], 'Avaliação — João Pereira', 2, '09:00');
  appt(ids[0], products[2], 'Clareamento — Mariana Costa', -3, '15:00', 'concluido');
  appt(ids[5], products[0], 'Avaliação — Ricardo Gomes', -6, '11:00', 'concluido');

  const charge = (cid, desc, amount, dueOffset, status, paidDaysAgo = null) => {
    const { id } = run('INSERT INTO charges (company_id, contact_id, description, amount_cents, due_date, status, provider, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      companyId, cid, desc, amount, addDays(today, dueOffset), status, 'pix_manual',
      paidDaysAgo === null ? null : new Date(Date.now() - paidDaysAgo * 86400000).toISOString());
    run('UPDATE charges SET pix_code = ? WHERE id = ?', pixPayload({ key: 'financeiro@clinicasorriso.com.br', name: 'Clinica Sorriso', city: 'Campinas', amountCents: amount, txid: `VF${id}` }), id);
  };
  charge(ids[0], 'Clareamento a laser', 89000, -3, 'pago', 3);
  charge(ids[5], 'Kit clareamento caseiro', 45000, -6, 'pago', 5);
  charge(ids[5], 'Avaliação odontológica', 9900, -12, 'pago', 12);
  charge(ids[9], 'Avaliação odontológica', 9900, 1, 'pendente');
  charge(ids[1], 'Restauração em resina (2 dentes)', 50000, -4, 'vencido');
  charge(ids[8], 'Clareamento a laser — sinal', 30000, 3, 'pendente');

  console.log(`Empresa demo criada. Login: ${EMAIL} / senha: ${PASSWORD}`);
  return companyId;
}

const LAW_EMAIL = 'advocacia@fechou.app';

export async function seedLawFirm({ email = LAW_EMAIL, password = PASSWORD } = {}) {
  if (main.get('SELECT id FROM users WHERE email = ?', email)) {
    console.log(`Escritório demo já existe (login: ${email})`);
    return null;
  }
  const { companyId } = registerCompany({ companyName: 'Martins & Lima Advocacia', name: 'Dra. Ana Martins', email, password, plan: 'profissional', segment: 'advocacia' });
  const weekdays = (ranges) => ({ dom: [], seg: ranges, ter: ranges, qua: ranges, qui: ranges, sex: ranges, sab: [] });
  saveSettings(companyId, {
    business_hours: weekdays([['09:00', '12:00'], ['13:00', '18:00']]),
    scheduling: { slot_interval_min: 60, default_duration_min: 60, min_notice_min: 120, capacity: 1, reminder_hours_before: 24 },
    ai: {
      agent_name: 'Camila',
      business_description: 'Escritório de advocacia em Belo Horizonte/MG (Av. Afonso Pena, 1500, sala 803 — Centro). Atuamos em Direito Trabalhista, Previdenciário, Família e Sucessões, e Consumidor/Cível. Consultas presenciais ou por videochamada. Para a consulta, o cliente deve trazer documento com foto e os documentos que tiver sobre o caso.',
      instructions: 'Seja acolhedora e profissional. Muitas pessoas chegam preocupadas: mostre empatia antes de fazer perguntas. Ofereça consulta presencial ou por videochamada.',
      objective: 'qualificar',
      scheduling_mode: 'confirm',
      price_mode: 'hide',
      charge_mode: 'never',
      intake_questions: [
        { key: 'area', label: 'Área do caso', question: 'Para eu te direcionar ao advogado certo: seu caso é trabalhista, previdenciário (INSS), de família ou de consumidor?' },
        { key: 'resumo', label: 'Resumo do caso', question: 'Pode me contar em poucas palavras o que aconteceu?' },
        { key: 'processo', label: 'Já existe processo?', question: 'Já existe algum processo em andamento sobre isso?' },
        { key: 'cidade', label: 'Cidade', question: 'Em qual cidade você está?' },
      ],
      urgency_rules: 'Audiência marcada para os próximos dias\nPrisão ou alguém preso\nPrazo vencendo ou intimação recebida\nOrdem de despejo',
      never_say: 'Dar parecer jurídico ou opinião sobre as chances do caso\nPrometer resultado\nFalar de honorários ou valores\nComentar prazos processuais',
    },
    team: { task_sla_hours: 3 },
    billing: { provider: 'pix_manual', pix_key: 'financeiro@martinslima.adv.br', pix_name: 'Martins e Lima Advocacia', pix_city: 'Belo Horizonte' },
  });
  const company = getCompany(companyId);
  const tz = company.timezone;
  const today = todayIn(tz);

  const service = (name, description, duration) => run(
    'INSERT INTO products (company_id, name, description, price_cents, kind, duration_min) VALUES (?, ?, ?, ?, ?, ?)',
    companyId, name, description, 30000, 'servico', duration,
  ).id;
  const trab = service('Consulta inicial — Trabalhista', 'Rescisão, horas extras, assédio, acidente de trabalho', 60);
  const prev = service('Consulta inicial — Previdenciário', 'Aposentadoria, auxílio-doença, BPC/LOAS, revisão de benefício', 60);
  const fam = service('Consulta inicial — Família e Sucessões', 'Divórcio, pensão alimentícia, guarda, inventário', 60);
  const cons = service('Consulta inicial — Consumidor e Cível', 'Cobranças indevidas, negativação, contratos, indenizações', 60);
  const retorno = service('Retorno de cliente', 'Acompanhamento de caso em andamento', 30);

  const ana = saveProfessional(companyId, {
    name: 'Dra. Ana Martins', role: 'Trabalhista e Previdenciário', color: '#1f7a45', services: [trab, prev, retorno],
    business_hours: { dom: [], seg: [['09:00', '12:00'], ['14:00', '18:00']], ter: [], qua: [['09:00', '12:00'], ['14:00', '18:00']], qui: [], sex: [['09:00', '12:00'], ['14:00', '18:00']], sab: [] },
  });
  const carlos = saveProfessional(companyId, {
    name: 'Dr. Carlos Lima', role: 'Família e Sucessões', color: '#2563eb', services: [fam, retorno],
    business_hours: { dom: [], seg: [], ter: [['09:00', '12:00'], ['13:00', '18:00']], qua: [], qui: [['09:00', '12:00'], ['13:00', '18:00']], sex: [['09:00', '12:00']], sab: [] },
  });
  const juliana = saveProfessional(companyId, {
    name: 'Dra. Juliana Rocha', role: 'Consumidor e Cível', color: '#7c3aed', services: [cons, prev, retorno],
    business_hours: weekdays([['13:00', '18:00']]),
  });

  const seq = (name, trigger, steps) => run('INSERT INTO sequences (company_id, name, trigger, steps) VALUES (?, ?, ?, ?)', companyId, name, trigger, JSON.stringify(steps)).id;
  seq('Consulta feita — acompanhar proposta', 'stage:proposta', [
    { delay_hours: 48, message: 'Olá, {{nome}}! Aqui é a Camila, do escritório Martins & Lima. Ficou alguma dúvida sobre a proposta que o advogado te apresentou?', use_ai: true },
    { delay_hours: 120, message: '{{nome}}, passando para saber se você decidiu seguir com o caso. Se preferir, posso agendar uma conversa rápida com o advogado.', use_ai: true },
  ]);
  seq('Lead sem resposta', 'manual', [
    { delay_hours: 24, message: 'Olá, {{nome}}! Vi que você nos procurou. Ainda posso te ajudar a agendar a consulta?', use_ai: false },
  ]);

  const at = (dayOffset, time) => zonedToUtc(addDays(today, dayOffset), time, tz).toISOString();
  const nextWeekday = (wd, minOffset = 1) => { for (let i = minOffset; i < minOffset + 8; i++) if (new Date(`${addDays(today, i)}T12:00:00Z`).getUTCDay() === wd) return i; return minOffset; };
  const msg = (cid, direction, author, body, minutesAgo) => run(
    'INSERT INTO messages (company_id, contact_id, direction, author, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    companyId, cid, direction, author, body, new Date(Date.now() - minutesAgo * 60000).toISOString(),
  );
  const person = (name, phone, stage, source, interest, fields, daysAgo) => {
    const c = createContact(companyId, { name, phone, source, interest }, { trigger: false });
    const created = new Date(Date.now() - daysAgo * 86400000).toISOString();
    run('UPDATE contacts SET created_at = ?, updated_at = ? WHERE id = ?', created, created, c.id);
    if (fields) saveCustomFields(companyId, c.id, fields);
    if (stage !== 'novo') changeStage(companyId, c.id, stage);
    return c.id;
  };

  // Conversa de triagem completa, com horário reservado aguardando confirmação.
  const marta = person('Marta Souza', '31987651234', 'qualificado', 'whatsapp', 'Rescisão sem pagamento', { area: 'Trabalhista', resumo: 'Foi demitida há 2 semanas e não recebeu as verbas rescisórias', processo: 'Não', cidade: 'Belo Horizonte' }, 0.1);
  msg(marta, 'in', 'contact', 'Boa tarde, fui demitida e a empresa não pagou minha rescisão', 95);
  msg(marta, 'out', 'ai', 'Boa tarde, Marta! Aqui é a Camila, do escritório Martins & Lima. Sinto muito por essa situação, vamos te ajudar. Para eu te direcionar ao advogado certo: seu caso é trabalhista, previdenciário (INSS), de família ou de consumidor?', 94);
  msg(marta, 'in', 'contact', 'Trabalhista', 92);
  msg(marta, 'out', 'ai', 'Obrigada! Pode me contar em poucas palavras o que aconteceu?', 91);
  msg(marta, 'in', 'contact', 'Fui demitida há 2 semanas e não recebi nada das verbas rescisórias', 89);
  msg(marta, 'out', 'ai', 'Entendi. Já existe algum processo em andamento sobre isso?', 88);
  msg(marta, 'in', 'contact', 'Não', 87);
  msg(marta, 'out', 'ai', 'Em qual cidade você está?', 86);
  msg(marta, 'in', 'contact', 'BH', 85);
  const dMarta = nextWeekday(3);
  msg(marta, 'out', 'ai', `Obrigada pelas informações! Quem cuida desse tipo de caso é a Dra. Ana Martins. Ela tem horário na quarta às 10h ou às 15h. Qual fica melhor? A consulta pode ser presencial ou por videochamada.`, 84);
  msg(marta, 'in', 'contact', 'Quarta às 10h, por vídeo', 80);
  const apptMarta = createAppointment(companyId, { contactId: marta, productId: trab, professionalId: ana.id, startAt: at(dMarta, '10:00'), status: 'solicitado', createdBy: 'seed', force: true, notes: 'Por videochamada' });
  msg(marta, 'out', 'ai', 'Reservei quarta às 10h com a Dra. Ana Martins, por videochamada. A equipe confirma em seguida e eu te aviso por aqui. 😊', 79);
  await createTask(companyId, { contactId: marta, type: 'confirmar_agendamento', title: `Confirmar horário — ${apptMarta.title}`, details: 'Solicitado para quarta às 10:00 com Dra. Ana Martins (videochamada)', payload: { appointment_id: apptMarta.id }, createdBy: 'ai' });

  // Urgência: audiência marcada.
  const roberto = person('Roberto Alves', '31991112233', 'contato', 'whatsapp', 'Audiência de pensão', { area: 'Família' }, 0.05);
  msg(roberto, 'in', 'contact', 'Preciso de ajuda urgente, tenho audiência de pensão na quinta e meu advogado sumiu', 25);
  msg(roberto, 'out', 'ai', 'Entendi, Roberto, isso é urgente. Já avisei a equipe e o Dr. Carlos Lima, que cuida de casos de família, vai falar com você em instantes. 🙏', 24);
  run('UPDATE contacts SET ai_enabled = 0, unread = 1 WHERE id = ?', roberto);
  await createTask(companyId, { contactId: roberto, type: 'urgente', details: 'Audiência de pensão na quinta; advogado anterior não responde', createdBy: 'ai', dueAt: new Date(Date.now() - 5 * 60000).toISOString() });

  // Triagem em andamento.
  const sandra = person('Sandra Pereira', '31988884444', 'contato', 'whatsapp', '', { area: 'Previdenciário' }, 0.02);
  msg(sandra, 'in', 'contact', 'Oi, o INSS negou meu auxílio-doença', 12);
  msg(sandra, 'out', 'ai', 'Olá, Sandra! Aqui é a Camila, do escritório Martins & Lima. Sinto muito, vamos ver como te ajudar. Pode me contar em poucas palavras o que aconteceu?', 11);
  run('UPDATE contacts SET unread = 1 WHERE id = ?', sandra);

  // Clientes com consultas confirmadas e histórico.
  const paulo = person('Paulo Henrique', '31977776666', 'qualificado', 'site', 'Cobrança indevida no cartão', { area: 'Consumidor', resumo: 'Cobranças de seguro que não contratou', processo: 'Não', cidade: 'Contagem' }, 3);
  createAppointment(companyId, { contactId: paulo, productId: cons, professionalId: juliana.id, startAt: at(1, '14:00'), status: 'confirmado', createdBy: 'seed', force: true });
  const lucia = person('Lúcia Fernandes', '31966665555', 'qualificado', 'indicacao', 'Divórcio consensual', { area: 'Família', resumo: 'Divórcio consensual com partilha de um imóvel', processo: 'Não', cidade: 'Belo Horizonte' }, 5);
  createAppointment(companyId, { contactId: lucia, productId: fam, professionalId: carlos.id, startAt: at(nextWeekday(2), '10:00'), status: 'confirmado', createdBy: 'seed', force: true });
  const jose = person('José Carlos Dias', '31955554444', 'proposta', 'whatsapp', 'Aposentadoria por tempo de contribuição', { area: 'Previdenciário', resumo: 'Quer saber se já pode se aposentar', processo: 'Não', cidade: 'Betim' }, 9);
  createAppointment(companyId, { contactId: jose, productId: prev, professionalId: ana.id, startAt: at(-4, '15:00'), status: 'concluido', createdBy: 'seed', force: true });
  const fernanda = person('Fernanda Costa', '31944443333', 'ganho', 'whatsapp', 'Horas extras não pagas', { area: 'Trabalhista', resumo: 'Horas extras não pagas por 3 anos', processo: 'Não', cidade: 'Belo Horizonte' }, 15);
  createAppointment(companyId, { contactId: fernanda, productId: trab, professionalId: ana.id, startAt: at(-10, '09:00'), status: 'concluido', createdBy: 'seed', force: true });
  createAppointment(companyId, { contactId: fernanda, productId: retorno, professionalId: ana.id, startAt: at(nextWeekday(5), '11:00'), status: 'confirmado', createdBy: 'seed', force: true });
  run('UPDATE contacts SET won_at = ? WHERE id = ?', new Date(Date.now() - 6 * 86400000).toISOString(), fernanda);
  const ricardo = person('Ricardo Mendes', '31933332222', 'ganho', 'google_maps', 'Inventário', { area: 'Família', resumo: 'Inventário do pai, 3 herdeiros', processo: 'Não', cidade: 'Nova Lima' }, 20);
  run('UPDATE contacts SET won_at = ? WHERE id = ?', new Date(Date.now() - 12 * 86400000).toISOString(), ricardo);
  const tiago = person('Tiago Ramos', '31922221111', 'perdido', 'whatsapp', 'Multa de trânsito', { area: 'Outro' }, 8);
  msg(tiago, 'in', 'contact', 'Vocês recorrem de multa de trânsito?', 60 * 24 * 8);
  msg(tiago, 'out', 'ai', 'Olá, Tiago! Infelizmente não atuamos com multas de trânsito. Posso te ajudar com algo trabalhista, previdenciário, de família ou de consumidor?', 60 * 24 * 8 - 1);

  await createTask(companyId, { contactId: jose, type: 'retorno', title: 'Enviar proposta de honorários — José Carlos', details: 'Consulta feita com a Dra. Ana; cliente aguarda proposta por escrito', createdBy: 'manual' });

  const charge = (cid, desc, amount, dueOffset, status, paidDaysAgo = null) => {
    const { id } = run('INSERT INTO charges (company_id, contact_id, description, amount_cents, due_date, status, provider, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      companyId, cid, desc, amount, addDays(today, dueOffset), status, 'pix_manual', paidDaysAgo === null ? null : new Date(Date.now() - paidDaysAgo * 86400000).toISOString());
    run('UPDATE charges SET pix_code = ? WHERE id = ?', pixPayload({ key: 'financeiro@martinslima.adv.br', name: 'Martins e Lima Advocacia', city: 'Belo Horizonte', amountCents: amount, txid: `VF${id}` }), id);
  };
  charge(fernanda, 'Honorários iniciais — ação trabalhista', 150000, -6, 'pago', 6);
  charge(ricardo, 'Honorários — inventário (1ª parcela)', 300000, -12, 'pago', 11);
  charge(ricardo, 'Honorários — inventário (2ª parcela)', 300000, -2, 'vencido');
  charge(fernanda, 'Custas iniciais', 45000, 4, 'pendente');

  console.log(`Escritório demo criado. Login: ${email} / senha: ${password}`);
  return companyId;
}

if (process.argv[1]?.endsWith('seed.js')) {
  if (process.argv[2] === 'advocacia') await seedLawFirm();
  else seedDemo();
}
