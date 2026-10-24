import { join } from 'node:path';

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
   * Enforced both up front via Content-Length and as the multipart file-size
   * limit, so an oversized upload is rejected with a clear 413 and leaves no
   * partial Source behind (see src/videos/routes.ts).
   */
  maxUploadBytes: number;
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
    maxUploadBytes: parseIntOr(env.MAX_UPLOAD_BYTES, 2 * 1024 ** 3),
    sessionSecret: env.SESSION_SECRET || undefined,
    cookieSecure: env.COOKIE_SECURE === 'true',
    webDistDir: env.WEB_DIST_DIR || undefined,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
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
