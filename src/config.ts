import { join } from 'node:path';
import { parseBytes, parseBytesOr } from './system/bytes';

/**
 * Runtime configuration, resolved from the environment at process start.
 * Defaults are chosen so `docker compose up` works with no env file, while a
 * self-hosting Operator can override anything.
 */
export interface Config {
  host: string;
  port: number;
  /** Root directory for all persisted state (SQLite + media). Mounted as a volume in prod. */
  dataDir: string;
  /** SQLite database file path. */
  dbPath: string;
  /** Root directory for persisted media (Sources, Renditions, Posters). */
  mediaDir: string;
  /**
   * Maximum accepted upload size in bytes (env `MAX_UPLOAD_BYTES`, default 2 GiB).
   * Accepts a size suffix (`2GiB`, `500MB`) as well as a bare byte count.
   * Enforced both up front via Content-Length and as the multipart file-size
   * limit, so an oversized upload is rejected with a clear 413 and leaves no
   * partial Source behind (see src/videos/routes.ts).
   */
  maxUploadBytes: number;
  /**
   * Ceiling on the total bytes this instance's media may occupy (env
   * `STORAGE_QUOTA_BYTES`, accepts size suffixes). Undefined means unlimited,
   * which is the default: a fresh install must work with no env file, and an
   * Operator who has not thought about a quota has not asked for one.
   *
   * Reaching it refuses uploads and transcode retries. It never deletes
   * anything, and playback is never gated (ADR-0011).
   */
  storageQuotaBytes: number | undefined;
  /**
   * Free space that must remain on the media filesystem (env
   * `MIN_FREE_DISK_BYTES`, default 1 GiB). On by default, unlike the Quota,
   * because a filesystem with no room left can wedge or corrupt SQLite — that
   * is a correctness risk rather than a capacity preference, so it needs a safe
   * default rather than an opt-in.
   */
  minFreeDiskBytes: number;
  /**
   * Where the Dashboard's warning band starts, as a percentage of the Quota
   * (env `QUOTA_WARN_PERCENT`, default 80). Configurable because 80% is a guess
   * about someone else's disk: on a 20 GB quota it fires with 4 GB left, on a
   * 2 TB quota with 400 GB left — too late or absurdly early depending on how
   * big the Operator's uploads are.
   */
  quotaWarnPercent: number;
  /**
   * Session-signing secret override. When set (via env), it takes precedence
   * over the secret auto-generated and persisted in the database on first run.
   */
  sessionSecret: string | undefined;
  /**
   * Whether the session cookie carries the `Secure` attribute. Off by default
   * so local HTTP dev works; Operators terminating TLS at a reverse proxy should
   * set COOKIE_SECURE=true.
   */
  cookieSecure: boolean;
  /**
   * Directory of the built SPA to serve as static files. When unset (e.g. in
   * tests, or in dev where Vite serves the SPA) the server exposes only the API.
   */
  webDistDir: string | undefined;
  /** `ffmpeg` binary to shell out to for transcoding. */
  ffmpegPath: string;
  /** `ffprobe` binary to shell out to for probing Sources. */
  ffprobePath: string;
  /**
   * How many Videos the in-process worker transcodes in parallel (env
   * `TRANSCODE_CONCURRENCY`, default 2). Host Configuration: an instance often
   * shares a VPS with other services, and transcoding is the part of
   * videocastle that visibly hurts its neighbours, so the server's owner can
   * turn it down to 1.
   */
  transcodeConcurrency: number;
  /**
   * `-threads` handed to each `ffmpeg` invocation (env `FFMPEG_THREADS`).
   * Undefined leaves ffmpeg its own choice, which is every core — so
   * concurrency alone does not bound CPU: a single transcode can saturate the
   * machine.
   */
  ffmpegThreads: number | undefined;
  /**
   * Whether a Video's Source is kept after it transcodes (env
   * `KEEP_SOURCE_AFTER_TRANSCODE`, default true — unchanged behaviour).
   * Turning it off roughly halves what a Video costs on disk, at the price of
   * never being able to re-transcode it.
   *
   * Only the exact string `false` turns it off. Any other value keeps the
   * Source, so a typo errs towards holding on to the Operator's originals
   * rather than destroying them (ADR-0010).
   *
   * **Forward-only**: this governs Videos transcoded from now on and never
   * touches a Source already on disk. Those go only when the Operator runs
   * `reclaim-sources` and asks for it.
   */
  keepSourceAfterTranscode: boolean;
  /** Length of the per-IP rate-limit window, in milliseconds. */
  rateLimitWindowMs: number;
  /** Max public viewer requests per IP per window (general flood guard). */
  rateLimitMax: number;
  /** Max password attempts (Video + Folder unlock) per IP per window (brute-force guard). */
  rateLimitPasswordMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR ?? join(process.cwd(), 'data');
  return {
    host: env.HOST ?? '0.0.0.0',
    port: parseIntOr(env.PORT, 8080),
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, 'videocastle.db'),
    mediaDir: env.MEDIA_DIR ?? join(dataDir, 'media'),
    maxUploadBytes: parseBytesOr(env.MAX_UPLOAD_BYTES, 2 * 1024 ** 3),
    storageQuotaBytes: parseBytes(env.STORAGE_QUOTA_BYTES),
    minFreeDiskBytes: parseBytesOr(env.MIN_FREE_DISK_BYTES, 1024 ** 3),
    quotaWarnPercent: parsePercentOr(env.QUOTA_WARN_PERCENT, 80),
    sessionSecret: env.SESSION_SECRET || undefined,
    cookieSecure: env.COOKIE_SECURE === 'true',
    webDistDir: env.WEB_DIST_DIR || undefined,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    transcodeConcurrency: parsePositiveIntOr(env.TRANSCODE_CONCURRENCY, 2),
    ffmpegThreads: parsePositiveIntOrUndefined(env.FFMPEG_THREADS),
    keepSourceAfterTranscode: env.KEEP_SOURCE_AFTER_TRANSCODE !== 'false',
    // Generous general ceiling: HLS playback makes many segment requests, so the
    // default (600/min/IP) stops floods without breaking normal viewing, while
    // password attempts get a much tighter bucket to slow brute-forcing.
    rateLimitWindowMs: parseIntOr(env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: parseIntOr(env.RATE_LIMIT_MAX, 600),
    rateLimitPasswordMax: parseIntOr(env.RATE_LIMIT_PASSWORD_MAX, 10),
  };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Like {@link parseIntOr} but refuses anything below 1. A concurrency of 0 or
 * less would wedge the transcode worker — nothing would ever be pumped — so a
 * nonsensical value falls back to the default rather than silently disabling
 * transcoding for an Operator who typed it wrong.
 */
function parsePositiveIntOr(value: string | undefined, fallback: number): number {
  const n = parseIntOr(value, fallback);
  return n >= 1 ? n : fallback;
}

/**
 * A percentage in 1–99. A warning at 0 would fire on an empty instance and one
 * at 100 would fire only once writes are already being refused, so neither is a
 * warning threshold — both fall back to the default.
 */
function parsePercentOr(value: string | undefined, fallback: number): number {
  const n = parseIntOr(value, fallback);
  return n >= 1 && n <= 99 ? n : fallback;
}

/** Unset, or anything not a positive integer, means "don't pass the flag". */
function parsePositiveIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) || n < 1 ? undefined : n;
}
