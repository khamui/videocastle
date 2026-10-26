import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReclaimSourcesCommand } from '../src/cli/reclaim-sources';
import { loadConfig } from '../src/config';
import { openDatabase, type DatabaseHandle } from '../src/db/client';
import { MediaStore } from '../src/media/media-store';
import { VideoRepo } from '../src/videos/video-repo';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo, waitFor } from './support';

/**
 * Optional Source discard (ADR-0010). Keeping the Source is the default and
 * stays the default; giving it up is a trade an Operator makes deliberately,
 * and the choice never reaches backwards to originals they already hold.
 */

let current: TestApp | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function signedIn(
  env: NodeJS.ProcessEnv = {},
): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp({ env: { MIN_FREE_DISK_BYTES: '0', ...env } });
  return { ...current, jar: await setupOperator(current.app) };
}

function upload(
  app: TestApp['app'],
  jar: Record<string, string>,
  title: string,
  bytes: number,
) {
  return uploadVideo(app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'x'.repeat(bytes) },
  });
}

function writeRendition(outputDir: string): void {
  mkdirSync(join(outputDir, 'rendition'), { recursive: true });
  writeFileSync(join(outputDir, 'rendition', 'seg_000.ts'), 'x'.repeat(500));
  writeFileSync(join(outputDir, 'poster.jpg'), 'x'.repeat(20));
}

/** Uploads a Video and drives it to Ready with a real Rendition on disk. */
async function uploadAndTranscode(
  testApp: TestApp,
  jar: Record<string, string>,
  title: string,
  bytes: number,
): Promise<void> {
  const { app, transcoder, worker } = testApp;
  const before = transcoder.requests.length;
  await upload(app, jar, title, bytes);
  await waitFor(() => transcoder.requests.length === before + 1);
  writeRendition(transcoder.requests[before]!.outputDir);
  await transcoder.complete();
  await worker.idle();
}

async function library(app: TestApp['app'], jar: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
  return res.json().videos as Array<{
    slug: string;
    state: string;
    storage: { sourceBytes: number; totalBytes: number; sourceDiscardedAt: number | null };
  }>;
}

describe('KEEP_SOURCE_AFTER_TRANSCODE', () => {
  it('keeps the Source by default', () => {
    expect(loadConfig({}).keepSourceAfterTranscode).toBe(true);
  });

  it('is turned off only by the exact string "false"', () => {
    expect(loadConfig({ KEEP_SOURCE_AFTER_TRANSCODE: 'false' }).keepSourceAfterTranscode).toBe(false);
    // Anything else keeps the Source: a typo must err towards holding on to
    // the Operator's originals, never towards destroying them.
    for (const value of ['no', '0', 'FALSE', 'off', '', 'true']) {
      expect(
        loadConfig({ KEEP_SOURCE_AFTER_TRANSCODE: value }).keepSourceAfterTranscode,
      ).toBe(true);
    }
  });

  it('keeps the Source after a successful transcode by default', async () => {
    const testApp = await signedIn();
    testApp.transcoder.auto = false;
    await uploadAndTranscode(testApp, testApp.jar, 'Kept', 4000);

    const [video] = await library(testApp.app, testApp.jar);
    expect(video!.state).toBe('ready');
    expect(video!.storage.sourceBytes).toBe(4000);
    expect(video!.storage.sourceDiscardedAt).toBeNull();
  });

  it('discards the Source once the Video is Ready when turned off', async () => {
    const testApp = await signedIn({ KEEP_SOURCE_AFTER_TRANSCODE: 'false' });
    testApp.transcoder.auto = false;
    await uploadAndTranscode(testApp, testApp.jar, 'Reclaimed', 4000);

    const [video] = await library(testApp.app, testApp.jar);
    expect(video!.state).toBe('ready');
    expect(video!.storage.sourceBytes).toBe(0);
    expect(video!.storage.sourceDiscardedAt).not.toBeNull();
    // The Rendition and Poster — the parts that make it playable — stay.
    expect(video!.storage.totalBytes).toBe(520);

    const store = new MediaStore(testApp.config.mediaDir);
    expect(existsSync(store.sourcePath(1))).toBe(false);
    expect(existsSync(store.playlistPath(1).replace('index.m3u8', 'seg_000.ts'))).toBe(true);
  });

  it('keeps a Failed Video’s Source even when turned off', async () => {
    // A Failed Video never reaches Ready, so the discard never runs — its
    // Source is the only route back from a failed transcode.
    const testApp = await signedIn({ KEEP_SOURCE_AFTER_TRANSCODE: 'false' });
    testApp.transcoder.auto = false;

    await upload(testApp.app, testApp.jar, 'Broken', 3000);
    await waitFor(() => testApp.transcoder.requests.length === 1);
    await testApp.transcoder.fail(new Error('encode exploded'));
    await testApp.worker.idle();

    const [video] = await library(testApp.app, testApp.jar);
    expect(video!.state).toBe('failed');
    expect(video!.storage.sourceBytes).toBe(3000);
    expect(video!.storage.sourceDiscardedAt).toBeNull();
  });

  it('leaves a discarded Video playable', async () => {
    const testApp = await signedIn({ KEEP_SOURCE_AFTER_TRANSCODE: 'false' });
    testApp.transcoder.auto = false;
    await uploadAndTranscode(testApp, testApp.jar, 'Still plays', 4000);

    const [video] = await library(testApp.app, testApp.jar);
    const watch = await testApp.app.inject({
      method: 'GET',
      url: `/api/watch/${video!.slug}`,
    });
    expect(watch.statusCode).toBe(200);
  });
});

describe('retrying a Video with no Source', () => {
  it('refuses with a stable reason, naming the discard', async () => {
    const testApp = await signedIn();
    testApp.transcoder.auto = false;

    // Reach Failed with a Source, then take the Source away as a reclaim run
    // would have — the state a Video is in when Retry must be refused.
    await upload(testApp.app, testApp.jar, 'Orphaned', 3000);
    await waitFor(() => testApp.transcoder.requests.length === 1);
    await testApp.transcoder.fail(new Error('encode exploded'));
    await testApp.worker.idle();

    const store = new MediaStore(testApp.config.mediaDir);
    await store.removeSource(1);
    await new VideoRepo(testApp.db.db).discardSource(1, 1_700_000_000_000);

    const [video] = await library(testApp.app, testApp.jar);
    const res = await testApp.app.inject({
      method: 'POST',
      url: `/api/videos/${video!.slug}/retry`,
      cookies: testApp.jar,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('source_unavailable');
    expect(res.json().detail).toContain('was discarded on');
    expect(res.json().detail).toContain('re-upload the original');
  });

  it('distinguishes a Source that vanished from one that was discarded', async () => {
    const testApp = await signedIn();
    testApp.transcoder.auto = false;

    await upload(testApp.app, testApp.jar, 'Vanished', 3000);
    await waitFor(() => testApp.transcoder.requests.length === 1);
    await testApp.transcoder.fail(new Error('encode exploded'));
    await testApp.worker.idle();

    // Removed behind videocastle's back — no discard recorded.
    await new MediaStore(testApp.config.mediaDir).removeSource(1);

    const [video] = await library(testApp.app, testApp.jar);
    const res = await testApp.app.inject({
      method: 'POST',
      url: `/api/videos/${video!.slug}/retry`,
      cookies: testApp.jar,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('source_unavailable');
    // Different advice: this one is a problem, not an expected consequence.
    expect(res.json().detail).toContain('missing from disk');
    expect(res.json().detail).toContain('storage-reconcile');
  });
});

/** A file-backed instance the CLI can reopen. */
interface Instance {
  env: NodeJS.ProcessEnv;
  store: MediaStore;
  open(): DatabaseHandle;
}

function instance(): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'vc-reclaim-'));
  tempDirs.push(dir);
  const env = { DB_PATH: join(dir, 'db.sqlite'), MEDIA_DIR: join(dir, 'media') };
  return { env, store: new MediaStore(env.MEDIA_DIR), open: () => openDatabase(env.DB_PATH) };
}

async function seed(
  inst: Instance,
  input: { title: string; sourceBytes: number; state: 'ready' | 'failed' | 'processing' },
): Promise<number> {
  const handle = inst.open();
  try {
    const repo = new VideoRepo(handle.db);
    const video = await repo.create({
      slug: `slug-${input.title.toLowerCase().replace(/\W+/g, '-')}`,
      title: input.title,
      description: null,
      createdAt: 1_700_000_000_000,
    });
    mkdirSync(join(inst.store.renditionDir(video.id)), { recursive: true });
    writeFileSync(inst.store.sourcePath(video.id), 'x'.repeat(input.sourceBytes));
    await repo.setSourceBytes(video.id, input.sourceBytes);
    if (input.state === 'ready') {
      writeFileSync(join(inst.store.renditionDir(video.id), 'seg_000.ts'), 'x'.repeat(100));
      await repo.markReady(video.id, {
        playlistPath: 'rendition/index.m3u8',
        posterPath: 'poster.jpg',
        durationSeconds: 10,
        renditionBytes: 100,
        posterBytes: 0,
      });
    } else if (input.state === 'failed') {
      await repo.markFailed(video.id, { reason: 'encode_failed' });
    }
    return video.id;
  } finally {
    handle.close();
  }
}

function runReclaim(inst: Instance, args: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  return runReclaimSourcesCommand(args, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: inst.env,
  }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

describe('reclaim-sources', () => {
  it('reports what it would free and deletes nothing by default', async () => {
    const inst = instance();
    const id = await seed(inst, { title: 'Ready one', sourceBytes: 5000, state: 'ready' });

    const dry = await runReclaim(inst);

    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Would discard 1 Source, freeing 5000 bytes');
    expect(dry.out).toContain('Re-run with --apply');
    expect(dry.out).toContain('can never be re-transcoded');
    // Untouched: a dry run is a read.
    expect(existsSync(inst.store.sourcePath(id))).toBe(true);
  });

  it('discards under --apply, keeping the Rendition', async () => {
    const inst = instance();
    const id = await seed(inst, { title: 'Ready one', sourceBytes: 5000, state: 'ready' });

    const applied = await runReclaim(inst, ['--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('Discarded 1 Source, freeing 5000 bytes');

    expect(existsSync(inst.store.sourcePath(id))).toBe(false);
    expect(existsSync(join(inst.store.renditionDir(id), 'seg_000.ts'))).toBe(true);

    const handle = inst.open();
    try {
      const video = await new VideoRepo(handle.db).findById(id);
      expect(video!.sourceBytes).toBe(0);
      expect(video!.sourceDiscardedAt).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  it('never touches a Failed Video’s Source — it is the only way back', async () => {
    const inst = instance();
    const failed = await seed(inst, { title: 'Failed one', sourceBytes: 7000, state: 'failed' });

    const res = await runReclaim(inst, ['--apply']);

    expect(res.out).toContain('No Sources to reclaim.');
    expect(res.out).toContain('Skipped 1');
    expect(res.out).toContain('only way back');
    expect(existsSync(inst.store.sourcePath(failed))).toBe(true);
  });

  it('never touches a Video still transcoding', async () => {
    const inst = instance();
    const processing = await seed(inst, {
      title: 'In flight',
      sourceBytes: 6000,
      state: 'processing',
    });

    await runReclaim(inst, ['--apply']);
    expect(existsSync(inst.store.sourcePath(processing))).toBe(true);
  });

  it('reclaims only the Ready Videos in a mixed Library', async () => {
    const inst = instance();
    const ready = await seed(inst, { title: 'Ready one', sourceBytes: 5000, state: 'ready' });
    const alsoReady = await seed(inst, { title: 'Ready two', sourceBytes: 3000, state: 'ready' });
    const failed = await seed(inst, { title: 'Failed one', sourceBytes: 7000, state: 'failed' });

    const res = await runReclaim(inst, ['--apply']);

    expect(res.out).toContain('Discarded 2 Sources, freeing 8000 bytes');
    expect(existsSync(inst.store.sourcePath(ready))).toBe(false);
    expect(existsSync(inst.store.sourcePath(alsoReady))).toBe(false);
    expect(existsSync(inst.store.sourcePath(failed))).toBe(true);
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const inst = instance();
    await seed(inst, { title: 'Ready one', sourceBytes: 5000, state: 'ready' });
    await runReclaim(inst, ['--apply']);

    const again = await runReclaim(inst, ['--apply']);
    expect(again.out).toContain('No Sources to reclaim.');
    expect(again.out).toContain('Source already discarded');
  });

  it('leaves storage-reconcile with nothing to report afterwards', async () => {
    // The discard records the freed bytes, so the figures stay true.
    const inst = instance();
    await seed(inst, { title: 'Ready one', sourceBytes: 5000, state: 'ready' });
    await runReclaim(inst, ['--apply']);

    const { runStorageReconcileCommand } = await import('../src/cli/storage-reconcile');
    const out: string[] = [];
    const code = await runStorageReconcileCommand([], {
      out: (l) => out.push(l),
      err: () => undefined,
      env: inst.env,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('all agree with disk');
  });

  it('refuses an argument it does not understand', async () => {
    const inst = instance();
    const res = await runReclaim(inst, ['--force']);
    expect(res.code).toBe(2);
    expect(res.err).toContain('Unrecognised argument: --force');
  });
});
