import { readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTestApp, type TestApp } from './helpers';
import { multipart, setupOperator, uploadVideo, waitFor } from './support';

/**
 * The two ceilings a server's owner can put on this instance. Reaching one
 * refuses writes — uploads and transcode retries — and nothing else: no media
 * is deleted, and playback of what is already stored is never gated (ADR-0011).
 *
 * `MIN_FREE_DISK_BYTES: '0'` throughout unless a test is about the disk floor,
 * so the quota behaviour under test doesn't depend on how full the machine
 * running the suite happens to be.
 */

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(
  env: NodeJS.ProcessEnv,
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

/** The same upload, streamed so no Content-Length reaches the server. */
function uploadChunked(
  app: TestApp['app'],
  jar: Record<string, string>,
  title: string,
  bytes: number,
) {
  const { payload, headers } = multipart({
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'x'.repeat(bytes) },
  });
  return app.inject({
    method: 'POST',
    url: '/api/videos',
    cookies: jar,
    headers,
    payload: Readable.from(payload),
  });
}

function mediaDirCount(mediaDir: string): number {
  return readdirSync(mediaDir).length;
}

async function usedBytes(
  app: TestApp['app'],
  jar: Record<string, string>,
): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/api/status', cookies: jar });
  return res.json().storage.totalBytes;
}

describe('the ceilings as configuration', () => {
  it('leaves the Quota unset by default — a fresh install has not asked for one', () => {
    expect(loadConfig({}).storageQuotaBytes).toBeUndefined();
  });

  it('keeps the free-disk floor on by default, at 1 GiB', () => {
    // On by default because a filesystem with no room left can wedge or
    // corrupt SQLite: a correctness risk, not a capacity preference.
    expect(loadConfig({}).minFreeDiskBytes).toBe(1024 ** 3);
  });

  it('reads both with size suffixes', () => {
    expect(loadConfig({ STORAGE_QUOTA_BYTES: '500GB' }).storageQuotaBytes).toBe(
      500_000_000_000,
    );
    expect(loadConfig({ STORAGE_QUOTA_BYTES: '50GiB' }).storageQuotaBytes).toBe(
      50 * 1024 ** 3,
    );
    expect(loadConfig({ MIN_FREE_DISK_BYTES: '2GiB' }).minFreeDiskBytes).toBe(
      2 * 1024 ** 3,
    );
  });

  it('treats a junk Quota as unset and a junk floor as the default', () => {
    expect(loadConfig({ STORAGE_QUOTA_BYTES: 'heaps' }).storageQuotaBytes).toBeUndefined();
    expect(loadConfig({ MIN_FREE_DISK_BYTES: 'heaps' }).minFreeDiskBytes).toBe(1024 ** 3);
  });
});

describe('with no Quota set', () => {
  it('accepts uploads exactly as before', async () => {
    const { app, jar } = await signedIn({});
    const res = await upload(app, jar, 'Unlimited', 4096);
    expect(res.statusCode).toBe(201);
    expect(await usedBytes(app, jar)).toBe(4096);
  });
});

describe('the Quota', () => {
  it('accepts an upload that fits', async () => {
    const { app, jar } = await signedIn({ STORAGE_QUOTA_BYTES: '100000' });
    const res = await upload(app, jar, 'Fits', 4096);
    expect(res.statusCode).toBe(201);
  });

  it('refuses an upload that would cross it, up front, with 507', async () => {
    const { app, jar, config } = await signedIn({ STORAGE_QUOTA_BYTES: '5000' });
    await upload(app, jar, 'First', 4000);

    const res = await upload(app, jar, 'Second', 4000);

    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('quota_exceeded');
    // ADR-0007: the real figures, not a genericised message.
    expect(res.json().detail).toContain('holds 4000 of its 5000-byte');
    expect(res.json().detail).toContain('STORAGE_QUOTA_BYTES');
    expect(res.json().detail).toContain('Nothing was deleted');

    // Nothing written, and the Video that did fit is untouched.
    expect(mediaDirCount(config.mediaDir)).toBe(1);
    expect(await usedBytes(app, jar)).toBe(4000);
  });

  it('refuses mid-stream when the client sends no Content-Length', async () => {
    const { app, jar, config } = await signedIn({ STORAGE_QUOTA_BYTES: '5000' });
    await upload(app, jar, 'First', 4000);

    const res = await uploadChunked(app, jar, 'Second', 4000);

    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('quota_exceeded');
    // The partial Source and its row were rolled back: no debris.
    expect(mediaDirCount(config.mediaDir)).toBe(1);
    const videos = (
      await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })
    ).json().videos;
    expect(videos).toHaveLength(1);
    expect(await usedBytes(app, jar)).toBe(4000);
  });

  it('refuses a transcode Retry when there is no room left', async () => {
    const { app, jar, transcoder, worker } = await signedIn({
      STORAGE_QUOTA_BYTES: '4000',
    });
    transcoder.auto = false;

    // Streamed, so only the Source's own bytes are weighed against the ceiling
    // — the Content-Length path counts the whole multipart body, which could
    // never fit a Quota set to exactly the file size.
    await uploadChunked(app, jar, 'Doomed', 4000);
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new Error('encode failed'));
    await worker.idle();

    const [video] = (
      await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })
    ).json().videos;
    expect(video.state).toBe('failed');

    // A Retry writes a fresh Rendition — the same new bytes an upload would be.
    const res = await app.inject({
      method: 'POST',
      url: `/api/videos/${video.slug}/retry`,
      cookies: jar,
    });
    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('quota_exceeded');
  });

  it('allows a Retry while there is still room', async () => {
    const { app, jar, transcoder, worker } = await signedIn({
      STORAGE_QUOTA_BYTES: '100000',
    });
    transcoder.auto = false;

    await upload(app, jar, 'Retryable', 1000);
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new Error('encode failed'));
    await worker.idle();

    const [video] = (
      await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })
    ).json().videos;
    const res = await app.inject({
      method: 'POST',
      url: `/api/videos/${video.slug}/retry`,
      cookies: jar,
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => transcoder.requests.length === 2);
    await transcoder.complete();
    await worker.idle();
  });

  it('lets a transcode already in flight finish', async () => {
    const { app, jar, transcoder, worker } = await signedIn({
      STORAGE_QUOTA_BYTES: '4500',
    });
    transcoder.auto = false;

    await upload(app, jar, 'In flight', 4000);
    await waitFor(() => transcoder.requests.length === 1);

    // The ceiling is now effectively reached, and a new upload is refused …
    expect((await upload(app, jar, 'Next', 4000)).statusCode).toBe(507);

    // … but the running transcode is never interrupted to save space.
    await transcoder.complete();
    await worker.idle();
    const [video] = (
      await app.inject({ method: 'GET', url: '/api/videos', cookies: jar })
    ).json().videos;
    expect(video.state).toBe('ready');
  });
});

describe('over the Quota', () => {
  it('reports the real figure instead of clamping, and deletes nothing', async () => {
    // Uploaded under a generous ceiling, then the Operator lowers it — the
    // shape of "I need this box back" (ADR-0011).
    const roomy = await signedIn({ STORAGE_QUOTA_BYTES: '100000' });
    await upload(roomy.app, roomy.jar, 'Already here', 8000);
    expect(await usedBytes(roomy.app, roomy.jar)).toBe(8000);
    const db = roomy.db;
    const mediaDir = roomy.config.mediaDir;
    await roomy.app.close();

    // Same data, a Quota now well below what is held.
    const tight = await buildTestApp({
      db,
      env: { MIN_FREE_DISK_BYTES: '0', STORAGE_QUOTA_BYTES: '1000', MEDIA_DIR: mediaDir },
    });
    current = tight;
    const signIn = await tight.app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { username: 'operator', password: 'correct horse battery' },
    });
    const jar = Object.fromEntries(signIn.cookies.map((c) => [c.name, c.value]));

    // Nothing was removed, and the figure is the truth — 800% of the ceiling.
    expect(await usedBytes(tight.app, jar)).toBe(8000);
    expect(mediaDirCount(mediaDir)).toBe(1);

    // Writes refuse …
    expect((await upload(tight.app, jar, 'No chance', 10)).statusCode).toBe(507);

    // … and the Video that is already there still plays: storage pressure
    // never reaches the Viewer (ADR-0011).
    const [video] = (
      await tight.app.inject({ method: 'GET', url: '/api/videos', cookies: jar })
    ).json().videos;
    const watch = await tight.app.inject({
      method: 'GET',
      url: `/api/watch/${video.slug}`,
    });
    expect(watch.statusCode).toBe(200);
    const stream = await tight.app.inject({
      method: 'GET',
      url: `/api/watch/${video.slug}/stream/index.m3u8`,
    });
    expect(stream.statusCode).not.toBe(507);
  });
});

describe('the free-disk floor', () => {
  it('refuses writes independently of the Quota', async () => {
    // A floor no real filesystem can satisfy, and no Quota at all: the floor
    // alone must be able to refuse.
    const { app, jar, config } = await buildTestApp({
      env: { MIN_FREE_DISK_BYTES: '1PiB' },
    }).then(async (testApp) => {
      current = testApp;
      return { ...testApp, jar: await setupOperator(testApp.app) };
    });

    const res = await upload(app, jar, 'No room', 100);

    expect(res.statusCode).toBe(507);
    expect(res.json().error).toBe('disk_floor_reached');
    expect(res.json().detail).toContain('MIN_FREE_DISK_BYTES');
    expect(res.json().detail).toContain('bytes free');
    expect(mediaDirCount(config.mediaDir)).toBe(0);
  });

  it('does not refuse when the floor is satisfied', async () => {
    const { app, jar } = await signedIn({ MIN_FREE_DISK_BYTES: '1' });
    expect((await upload(app, jar, 'Fine', 100)).statusCode).toBe(201);
  });
});
