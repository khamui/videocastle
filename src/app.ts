import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import type { Config } from './config';
import type { Database } from './db/client';
import type { Clock } from './ports/clock';
import type { SlugGenerator } from './ports/slug';
import type { Transcoder } from './ports/transcoder';
import { OperatorRepo } from './auth/operator-repo';
import { createSessionManager } from './auth/session';
import { registerAuthRoutes } from './auth/routes';
import { MediaStore } from './media/media-store';
import { createStorageGuard } from './media/storage-guard';
import { VideoRepo } from './videos/video-repo';
import { FolderRepo } from './videos/folder-repo';
import { createTranscodeWorker, type VideoWorker } from './videos/transcode-worker';
import { registerVideoRoutes } from './videos/routes';
import { registerWatchRoutes } from './videos/watch-routes';
import { createTranscodingStatus } from './system/transcoding-status';
import { registerRateLimiting } from './system/rate-limit';
import { registerWebServer } from './web-server';

declare module 'fastify' {
  interface FastifyInstance {
    /** The in-process transcoding worker; exposed for deterministic tests. */
    videoWorker: VideoWorker;
  }
}

/**
 * Everything the application needs to run, injected at construction. The three
 * nondeterministic collaborators (clock, slugGenerator, transcoder) are ports so
 * tests can substitute fakes and drive behaviour deterministically through the
 * HTTP seam (spec: Testing Decisions).
 */
export interface AppDeps {
  db: Database;
  clock: Clock;
  slugGenerator: SlugGenerator;
  transcoder: Transcoder;
  config: Config;
  /**
   * Enable the Fastify logger. Off by default (quiet tests); the production
   * entrypoint turns it on so that, e.g., a transcode failure is visible rather
   * than silently leaving a Video in the Failed state.
   */
  logger?: boolean;
}

/**
 * Builds the Fastify application — the single in-process test seam. Callers
 * (production entrypoint and tests alike) construct it with the same deps and
 * drive it either over the network or via `app.inject`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // `trustProxy` so `request.ip` is the real client IP from `X-Forwarded-For`
  // (set by the Operator's own TLS-terminating reverse proxy, the documented
  // deploy shape — ADR-0004), which per-IP rate limiting keys on. Without it
  // every request would look like it came from the proxy.
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  const operatorRepo = new OperatorRepo(deps.db);
  const sessionSecret = await operatorRepo.resolveSessionSecret(
    deps.config.sessionSecret,
  );

  await app.register(fastifyCookie, { secret: sessionSecret });
  await app.register(fastifyMultipart, {
    // The hard ceiling on a Source upload. `throwFileSizeLimit: false` makes an
    // over-cap file truncate (flagging `file.truncated`) rather than throw mid
    // -stream, so the upload route detects it, rolls back the partial, and
    // returns one clear 413 (see src/videos/routes.ts) instead of a generic 500.
    limits: { fileSize: deps.config.maxUploadBytes, files: 1 },
    throwFileSizeLimit: false,
  });

  // Per-IP rate limiting on the public Viewer surface (general flood guard +
  // stricter password-attempt guard). Registered before the routes so its
  // onRequest hook gates them.
  registerRateLimiting(app, {
    clock: deps.clock,
    windowMs: deps.config.rateLimitWindowMs,
    generalMax: deps.config.rateLimitMax,
    passwordMax: deps.config.rateLimitPasswordMax,
  });

  const session = createSessionManager({
    repo: operatorRepo,
    cookieSecure: deps.config.cookieSecure,
  });

  const videoRepo = new VideoRepo(deps.db);
  const folderRepo = new FolderRepo(deps.db);
  const mediaStore = new MediaStore(deps.config.mediaDir);
  const worker = createTranscodeWorker(
    {
      repo: videoRepo,
      store: mediaStore,
      transcoder: deps.transcoder,
      onError: (videoId, err) =>
        app.log.error({ err, videoId }, 'transcode failed'),
    },
    deps.config.transcodeConcurrency,
  );
  app.decorate('videoWorker', worker);

  // The ceilings the server's owner set. Reaching one refuses writes; it never
  // deletes, and never gates playback (ADR-0011).
  const storageGuard = createStorageGuard({
    repo: videoRepo,
    mediaDir: deps.config.mediaDir,
    limits: {
      quotaBytes: deps.config.storageQuotaBytes,
      minFreeDiskBytes: deps.config.minFreeDiskBytes,
    },
  });
  app.log.info(
    {
      quota: deps.config.storageQuotaBytes ?? 'unlimited',
      minFreeDisk: deps.config.minFreeDiskBytes,
    },
    'storage ceilings',
  );

  // Probe transcoding availability once at boot so uploads can be gated and the
  // Dashboard warned; log the result loudly since a missing ffmpeg is the most
  // common operational failure.
  const transcoding = createTranscodingStatus(deps.transcoder);
  const availability = await transcoding.refresh();
  if (availability.available) {
    // Log the effective limits too: "why is this instance transcoding slowly?"
    // should be answerable from the boot log rather than from the environment.
    app.log.info(
      {
        ffmpeg: availability.version,
        concurrency: deps.config.transcodeConcurrency,
        threads: deps.config.ffmpegThreads ?? 'ffmpeg default',
      },
      'transcoding available',
    );
  } else {
    app.log.warn(
      { error: availability.error },
      'transcoding unavailable — uploads will be refused until ffmpeg is runnable',
    );
  }

  await app.register(registerAuthRoutes, {
    repo: operatorRepo,
    clock: deps.clock,
    session,
  });

  await app.register(registerVideoRoutes, {
    session,
    repo: videoRepo,
    folderRepo,
    worker,
    store: mediaStore,
    slugGenerator: deps.slugGenerator,
    clock: deps.clock,
    transcoding,
    maxUploadBytes: deps.config.maxUploadBytes,
    storage: storageGuard,
  });

  // The public Viewer surface (no session): watch a Video via its Share Link,
  // or browse a Folder shared as a tiled gallery.
  await registerWatchRoutes(app, {
    repo: videoRepo,
    folderRepo,
    store: mediaStore,
    clock: deps.clock,
    cookieSecure: deps.config.cookieSecure,
  });

  await registerWebServer(app, deps.config.webDistDir);

  return app;
}
