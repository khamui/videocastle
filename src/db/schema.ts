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

/**
 * An uploaded Video and its transcoding lifecycle. A row exists from the moment
 * the upload stream is saved (state `processing`); the in-process worker fills
 * in the Rendition and Poster references and flips the state to `ready` once
 * transcoding succeeds. The `slug` is the unguessable Share Link (ADR-0002).
 *
 * Only the columns this milestone needs are present; password, expiry, owning
 * Folder, and view count arrive in later tickets as additive migrations. The
 * on-disk path columns are relative to the Video's media directory and are
 * never exposed over the API (storage layout stays private).
 */
export const videos = sqliteTable('videos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unguessable ~10-char base62 slug; the `/v/<slug>` Share Link. */
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  /** One of `processing` | `ready` | `failed` (see VideoState). */
  state: text('state').notNull(),
  /** Transcoding progress, 0–100. 100 once Ready. */
  progress: integer('progress').notNull().default(0),
  /** HLS playlist path relative to the media dir; set when Ready. */
  playlistPath: text('playlist_path'),
  /** Poster image path relative to the media dir; set when Ready. */
  posterPath: text('poster_path'),
  /** Source duration in seconds, probed during transcoding; set when Ready. */
  durationSeconds: integer('duration_seconds'),
  /** Epoch milliseconds, read from the injected Clock. */
  createdAt: integer('created_at').notNull(),
});

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/** The lifecycle states a Video can be in within this milestone. */
export type VideoState = 'processing' | 'ready' | 'failed';
