import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import type { Video } from '../db/schema';
import type { MediaStore } from '../media/media-store';
import type { VideoRepo } from './video-repo';

export interface WatchRouteOptions extends FastifyPluginOptions {
  repo: VideoRepo;
  store: MediaStore;
}

/**
 * The Viewer surface: watching a Video via its `/v/<slug>` Share Link, with no
 * account and no Operator session (ADR-0002 — possession of the unguessable link
 * is the sole permission). The SPA's Watch Page reads the view model from
 * `GET /api/watch/:slug` and plays the HLS Rendition served here.
 *
 * Unlike the operator-facing API (ADR-0007, verbose technical errors), this
 * surface is deliberately opaque. An unknown slug collapses to one generic 404
 * so the system never reveals whether a given link exists (the unified page
 * that also covers expired/deleted is finished in a later ticket). A Video that
 * resolves but cannot yet be played reports its state with no diagnostics: a
 * Processing Video is "being prepared" (spec: Viewer story 40) and a Failed one
 * is a neutral "temporarily unavailable" (GLOSSARY: Failed) — distinct from the
 * existence-hiding 404, which ADR-0002 reserves for expired/deleted/unknown.
 *
 * Only `.ts` segments and the playlist are servable, by an allow-list, so a
 * crafted filename can never reach the Source or escape the Rendition directory.
 */
export async function registerWatchRoutes(
  app: FastifyInstance,
  options: WatchRouteOptions,
): Promise<void> {
  const { repo, store } = options;

  // The watch view model: enough for the Watch Page to render, never the id or
  // on-disk layout. A Ready Video carries its playback URLs; a Processing one
  // carries only what the "being prepared" screen needs.
  app.get<{ Params: { slug: string } }>('/api/watch/:slug', async (request, reply) => {
    const video = await repo.findBySlug(request.params.slug);
    if (!video) return notFound(reply);

    switch (video.state) {
      case 'ready':
        return { watch: serializeReady(video) };
      case 'processing':
        return { watch: serializeProcessing(video) };
      case 'failed':
        // Neutral for the Viewer: the link resolves, but nothing diagnostic is
        // exposed — the real reason is the Operator's (ADR-0007), in the log.
        return { watch: { state: 'failed' as const } };
      default:
        return notFound(reply);
    }
  });

  // The HLS playlist and its segments. Served only for a Ready Video, and only
  // for an allow-listed filename within the Rendition.
  app.get<{ Params: { slug: string; file: string } }>(
    '/api/watch/:slug/stream/:file',
    async (request, reply) => {
      const video = await readyVideo(repo, request.params.slug);
      if (!video) return notFound(reply);

      const { file } = request.params;
      if (file === 'index.m3u8') {
        return sendMedia(reply, store.playlistPath(video.id), HLS_PLAYLIST_TYPE);
      }
      if (SEGMENT_NAME.test(file)) {
        return sendMedia(reply, store.segmentPath(video.id, file), HLS_SEGMENT_TYPE);
      }
      return notFound(reply);
    },
  );

  // The Poster still, shown before playback begins.
  app.get<{ Params: { slug: string } }>(
    '/api/watch/:slug/poster.jpg',
    async (request, reply) => {
      const video = await readyVideo(repo, request.params.slug);
      if (!video) return notFound(reply);
      return sendMedia(reply, store.posterPath(video.id), 'image/jpeg');
    },
  );
}

/** The one generic Viewer-facing failure (ADR-0002: no existence leak). */
function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found' });
}

const HLS_PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const HLS_SEGMENT_TYPE = 'video/mp2t';
/** Matches the transcoder's segment naming (`seg_%03d.ts`), nothing else. */
const SEGMENT_NAME = /^seg_\d+\.ts$/;

/** Resolves a slug to its Video only when it is Ready to watch, else undefined. */
async function readyVideo(
  repo: VideoRepo,
  slug: string,
): Promise<Video | undefined> {
  const video = await repo.findBySlug(slug);
  return video?.state === 'ready' ? video : undefined;
}

/**
 * Streams a media file with its content type, or the generic 404 if it is
 * missing on disk (so a half-produced Rendition never surfaces as a 500).
 */
async function sendMedia(
  reply: FastifyReply,
  path: string,
  contentType: string,
): Promise<FastifyReply> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return notFound(reply);
    size = info.size;
  } catch {
    return notFound(reply);
  }
  reply.header('content-type', contentType);
  reply.header('content-length', size);
  return reply.send(createReadStream(path));
}

interface ReadyWatchView {
  state: 'ready';
  slug: string;
  title: string;
  description: string | null;
  posterUrl: string;
  playlistUrl: string;
}

interface ProcessingWatchView {
  state: 'processing';
  slug: string;
  title: string;
  description: string | null;
}

function serializeReady(video: Video): ReadyWatchView {
  return {
    state: 'ready',
    slug: video.slug,
    title: video.title,
    description: video.description,
    posterUrl: `/api/watch/${video.slug}/poster.jpg`,
    playlistUrl: `/api/watch/${video.slug}/stream/index.m3u8`,
  };
}

function serializeProcessing(video: Video): ProcessingWatchView {
  return {
    state: 'processing',
    slug: video.slug,
    title: video.title,
    description: video.description,
  };
}
