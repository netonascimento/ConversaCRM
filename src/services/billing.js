import { all, get, run, now } from '../db.js';
import { config } from '../config.js';
import { getCompany } from './company.js';
import { getContact, formatMoney, firstName, logActivity, changeStage } from './crm.js';
import { sendMessage } from './messaging.js';
import { todayIn, daysBetween, formatDateBR, isWithinHours, addDays } from './time.js';

// ---- Pix "copia e cola" (BR Code estático, padrão EMV do Banco Central) --------

function emv(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

export function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const plain = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, max);

export function pixPayload({ key, name, city, amountCents, txid = '***', description = '' }) {
  if (!key) throw new Error('Chave Pix não configurada (Configurações → Cobrança)');
  const account = emv('00', 'br.gov.bcb.pix') + emv('01', key) + (description ? emv('02', plain(description, 40)) : '');
  const body = emv('00', '01')
    + emv('26', account)
    + emv('52', '0000')
    + emv('53', '986')
    + (amountCents ? emv('54', (amountCents / 100).toFixed(2)) : '')
    + emv('58', 'BR')
    + emv('59', plain(name, 25) || 'RECEBEDOR')
    + emv('60', plain(city, 15) || 'BRASIL')
    + emv('62', emv('05', plain(txid, 25).replace(/ /g, '') || '***'))
    + '6304';
  return body + crc16(body);
}

// ---- Gateways ---------------------------------------------------------------

async function asaasRequest(billing, method, pathname, body) {
  const base = billing.asaas_sandbox ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
  const res = await fetch(base + pathname, {
    method,
    headers: { access_token: billing.asaas_api_key, 'Content-Type': 'application/json', 'User-Agent': 'Falaki' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.errors?.[0]?.description || `Asaas HTTP ${res.status}`);
  return data;
}

async function createAsaasCharge(company, charge, contact) {
  const billing = company.settings.billing;
  if (!billing.asaas_api_key) throw new Error('Chave da API do Asaas não configurada');
  if (!contact?.document) throw new Error('O Asaas exige CPF/CNPJ do cliente: preencha o campo "Documento" no contato');
  const found = await asaasRequest(billing, 'GET', `/customers?externalReference=contact:${contact.id}`);
  const customer = found.data?.[0] || await asaasRequest(billing, 'POST', '/customers', {
    name: contact.name || contact.business_name || 'Cliente', cpfCnpj: contact.document.replace(/\D/g, ''),
    email: contact.email || undefined, mobilePhone: contact.phone?.replace(/^55/, '') || undefined,
    externalReference: `contact:${contact.id}`,
  });
  const payment = await asaasRequest(billing, 'POST', '/payments', {
    customer: customer.id, billingType: 'UNDEFINED', value: charge.amount_cents / 100,
    dueDate: charge.due_date, description: charge.description, externalReference: `charge:${charge.id}`,
  });
  return { provider_id: payment.id, payment_url: payment.invoiceUrl };
}

async function createMercadoPagoCharge(company, charge) {
  const token = company.settings.billing.mercadopago_token;
  if (!token) throw new Error('Access token do Mercado Pago não configurado');
  const res = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ title: charge.description, quantity: 1, unit_price: charge.amount_cents / 100, currency_id: 'BRL' }],
      external_reference: `charge:${charge.id}`,
      notification_url: `${config.publicUrl}/webhooks/billing/mercadopago/${company.public_id}?token=${company.webhook_token}`,
      date_of_expiration: `${addDays(charge.due_date, 30)}T23:59:59.000-03:00`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Mercado Pago HTTP ${res.status}`);
  return { provider_id: data.id, payment_url: data.init_point };
}

export async function fetchMercadoPagoPayment(company, paymentId) {
  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${company.settings.billing.mercadopago_token}` },
  });
  if (!res.ok) throw new Error(`Mercado Pago HTTP ${res.status}`);
  return res.json();
}

// ---- Mensagens --------------------------------------------------------------

function paymentInfo(charge) {
  if (charge.payment_url) return `Link para pagamento: ${charge.payment_url}`;
  if (charge.pix_code) return `Pix copia e cola:\n${charge.pix_code}`;
  return 'Responda esta mensagem para receber os dados de pagamento.';
}

export function chargeMessage(kind, charge, contact, days = 0) {
  const nome = firstName(contact?.name) || 'tudo bem';
  const valor = formatMoney(charge.amount_cents);
  const venc = formatDateBR(charge.due_date);
  const pay = paymentInfo(charge);
  switch (kind) {
    case 'new':
      return `Olá, ${nome}! Segue a cobrança referente a *${charge.description}* no valor de *${valor}*, com vencimento em ${venc}.\n\n${pay}\n\nQualquer dúvida é só responder aqui. 😊`;
    case 'before':
      return days === 0
        ? `Oi, ${nome}! Passando para lembrar que a cobrança de *${charge.description}* (${valor}) vence *hoje*.\n\n${pay}\n\nSe já pagou, pode desconsiderar. Obrigado!`
        : `Oi, ${nome}! Um lembrete amigável: a cobrança de *${charge.description}* (${valor}) vence em ${days} dia${days > 1 ? 's' : ''} (${venc}).\n\n${pay}`;
    case 'after':
      return `Oi, ${nome}, tudo bem? Notamos que a cobrança de *${charge.description}* (${valor}) com vencimento em ${venc} ainda está em aberto. Imagino que tenha sido só a correria. 🙏\n\n${pay}\n\nSe já pagou, desconsidere. Se precisar de outra data ou de parcelamento, me avise que a gente resolve.`;
    case 'paid':
      return `Pagamento de *${charge.description}* (${valor}) recebido! ✅ Muito obrigado, ${nome}.`;
    default:
      return pay;
  }
}

// ---- Operações --------------------------------------------------------------

export const getCharge = (companyId, id) => get(
  `SELECT ch.*, c.name AS contact_name, c.phone AS contact_phone FROM charges ch
   LEFT JOIN contacts c ON c.id = ch.contact_id WHERE ch.company_id = ? AND ch.id = ?`, companyId, id);

export function listCharges(companyId, { status, contactId } = {}) {
  const where = ['ch.company_id = ?'];
  const params = [companyId];
  if (status) { where.push('ch.status = ?'); params.push(status); }
  if (contactId) { where.push('ch.contact_id = ?'); params.push(contactId); }
  return all(`SELECT ch.*, c.name AS contact_name, c.phone AS contact_phone FROM charges ch
              LEFT JOIN contacts c ON c.id = ch.contact_id WHERE ${where.join(' AND ')}
              ORDER BY CASE ch.status WHEN 'vencido' THEN 0 WHEN 'pendente' THEN 1 ELSE 2 END, ch.due_date`, ...params);
}

export async function createCharge(companyId, { contactId, productId = null, description, amountCents, dueDate, send = true }) {
  const company = getCompany(companyId);
  const contact = contactId ? getContact(companyId, contactId) : null;
  if (!description || !(amountCents > 0)) throw new Error('Descrição e valor são obrigatórios');
  const due = dueDate || todayIn(company.timezone);
  const provider = company.settings.billing.provider;
  const { id } = run(
    'INSERT INTO charges (company_id, contact_id, product_id, description, amount_cents, due_date, provider) VALUES (?, ?, ?, ?, ?, ?, ?)',
    companyId, contactId || null, productId, description, Math.round(amountCents), due, provider,
  );
  let charge = getCharge(companyId, id);
  try {
    let extra = {};
    if (provider === 'asaas') extra = await createAsaasCharge(company, charge, contact);
    else if (provider === 'mercadopago') extra = await createMercadoPagoCharge(company, charge);
    else {
      const b = company.settings.billing;
      extra = { pix_code: pixPayload({ key: b.pix_key, name: b.pix_name || company.name, city: b.pix_city, amountCents: charge.amount_cents, txid: `VF${id}` }) };
    }
    run('UPDATE charges SET provider_id = ?, payment_url = ?, pix_code = ? WHERE id = ?', extra.provider_id || null, extra.payment_url || null, extra.pix_code || null, id);
  } catch (err) {
    run('DELETE FROM charges WHERE id = ?', id);
    throw err;
  }
  charge = getCharge(companyId, id);
  if (contact) {
    logActivity(companyId, contact.id, 'cobranca', `Cobrança criada: ${description} — ${formatMoney(charge.amount_cents)} (venc. ${formatDateBR(due)})`);
    if (send) {
      await sendMessage(companyId, contact.id, chargeMessage('new', charge, contact), 'billing');
      markReminder(charge, 'created');
    }
  }
  return charge;
}

function markReminder(charge, key) {
  const sent = JSON.parse(charge.reminders || '[]');
  if (!sent.includes(key)) sent.push(key);
  run('UPDATE charges SET reminders = ? WHERE id = ?', JSON.stringify(sent), charge.id);
}

export async function markPaid(companyId, chargeId, { notify = true, via = 'manual' } = {}) {
  const charge = getCharge(companyId, chargeId);
  if (!charge || charge.status === 'pago') return charge;
  run("UPDATE charges SET status = 'pago', paid_at = ? WHERE id = ?", now(), chargeId);
  const company = getCompany(companyId);
  if (charge.contact_id) {
    const contact = getContact(companyId, charge.contact_id);
    logActivity(companyId, charge.contact_id, 'cobranca', `Pagamento recebido: ${charge.description} — ${formatMoney(charge.amount_cents)} (${via})`);
    if (company.settings.billing.auto_win_on_payment && contact.stage !== 'ganho') changeStage(companyId, contact.id, 'ganho', 'pagamento recebido');
    if (notify) await sendMessage(companyId, contact.id, chargeMessage('paid', charge, contact), 'billing');
  }
  return getCharge(companyId, chargeId);
}

export function cancelCharge(companyId, chargeId) {
  run("UPDATE charges SET status = 'cancelado' WHERE id = ? AND company_id = ? AND status != 'pago'", chargeId, companyId);
  return getCharge(companyId, chargeId);
}

/** Marca vencidas e envia lembretes da régua de cobrança. Chamado pelo agendador. */
export async function processBilling() {
  let reminders = 0;
  const open = all("SELECT * FROM charges WHERE status IN ('pendente', 'vencido')");
  for (const charge of open) {
    const company = getCompany(charge.company_id);
    if (company.status !== 'ativa') continue;
    const today = todayIn(company.timezone);
    const days = daysBetween(today, charge.due_date); // > 0: faltam dias; < 0: atrasada
    if (days < 0 && charge.status === 'pendente') run("UPDATE charges SET status = 'vencido' WHERE id = ?", charge.id);
    if (!charge.contact_id) continue;
    if (!isWithinHours(new Date(), company.timezone, company.settings.business_hours)) continue;

    const { reminder_days_before: before, reminder_days_after: after } = company.settings.billing;
    let kind = null;
    let key = null;
    if (days >= 0 && before.map(Number).includes(days)) { kind = 'before'; key = `d-${days}`; }
    if (days < 0 && after.map(Number).includes(-days)) { kind = 'after'; key = `d+${-days}`; }
    const sent = JSON.parse(charge.reminders || '[]');
    if (!kind || sent.includes(key)) continue;
    // Não manda lembrete "faltam X dias" no mesmo dia em que a cobrança foi enviada.
    if (kind === 'before' && days > 0 && charge.created_at.slice(0, 10) === new Date().toISOString().slice(0, 10)) continue;

    const contact = getContact(charge.company_id, charge.contact_id);
    markReminder(charge, key);
    await sendMessage(charge.company_id, contact.id, chargeMessage(kind, charge, contact, days), 'billing');
    logActivity(charge.company_id, contact.id, 'cobranca', `Lembrete de cobrança enviado (${key}): ${charge.description}`);
    reminders++;
  }
  return reminders;
}
