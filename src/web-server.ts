import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/**
 * Serves the built Vite/React SPA (the Dashboard and Watch Page) as static
 * files, with an index.html fallback so client-side routes resolve. API routes
 * keep returning JSON 404s. Does nothing when `webDistDir` is unset or missing,
 * so the API can run headless (tests) or alongside the Vite dev server (dev).
 */
export async function registerWebServer(
  app: FastifyInstance,
  webDistDir: string | undefined,
): Promise<void> {
  if (!webDistDir || !existsSync(join(webDistDir, 'index.html'))) return;

  await app.register(fastifyStatic, { root: webDistDir, prefix: '/' });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
}
