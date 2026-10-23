import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { Config } from './config';
import type { Database } from './db/client';
import type { Clock } from './ports/clock';
import type { SlugGenerator } from './ports/slug';
import type { Transcoder } from './ports/transcoder';
import { OperatorRepo } from './auth/operator-repo';
import { registerAuthRoutes } from './auth/routes';
import { registerWebServer } from './web-server';

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
}

/**
 * Builds the Fastify application — the single in-process test seam. Callers
 * (production entrypoint and tests alike) construct it with the same deps and
 * drive it either over the network or via `app.inject`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  const repo = new OperatorRepo(deps.db);
  const sessionSecret = await repo.resolveSessionSecret(deps.config.sessionSecret);

  await app.register(fastifyCookie, { secret: sessionSecret });

  await app.register(registerAuthRoutes, {
    repo,
    clock: deps.clock,
    cookieSecure: deps.config.cookieSecure,
  });

  await registerWebServer(app, deps.config.webDistDir);

  return app;
}
