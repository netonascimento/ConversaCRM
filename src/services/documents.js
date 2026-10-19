import { all, get, run } from '../db.js';
import { getContact, logActivity } from './crm.js';

// Documentos da empresa: de um cliente, de um contrato ou gerais (sem cliente).
// O arquivo fica no banco da empresa (tabela document_files), junto com os outros dados dela.

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Só formatos de documento comuns. HTML, SVG e executáveis ficam de fora.
const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
};
export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

export const CATEGORIES = ['Contrato', 'Proposta', 'Documento pessoal', 'Comprovante', 'Nota fiscal', 'Laudo / relatório', 'Outro'];

const COLUMNS = `d.id, d.company_id, d.contact_id, d.contract_id, d.name, d.mime, d.size, d.category, d.uploaded_by, d.created_at,
  c.name AS contact_name, k.title AS contract_title`;
const FROM = `FROM documents d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN contracts k ON k.id = d.contract_id`;

export const getDocument = (companyId, id) => get(`SELECT ${COLUMNS} ${FROM} WHERE d.company_id = ? AND d.id = ?`, companyId, id) || null;

/** scope: 'company' = só os gerais da empresa; contactIds limita aos clientes visíveis (perfil Profissional). */
export function listDocuments(companyId, { contactId, contractId, q, scope, contactIds } = {}) {
  const where = ['d.company_id = ?'];
  const params = [companyId];
  if (contactId) { where.push('d.contact_id = ?'); params.push(contactId); }
  if (contractId) { where.push('d.contract_id = ?'); params.push(contractId); }
  if (scope === 'company') where.push('d.contact_id IS NULL');
  if (q) { where.push('(d.name LIKE ? OR d.category LIKE ? OR c.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = all(`SELECT ${COLUMNS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT 500`, ...params);
  return contactIds ? rows.filter((r) => r.contact_id && contactIds.has(r.contact_id)) : rows;
}

export function addDocument(companyId, { name, data, contactId = null, contractId = null, category = '' }, { by = 'Equipe' } = {}) {
  const fileName = String(name || '').trim().replace(/[\\/\0]/g, '_').slice(0, 200);
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  if (!fileName || !TYPES[ext]) throw new Error(`Formato não aceito. Envie: ${ALLOWED_EXTENSIONS.join(', ')}`);
  const bytes = Buffer.from(String(data || ''), 'base64');
  if (!bytes.length) throw new Error('Arquivo vazio');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error('Arquivo maior que 10 MB');
  let contact = null;
  if (contactId) {
    contact = getContact(companyId, contactId);
    if (!contact) throw new Error('Cliente não encontrado');
  }
  if (contractId) {
    const k = get('SELECT contact_id FROM contracts WHERE company_id = ? AND id = ?', companyId, contractId);
    if (!k) throw new Error('Contrato não encontrado');
    if (contact && k.contact_id !== contact.id) throw new Error('O contrato é de outro cliente');
    contactId = k.contact_id;
  }
  const { id } = run(
    'INSERT INTO documents (company_id, contact_id, contract_id, name, mime, size, category, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    companyId, contactId || null, contractId || null, fileName, TYPES[ext], bytes.length, String(category || '').slice(0, 60), by,
  );
  run('INSERT INTO document_files (document_id, data) VALUES (?, ?)', id, bytes);
  if (contactId) logActivity(companyId, contactId, 'documento', `${by} anexou o documento "${fileName}"`);
  return getDocument(companyId, id);
}

/** Conteúdo em base64 (o navegador monta o arquivo para abrir ou baixar). */
export function documentContent(companyId, id) {
  const doc = getDocument(companyId, id);
  if (!doc) return null;
  const file = get('SELECT data FROM document_files WHERE document_id = ?', id);
  return { ...doc, data: Buffer.from(file.data).toString('base64') };
}

export function updateDocument(companyId, id, { category, contractId }) {
  const doc = getDocument(companyId, id);
  if (!doc) return null;
  if (contractId !== undefined && contractId !== null) {
    const k = get('SELECT contact_id FROM contracts WHERE company_id = ? AND id = ?', companyId, contractId);
    if (!k || (doc.contact_id && k.contact_id !== doc.contact_id)) throw new Error('Contrato não encontrado para este cliente');
  }
  run('UPDATE documents SET category = ?, contract_id = ? WHERE id = ?',
    category === undefined ? doc.category : String(category).slice(0, 60), contractId === undefined ? doc.contract_id : contractId || null, id);
  return getDocument(companyId, id);
}

export function deleteDocument(companyId, id, { by = 'Equipe' } = {}) {
  const doc = getDocument(companyId, id);
  if (!doc) return false;
  run('DELETE FROM documents WHERE id = ?', id);
  if (doc.contact_id) logActivity(companyId, doc.contact_id, 'documento', `${by} excluiu o documento "${doc.name}"`);
  return true;
}
