// Só o suficiente para contas e sessões da demonstração (tudo fica no navegador).
const B = globalThis.Buffer;
export function randomBytes(n) {
  const buf = B.from(globalThis.crypto.getRandomValues(new Uint8Array(n)));
  // O pacote "buffer" do navegador não conhece base64url.
  const toString = buf.toString.bind(buf);
  buf.toString = (enc, ...rest) => (enc === 'base64url'
    ? toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : toString(enc, ...rest));
  return buf;
}
export function scryptSync(password, salt, len) {
  const out = new Uint8Array(len);
  let h = 2166136261;
  const input = `${salt}:${password}`;
  for (let round = 0; round < 64; round++) {
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i) + round; h = Math.imul(h, 16777619) >>> 0; out[(i + round) % len] ^= h & 0xff; }
  }
  return B.from(out);
}
export const timingSafeEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export const createHmac = () => { throw new Error('indisponível na demonstração'); };
export default { randomBytes, scryptSync, timingSafeEqual, createHmac };
