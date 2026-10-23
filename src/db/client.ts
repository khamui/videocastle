import { DatabaseSync } from './node-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { runMigrations } from './migrate';
import * as schema from './schema';

export type Database = SqliteRemoteDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  raw: DatabaseSync;
  close(): void;
}

/**
 * Opens a SQLite database and returns a Drizzle query layer over it.
 *
 * SQLite is Node's built-in `node:sqlite` (zero native dependencies), bridged to
 * Drizzle through its `sqlite-proxy` driver: Drizzle builds the SQL, and the
 * small executor below runs it synchronously against `node:sqlite`. Keeping the
 * executor explicit (rather than a native-module driver that must compile) is a
 * deliberate ownership choice (ADR-0001).
 *
 * Pass `:memory:` for an ephemeral database (used by tests).
 */
export function openDatabase(path: string): DatabaseHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  runMigrations(raw);

  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      const statement = raw.prepare(sql);
      if (method === 'run') {
        statement.run(...params);
        return { rows: [] };
      }
      const rows = statement.all(...params).map((row) => Object.values(row));
      return { rows: method === 'get' ? (rows[0] ?? []) : rows };
    },
    { schema },
  );

  return {
    db,
    raw,
    close: () => raw.close(),
  };
}
