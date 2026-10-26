import type { Config } from '../config';
import { formatBytes, parseBytes } from './bytes';

/**
 * The Host Configuration as the Dashboard shows it: every setting, its value,
 * and **where that value came from**.
 *
 * The provenance is the point. "Why is concurrency 2?" should be answerable
 * from the Dashboard rather than by reading the source or guessing at the
 * container's environment — and an Operator who mistyped a value should be told
 * so (ADR-0007) instead of silently getting the default they didn't ask for.
 *
 * Read-only by construction: these are Host Configuration, fixed at process
 * start and never editable from the Dashboard (GLOSSARY: Host Configuration).
 */

export type ValueSource =
  /** Not set in the environment; this is the built-in default. */
  | 'default'
  /** Set in the environment and used. */
  | 'environment'
  /** Set in the environment but unreadable, so the default is in force. */
  | 'invalid';

export interface HostSetting {
  /** The environment variable's name. */
  key: string;
  /** The value actually in force, rendered for display. */
  value: string;
  source: ValueSource;
  /** What the setting does, in one line. */
  description: string;
  /** The raw environment value, when it was rejected as unreadable. */
  rejected?: string;
  /**
   * A readable rendering of a byte count, shown beside the exact figure. Both,
   * never one: `41943040` is what an Operator pastes back into their
   * environment, and `40.0 MiB` is what tells them whether it is the number
   * they meant (ADR-0007).
   */
  humanValue?: string;
}

export interface HostConfigSection {
  title: string;
  settings: HostSetting[];
}

/** Whether a byte-valued variable was set and readable. */
function byteSource(raw: string | undefined): ValueSource {
  if (raw === undefined) return 'default';
  return parseBytes(raw) === undefined ? 'invalid' : 'environment';
}

/** Whether an integer-valued variable was set and within `min`–`max`. */
function intSource(
  raw: string | undefined,
  bounds: { min: number; max: number } = { min: 1, max: Number.MAX_SAFE_INTEGER },
): ValueSource {
  if (raw === undefined) return 'default';
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < bounds.min || n > bounds.max
    ? 'invalid'
    : 'environment';
}

/** Whether a plain string variable was set to anything non-empty. */
function textSource(raw: string | undefined): ValueSource {
  return raw === undefined || raw.length === 0 ? 'default' : 'environment';
}

function setting(
  key: string,
  description: string,
  value: string,
  source: ValueSource,
  raw: string | undefined,
): HostSetting {
  return {
    key,
    description,
    value,
    source,
    ...(source === 'invalid' && raw !== undefined ? { rejected: raw } : {}),
  };
}

/** A byte-valued setting: the exact figure, plus a readable one beside it. */
function byteSetting(
  key: string,
  description: string,
  bytes: number | undefined,
  unsetLabel: string,
  raw: string | undefined,
): HostSetting {
  const base = setting(
    key,
    description,
    bytes === undefined ? unsetLabel : String(bytes),
    byteSource(raw),
    raw,
  );
  return bytes === undefined ? base : { ...base, humanValue: formatBytes(bytes) };
}

export function hostConfigReport(
  config: Config,
  env: NodeJS.ProcessEnv,
): HostConfigSection[] {
  return [
    {
      title: 'Network',
      settings: [
        setting('HOST', 'Address the server listens on.', config.host, textSource(env.HOST), env.HOST),
        setting('PORT', 'Port the server listens on.', String(config.port), intSource(env.PORT, { min: 1, max: 65535 }), env.PORT),
        setting(
          'COOKIE_SECURE',
          'Marks the session cookie Secure. Set it when a reverse proxy terminates TLS.',
          String(config.cookieSecure),
          env.COOKIE_SECURE === undefined ? 'default' : 'environment',
          env.COOKIE_SECURE,
        ),
      ],
    },
    {
      title: 'Storage',
      settings: [
        setting('DATA_DIR', 'Root for the database and media.', config.dataDir, textSource(env.DATA_DIR), env.DATA_DIR),
        setting('MEDIA_DIR', 'Where Sources, Renditions and Posters are written.', config.mediaDir, textSource(env.MEDIA_DIR), env.MEDIA_DIR),
        setting('DB_PATH', 'The SQLite file.', config.dbPath, textSource(env.DB_PATH), env.DB_PATH),
        byteSetting(
          'STORAGE_QUOTA_BYTES',
          'Ceiling on total media bytes. Refuses writes; never deletes.',
          config.storageQuotaBytes,
          'unlimited',
          env.STORAGE_QUOTA_BYTES,
        ),
        byteSetting(
          'MIN_FREE_DISK_BYTES',
          'Free space that must remain on the media filesystem.',
          config.minFreeDiskBytes,
          'unlimited',
          env.MIN_FREE_DISK_BYTES,
        ),
        setting(
          'QUOTA_WARN_PERCENT',
          'Where the storage warning band starts, as a percentage of the Quota.',
          String(config.quotaWarnPercent),
          intSource(env.QUOTA_WARN_PERCENT, { min: 1, max: 99 }),
          env.QUOTA_WARN_PERCENT,
        ),
        byteSetting(
          'MAX_UPLOAD_BYTES',
          'Largest accepted upload.',
          config.maxUploadBytes,
          'unlimited',
          env.MAX_UPLOAD_BYTES,
        ),
      ],
    },
    {
      title: 'Transcoding',
      settings: [
        setting('FFMPEG_PATH', 'ffmpeg binary used for transcoding.', config.ffmpegPath, textSource(env.FFMPEG_PATH), env.FFMPEG_PATH),
        setting('FFPROBE_PATH', 'ffprobe binary used for probing Sources.', config.ffprobePath, textSource(env.FFPROBE_PATH), env.FFPROBE_PATH),
        setting(
          'TRANSCODE_CONCURRENCY',
          'Videos transcoded in parallel.',
          String(config.transcodeConcurrency),
          intSource(env.TRANSCODE_CONCURRENCY),
          env.TRANSCODE_CONCURRENCY,
        ),
        setting(
          'KEEP_SOURCE_AFTER_TRANSCODE',
          'Keeps each Video’s original after transcoding. Turning it off halves what new Videos cost, and they can never be re-transcoded.',
          String(config.keepSourceAfterTranscode),
          env.KEEP_SOURCE_AFTER_TRANSCODE === undefined ? 'default' : 'environment',
          env.KEEP_SOURCE_AFTER_TRANSCODE,
        ),
        setting(
          'FFMPEG_THREADS',
          'Threads each ffmpeg invocation may use.',
          config.ffmpegThreads === undefined
            ? "ffmpeg's own choice"
            : String(config.ffmpegThreads),
          intSource(env.FFMPEG_THREADS),
          env.FFMPEG_THREADS,
        ),
      ],
    },
    {
      title: 'Rate limiting',
      settings: [
        setting('RATE_LIMIT_WINDOW_MS', 'Length of the per-IP rate-limit window.', String(config.rateLimitWindowMs), intSource(env.RATE_LIMIT_WINDOW_MS), env.RATE_LIMIT_WINDOW_MS),
        setting('RATE_LIMIT_MAX', 'Viewer requests allowed per IP per window.', String(config.rateLimitMax), intSource(env.RATE_LIMIT_MAX), env.RATE_LIMIT_MAX),
        setting('RATE_LIMIT_PASSWORD_MAX', 'Password attempts allowed per IP per window.', String(config.rateLimitPasswordMax), intSource(env.RATE_LIMIT_PASSWORD_MAX), env.RATE_LIMIT_PASSWORD_MAX),
      ],
    },
    {
      title: 'Secrets',
      settings: [
        {
          key: 'SESSION_SECRET',
          description:
            'Signs the Operator session cookie. Generated and persisted on first run when unset.',
          // Never the value itself, not even to the single Operator: this is a
          // page that gets screen-shared and pasted into bug reports.
          value: config.sessionSecret === undefined ? 'auto-generated' : 'set (hidden)',
          source: config.sessionSecret === undefined ? 'default' : 'environment',
        },
      ],
    },
  ];
}
