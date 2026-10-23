import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from './node-sqlite';

interface JournalEntry {
  tag: string;
}
interface Journal {
  entries: JournalEntry[];
}

const migrationsDir = new URL('../../drizzle/', import.meta.url);

/**
 * Applies any not-yet-applied migrations from ./drizzle in journal order.
 *
 * The migration SQL is generated from src/db/schema.ts by `drizzle-kit generate`
 * (the schema is the single source of truth). This is a deliberately small,
 * explicit runner rather than a migration framework (ADR-0001): it records
 * applied migrations by tag in `_migrations` and is safe to run on every boot.
 */
export function runMigrations(raw: DatabaseSync): void {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       tag text PRIMARY KEY NOT NULL,
       applied_at integer NOT NULL
     )`,
  );

  const journal = readJson<Journal>(new URL('meta/_journal.json', migrationsDir));
  const applied = new Set(
    raw
      .prepare('SELECT tag FROM _migrations')
      .all()
      .map((row) => (row as { tag: string }).tag),
  );

  const record = raw.prepare(
    'INSERT INTO _migrations (tag, applied_at) VALUES (?, ?)',
  );

  for (const entry of journal.entries) {
    if (applied.has(entry.tag)) continue;

    const sql = readFileSync(new URL(`${entry.tag}.sql`, migrationsDir), 'utf8');
    for (const statement of splitStatements(sql)) {
      raw.exec(statement);
    }
    // `Date.now()` directly (not the Clock port): this is boot-time migration
    // bookkeeping, not observable domain behaviour, and runs before the app —
    // and its injected Clock — is constructed.
    record.run(entry.tag, Date.now());
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as T;
}
