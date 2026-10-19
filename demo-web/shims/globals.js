import { Buffer } from 'buffer';
globalThis.Buffer = Buffer;
globalThis.process = { env: { DB_PATH: ':memory:', AI_DEBOUNCE_MS: '1200', DISABLE_SCHEDULER: 'true', PUBLIC_URL: 'https://seu-dominio.com.br' }, argv: [] };
