import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { hashPassword } from '../auth/password';
import type { Clock } from '../ports/clock';
import type { SlugGenerator } from '../ports/slug';
import type { Video } from '../db/schema';
import { totalBytes, type MediaStore } from '../media/media-store';
import {
  refusalFor,
  type StorageAllowance,
  type StorageGuard,
} from '../media/storage-guard';
import { buildStorageReport } from '../media/storage-report';
import { hostConfigReport } from '../system/host-config-report';
import type { Config } from '../config';
import type { SessionManager } from '../auth/session';
import type { TranscodingStatus } from '../system/transcoding-status';
import type { VideoRepo } from './video-repo';
import type { FolderRepo } from './folder-repo';
import type { Folder } from '../db/schema';
import type { VideoWorker } from './transcode-worker';

/** Raised by {@link byteCeiling} when an upload outgrows what may be written. */
class StorageCeilingExceeded extends Error {
  constructor(
    readonly wrote: number,
    readonly allowed: number,
  ) {
    super(`Source reached ${wrote} bytes, over the ${allowed} bytes available.`);
    this.name = 'StorageCeilingExceeded';
  }
}

/**
 * Fails the stream the moment the bytes written would pass `allowed`, so a body
 * that no longer fits stops consuming disk as soon as that is known rather than
 * at the end of a multi-gigabyte upload.
 */
function byteCeiling(allowed: number): Transform {
  let wrote = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      wrote += chunk.length;
      if (wrote > allowed) {
        callback(new StorageCeilingExceeded(wrote, allowed));
        return;
      }
      callback(null, chunk);
    },
  });
}

export interface VideoRouteOptions extends FastifyPluginOptions {
  session: SessionManager;
  repo: VideoRepo;
  folderRepo: FolderRepo;
  worker: VideoWorker;
  store: MediaStore;
  slugGenerator: SlugGenerator;
  clock: Clock;
  transcoding: TranscodingStatus;
  /** Hard ceiling on a Source upload, in bytes (spec: configurable max upload size). */
  maxUploadBytes: number;
  /** The Quota and free-disk ceilings that gate writes (ADR-0011). */
  storage: StorageGuard;
  /** Where the Dashboard's storage warning band starts. */
  quotaWarnPercent: number;
  /** The SQLite file, reported (and excluded from the Quota) in the storage view. */
  dbPath: string;
  /** The whole resolved configuration, for the read-only Settings → Server view. */
  config: Config;
  /** The environment it was resolved from, so each value's provenance is known. */
  env: NodeJS.ProcessEnv;
}

export async function registerVideoRoutes(
  app: FastifyInstance,
  options: VideoRouteOptions,
): Promise<void> {
  const { session, repo, folderRepo, worker, store, slugGenerator, clock, transcoding, maxUploadBytes, storage, quotaWarnPercent, dbPath, config, env } =
    options;
  const requireOperator = { preHandler: session.requireOperator } as const;

  /**
   * **507 Insufficient Storage**, not 413. A 413 says "your request is too
   * large" — a property of the request, which the Operator fixes by sending
   * something smaller. A 507 says "this server has no room" — a property of the
   * server, which they fix by freeing space or raising a ceiling. Different
   * problems; the Operator should not have to guess which one they hit.
   */
  function sendStorageRefusal(
    reply: FastifyReply,
    allowance: StorageAllowance,
    wanted: number,
  ): FastifyReply {
    const refusal = refusalFor(allowance, wanted, storage.limits);
    // The body's `error` is the stable machine code the client reads as
    // `reason` (ADR-0007); `detail` carries the real figures.
    return reply.code(507).send({ error: refusal.reason, detail: refusal.detail });
  }

  /** Resolves a Video's owning Folder slug (null when it sits in the root). */
  async function folderSlugOf(video: Video): Promise<string | null> {
    if (video.folderId === null) return null;
    const folder = await folderRepo.findById(video.folderId);
    return folder?.slug ?? null;
  }

  // Transcoding health, so the Dashboard can warn (and we can gate uploads)
  // when ffmpeg isn't runnable. Re-probes so recovery needs no restart.
  app.get('/api/status', requireOperator, async () => {
    const status = await transcoding.refresh();
    // A `SUM()` of figures recorded at write time — not a walk of the media
    // directory, which would make this endpoint cost O(Library) per poll.
    const totals = await repo.storageTotals();
    return {
      transcoding: {
        available: status.available,
        version: status.version ?? null,
        // ADR-0007: tell the Operator the real reason it's unavailable.
        error: status.error ?? null,
      },
      storage: await buildStorageReport({
        totals,
        guard: storage,
        warnPercent: quotaWarnPercent,
        dbPath,
      }),
    };
  });

  // The Host Configuration, with each value's provenance. Its own endpoint
  // rather than part of `/api/status`: that one is polled while a Video
  // transcodes, and configuration fixed at process start has no business being
  // re-sent every three seconds.
  app.get('/api/server-config', requireOperator, () => ({
    sections: hostConfigReport(config, env),
  }));

  // Upload a Video. The file streams straight to disk (never buffered whole in
  // memory); the response returns the moment the Source is saved — in the
  // `processing` state with a usable Share Link — and transcoding runs on the
  // background worker. The client must send the `title`/`description` field
  // parts *before* the file part so the metadata is known when the file arrives.
  app.post('/api/videos', requireOperator, async (request, reply) => {
    // Refuse before reading the body when transcoding can't run — nothing good
    // can come of saving a Source we can't process. Re-probe first so an
    // Operator who just installed ffmpeg isn't blocked by a stale boot check.
    if (!transcoding.current().available) {
      await transcoding.refresh();
      if (!transcoding.current().available) {
        return reply.code(503).send({
          error: 'transcoding_unavailable',
          detail: transcoding.current().error ?? undefined,
        });
      }
    }

    // Reject an over-cap upload up front when the client declares its size, so a
    // body we'd only reject anyway never streams to disk. Content-Length for a
    // multipart body is an upper bound on the file (plus small field overhead),
    // so `> cap` here is a safe early-out; a missing/understated length falls
    // through to the mid-stream limit below (spec: early when present, else mid).
    const declaredLength = request.headers['content-length'];
    const declared =
      declaredLength === undefined ? undefined : Number(declaredLength);
    const declaredBytes =
      declared !== undefined && Number.isFinite(declared) ? declared : undefined;

    if (declaredBytes !== undefined && declaredBytes > maxUploadBytes) {
      return reply.code(413).send({
        error: 'upload_too_large',
        detail: `Upload is ${declaredBytes} bytes, over the ${maxUploadBytes}-byte maximum.`,
      });
    }

    // How much this instance may still write. Probed once per upload: a `SUM()`
    // of the recorded figures plus one `statfs`, never a walk of the media dir.
    const allowance = await storage.allowance();
    if (declaredBytes !== undefined && declaredBytes > allowance.bytes) {
      return sendStorageRefusal(reply, allowance, declaredBytes);
    }

    let title: string | undefined;
    let description: string | null = null;
    let created: Video | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'title') title = String(part.value).trim();
          else if (part.fieldname === 'description') {
            const value = String(part.value).trim();
            description = value.length > 0 ? value : null;
          }
          continue;
        }

        // The single file part. Everything we need to open the Source file must
        // be known by now; otherwise there is nothing valid to stream into.
        if (!title) {
          return reply.code(400).send({ error: 'missing_title' });
        }

        created = await repo.create({
          slug: slugGenerator.next(),
          title,
          description,
          createdAt: clock.now(),
        });
        await store.ensureVideoDir(created.id);
        // A client can omit or understate Content-Length, so the ceiling is
        // enforced again on the bytes actually arriving. When nothing caps this
        // instance the counter is skipped entirely rather than taxing every
        // chunk of every upload.
        const sink = createWriteStream(store.sourcePath(created.id));
        if (Number.isFinite(allowance.bytes)) {
          await pipeline(part.file, byteCeiling(allowance.bytes), sink);
        } else {
          await pipeline(part.file, sink);
        }

        // The file exceeded the cap without an honest Content-Length: it was
        // truncated at the limit mid-stream. Roll back the partial Source + row
        // and return the same clear 413 as the early check — no junk left behind.
        if (part.file.truncated) {
          await repo.delete(created.id);
          await store.removeVideo(created.id);
          return reply.code(413).send({
            error: 'upload_too_large',
            detail: `Upload exceeds the ${maxUploadBytes}-byte maximum.`,
          });
        }

        // Record what the Source weighs, now that the stream has closed and
        // before anything can report on it. Reading it here is the only `stat`
        // this figure ever costs.
        created = {
          ...created,
          sourceBytes: await store.sourceBytes(created.id),
        };
        await repo.setSourceBytes(created.id, created.sourceBytes);
        break; // one file per upload; ignore any trailing parts
      }
    } catch (err) {
      // The upload failed mid-stream (e.g. the disk filled — ENOSPC): roll back
      // so a half-written Source and its orphaned row don't linger, then hand
      // the Operator the real cause (ADR-0007). The cap-exceeded case is handled
      // above as a clean 413; this catch covers genuine write failures.
      if (created) {
        await repo.delete(created.id);
        await store.removeVideo(created.id);
      }

      // A ceiling crossed mid-stream: the partial Source has just been removed
      // above, so nothing is left behind and nothing existing was touched
      // (ADR-0011).
      if (err instanceof StorageCeilingExceeded) {
        request.log.warn(
          { wrote: err.wrote, allowed: err.allowed },
          'upload refused: storage ceiling reached mid-stream',
        );
        return sendStorageRefusal(reply, allowance, err.wrote);
      }

      request.log.error(err, 'upload failed');
      // ADR-0007: the Operator owns the box — hand them the real cause.
      return reply.code(500).send({
        error: 'upload_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    if (!created) {
      return reply.code(400).send({ error: 'missing_file' });
    }

    worker.enqueue(created.id);
    return reply.code(201).send({
      video: serializeVideo(created, clock.now(), await folderSlugOf(created)),
    });
  });

  // The Operator's Library: every Video with its state, transcoding progress,
  // and owning Folder (slug, or null for a root Video).
  app.get('/api/videos', requireOperator, async () => {
    const now = clock.now();
    const [all, folderSlugById] = await Promise.all([repo.list(), folderSlugMap()]);
    return {
      videos: all.map((video) =>
        serializeVideo(video, now, video.folderId === null ? null : folderSlugById.get(video.folderId) ?? null),
      ),
    };
  });

  /** A folderId → slug lookup, so a batch of Videos resolves their Folder without N queries. */
  async function folderSlugMap(): Promise<Map<number, string>> {
    const all = await folderRepo.list();
    return new Map(all.map((folder) => [folder.id, folder.slug]));
  }

  // The Operator's Folders, newest first, each with how many Videos it holds.
  app.get('/api/folders', requireOperator, async () => {
    const now = clock.now();
    const [folders, videos] = await Promise.all([folderRepo.list(), repo.list()]);
    const counts = new Map<number, number>();
    for (const video of videos) {
      if (video.folderId !== null) {
        counts.set(video.folderId, (counts.get(video.folderId) ?? 0) + 1);
      }
    }
    return {
      folders: folders.map((folder) => serializeFolder(folder, counts.get(folder.id) ?? 0, now)),
    };
  });

  // Create a Folder with an unguessable `/f/<slug>` Share Link (ADR-0002).
  app.post<{ Body: { name?: unknown } }>(
    '/api/folders',
    requireOperator,
    async (request, reply) => {
      const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
      if (name.length === 0) {
        return reply.code(400).send({
          error: 'missing_name',
          detail: 'A non-empty Folder name is required.',
        });
      }
      const folder = await folderRepo.create({
        slug: slugGenerator.next(),
        name,
        createdAt: clock.now(),
      });
      return reply.code(201).send({ folder: serializeFolder(folder, 0, clock.now()) });
    },
  );

  // Browse a Folder: the Folder and the Videos it holds (spec: Operator can
  // browse the Videos inside a Folder). Unknown slug → technical 404 (ADR-0007).
  app.get<{ Params: { slug: string } }>(
    '/api/folders/:slug',
    requireOperator,
    async (request, reply) => {
      const folder = await folderRepo.findBySlug(request.params.slug);
      if (!folder) return folderNotFound(reply, request.params.slug);

      const now = clock.now();
      const videos = await repo.listByFolder(folder.id);
      return {
        folder: serializeFolder(folder, videos.length, now),
        videos: videos.map((video) => serializeVideo(video, now, folder.slug)),
      };
    },
  );

  // Protect a Folder's `/f/` gallery with a password, or replace an existing
  // one (spec: Operator story 29). Stored hashed (scrypt, same as a Video's);
  // the plaintext is never persisted or echoed. A Viewer then unlocks the
  // Folder once and its Videos cascade open (ADR-0002 second factor).
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/folders/:slug/password',
    requireOperator,
    async (request, reply) => {
      const folder = await folderRepo.findBySlug(request.params.slug);
      if (!folder) return folderNotFound(reply, request.params.slug);

      const password =
        typeof request.body?.password === 'string' ? request.body.password.trim() : '';
      if (password.length === 0) {
        return reply.code(400).send({
          error: 'missing_password',
          detail: 'A non-empty password is required to protect a Folder.',
        });
      }

      await folderRepo.setPasswordHash(folder.id, await hashPassword(password));
      return reply.code(200).send({ folder: await serializeFolderFresh(folder.id) });
    },
  );

  // Remove a Folder's password, making its gallery open again.
  app.delete<{ Params: { slug: string } }>(
    '/api/folders/:slug/password',
    requireOperator,
    async (request, reply) => {
      const folder = await folderRepo.findBySlug(request.params.slug);
      if (!folder) return folderNotFound(reply, request.params.slug);

      await folderRepo.setPasswordHash(folder.id, null);
      return reply.code(200).send({ folder: await serializeFolderFresh(folder.id) });
    },
  );

  // Set, extend, clear, or re-enable a Folder gallery's expiry (spec: Operator
  // story 29). Body carries `expiresAt` as epoch milliseconds, or null to never
  // expire — mirroring a Video's expiry; the Clock decides expired/not-expired.
  app.post<{ Params: { slug: string }; Body: { expiresAt?: unknown } }>(
    '/api/folders/:slug/expiry',
    requireOperator,
    async (request, reply) => {
      const folder = await folderRepo.findBySlug(request.params.slug);
      if (!folder) return folderNotFound(reply, request.params.slug);

      const raw = request.body?.expiresAt;
      const expiresAt =
        raw === null || raw === undefined
          ? null
          : typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : NaN;
      if (Number.isNaN(expiresAt)) {
        return reply.code(400).send({
          error: 'invalid_expiry',
          detail: 'expiresAt must be epoch milliseconds (a finite number) or null.',
        });
      }

      await folderRepo.setExpiresAt(folder.id, expiresAt);
      return reply.code(200).send({ folder: await serializeFolderFresh(folder.id) });
    },
  );

  // Delete a Folder, with an explicit choice about its Videos (spec: Operator
  // story 31, ADR-0006). The `videos` query param is required and has no
  // default, so an accidental call can never silently destroy Videos:
  //   - `delete` purges the Folder and every Video in it (media + Share Links).
  //   - `keep`   removes the Folder only, moving its Videos to the Library root
  //              (each Video and its own `/v/<slug>` link survive intact).
  // The Dashboard presents both options before calling (story 31).
  app.delete<{ Params: { slug: string }; Querystring: { videos?: string } }>(
    '/api/folders/:slug',
    requireOperator,
    async (request, reply) => {
      const folder = await folderRepo.findBySlug(request.params.slug);
      if (!folder) return folderNotFound(reply, request.params.slug);

      const mode = request.query.videos;
      if (mode !== 'delete' && mode !== 'keep') {
        return reply.code(400).send({
          error: 'missing_videos_choice',
          detail:
            'The `videos` query param is required: "delete" to purge the Folder and its Videos, or "keep" to move them to the Library root.',
        });
      }

      const contained = await repo.listByFolder(folder.id);
      if (mode === 'delete') {
        // Purge each Video first (row + media), so no row is left pointing at a
        // vanished Folder and private footage is really gone (spec: ──delete──▶).
        for (const video of contained) {
          await repo.delete(video.id);
          await store.removeVideo(video.id);
        }
      } else {
        // Keep the Videos: detach them to the Library root before the Folder row
        // goes (its id is a live foreign key), leaving each Share Link working.
        for (const video of contained) {
          await repo.setFolder(video.id, null);
        }
      }
      await folderRepo.delete(folder.id);
      return reply.code(204).send();
    },
  );

  /** Re-reads a Folder after a change and serializes it with its live Video count. */
  async function serializeFolderFresh(id: number): Promise<FolderView> {
    const folder = await folderRepo.findById(id);
    if (!folder) throw new Error('Folder vanished mid-request');
    const videos = await repo.listByFolder(id);
    return serializeFolder(folder, videos.length, clock.now());
  }

  // Move a Video into a Folder, or back to the Library root. `folderSlug` names
  // the destination Folder; null moves it to the root. A Video belongs to at
  // most one Folder (the move replaces any prior membership — never two at once).
  app.post<{ Params: { slug: string }; Body: { folderSlug?: unknown } }>(
    '/api/videos/:slug/folder',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      const target = request.body?.folderSlug;
      let folder: Folder | undefined;
      if (target !== null && target !== undefined) {
        if (typeof target !== 'string') {
          return reply.code(400).send({
            error: 'invalid_folder',
            detail: 'folderSlug must be a Folder slug string, or null for the Library root.',
          });
        }
        folder = await folderRepo.findBySlug(target);
        if (!folder) return folderNotFound(reply, target);
      }

      await repo.setFolder(video.id, folder ? folder.id : null);
      const updated = (await repo.findById(video.id)) ?? video;
      return reply.code(200).send({
        video: serializeVideo(updated, clock.now(), folder ? folder.slug : null),
      });
    },
  );

  // Retry a Failed Video. The Source was retained through the failure, so this
  // simply re-queues transcoding (Failed → Processing) against the same file.
  // Only a Failed Video is retryable; retrying anything else is refused with
  // the Video's real state (ADR-0007: the real reason, not a genericised one).
  app.post<{ Params: { slug: string } }>(
    '/api/videos/:slug/retry',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);
      if (video.state !== 'failed') {
        return reply.code(409).send({
          error: 'not_retryable',
          detail: `Video "${video.slug}" is in state "${video.state}"; only a Failed Video can be retried.`,
        });
      }

      // Don't re-queue into a transcoder that can't run — it would only
      // re-fail. Retry is a deliberate, infrequent recovery action, so always
      // re-probe (unlike the high-frequency upload gate): this both catches an
      // ffmpeg that broke since boot and clears a stale "unavailable" the
      // moment the Operator fixes it.
      const status = await transcoding.refresh();
      if (!status.available) {
        return reply.code(503).send({
          error: 'transcoding_unavailable',
          detail: status.error ?? undefined,
        });
      }

      // A transcode reads the Source. Without one there is nothing to re-encode,
      // so say that plainly now rather than enqueueing a job that will come
      // back as an opaque ffmpeg failure minutes later (ADR-0007). The `stat`
      // is affordable here precisely because Retry is rare and deliberate.
      if (!(await store.hasSource(video.id))) {
        return reply.code(409).send({
          error: 'source_unavailable',
          detail:
            video.sourceDiscardedAt !== null
              ? `The Source for "${video.slug}" was discarded on ` +
                `${new Date(video.sourceDiscardedAt).toISOString()}, so it cannot be ` +
                `re-transcoded. Discarding is irreversible (ADR-0010); re-upload the ` +
                `original to replace this Video.`
              : `The Source for "${video.slug}" is missing from disk, so it cannot be ` +
                `re-transcoded. It was not discarded through videocastle — run ` +
                `\`videocastle storage-reconcile\` to see what else is missing.`,
        });
      }

      // A retry writes a fresh Rendition, which is the same new bytes an upload
      // would be, so it is gated too. How big that Rendition will be is not
      // knowable in advance, so the rule is "is there any room at all?" rather
      // than a size check: a retry started with headroom may still finish
      // slightly over a ceiling, and nothing is deleted to fix that — the
      // over-quota state is simply reported honestly (ADR-0011).
      const allowance = await storage.allowance();
      if (allowance.bytes <= 0) {
        return sendStorageRefusal(reply, allowance, 1);
      }

      // Purge any partial Rendition/Poster the failed run left so the retry
      // transcodes into a clean output dir (the retained Source is kept).
      await store.clearRendition(video.id);

      // Read back the re-queued (Processing) Video before enqueuing, so the
      // response reflects the retry regardless of how fast the worker then runs
      // the job (a quick transcoder could otherwise flip the state first).
      await repo.markProcessing(video.id);
      const requeued = await repo.findById(video.id);
      worker.enqueue(video.id);
      {
        const v = requeued ?? video;
        return reply.code(200).send({ video: serializeVideo(v, clock.now(), await folderSlugOf(v)) });
      }
    },
  );

  // Delete a Video: purge its Source and Rendition and kill its Share Link, so
  // private footage is really gone (spec: Operator story 19). The row is removed
  // first — that alone invalidates the link immediately (the slug stops
  // resolving) — then the media directory is purged from disk. Irreversible by
  // design; the Dashboard confirms before calling this (story 20).
  //
  // A deleted slug collapses into the same generic Viewer 404 as an unknown one
  // (ADR-0002, no existence leak) precisely because the row is gone: the Viewer
  // surface can no longer tell a deleted link from one that never existed.
  app.delete<{ Params: { slug: string } }>(
    '/api/videos/:slug',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      // Operator surface (ADR-0007): the real reason, not a genericised one.
      if (!video) return videoNotFound(reply, request.params.slug);

      await repo.delete(video.id);
      await store.removeVideo(video.id);
      return reply.code(204).send();
    },
  );

  // Protect a Video with a password (spec: Operator story — password-protect a
  // link). The password is stored hashed (scrypt, same as the Operator
  // credential); the plaintext is never persisted or echoed back. Setting a
  // password on an already-protected Video simply replaces it.
  app.post<{ Params: { slug: string }; Body: { password?: unknown } }>(
    '/api/videos/:slug/password',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      const password =
        typeof request.body?.password === 'string' ? request.body.password.trim() : '';
      if (password.length === 0) {
        return reply.code(400).send({
          error: 'missing_password',
          detail: 'A non-empty password is required to protect a Video.',
        });
      }

      await repo.setPasswordHash(video.id, await hashPassword(password));
      const updated = await repo.findById(video.id);
      {
        const v = updated ?? video;
        return reply.code(200).send({ video: serializeVideo(v, clock.now(), await folderSlugOf(v)) });
      }
    },
  );

  // Remove a Video's password, making its Share Link open again.
  app.delete<{ Params: { slug: string } }>(
    '/api/videos/:slug/password',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      await repo.setPasswordHash(video.id, null);
      const updated = await repo.findById(video.id);
      {
        const v = updated ?? video;
        return reply.code(200).send({ video: serializeVideo(v, clock.now(), await folderSlugOf(v)) });
      }
    },
  );

  // Set, extend, clear, or re-enable a Video's Share Link expiry (spec:
  // Operator story — expiring links). The body carries `expiresAt` as epoch
  // milliseconds, or null to never expire. The same call extends an active
  // link or re-enables an expired one by moving the instant into the future;
  // the Clock decides expired/not-expired, so this route only persists.
  app.post<{ Params: { slug: string }; Body: { expiresAt?: unknown } }>(
    '/api/videos/:slug/expiry',
    requireOperator,
    async (request, reply) => {
      const video = await repo.findBySlug(request.params.slug);
      if (!video) return videoNotFound(reply, request.params.slug);

      const raw = request.body?.expiresAt;
      const expiresAt =
        raw === null || raw === undefined
          ? null
          : typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : NaN;
      if (Number.isNaN(expiresAt)) {
        return reply.code(400).send({
          error: 'invalid_expiry',
          detail: 'expiresAt must be epoch milliseconds (a finite number) or null.',
        });
      }

      await repo.setExpiresAt(video.id, expiresAt);
      const updated = await repo.findById(video.id);
      {
        const v = updated ?? video;
        return reply.code(200).send({ video: serializeVideo(v, clock.now(), await folderSlugOf(v)) });
      }
    },
  );
}

/** The Operator-facing not-found (ADR-0007: the real reason, naming the slug). */
function videoNotFound(
  reply: import('fastify').FastifyReply,
  slug: string,
): import('fastify').FastifyReply {
  return reply.code(404).send({
    error: 'video_not_found',
    detail: `No Video with slug "${slug}".`,
  });
}

/** The Operator-facing Folder not-found (ADR-0007: the real reason, naming the slug). */
function folderNotFound(
  reply: import('fastify').FastifyReply,
  slug: string,
): import('fastify').FastifyReply {
  return reply.code(404).send({
    error: 'folder_not_found',
    detail: `No Folder with slug "${slug}".`,
  });
}

/**
 * The public shape of a Video. Deliberately omits the internal id and all
 * on-disk paths — the Library needs state, progress, and a Share Link, not the
 * storage layout.
 */
export interface VideoView {
  slug: string;
  title: string;
  description: string | null;
  state: string;
  progress: number;
  durationSeconds: number | null;
  /** Failure code when `state === 'failed'`, else null (see TranscodeFailureReason). */
  failureReason: string | null;
  /** Diagnostic detail for a failure, else null. Shown to the single Operator. */
  failureDetail: string | null;
  /** Whether a per-Video password gates the Share Link. The hash is never exposed. */
  protected: boolean;
  /** Share Link expiry (epoch ms), or null when the link never expires. */
  expiresAt: number | null;
  /** Whether the link has expired as of now (per the injected Clock). */
  expired: boolean;
  /** The owning Folder's slug, or null when the Video sits in the Library root. */
  folderSlug: string | null;
  shareUrl: string;
  createdAt: number;
  /**
   * What this Video occupies on disk, as recorded at write time. The Operator
   * owns the server, so what their media costs is theirs to see — it is what
   * the Storage view sorts on when they need to free space.
   */
  storage: {
    sourceBytes: number;
    renditionBytes: number;
    posterBytes: number;
    totalBytes: number;
    /**
     * When the Operator discarded this Video's Source (epoch ms), else null.
     * The Video still plays; it can no longer be re-transcoded (ADR-0010).
     */
    sourceDiscardedAt: number | null;
  };
}

function serializeVideo(
  video: Video,
  now: number,
  folderSlug: string | null,
): VideoView {
  return {
    slug: video.slug,
    title: video.title,
    description: video.description,
    state: video.state,
    progress: video.progress,
    durationSeconds: video.durationSeconds,
    failureReason: video.failureReason,
    failureDetail: video.failureDetail,
    protected: video.passwordHash !== null,
    expiresAt: video.expiresAt,
    expired: isExpired(video, now),
    folderSlug,
    shareUrl: `/v/${video.slug}`,
    createdAt: video.createdAt,
    storage: {
      sourceBytes: video.sourceBytes,
      renditionBytes: video.renditionBytes,
      posterBytes: video.posterBytes,
      totalBytes: totalBytes(video),
      sourceDiscardedAt: video.sourceDiscardedAt,
    },
  };
}

/** The public shape of a Folder for the Operator's Library. */
export interface FolderView {
  slug: string;
  name: string;
  videoCount: number;
  /** Whether a password gates the `/f/` gallery. The hash is never exposed. */
  protected: boolean;
  /** Gallery Share Link expiry (epoch ms), or null when it never expires. */
  expiresAt: number | null;
  /** Whether the gallery link has expired as of now (per the injected Clock). */
  expired: boolean;
  shareUrl: string;
  createdAt: number;
}

function serializeFolder(folder: Folder, videoCount: number, now: number): FolderView {
  return {
    slug: folder.slug,
    name: folder.name,
    videoCount,
    protected: folder.passwordHash !== null,
    expiresAt: folder.expiresAt,
    expired: isExpired(folder, now),
    shareUrl: `/f/${folder.slug}`,
    createdAt: folder.createdAt,
  };
}

/**
 * Whether a Share Link has expired as of `now` (the injected Clock). Works for
 * anything carrying an optional expiry instant — a Video or a Folder alike.
 */
export function isExpired(link: { expiresAt: number | null }, now: number): boolean {
  return link.expiresAt !== null && now >= link.expiresAt;
}
