// No navegador a demonstração usa só o banco compartilhado: um contexto síncrono basta.
export class AsyncLocalStorage {
  run(store, fn) {
    const prev = this.store;
    this.store = store;
    try { return fn(); } finally { this.store = prev; }
  }
  getStore() { return this.store; }
}
export default { AsyncLocalStorage };
