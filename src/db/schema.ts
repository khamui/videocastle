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
 * An Operator-created Folder: a shareable, one-level-deep group of Videos (a
 * Folder never contains another Folder — see GLOSSARY). The `slug` is the
 * unguessable `/f/<slug>` Folder Share Link (ADR-0002); a Video points at its
 * Folder via `videos.folderId`, and a Video in no Folder sits in the Library
 * root (folderId null).
 */
export const folders = sqliteTable('folders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Unguessable base62 slug; the `/f/<slug>` Folder Share Link. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /**
   * Optional Folder password, stored hashed (scrypt, same format as the Video
   * and Operator credentials — see src/auth/password.ts). Null means the `/f/`
   * gallery link is open; when set, a Viewer unlocks the Folder once and then
   * plays any Video in it without re-prompting (the Folder→Video cascade).
   */
  passwordHash: text('password_hash'),
  /**
   * Optional Folder Share Link expiry, epoch milliseconds. Null means the
   * gallery link never expires; when set, it is evaluated against the injected
   * Clock and, once the instant has passed, the Folder is Expired and its `/f/`
   * link returns the generic Viewer 404 (ADR-0002). Mirrors a Video's expiry.
   */
  expiresAt: integer('expires_at'),
  /**
   * The Folder's Portrait-optimized default (GLOSSARY): applied to Videos
   * uploaded into it, and the state the Folder drawer's toggle reflects —
   * toggling it also applies to every Video currently in the Folder. Defaults
   * off. The truth for playback is always the Video's own flag.
   */
  portraitOptimized: integer('portrait_optimized', { mode: 'boolean' })
    .notNull()
    .default(false),
  /**
   * The Folder's Autoplay default (GLOSSARY): applied to Videos uploaded into
   * it, and the state the Folder drawer's toggle reflects — toggling it also
   * applies to every Video currently in the Folder. Defaults off. The truth for
   * playback is always the Video's own flag.
   */
  autoplay: integer('autoplay', { mode: 'boolean' }).notNull().default(false),
  /** Epoch milliseconds, read from the injected Clock. */
  createdAt: integer('created_at').notNull(),
});

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

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
  /**
   * Optional per-Video password, stored hashed (scrypt, same format as the
   * Operator credential — see src/auth/password.ts). Null means the Share Link
   * is open; when set, a Viewer must supply the password before playback.
   */
  passwordHash: text('password_hash'),
  /**
   * Optional Share Link expiry, epoch milliseconds. Null means the link never
   * expires; when set, the link is evaluated against the injected Clock and,
   * once the instant has passed, the Video is Expired and its link returns the
   * generic Viewer 404 (ADR-0002). Set it forward again to re-enable the link.
   */
  expiresAt: integer('expires_at'),
  /**
   * The owning Folder, or null when the Video sits in the Library root. A Video
   * belongs to at most one Folder (a single column — never two at once).
   */
  folderId: integer('folder_id').references(() => folders.id),
  /**
   * Operator display hint (not content): when set, a Viewer on a portrait
   * screen sees the frame cropped to fill vertically (GLOSSARY: Portrait-
   * optimized), for a Video whose meaningful content is the vertical centre.
   * A no-op on landscape/desktop. Defaults off.
   */
  portraitOptimized: integer('portrait_optimized', { mode: 'boolean' })
    .notNull()
    .default(false),
  /**
   * Operator playback hint (not content): when set, the Watch Page starts the
   * Video automatically, muted, as soon as the page loads (GLOSSARY: Autoplay).
   * Muted because that is the only autoplay browsers reliably allow without a
   * user gesture — the Viewer unmutes from the native controls. Defaults off,
   * which preserves the click-to-play default (`preload="none"`, no autoplay).
   */
  autoplay: integer('autoplay', { mode: 'boolean' }).notNull().default(false),
  /**
   * Bytes the Source occupies on disk, recorded when the upload stream closes.
   * Zero when there is no Source — it was never written, or it was discarded
   * (ADR-0010). A Failed Video still has one, and it still counts.
   */
  sourceBytes: integer('source_bytes').notNull().default(0),
  /**
   * When the Operator deliberately discarded this Video's Source (epoch ms),
   * or null while it is still held (ADR-0010).
   *
   * Recorded rather than inferred from `sourceBytes` being zero, because the
   * two cases need different things said to the Operator: a discarded Source
   * is expected and the Video is fine, while one that vanished on its own is a
   * problem worth investigating. Both make Retry impossible; only one is news.
   */
  sourceDiscardedAt: integer('source_discarded_at'),
  /**
   * Bytes the HLS Rendition (playlist + segments) occupies; recorded when the
   * transcode succeeds, and zeroed when a retry clears the old Rendition.
   */
  renditionBytes: integer('rendition_bytes').notNull().default(0),
  /** Bytes the Poster occupies; recorded alongside the Rendition. */
  posterBytes: integer('poster_bytes').notNull().default(0),
  /** Short stable failure code (see TranscodeFailureReason); set when Failed. */
  failureReason: text('failure_reason'),
  /** Diagnostic detail for a failure (e.g. trimmed ffmpeg stderr); set when Failed. */
  failureDetail: text('failure_detail'),
  /** Epoch milliseconds, read from the injected Clock. */
  createdAt: integer('created_at').notNull(),
});

export type Video = typeof videos.$inferSelect;
export type NewVideo = typeof videos.$inferInsert;

/** The lifecycle states a Video can be in within this milestone. */
export type VideoState = 'processing' | 'ready' | 'failed';
