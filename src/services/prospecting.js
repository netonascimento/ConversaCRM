import { all, get, run } from '../db.js';
import { getCompany, placesKeyFor } from './company.js';
import { createContact, normalizePhone, logActivity } from './crm.js';
import { triggerSequences, enroll } from './followup.js';

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
  'places.internationalPhoneNumber', 'places.websiteUri', 'places.rating', 'places.userRatingCount',
  'places.googleMapsUri', 'places.primaryTypeDisplayName', 'nextPageToken',
].join(',');

/** Busca empresas no Google Maps (Places API - Text Search) e salva como prospects. */
export async function searchPlaces(companyId, query, { maxResults = 60 } = {}) {
  const company = getCompany(companyId);
  const key = placesKeyFor(company);
  if (!key) throw new Error('Configure a chave da Google Places API em Configurações → Avançado');
  if (!query?.trim()) throw new Error('Informe o que buscar, ex.: "dentista em Campinas"');

  const places = [];
  let pageToken;
  do {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify({ textQuery: query, languageCode: 'pt-BR', regionCode: 'BR', pageSize: 20, pageToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Google Places HTTP ${res.status}`);
    places.push(...(data.places || []));
    pageToken = data.nextPageToken;
  } while (pageToken && places.length < maxResults);

  return saveResults(companyId, query, places.map((p) => ({
    place_id: p.id,
    name: p.displayName?.text || 'Sem nome',
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || null,
    address: p.formattedAddress || null,
    website: p.websiteUri || null,
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? null,
    category: p.primaryTypeDisplayName?.text || null,
    maps_url: p.googleMapsUri || null,
  })));
}

export function saveResults(companyId, query, results) {
  const { id: searchId } = run('INSERT INTO prospect_searches (company_id, query, results_count) VALUES (?, ?, ?)', companyId, query, results.length);
  for (const r of results) {
    const existing = r.place_id && get('SELECT id FROM contacts WHERE company_id = ? AND place_id = ?', companyId, r.place_id);
    run(
      `INSERT INTO prospects (company_id, search_id, place_id, name, phone, address, website, rating, reviews, category, maps_url, contact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      companyId, searchId, r.place_id, r.name, r.phone, r.address, r.website, r.rating, r.reviews, r.category, r.maps_url, existing?.id || null,
    );
  }
  return getSearch(companyId, searchId);
}

export function getSearch(companyId, searchId) {
  const search = get('SELECT * FROM prospect_searches WHERE id = ? AND company_id = ?', searchId, companyId);
  if (!search) return null;
  return { ...search, results: all('SELECT * FROM prospects WHERE search_id = ? ORDER BY rating DESC NULLS LAST, reviews DESC', searchId) };
}

export const listSearches = (companyId) => all('SELECT * FROM prospect_searches WHERE company_id = ? ORDER BY id DESC LIMIT 50', companyId);

/** Importa prospects selecionados para o CRM e, opcionalmente, coloca num follow-up de prospecção. */
export function importProspects(companyId, prospectIds, { sequenceId = null } = {}) {
  const imported = [];
  for (const pid of prospectIds) {
    const p = get('SELECT * FROM prospects WHERE id = ? AND company_id = ?', pid, companyId);
    if (!p || p.contact_id) continue;
    const phone = normalizePhone(p.phone);
    const dup = phone && get('SELECT id FROM contacts WHERE company_id = ? AND phone = ?', companyId, phone);
    let contactId = dup?.id;
    if (!contactId) {
      const contact = createContact(companyId, {
        name: p.name, business_name: p.name, phone, address: p.address, website: p.website,
        rating: p.rating, place_id: p.place_id, source: 'google_maps', tags: p.category || '',
        notes: p.maps_url ? `Google Maps: ${p.maps_url}` : '',
      }, { trigger: false });
      contactId = contact.id;
      logActivity(companyId, contactId, 'prospeccao', `Importado do Google Maps (nota ${p.rating ?? '-'}, ${p.reviews ?? 0} avaliações)`);
      triggerSequences(companyId, contactId, 'prospect');
    }
    if (sequenceId) enroll(companyId, Number(sequenceId), contactId);
    run('UPDATE prospects SET contact_id = ? WHERE id = ?', contactId, p.id);
    imported.push(contactId);
  }
  return imported;
}
