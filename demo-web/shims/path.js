const clean = (p) => { const out = []; for (const seg of p.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); } return `/${out.join('/')}`; };
export const join = (...p) => clean(p.join('/'));
export const resolve = (...p) => clean(p.join('/'));
export const normalize = (p) => clean(p);
export const dirname = (p) => clean(`${p}/..`);
export const extname = (p) => (p.match(/\.[^./]+$/) || [''])[0];
export default { join, resolve, normalize, dirname, extname };
