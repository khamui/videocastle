import { defineConfig } from 'drizzle-kit';

// Drizzle Kit generates migration SQL from src/db/schema.ts into ./drizzle.
// The schema is the single source of truth; generated SQL is applied at boot
// by src/db/migrate.ts (see that file). We target the generic `sqlite` dialect
// because the runtime driver is node:sqlite via drizzle-orm/sqlite-proxy.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
