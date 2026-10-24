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
import { VideoRepo } from './videos/video-repo';
import { createTranscodeWorker, type VideoWorker } from './videos/transcode-worker';
import { registerVideoRoutes } from './videos/routes';
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
  const app = Fastify({ logger: deps.logger ?? false });

  const operatorRepo = new OperatorRepo(deps.db);
  const sessionSecret = await operatorRepo.resolveSessionSecret(
    deps.config.sessionSecret,
  );

  await app.register(fastifyCookie, { secret: sessionSecret });
  await app.register(fastifyMultipart, {
    limits: { fileSize: deps.config.maxUploadBytes, files: 1 },
  });

  const session = createSessionManager({
    repo: operatorRepo,
    cookieSecure: deps.config.cookieSecure,
  });

  const videoRepo = new VideoRepo(deps.db);
  const mediaStore = new MediaStore(deps.config.mediaDir);
  const worker = createTranscodeWorker({
    repo: videoRepo,
    store: mediaStore,
    transcoder: deps.transcoder,
    onError: (videoId, err) =>
      app.log.error({ err, videoId }, 'transcode failed'),
  });
  app.decorate('videoWorker', worker);

  await app.register(registerAuthRoutes, {
    repo: operatorRepo,
    clock: deps.clock,
    session,
  });

  await app.register(registerVideoRoutes, {
    session,
    repo: videoRepo,
    worker,
    store: mediaStore,
    slugGenerator: deps.slugGenerator,
    clock: deps.clock,
  });

  await registerWebServer(app, deps.config.webDistDir);

  return app;
}
