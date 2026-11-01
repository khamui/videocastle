import { mkdirSync } from 'node:fs';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { Server as TusServer, type Upload } from '@tus/server';
import { FileStore } from '@tus/file-store';
import type { Clock } from '../ports/clock';
import type { SlugGenerator } from '../ports/slug';
import type { MediaStore } from '../media/media-store';
import {
  refusalFor,
  type StorageGuard,
} from '../media/storage-guard';
import type { SessionManager } from '../auth/session';
import type { TranscodingStatus } from '../system/transcoding-status';
import type { VideoRepo } from './video-repo';
import type { FolderRepo } from './folder-repo';
import { serializeVideo, UNNAMED_VIDEO } from './routes';

/** How long an abandoned partial Upload is kept before the reaper removes it (ADR-0013). */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the reaper sweeps the uploads directory for expired partials. */
const REAPER_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A refusal thrown from a tus lifecycle hook. `@tus/server` reads `status_code`
 * and `body` off a thrown error and sends exactly those to the client, so this
 * is how an Upload is rejected with a technical, copy-pasteable reason
 * (ADR-0007) — the same `{ error, detail }` shape the rest of the API uses.
 */
function uploadRefusal(status: number, error: string, detail: string): Error {
  return Object.assign(new Error(detail), {
    status_code: status,
    body: JSON.stringify({ error, detail }),
  });
}

export interface UploadRouteOptions extends FastifyPluginOptions {
  session: SessionManager;
  repo: VideoRepo;
  folderRepo: FolderRepo;
  worker: { enqueue(videoId: number): void };
  store: MediaStore;
  slugGenerator: SlugGenerator;
  clock: Clock;
  transcoding: TranscodingStatus;
  storage: StorageGuard;
  /** Hard ceiling on a single Source upload, in bytes (shared with the legacy route). */
  maxUploadBytes: number;
  /** Most incomplete Uploads allowed at once — the server half of the batch cap (ADR-0013). */
  maxUploadBatch: number;
  /** Where in-progress partials live (config.uploadsDir). */
  uploadsDir: string;
}

/**
 * Resumable, multi-file uploads over the tus protocol (ADR-0013). Each file is
 * its own tus Upload under `/api/uploads`; a phone that locks mid-transfer
 * resumes from its last byte offset on wake rather than restarting. An Upload
 * is not yet a Video — it has no row and no Share Link — until its bytes finish
 * arriving, at which point {@link onUploadFinish} creates the Processing Video
 * and enqueues transcoding, exactly as the legacy single-shot route does.
 */
export async function registerUploadRoutes(
  app: FastifyInstance,
  options: UploadRouteOptions,
): Promise<void> {
  const {
    session,
    repo,
    folderRepo,
    worker,
    store,
    slugGenerator,
    clock,
    transcoding,
    storage,
    maxUploadBytes,
    maxUploadBatch,
    uploadsDir,
  } = options;

  // Create the uploads directory up front and synchronously. @tus/file-store
  // otherwise does it from a fire-and-forget `mkdir` in its constructor (its
  // own code flags this as a TODO), which under threadpool pressure can land
  // late; doing it here means the directory is reliably present before the
  // first Upload and the store's async attempt is a fast no-op.
  mkdirSync(uploadsDir, { recursive: true });

  const datastore = new FileStore({
    directory: uploadsDir,
    expirationPeriodInMilliseconds: UPLOAD_TTL_MS,
  });

  const tus = new TusServer({
    path: '/api/uploads',
    datastore,
    maxSize: maxUploadBytes,
    // The Operator's own reverse proxy terminates TLS (ADR-0004); honour its
    // forwarded host/proto so the Upload URLs tus hands back resolve.
    respectForwardedHeaders: true,

    // Gate a new Upload before any bytes are accepted — the resumable analogue
    // of the legacy route's up-front checks.
    async onUploadCreate(_req, upload: Upload) {
      // Nothing good comes of accepting a Source we can't transcode.
      if (!transcoding.current().available) {
        await transcoding.refresh();
        if (!transcoding.current().available) {
          throw uploadRefusal(
            503,
            'transcoding_unavailable',
            transcoding.current().error ?? 'Transcoding is unavailable.',
          );
        }
      }

      // tus has no notion of a batch, so the batch cap becomes a ceiling on
      // concurrent incomplete Uploads (ADR-0013). Counted here, before this one
      // is created, so the limit is exactly `maxUploadBatch` in flight.
      const inflight = await countInflightUploads(uploadsDir);
      if (inflight >= maxUploadBatch) {
        throw uploadRefusal(
          429,
          'too_many_uploads',
          `${inflight} uploads are already in progress; the limit is ${maxUploadBatch} ` +
            `(MAX_UPLOAD_BATCH). Finish or cancel one before starting another.`,
        );
      }

      // Does the declared size fit? The allowance is the recorded Video bytes
      // and free-disk ceilings (ADR-0011); partials already on disk are not in
      // that SUM, so subtract them here to honour "partials count against the
      // storage figure" (ADR-0013).
      const declared = upload.size;
      if (declared !== undefined) {
        const allowance = await storage.allowance();
        if (Number.isFinite(allowance.bytes)) {
          const partials = await partialUploadBytes(uploadsDir);
          const remaining = allowance.bytes - partials;
          if (declared > remaining) {
            const refusal = refusalFor(allowance, declared, storage.limits);
            throw uploadRefusal(507, refusal.reason, refusal.detail);
          }
        }
      }

      // Fail fast on an unknown target Folder, rather than at finish time when
      // there would already be a whole Source on disk to unwind.
      const folderSlug = metaString(upload.metadata, 'folderSlug');
      if (folderSlug) {
        const folder = await folderRepo.findBySlug(folderSlug);
        if (!folder) {
          throw uploadRefusal(404, 'folder_not_found', `No Folder with slug "${folderSlug}".`);
        }
      }

      return {};
    },

    // The bytes are all here: the partial becomes a Video. This is the single
    // point where a row and a Share Link come into being (ADR-0013).
    async onUploadFinish(_req, upload: Upload) {
      const rawTitle = metaString(upload.metadata, 'title');
      const title = rawTitle && rawTitle.length > 0 ? rawTitle : UNNAMED_VIDEO;
      const description = metaString(upload.metadata, 'description') || null;
      const folderSlug = metaString(upload.metadata, 'folderSlug');

      // Re-resolve the Folder (validated at create): inherit its display
      // defaults, exactly as the legacy route does.
      const folder = folderSlug ? await folderRepo.findBySlug(folderSlug) : undefined;

      const created = await repo.create({
        slug: slugGenerator.next(),
        title,
        description,
        folderId: folder ? folder.id : null,
        portraitOptimized: folder ? folder.portraitOptimized : false,
        autoplay: folder ? folder.autoplay : false,
        createdAt: clock.now(),
      });

      // Move the finished partial into the Video's Source slot. Both live under
      // the data directory, so this is an atomic rename, never a copy.
      await store.ensureVideoDir(created.id);
      const partialPath = upload.storage?.path ?? join(uploadsDir, upload.id);
      await rename(partialPath, store.sourcePath(created.id));
      // The data file is gone; drop the orphaned tus info sidecar so the reaper
      // never trips over a half-removed Upload.
      await rm(join(uploadsDir, `${upload.id}.json`), { force: true });

      const sourceBytes = await store.sourceBytes(created.id);
      await repo.setSourceBytes(created.id, sourceBytes);
      worker.enqueue(created.id);

      // tus allows a JSON body here even though the bare protocol wouldn't; the
      // client reads the created Video from it to swap its optimistic tile.
      const video = serializeVideo({ ...created, sourceBytes }, clock.now(), folder?.slug ?? null);
      return {
        status_code: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video }),
      };
    },
  });

  // tus PATCH/POST bodies are `application/offset+octet-stream`, which Fastify
  // would otherwise 415. Register a no-op parser that leaves the raw stream for
  // tus to read from `request.raw`.
  app.addContentTypeParser(
    'application/offset+octet-stream',
    (_req, _payload, done) => done(null),
  );

  // Every tus method (POST/HEAD/PATCH/DELETE/OPTIONS) on the collection and on a
  // single Upload, gated to the Operator. `reply.hijack()` hands the raw
  // response to tus so Fastify does not also try to reply.
  const handle = (request: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    void tus.handle(request.raw, reply.raw);
  };
  const guarded = { preHandler: session.requireOperator } as const;
  app.all('/api/uploads', guarded, handle);
  app.all('/api/uploads/*', guarded, handle);

  // Reap abandoned partials (ADR-0013). `cleanUpExpiredUploads` removes any
  // Upload idle past the FileStore's expiration window; a partial is not a
  // Video, so this never touches Operator media (ADR-0011).
  const reaper = setInterval(() => {
    tus
      .cleanUpExpiredUploads()
      .then((removed) => {
        if (removed > 0) app.log.info({ removed }, 'reaped expired partial uploads');
      })
      .catch((err) => app.log.warn({ err }, 'upload reaper failed'));
  }, REAPER_INTERVAL_MS);
  reaper.unref();
  app.addHook('onClose', async () => clearInterval(reaper));
}

/** The value of a tus metadata key as a trimmed string, or '' when absent. */
function metaString(metadata: Upload['metadata'], key: string): string {
  const value = metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * How many incomplete Uploads exist, by counting the FileStore's `<id>.json`
 * info sidecars — one per Upload, present until the Upload finishes or is
 * reaped. Cheap: a single directory read, no per-file stat.
 */
async function countInflightUploads(uploadsDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(uploadsDir);
  } catch {
    return 0; // no uploads directory yet means nothing in flight
  }
  return names.filter((name) => name.endsWith('.json')).length;
}

/** Total bytes the partial data files occupy right now (excludes the `.json` sidecars). */
async function partialUploadBytes(uploadsDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(uploadsDir);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    names
      .filter((name) => !name.endsWith('.json'))
      .map(async (name) => {
        try {
          const info = await stat(join(uploadsDir, name));
          return info.isFile() ? info.size : 0;
        } catch {
          return 0;
        }
      }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}
