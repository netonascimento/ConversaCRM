import { config } from '../config.js';

// Envio de e-mails da plataforma pelo Resend (https://resend.com/docs/api-reference/emails/send-email).

let sender = async ({ to, subject, html, text }) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Resend respondeu ${res.status}`);
  }
  return res.json();
};
// Permite substituir o envio nos testes.
export function setEmailSender(fn) { sender = fn; }

export const emailEnabled = () => Boolean(config.resendKey);

export const sendEmail = (msg) => sender(msg);

export function sendVerificationCode(to, name, code) {
  const first = String(name || '').trim().split(' ')[0];
  const text = `Olá${first ? `, ${first}` : ''}!\n\nSeu código de confirmação do Conversa CRM é: ${code}\n\nEle vale por 30 minutos. Se você não criou uma conta, ignore este e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2a24;max-width:480px">
  <p>Olá${first ? `, ${first.replace(/[<>&"']/g, '')}` : ''}!</p>
  <p>Seu código de confirmação do <strong>Conversa CRM</strong> é:</p>
  <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:16px 0">${code}</p>
  <p style="color:#66736b;font-size:13px">Ele vale por 30 minutos. Se você não criou uma conta, ignore este e-mail.</p>
</div>`;
  return sendEmail({ to, subject: `${code} é o seu código do Conversa CRM`, html, text });
}
