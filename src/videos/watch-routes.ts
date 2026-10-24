import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { Video } from '../db/schema';
import { verifyPassword } from '../auth/password';
import type { MediaStore } from '../media/media-store';
import type { VideoRepo } from './video-repo';

export interface WatchRouteOptions extends FastifyPluginOptions {
  repo: VideoRepo;
  store: MediaStore;
  /** Whether the unlock-grant cookie carries `Secure` (mirrors the session cookie). */
  cookieSecure: boolean;
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
  const { repo, store, cookieSecure } = options;

  const grantCookie = (slug: string): string => `vc_watch_${slug}`;
  const grantOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecure,
  } as const;

  /**
   * Whether this request carries a valid unlock grant for the slug. The grant
   * is a signed, slug-scoped cookie minted by `/unlock`, so a grant for one
   * Video never opens another.
   */
  function unlocked(request: FastifyRequest, slug: string): boolean {
    const raw = request.cookies[grantCookie(slug)];
    if (!raw) return false;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value === 'ok';
  }

  /** A protected Video is sealed until this request proves it has been unlocked. */
  function sealed(request: FastifyRequest, video: Video): boolean {
    return video.passwordHash !== null && !unlocked(request, video.slug);
  }

  // The watch view model: enough for the Watch Page to render, never the id or
  // on-disk layout. A Ready Video carries its playback URLs; a Processing one
  // carries only what the "being prepared" screen needs. A protected Video
  // reveals nothing until unlocked — just that a password is required.
  app.get<{ Params: { slug: string } }>('/api/watch/:slug', async (request, reply) => {
    const video = await repo.findBySlug(request.params.slug);
    if (!video) return notFound(reply);
    if (sealed(request, video)) return reply.send({ watch: { state: 'protected' as const } });
    // A Failed Video stays neutral for the Viewer: the link resolves, but
    // nothing diagnostic is exposed — the real reason is the Operator's
    // (ADR-0007), in the log. sendWatchView encodes that.
    return sendWatchView(reply, video);
  });

  // The HLS playlist and its segments. Served only for a Ready Video, and only
  // for an allow-listed filename within the Rendition. A protected Video's media
  // stays sealed (generic 404) until the request carries a valid unlock grant.
  app.get<{ Params: { slug: string; file: string } }>(
    '/api/watch/:slug/stream/:file',
    async (request, reply) => {
      const video = await readyVideo(repo, request.params.slug);
      if (!video || sealed(request, video)) return notFound(reply);

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
      if (!video || sealed(request, video)) return notFound(reply);
      return sendMedia(reply, store.posterPath(video.id), 'image/jpeg');
    },
  );

  // Unlock a protected Video with its password. On success, mint a signed,
  // slug-scoped grant cookie and return the now-visible watch view. Responses
  // are deliberately opaque (ADR-0002 + anti-enumeration): an unknown slug is
  // the generic 404, and a wrong password is a flat 401 — neither reveals
  // whether a Video (or a password) exists behind the link.
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/watch/:slug/unlock',
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return notFound(reply);

      // No password set: nothing to unlock — just return the view as-is.
      if (video.passwordHash === null) return sendWatchView(reply, video);

      const password =
        typeof request.body?.password === 'string' ? request.body.password : '';
      if (!(await verifyPassword(password, video.passwordHash))) {
        return reply.code(401).send({ error: 'incorrect_password' });
      }

      reply.setCookie(grantCookie(video.slug), 'ok', { ...grantOptions, signed: true });
      return sendWatchView(reply, video);
    },
  );

  /** Sends the state-appropriate watch view for an unlocked/open Video. */
  function sendWatchView(reply: FastifyReply, video: Video): FastifyReply {
    switch (video.state) {
      case 'ready':
        return reply.send({ watch: serializeReady(video) });
      case 'processing':
        return reply.send({ watch: serializeProcessing(video) });
      case 'failed':
        return reply.send({ watch: { state: 'failed' as const } });
      default:
        return notFound(reply);
    }
  }
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
