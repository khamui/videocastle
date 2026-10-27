import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type {
  FastifyInstance,
  FastifyPluginOptions,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { Folder, Video } from '../db/schema';
import { verifyPassword } from '../auth/password';
import type { Clock } from '../ports/clock';
import type { MediaStore } from '../media/media-store';
import { isExpired } from './routes';
import type { VideoRepo } from './video-repo';
import type { FolderRepo } from './folder-repo';

export interface WatchRouteOptions extends FastifyPluginOptions {
  repo: VideoRepo;
  folderRepo: FolderRepo;
  store: MediaStore;
  clock: Clock;
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
  const { repo, folderRepo, store, clock, cookieSecure } = options;

  /**
   * Resolves a slug to a *live* Video for the Viewer: unknown, deleted, and
   * expired links all collapse to undefined, so they share the one generic 404
   * (ADR-0002 — a Viewer can never tell which of the three a link is).
   */
  async function liveVideo(slug: string): Promise<Video | undefined> {
    const video = await repo.findBySlug(slug);
    if (!video || isExpired(video, clock.now())) return undefined;
    return video;
  }

  /**
   * Resolves a slug to a *live* Folder for the Viewer: an unknown or expired
   * Folder collapses to undefined, so both share the one generic 404 (ADR-0002 —
   * a Viewer can never tell which it is), exactly as {@link liveVideo} does.
   */
  async function liveFolder(slug: string): Promise<Folder | undefined> {
    const folder = await folderRepo.findBySlug(slug);
    if (!folder || isExpired(folder, clock.now())) return undefined;
    return folder;
  }

  /** A live Video, but only when it is Ready to play, else undefined. */
  async function readyVideo(slug: string): Promise<Video | undefined> {
    const video = await liveVideo(slug);
    return video?.state === 'ready' ? video : undefined;
  }

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

  const folderGrantCookie = (slug: string): string => `vc_folder_${slug}`;

  /**
   * Whether this request carries a valid unlock grant for the Folder. Like the
   * Video grant, it is a signed, slug-scoped cookie minted by the Folder
   * `/unlock`, so unlocking one Folder never opens another.
   */
  function folderUnlocked(request: FastifyRequest, slug: string): boolean {
    const raw = request.cookies[folderGrantCookie(slug)];
    if (!raw) return false;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid && unsigned.value === 'ok';
  }

  /** A protected Folder is sealed until this request proves it has been unlocked. */
  function folderSealed(request: FastifyRequest, folder: Folder): boolean {
    return folder.passwordHash !== null && !folderUnlocked(request, folder.slug);
  }

  /**
   * The Folder→Video cascade (spec: Viewer story 37). Once a Viewer has Folder
   * access, opening one of its Videos must play without a second prompt — even a
   * Video that carries its own password. We realise that by minting the Video's
   * own grant here: the media routes then serve it unchanged, and because this
   * only ever runs behind proven Folder access, a standalone `/v/<slug>` link
   * (which never gets here) still enforces the Video's own password (story 39).
   */
  function cascadeGrant(reply: FastifyReply, video: Video): void {
    if (video.passwordHash !== null) {
      reply.setCookie(grantCookie(video.slug), 'ok', { ...grantOptions, signed: true });
    }
  }

  // The watch view model: enough for the Watch Page to render, never the id or
  // on-disk layout. A Ready Video carries its playback URLs; a Processing one
  // carries only what the "being prepared" screen needs. A protected Video
  // reveals nothing until unlocked — just that a password is required.
  app.get<{ Params: { slug: string } }>('/api/watch/:slug', async (request, reply) => {
    const video = await liveVideo(request.params.slug);
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
      const video = await readyVideo(request.params.slug);
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
      const video = await readyVideo(request.params.slug);
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
      const video = await liveVideo(request.params.slug);
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

  /** The open gallery view: the Folder's name and its playable Videos as tiles. */
  async function openGalleryView(folder: Folder) {
    const now = clock.now();
    const tiles = (await repo.listByFolder(folder.id))
      .filter((video) => video.state === 'ready' && !isExpired(video, now))
      .map(serializeTile);
    return { protected: false as const, slug: folder.slug, name: folder.name, videos: tiles };
  }

  // A Folder shared as a tiled gallery (spec: Viewer story 36). A `/f/<slug>`
  // link resolves to the Folder's name and its playable Videos as tiles, each a
  // jumping-off point to `/f/<slug>/<vslug>`. Only Ready, non-expired Videos are
  // tiled — a Processing/Failed/expired Video has nothing a Viewer can watch, so
  // it stays out of the gallery rather than offering a dead tile. A protected,
  // not-yet-unlocked Folder reveals nothing but that it needs a password; an
  // unknown or expired Folder is the one generic 404 (ADR-0002, no existence leak).
  app.get<{ Params: { slug: string } }>('/api/watch/folder/:slug', async (request, reply) => {
    const folder = await liveFolder(request.params.slug);
    if (!folder) return notFound(reply);
    if (folderSealed(request, folder)) return reply.send({ folder: { protected: true as const } });
    return reply.send({ folder: await openGalleryView(folder) });
  });

  // Unlock a protected Folder with its password. On success, mint a signed,
  // Folder-scoped grant and return the now-open gallery; the grant then cascades
  // to every Video opened from within the Folder. Responses stay opaque
  // (ADR-0002 + anti-enumeration): an unknown/expired Folder is the generic 404
  // and a wrong password a flat 401 — neither reveals what's behind the link.
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/watch/folder/:slug/unlock',
    async (request, reply) => {
      const folder = await liveFolder(request.params.slug);
      if (!folder) return notFound(reply);

      // No password set: nothing to unlock — just return the open gallery.
      if (folder.passwordHash === null) {
        return reply.send({ folder: await openGalleryView(folder) });
      }

      const password =
        typeof request.body?.password === 'string' ? request.body.password : '';
      if (!(await verifyPassword(password, folder.passwordHash))) {
        return reply.code(401).send({ error: 'incorrect_password' });
      }

      reply.setCookie(folderGrantCookie(folder.slug), 'ok', { ...grantOptions, signed: true });
      return reply.send({ folder: await openGalleryView(folder) });
    },
  );

  // A single Video opened from within its Folder: `/f/<slug>/<vslug>`. Access is
  // gated by the *Folder*, not the Video: a locked Folder reports `protected`
  // (the Viewer unlocks the Folder, never the Video, from here), and once Folder
  // access is proven it cascades — the Video plays without a second prompt even
  // if it carries its own password (spec: Viewer story 37). The Video must
  // actually live in this Folder, else the one generic 404, so a Folder link
  // can't be used to probe Videos that aren't in it. Playback, poster, and the
  // (cascaded) grant all run through the Video's own `/api/watch/:vslug/*` routes.
  app.get<{ Params: { slug: string; vslug: string } }>(
    '/api/watch/folder/:slug/:vslug',
    async (request, reply) => {
      const folder = await liveFolder(request.params.slug);
      if (!folder) return notFound(reply);
      if (folderSealed(request, folder)) {
        return reply.send({ watch: { state: 'protected' as const } });
      }

      const video = await liveVideo(request.params.vslug);
      if (!video || video.folderId !== folder.id) return notFound(reply);

      cascadeGrant(reply, video);
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
  /** Operator hint: crop-to-fill on a portrait screen (GLOSSARY: Portrait-optimized). */
  portraitOptimized: boolean;
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
    portraitOptimized: video.portraitOptimized,
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

/** One Video as a gallery tile — enough to render it, never the id or layout. */
interface GalleryTile {
  slug: string;
  title: string;
  durationSeconds: number | null;
  /** Whether a password gates the Video (the tile links on; the gate is on open). */
  protected: boolean;
  /**
   * The poster still, or null when the Video is protected — a sealed Video keeps
   * its Poster sealed (mirroring the media routes), so a shared Folder never
   * leaks a protected Video's frame before it's unlocked.
   */
  posterUrl: string | null;
}

function serializeTile(video: Video): GalleryTile {
  const isProtected = video.passwordHash !== null;
  return {
    slug: video.slug,
    title: video.title,
    durationSeconds: video.durationSeconds,
    protected: isProtected,
    posterUrl: isProtected ? null : `/api/watch/${video.slug}/poster.jpg`,
  };
}
