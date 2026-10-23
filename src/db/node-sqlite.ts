import { createRequire } from 'node:module';

/**
 * `node:sqlite` is a prefix-only builtin (bare `sqlite` is not resolvable). Some
 * bundlers — notably Vite, which the test runner uses — rewrite the ESM
 * specifier `node:sqlite` to `sqlite` when externalizing, which then fails to
 * load. Requiring it through `createRequire` keeps the specifier opaque to the
 * bundler while resolving to the real builtin at runtime.
 */
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import('node:sqlite').DatabaseSync;
