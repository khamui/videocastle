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
   * Maximum accepted upload size in bytes. Enforced as the multipart file-size
   * limit so oversized uploads are rejected rather than silently truncated.
   * Richer cap/disk-full handling is a later ticket; this is the hard ceiling.
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
  };
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}
