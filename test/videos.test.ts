import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscodeError } from '../src/ports/transcoder';
import { buildTestApp, type TestApp } from './helpers';
import { OPERATOR, setupOperator, uploadVideo, waitFor } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Builds an app and completes first-run setup, returning it plus the session jar. */
async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  return { ...current, jar: await setupOperator(current.app) };
}

/**
 * Uploads one Video and drives its transcode to Failed via the fake
 * Transcoder, leaving it in the Failed state ready to be retried.
 */
async function uploadFailed(
  app: TestApp['app'],
  jar: Record<string, string>,
  transcoder: TestApp['transcoder'],
  worker: TestApp['worker'],
  error = new TranscodeError('encode_failed', 'ffmpeg blew up', 'stderr tail here'),
): Promise<void> {
  transcoder.auto = false;
  await uploadVideo(app, jar, {
    fields: { title: 'Clip' },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await waitFor(() => transcoder.requests.length === 1);
  await transcoder.fail(error);
  await worker.idle();
}

describe('uploading a Video', () => {
  it('returns immediately with the Video Processing and a usable Share Link', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // keep it Processing so we can observe that state

    const res = await uploadVideo(app, jar, {
      fields: { title: 'My Interview' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'raw bytes' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().video).toMatchObject({
      title: 'My Interview',
      state: 'processing',
      progress: 0,
      shareUrl: '/v/slug-1',
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos).toHaveLength(1);
    expect(list.json().videos[0]).toMatchObject({
      state: 'processing',
      shareUrl: '/v/slug-1',
    });
  });

  it('streams the Source to disk rather than returning before it is saved', async () => {
    const { app, jar, config, worker } = await signedIn();

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'the source bytes' },
    });
    await worker.idle();

    // Exactly one Video directory, keyed by the Video's id, holding the Source.
    const dirs = readdirSync(config.mediaDir);
    expect(dirs).toHaveLength(1);
    const source = readFileSync(join(config.mediaDir, dirs[0]!, 'source'), 'utf8');
    expect(source).toBe('the source bytes');
  });

  it('rejects an upload with no file part', async () => {
    const { app, jar } = await signedIn();

    const res = await uploadVideo(app, jar, { fields: { title: 'No file' } });

    expect(res.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos).toHaveLength(0);
  });

  it('rejects an upload with no title', async () => {
    const { app, jar } = await signedIn();

    const res = await uploadVideo(app, jar, {
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('requires an authenticated Operator to upload or list', async () => {
    current = await buildTestApp();
    await current.app.inject({ method: 'POST', url: '/api/setup', payload: OPERATOR });

    const upload = await current.app.inject({ method: 'POST', url: '/api/videos' });
    expect(upload.statusCode).toBe(401);

    const list = await current.app.inject({ method: 'GET', url: '/api/videos' });
    expect(list.statusCode).toBe(401);
  });

  it('files the Video into a Folder when a folderSlug is supplied', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;
    const folder = await app.inject({
      method: 'POST',
      url: '/api/folders',
      cookies: jar,
      payload: { name: 'Trips' },
    });
    const folderSlug = folder.json().folder.slug as string;

    const res = await uploadVideo(app, jar, {
      fields: { title: 'Beach', folderSlug },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().video.folderSlug).toBe(folderSlug);
  });

  it('rejects an upload into an unknown Folder', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;

    const res = await uploadVideo(app, jar, {
      fields: { title: 'Orphan', folderSlug: 'does-not-exist' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('portrait optimization', () => {
  /** Finds one Video in the Operator's Library list by slug. */
  async function findVideo(
    app: TestApp['app'],
    jar: Record<string, string>,
    slug: string,
  ): Promise<{ portraitOptimized: boolean } | undefined> {
    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    return (list.json().videos as { slug: string; portraitOptimized: boolean }[]).find(
      (v) => v.slug === slug,
    );
  }

  it('toggles a Video’s portrait-optimized flag', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;
    const up = await uploadVideo(app, jar, {
      fields: { title: 'Vertical' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    const slug = up.json().video.slug as string;
    expect(up.json().video.portraitOptimized).toBe(false);

    const on = await app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/portrait`,
      cookies: jar,
      payload: { optimized: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().video.portraitOptimized).toBe(true);
    expect((await findVideo(app, jar, slug))?.portraitOptimized).toBe(true);
  });

  it('applies a Folder toggle to its Videos, and new uploads inherit it', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;
    const folder = await app.inject({
      method: 'POST',
      url: '/api/folders',
      cookies: jar,
      payload: { name: 'Reels' },
    });
    const folderSlug = folder.json().folder.slug as string;

    const first = await uploadVideo(app, jar, {
      fields: { title: 'A', folderSlug },
      file: { fieldname: 'file', filename: 'a.mp4', content: 'bytes' },
    });
    const firstSlug = first.json().video.slug as string;

    const toggled = await app.inject({
      method: 'POST',
      url: `/api/folders/${folderSlug}/portrait`,
      cookies: jar,
      payload: { optimized: true },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json().folder.portraitOptimized).toBe(true);
    // Applied to the Video already in the Folder…
    expect((await findVideo(app, jar, firstSlug))?.portraitOptimized).toBe(true);

    // …and inherited by a Video uploaded into the Folder afterwards.
    const second = await uploadVideo(app, jar, {
      fields: { title: 'B', folderSlug },
      file: { fieldname: 'file', filename: 'b.mp4', content: 'bytes' },
    });
    expect(second.json().video.portraitOptimized).toBe(true);
  });

  it('rejects a non-boolean portrait value', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;
    const up = await uploadVideo(app, jar, {
      fields: { title: 'V' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    const slug = up.json().video.slug as string;

    const res = await app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/portrait`,
      cookies: jar,
      payload: { optimized: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('transcoding to Ready', () => {
  it('transcodes via the Transcoder port to Ready with one Rendition and a poster', async () => {
    const { app, jar, transcoder, worker, db } = await signedIn();

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    // Reached the port with the Video's Source path.
    expect(transcoder.requests).toHaveLength(1);
    expect(transcoder.requests[0]!.sourcePath).toMatch(/\/source$/);

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos[0]).toMatchObject({
      state: 'ready',
      progress: 100,
      durationSeconds: 42,
    });

    // Exactly one Rendition + one Poster recorded for the Video.
    const row = db.raw
      .prepare('SELECT playlist_path, poster_path FROM videos')
      .get() as { playlist_path: string | null; poster_path: string | null };
    expect(row.playlist_path).toBe('rendition/index.m3u8');
    expect(row.poster_path).toBe('poster.jpg');
  });

  it('surfaces transcoding progress in the Library while Processing', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    await transcoder.progress(50);
    const mid = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(mid.json().videos[0]).toMatchObject({ state: 'processing', progress: 50 });

    await transcoder.complete();
    await worker.idle();
    const done = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(done.json().videos[0]).toMatchObject({ state: 'ready', progress: 100 });
  });

  it('marks the Video Failed and surfaces the reason when the transcode errors', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    await transcoder.fail(
      new TranscodeError('encode_failed', 'ffmpeg blew up', 'stderr tail here'),
    );
    await worker.idle();

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos[0]).toMatchObject({
      state: 'failed',
      failureReason: 'encode_failed',
      failureDetail: 'stderr tail here',
    });
  });

  it('retains the Source when a transcode fails, so it can be retried', async () => {
    const { app, jar, transcoder, worker, config } = await signedIn();

    await uploadFailed(app, jar, transcoder, worker);

    // The Source the Operator uploaded is still on disk under the Video's dir.
    const [id] = readdirSync(config.mediaDir);
    const source = readFileSync(join(config.mediaDir, id!, 'source'), 'utf8');
    expect(source).toBe('bytes');
  });
});

describe('retrying a Failed Video', () => {
  it('re-queues transcoding and moves the Video back to Processing', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    await uploadFailed(app, jar, transcoder, worker);

    const retry = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/retry',
      cookies: jar,
    });

    expect(retry.statusCode).toBe(200);
    // Back to Processing, with the prior failure diagnostics cleared.
    expect(retry.json().video).toMatchObject({
      slug: 'slug-1',
      state: 'processing',
      progress: 0,
      failureReason: null,
      failureDetail: null,
    });

    // The worker picked the job up again: a second transcode is in flight,
    // and completing it drives the Video to Ready.
    await waitFor(() => transcoder.requests.length === 2);
    await transcoder.complete();
    await worker.idle();

    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos[0]).toMatchObject({ state: 'ready', progress: 100 });
  });

  it('purges a partial Rendition before re-queuing, keeping the Source', async () => {
    const { app, jar, transcoder, worker, config } = await signedIn();
    await uploadFailed(app, jar, transcoder, worker);

    // Simulate the debris a failed real transcode can leave behind: a partial
    // Rendition and Poster in the Video's dir, alongside the retained Source.
    const [id] = readdirSync(config.mediaDir);
    const dir = join(config.mediaDir, id!);
    mkdirSync(join(dir, 'rendition'), { recursive: true });
    writeFileSync(join(dir, 'rendition', 'seg_000.ts'), 'partial');
    writeFileSync(join(dir, 'rendition', 'index.m3u8'), 'partial');
    writeFileSync(join(dir, 'poster.jpg'), 'partial');

    const retry = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/retry',
      cookies: jar,
    });
    expect(retry.statusCode).toBe(200);

    // The partial Rendition and Poster are gone; the Source is untouched.
    expect(existsSync(join(dir, 'rendition'))).toBe(false);
    expect(existsSync(join(dir, 'poster.jpg'))).toBe(false);
    expect(readFileSync(join(dir, 'source'), 'utf8')).toBe('bytes');
  });

  it('refuses to retry a Video that is not Failed (409, technical reason)', async () => {
    const { app, jar, worker } = await signedIn();
    // A plain upload with the default auto transcoder reaches Ready.
    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    const retry = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/retry',
      cookies: jar,
    });

    expect(retry.statusCode).toBe(409);
    // ADR-0007: the Operator gets the real state, not a genericised message.
    expect(retry.json()).toMatchObject({ error: 'not_retryable' });
    expect(retry.json().detail).toContain('ready');
  });

  it('returns 404 for an unknown Video slug', async () => {
    const { app, jar } = await signedIn();

    const retry = await app.inject({
      method: 'POST',
      url: '/api/videos/does-not-exist/retry',
      cookies: jar,
    });

    expect(retry.statusCode).toBe(404);
    expect(retry.json()).toMatchObject({ error: 'video_not_found' });
  });

  it('requires an authenticated Operator', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    await uploadFailed(app, jar, transcoder, worker);

    const retry = await app.inject({ method: 'POST', url: '/api/videos/slug-1/retry' });

    expect(retry.statusCode).toBe(401);
  });

  it('refuses to retry with 503 when transcoding is unavailable', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    await uploadFailed(app, jar, transcoder, worker);

    // ffmpeg becomes unrunnable after the failure; a retry would only re-fail.
    transcoder.available = false;

    const retry = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/retry',
      cookies: jar,
    });

    expect(retry.statusCode).toBe(503);
    expect(retry.json()).toMatchObject({ error: 'transcoding_unavailable' });

    // Still Failed — nothing was re-queued.
    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos[0]).toMatchObject({ state: 'failed' });
  });
});

describe('deleting a Video', () => {
  it('purges the Source and Rendition from disk and removes the Video', async () => {
    const { app, jar, worker, config } = await signedIn();
    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    // The debris of a finished transcode: the Video's dir holds a Source, a
    // Rendition, and a Poster — all of which deletion must purge.
    const [id] = readdirSync(config.mediaDir);
    const dir = join(config.mediaDir, id!);
    mkdirSync(join(dir, 'rendition'), { recursive: true });
    writeFileSync(join(dir, 'rendition', 'index.m3u8'), 'playlist');
    writeFileSync(join(dir, 'poster.jpg'), 'poster');

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/videos/slug-1',
      cookies: jar,
    });
    expect(del.statusCode).toBe(204);

    // The whole Video directory is gone (Source + Rendition + Poster purged)…
    expect(existsSync(dir)).toBe(false);
    // …and the Video no longer exists in the Library.
    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos).toHaveLength(0);
  });

  it('kills the Share Link at once: the deleted link 404s like an unknown slug', async () => {
    const { app, jar, worker } = await signedIn();
    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    // An unknown slug's generic 404, captured before the delete for comparison.
    const unknown = await app.inject({ method: 'GET', url: '/api/watch/does-not-exist' });

    await app.inject({ method: 'DELETE', url: '/api/videos/slug-1', cookies: jar });

    // The deleted link now resolves to the identical generic 404 (ADR-0002: no
    // existence leak — a deleted link is indistinguishable from one that never
    // existed).
    const deleted = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(deleted.statusCode).toBe(404);
    expect(deleted.json()).toEqual(unknown.json());
    expect(deleted.json()).toEqual({ error: 'not_found' });
  });

  it('purges media an in-flight transcode writes after a mid-Processing delete', async () => {
    const { app, jar, transcoder, worker, config } = await signedIn();
    transcoder.auto = false; // hold the transcode open so we can delete mid-flight

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    const [id] = readdirSync(config.mediaDir);
    const dir = join(config.mediaDir, id!);

    // Delete while the Video is still Processing: the link dies and what's on
    // disk now is purged at once.
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/videos/slug-1',
      cookies: jar,
    });
    expect(del.statusCode).toBe(204);

    // The transcode was still running and writes its Rendition into the dir
    // *after* the delete — exactly the orphan the "really gone" guarantee must
    // not leave behind (spec: any ──delete──▶ gone).
    mkdirSync(join(dir, 'rendition'), { recursive: true });
    writeFileSync(join(dir, 'rendition', 'index.m3u8'), 'orphaned');
    writeFileSync(join(dir, 'poster.jpg'), 'orphaned');
    await transcoder.complete();
    await worker.idle();

    // The worker swept the orphaned output once the transcode finished: nothing
    // of the deleted Video survives on disk.
    expect(existsSync(dir)).toBe(false);
  });

  it('returns 404 with the real reason for an unknown slug (ADR-0007)', async () => {
    const { app, jar } = await signedIn();

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/videos/does-not-exist',
      cookies: jar,
    });

    expect(del.statusCode).toBe(404);
    // Operator surface: the technical reason, not a genericised message.
    expect(del.json()).toMatchObject({ error: 'video_not_found' });
    expect(del.json().detail).toContain('does-not-exist');
  });

  it('requires an authenticated Operator', async () => {
    const { app, jar, worker } = await signedIn();
    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    const del = await app.inject({ method: 'DELETE', url: '/api/videos/slug-1' });
    expect(del.statusCode).toBe(401);

    // Nothing was deleted.
    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos).toHaveLength(1);
  });
});

describe('transcoding availability', () => {
  it('reports transcoding available with a version in the normal case', async () => {
    const { app, jar } = await signedIn();

    const res = await app.inject({ method: 'GET', url: '/api/status', cookies: jar });

    expect(res.statusCode).toBe(200);
    // The transcoding block is what this asserts; `/api/status` also carries
    // storage accounting (see storage-accounting.test.ts).
    expect(res.json()).toMatchObject({
      transcoding: { available: true, version: 'fake-1.0', error: null },
    });
  });

  it('refuses uploads with 503 and writes nothing when transcoding is unavailable', async () => {
    current = await buildTestApp({ transcoderAvailable: false });
    const jar = await setupOperator(current.app);
    const { app, config } = current;

    const res = await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    expect(res.statusCode).toBe(503);
    // ADR-0007: the 503 carries the technical reason for the Operator.
    expect(res.json()).toMatchObject({
      error: 'transcoding_unavailable',
      detail: 'fake unavailable',
    });

    // No Video row and no Source written.
    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos).toHaveLength(0);
    expect(readdirSync(config.mediaDir)).toHaveLength(0);

    const status = await app.inject({ method: 'GET', url: '/api/status', cookies: jar });
    expect(status.json()).toMatchObject({
      transcoding: { available: false, version: null, error: 'fake unavailable' },
    });
  });

  it('requires an authenticated Operator for status', async () => {
    current = await buildTestApp();
    await current.app.inject({ method: 'POST', url: '/api/setup', payload: OPERATOR });

    const res = await current.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
  });
});
