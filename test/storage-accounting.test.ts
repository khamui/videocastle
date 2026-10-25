import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runStorageReconcileCommand } from '../src/cli/storage-reconcile';
import { loadConfig } from '../src/config';
import { openDatabase, type DatabaseHandle } from '../src/db/client';
import { MediaStore } from '../src/media/media-store';
import { formatBytes, parseBytes } from '../src/system/bytes';
import { VideoRepo } from '../src/videos/video-repo';
import { buildTestApp, type TestApp } from './helpers';
import { OPERATOR, cookieJar, setupOperator, uploadVideo, waitFor } from './support';

/**
 * Storage accounting: what this instance holds, recorded as it is written and
 * summed on read. Nothing here enforces or displays a limit — this slice only
 * makes usage knowable, which is the prerequisite for capping it.
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
  current = await buildTestApp({ env });
  return { ...current, jar: await setupOperator(current.app) };
}

function upload(
  app: TestApp['app'],
  jar: Record<string, string>,
  title: string,
  bytes: number,
): Promise<{ statusCode: number; json: () => { video: { slug: string } } }> {
  return uploadVideo(app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'x'.repeat(bytes) },
  }) as never;
}

interface VideoStorage {
  sourceBytes: number;
  renditionBytes: number;
  posterBytes: number;
  totalBytes: number;
}

async function library(
  app: TestApp['app'],
  jar: Record<string, string>,
): Promise<Array<{ slug: string; state: string; storage: VideoStorage }>> {
  const res = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
  return res.json().videos;
}

async function instanceStorage(
  app: TestApp['app'],
  jar: Record<string, string>,
): Promise<VideoStorage> {
  const res = await app.inject({ method: 'GET', url: '/api/status', cookies: jar });
  return res.json().storage;
}

/**
 * Writes a plausible Rendition and Poster where the transcoder would have, so
 * completing the fake transcode has real bytes to measure.
 */
function writeRendition(
  outputDir: string,
  sizes: { playlist: number; segment: number; poster: number },
): void {
  mkdirSync(join(outputDir, 'rendition'), { recursive: true });
  writeFileSync(join(outputDir, 'rendition', 'index.m3u8'), 'x'.repeat(sizes.playlist));
  writeFileSync(join(outputDir, 'rendition', 'seg_000.ts'), 'x'.repeat(sizes.segment));
  writeFileSync(join(outputDir, 'poster.jpg'), 'x'.repeat(sizes.poster));
}

describe('size suffixes in the Host Configuration', () => {
  it('reads a bare byte count, so every value that worked before still does', () => {
    expect(parseBytes('2147483648')).toBe(2 * 1024 ** 3);
    expect(loadConfig({ MAX_UPLOAD_BYTES: '1073741824' }).maxUploadBytes).toBe(1024 ** 3);
  });

  it('keeps decimal and binary suffixes distinct', () => {
    expect(parseBytes('1GB')).toBe(1_000_000_000);
    expect(parseBytes('1GiB')).toBe(1_073_741_824);
    expect(parseBytes('500GB')).toBe(500_000_000_000);
    expect(parseBytes('50GiB')).toBe(50 * 1024 ** 3);
  });

  it('treats a bare letter as binary, as dd and free do', () => {
    expect(parseBytes('512M')).toBe(512 * 1024 ** 2);
    expect(parseBytes('2G')).toBe(2 * 1024 ** 3);
    expect(parseBytes('1K')).toBe(1024);
  });

  it('accepts fractions, lower case and surrounding space', () => {
    expect(parseBytes('1.5TB')).toBe(1_500_000_000_000);
    expect(parseBytes('  2gib ')).toBe(2 * 1024 ** 3);
    expect(parseBytes('100 MB')).toBe(100_000_000);
  });

  it('refuses what it cannot read rather than guessing', () => {
    for (const value of ['', 'lots', '-5', '-1GiB', 'GiB', '1XB', undefined]) {
      expect(parseBytes(value)).toBeUndefined();
    }
  });

  it('falls back to the default when MAX_UPLOAD_BYTES is junk', () => {
    expect(loadConfig({ MAX_UPLOAD_BYTES: 'big' }).maxUploadBytes).toBe(2 * 1024 ** 3);
    expect(loadConfig({ MAX_UPLOAD_BYTES: '4GiB' }).maxUploadBytes).toBe(4 * 1024 ** 3);
  });

  it('prints sizes an Operator can read', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GiB');
  });
});

describe('recording what a Video holds', () => {
  it('records the Source bytes as soon as the upload stream closes', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // still Processing: no Rendition exists yet

    await upload(app, jar, 'Interview', 4096);

    const [video] = await library(app, jar);
    expect(video!.state).toBe('processing');
    expect(video!.storage).toMatchObject({
      sourceBytes: 4096,
      renditionBytes: 0,
      posterBytes: 0,
      totalBytes: 4096,
    });
  });

  it('records the Rendition and Poster bytes when the transcode lands', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await upload(app, jar, 'Interview', 4096);
    await waitFor(() => transcoder.requests.length === 1);
    writeRendition(transcoder.requests[0]!.outputDir, {
      playlist: 100,
      segment: 900,
      poster: 50,
    });
    await transcoder.complete();
    await worker.idle();

    const [video] = await library(app, jar);
    expect(video!.state).toBe('ready');
    expect(video!.storage).toEqual({
      sourceBytes: 4096,
      renditionBytes: 1000,
      posterBytes: 50,
      totalBytes: 5146,
    });
  });

  it('counts a Failed Video’s retained Source — those are real bytes on a real disk', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await upload(app, jar, 'Broken', 2048);
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new Error('encode exploded'));
    await worker.idle();

    const [video] = await library(app, jar);
    expect(video!.state).toBe('failed');
    expect(video!.storage.sourceBytes).toBe(2048);
    expect(await instanceStorage(app, jar)).toMatchObject({ totalBytes: 2048 });
  });

  it('zeroes the Rendition figures on retry, since the old Rendition is deleted', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await upload(app, jar, 'Flaky', 1024);
    await waitFor(() => transcoder.requests.length === 1);
    writeRendition(transcoder.requests[0]!.outputDir, {
      playlist: 10,
      segment: 490,
      poster: 20,
    });
    await transcoder.fail(new Error('failed after writing a partial Rendition'));
    await worker.idle();

    const failed = (await library(app, jar))[0]!;
    const retry = await app.inject({
      method: 'POST',
      url: `/api/videos/${failed.slug}/retry`,
      cookies: jar,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().video.storage).toMatchObject({
      renditionBytes: 0,
      posterBytes: 0,
      sourceBytes: 1024,
    });

    await waitFor(() => transcoder.requests.length === 2);
    await transcoder.complete();
    await worker.idle();
  });
});

describe('what the instance holds', () => {
  it('sums every Video, and drops the bytes when one is deleted', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;

    await upload(app, jar, 'One', 1000);
    await upload(app, jar, 'Two', 2500);
    expect(await instanceStorage(app, jar)).toMatchObject({
      sourceBytes: 3500,
      totalBytes: 3500,
    });

    const videos = await library(app, jar);
    const victim = videos.find((v) => v.storage.sourceBytes === 2500)!;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/videos/${victim.slug}`,
      cookies: jar,
    });
    expect(res.statusCode).toBe(204);

    expect(await instanceStorage(app, jar)).toMatchObject({ totalBytes: 1000 });
  });

  it('drops the bytes of every Video purged with its Folder', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false;

    const folder = await app.inject({
      method: 'POST',
      url: '/api/folders',
      cookies: jar,
      payload: { name: 'Client review' },
    });
    const folderSlug = folder.json().folder.slug;

    await upload(app, jar, 'In folder', 1500);
    const [video] = await library(app, jar);
    const moved = await app.inject({
      method: 'POST',
      url: `/api/videos/${video!.slug}/folder`,
      cookies: jar,
      payload: { folderSlug },
    });
    expect(moved.json().video.folderSlug).toBe(folderSlug);
    expect(await instanceStorage(app, jar)).toMatchObject({ totalBytes: 1500 });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${folderSlug}?videos=delete`,
      cookies: jar,
    });
    expect(removed.statusCode).toBe(204);

    expect(await instanceStorage(app, jar)).toMatchObject({ totalBytes: 0 });
  });

  it('reports nothing held on a fresh instance', async () => {
    const { app, jar } = await signedIn();
    expect(await instanceStorage(app, jar)).toEqual({
      sourceBytes: 0,
      renditionBytes: 0,
      posterBytes: 0,
      totalBytes: 0,
    });
  });
});

/**
 * The backfill and `storage-reconcile` both need a file-backed database the CLI
 * can reopen, so these drive the real command through its argv/env entrypoint.
 */
interface Instance {
  dir: string;
  env: NodeJS.ProcessEnv;
  store: MediaStore;
  open(): DatabaseHandle;
}

function instance(): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'vc-storage-'));
  tempDirs.push(dir);
  const env = { DB_PATH: join(dir, 'db.sqlite'), MEDIA_DIR: join(dir, 'media') };
  return {
    dir,
    env,
    store: new MediaStore(env.MEDIA_DIR),
    open: () => openDatabase(env.DB_PATH),
  };
}

/** Creates a Video row with media on disk, as an earlier version would have. */
async function seedVideo(
  inst: Instance,
  input: { title: string; sourceBytes: number; record: boolean },
): Promise<number> {
  const handle = inst.open();
  try {
    const repo = new VideoRepo(handle.db);
    const video = await repo.create({
      slug: `slug-${input.title.toLowerCase()}`,
      title: input.title,
      description: null,
      createdAt: 1_700_000_000_000,
    });
    mkdirSync(inst.store.videoDir(video.id), { recursive: true });
    writeFileSync(inst.store.sourcePath(video.id), 'x'.repeat(input.sourceBytes));
    if (input.record) {
      await repo.setSourceBytes(video.id, input.sourceBytes);
    }
    return video.id;
  } finally {
    handle.close();
  }
}

function runReconcile(
  inst: Instance,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  return runStorageReconcileCommand(args, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: inst.env,
  }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

describe('storage-reconcile', () => {
  it('reports no drift and exits 0 on a consistent instance', async () => {
    const inst = instance();
    await seedVideo(inst, { title: 'Agreed', sourceBytes: 800, record: true });

    const { code, out } = await runReconcile(inst);

    expect(code).toBe(0);
    expect(out).toContain('videos checked: 1');
    expect(out).toContain('recorded sizes: all agree with disk');
    expect(out).toContain('orphaned media: none');
  });

  it('exits non-zero on drift and changes nothing without --apply', async () => {
    const inst = instance();
    // Recorded as zero while 800 bytes sit on disk — the shape of a crash
    // between writing media and recording it.
    const id = await seedVideo(inst, { title: 'Drifted', sourceBytes: 800, record: false });

    const dry = await runReconcile(inst);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('1 Video disagree');
    expect(dry.out).toContain('recorded: source=0');
    expect(dry.out).toContain('on disk:  source=800');
    expect(dry.out).toContain('delta:    +800 bytes');
    expect(dry.out).toContain('Run again with --apply');

    // Still untouched: a dry run is a read.
    const handle = inst.open();
    try {
      const video = await new VideoRepo(handle.db).findById(id);
      expect(video!.sourceBytes).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('writes the measured sizes under --apply, and then agrees', async () => {
    const inst = instance();
    await seedVideo(inst, { title: 'Drifted', sourceBytes: 800, record: false });

    const applied = await runReconcile(inst, ['--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('(corrected)');

    // The proof is the next run: a fresh read now finds nothing to report.
    const after = await runReconcile(inst);
    expect(after.code).toBe(0);
    expect(after.out).toContain('recorded sizes: all agree with disk');
  });

  it('calls out a Video whose media is gone, rather than only mis-counted', async () => {
    const inst = instance();
    const id = await seedVideo(inst, { title: 'Vanished', sourceBytes: 900, record: true });
    rmSync(inst.store.videoDir(id), { recursive: true, force: true });

    const dry = await runReconcile(inst);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain('its media is gone');

    // Correcting the figures doesn't make the Video playable, so it still reports.
    const applied = await runReconcile(inst, ['--apply']);
    expect(applied.code).toBe(1);
    expect(applied.out).toContain('its media is gone');
  });

  it('reports orphaned media and leaves it on disk in both modes (ADR-0011)', async () => {
    const inst = instance();
    await seedVideo(inst, { title: 'Kept', sourceBytes: 100, record: true });

    // A directory with no Video behind it: the residue of a crash mid-delete.
    const orphan = join(inst.env.MEDIA_DIR!, '9999');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'source'), 'x'.repeat(2048));

    for (const args of [[], ['--apply']]) {
      const { code, out } = await runReconcile(inst, args);
      expect(code).toBe(1);
      expect(out).toContain('orphaned media: 1 entry with no Video, 2048 bytes');
      expect(out).toContain(orphan);
      expect(out).toContain('this command never deletes media');
      expect(out).toContain(`rm -rf '${orphan}'`);
      expect(existsSync(join(orphan, 'source'))).toBe(true);
    }
  });

  it('reports an entry whose name is not a Video id at all', async () => {
    const inst = instance();
    await seedVideo(inst, { title: 'Kept', sourceBytes: 100, record: true });
    const stray = join(inst.env.MEDIA_DIR!, 'tmp-upload-junk');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'blob'), 'x'.repeat(10));

    const { code, out } = await runReconcile(inst);
    expect(code).toBe(1);
    expect(out).toContain('tmp-upload-junk');
  });

  it('refuses an argument it does not understand instead of guessing', async () => {
    const inst = instance();
    const { code, err } = await runReconcile(inst, ['--delete-orphans']);
    expect(code).toBe(2);
    expect(err).toContain('Unrecognised argument: --delete-orphans');
  });
});

describe('upgrading an instance that predates storage accounting', () => {
  it('fills in the figures from one storage-reconcile --apply, and the server then reports them', async () => {
    const inst = instance();
    // Rows with media on disk but no recorded sizes — what an instance that
    // ran a version before these columns existed looks like after upgrading.
    // There is no boot-time backfill: this is the documented upgrade step, so
    // re-measuring is only ever something the Operator asked for.
    await seedVideo(inst, { title: 'Old one', sourceBytes: 1200, record: false });
    await seedVideo(inst, { title: 'Old two', sourceBytes: 3400, record: false });

    const before = inst.open();
    const stale = await buildTestApp({ db: before, env: inst.env });
    const staleJar = await setupOperator(stale.app);
    // Until it is run, the instance honestly reports nothing recorded.
    expect(await instanceStorage(stale.app, staleJar)).toMatchObject({ totalBytes: 0 });
    expect(await library(stale.app, staleJar)).toHaveLength(2);
    await stale.close();
    before.close();

    const { code } = await runReconcile(inst, ['--apply']);
    expect(code).toBe(0);

    const after = inst.open();
    current = await buildTestApp({ db: after, env: inst.env });
    // Same persisted data, so the Operator already exists: sign in rather than
    // set up.
    const signIn = await current.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: OPERATOR,
    });
    expect(signIn.statusCode).toBe(200);
    const jar = cookieJar(signIn);
    expect(await instanceStorage(current.app, jar)).toMatchObject({
      sourceBytes: 4600,
      totalBytes: 4600,
    });

    await current.close();
    current = undefined;
    after.close();
  });
});
