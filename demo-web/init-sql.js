import initSqlJs from 'sql.js/dist/sql-wasm.js';
import wasmBinary from 'sql.js/dist/sql-wasm.wasm';
globalThis.__SQL = await initSqlJs({ wasmBinary });
