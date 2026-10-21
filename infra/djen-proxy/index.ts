// Ponto de saída no Brasil para o Diário de Justiça Eletrônico Nacional (DJEN / Comunica API do CNJ).
// O Diário recusa (HTTP 403) consultas de fora do Brasil, e o Conversa CRM roda nos EUA. Esta função
// do Supabase é chamada com o cabeçalho "x-region: sa-east-1" (São Paulo) e só repassa consultas de
// leitura ao Diário. Protegida por senha (DJEN_PROXY_TOKEN, a mesma configurada no Railway).
// Publicada com verify_jwt = false: a autenticação é a senha acima.

const DJEN = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const ALLOWED = new Set([
  'numeroOab', 'ufOab', 'numeroProcesso', 'siglaTribunal', 'nomeAdvogado',
  'dataDisponibilizacaoInicio', 'dataDisponibilizacaoFim', 'itensPorPagina', 'pagina',
]);

const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });

// Compara a senha sem vazar o tempo de comparação.
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return json(405, { error: 'Só consultas (GET).' });
  // Tolerante a espaço, quebra de linha ou aspas coladas junto com a senha.
  const clean = (v: string | null) => String(v || '').trim().replace(/^["']|["']$/g, '').trim();
  const token = clean(Deno.env.get('DJEN_PROXY_TOKEN'));
  const given = clean(req.headers.get('x-proxy-token'));
  if (!sameSecret(given, token)) {
    // "configured" ajuda a saber se o segredo DJEN_PROXY_TOKEN está cadastrado neste projeto.
    return json(401, { error: 'Senha inválida.', configured: token.length > 0 });
  }

  const url = new URL(req.url);
  // Diagnóstico: de onde esta função está saindo (deve ser BR / São Paulo).
  if (url.searchParams.get('ping') === '1') {
    const where = await fetch('https://ipinfo.io/json').then((r) => r.json()).catch(() => ({}));
    return json(200, { ok: true, region: Deno.env.get('SB_REGION') || null, country: where.country || null, city: where.city || null });
  }

  const qs = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (ALLOWED.has(k)) qs.set(k, v.slice(0, 120));
  if (![...qs.keys()].some((k) => ['numeroOab', 'numeroProcesso', 'siglaTribunal', 'nomeAdvogado'].includes(k))) {
    return json(400, { error: 'Informe numeroOab, numeroProcesso, siglaTribunal ou nomeAdvogado.' });
  }
  try {
    const res = await fetch(`${DJEN}?${qs}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    const extra: Record<string, string> = {};
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) extra['x-ratelimit-remaining'] = remaining;
    return new Response(body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json', ...extra } });
  } catch (err) {
    return json(504, { error: `Diário sem resposta: ${(err as Error).name}` });
  }
});
