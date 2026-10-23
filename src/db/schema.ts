import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * The single Operator credential for this instance (spec: single-Operator v1).
 * Created on first run; sign-in verifies against `passwordHash`. At most one row
 * is ever present — enforced in application code, not the schema.
 */
export const operators = sqliteTable('operators', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  /** Hashed password (never the plaintext). Format is owned by src/auth/password.ts. */
  passwordHash: text('password_hash').notNull(),
  /** Epoch milliseconds, read from the injected Clock. */
  createdAt: integer('created_at').notNull(),
});

/**
 * Small key/value table for instance-level settings that must persist across
 * restarts. Used in the walking skeleton for the auto-generated session-signing
 * secret (key `session_secret`).
 */
export const appConfig = sqliteTable('app_config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
