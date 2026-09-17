// Compatibility surface for tests and `npm run create-admin`.
// The implementation now lives in lib/store-sqlite.mjs so both hosts share it.
export { openDatabase as database, createUser, sqliteStore } from '../lib/store-sqlite.mjs';
export { passwordHash, passwordMatches } from '../lib/core.mjs';
