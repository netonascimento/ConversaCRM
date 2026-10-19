export const existsSync = () => false;
export const mkdirSync = () => {};
export const readFileSync = () => { throw new Error('fs indisponível no navegador'); };
export const statSync = () => ({ isFile: () => false });
export const createReadStream = () => { throw new Error('fs indisponível no navegador'); };
export default { existsSync, mkdirSync, readFileSync, statSync, createReadStream };
