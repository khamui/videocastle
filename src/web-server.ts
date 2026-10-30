import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Clock } from './ports/clock';
import type { VideoRepo } from './videos/video-repo';
import type { FolderRepo } from './videos/folder-repo';
import {
  createPreviewResolver,
  injectShareMeta,
  type PreviewMeta,
} from './videos/share-preview';

export interface WebServerOptions {
  webDistDir: string | undefined;
  repo: VideoRepo;
  folderRepo: FolderRepo;
  clock: Clock;
}

/**
 * Serves the built Vite/React SPA (the Dashboard and Watch Page) as static
 * files, with an index.html fallback so client-side routes resolve. API routes
 * keep returning JSON 404s. Does nothing when `webDistDir` is unset or missing,
 * so the API can run headless (tests) or alongside the Vite dev server (dev).
 *
 * The Viewer Share-Link routes (`/v/...`, `/f/...`) are served here too, each
 * with per-link Open Graph meta injected into the shell's `<head>` (ADR-0012)
 * so a link pasted into a messenger shows the Video/Folder title rather than
 * the same generic card every time. Only a Ready, unprotected, non-expired
 * target gets a real title; everything else falls back to the generic shell,
 * keeping the opacity ADR-0002 requires.
 */
export async function registerWebServer(
  app: FastifyInstance,
  options: WebServerOptions,
): Promise<void> {
  const { webDistDir, repo, folderRepo, clock } = options;
  if (!webDistDir || !existsSync(join(webDistDir, 'index.html'))) return;

  await app.register(fastifyStatic, { root: webDistDir, prefix: '/' });

  // Read the built shell once; every Share-Link preview is a cheap string
  // transform over this template.
  const shell = readFileSync(join(webDistDir, 'index.html'), 'utf8');
  const preview = createPreviewResolver({ repo, folderRepo, clock });

  const sendShell = (reply: FastifyReply, meta: PreviewMeta | null): FastifyReply =>
    reply.type('text/html').send(injectShareMeta(shell, meta));

  app.get<{ Params: { slug: string } }>('/v/:slug', async (request, reply) =>
    sendShell(reply, await preview.video(request.params.slug)),
  );

  app.get<{ Params: { slug: string } }>('/f/:slug', async (request, reply) =>
    sendShell(reply, await preview.folder(request.params.slug)),
  );

  app.get<{ Params: { slug: string; vslug: string } }>(
    '/f/:slug/:vslug',
    async (request, reply) =>
      sendShell(
        reply,
        await preview.folderVideo(request.params.slug, request.params.vslug),
      ),
  );

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
}
