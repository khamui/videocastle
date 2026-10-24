import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  return { ...current, jar: await setupOperator(current.app) };
}

async function uploadReady(
  app: TestApp,
  jar: Record<string, string>,
): Promise<void> {
  await uploadVideo(app.app, jar, {
    fields: { title: 'My Interview' },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await app.worker.idle();
  const [id] = readdirSync(app.config.mediaDir);
  const dir = join(app.config.mediaDir, id!);
  mkdirSync(join(dir, 'rendition'), { recursive: true });
  writeFileSync(join(dir, 'rendition', 'index.m3u8'), '#EXTM3U\n');
  writeFileSync(join(dir, 'poster.jpg'), 'JPEG');
}

const HOUR = 60 * 60 * 1000;

async function setExpiry(
  app: TestApp['app'],
  jar: Record<string, string>,
  slug: string,
  expiresAt: number | null,
) {
  return app.inject({
    method: 'POST',
    url: `/api/videos/${slug}/expiry`,
    cookies: jar,
    payload: { expiresAt },
  });
}

describe('setting a Video expiry (Operator)', () => {
  it('sets, reflects, and clears an expiry in the Library', async () => {
    const { app, jar, clock } = await signedIn();
    await uploadReady(current!, jar);
    const when = clock.now() + HOUR;

    const set = await setExpiry(app, jar, 'slug-1', when);
    expect(set.statusCode).toBe(200);
    expect(set.json().video).toMatchObject({ expiresAt: when, expired: false });

    const clear = await setExpiry(app, jar, 'slug-1', null);
    expect(clear.statusCode).toBe(200);
    expect(clear.json().video).toMatchObject({ expiresAt: null, expired: false });
  });

  it('reports the Video Expired once the clock passes the expiry', async () => {
    const { app, jar, clock } = await signedIn();
    await uploadReady(current!, jar);
    await setExpiry(app, jar, 'slug-1', clock.now() + HOUR);

    clock.advance(2 * HOUR);

    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos[0]).toMatchObject({ expired: true });
  });

  it('rejects a non-numeric expiry with a technical 400', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const res = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/expiry',
      cookies: jar,
      payload: { expiresAt: 'soon' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_expiry' });
  });

  it('returns a technical 404 for an unknown slug and requires an Operator', async () => {
    const { app, jar } = await signedIn();

    const unknown = await setExpiry(app, jar, 'nope', Date.now());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'video_not_found' });

    const anon = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/expiry',
      payload: { expiresAt: null },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('watching an expiring Video (Viewer)', () => {
  it('plays before expiry, then returns the generic 404 once it passes', async () => {
    const { app, jar, clock } = await signedIn();
    await uploadReady(current!, jar);
    await setExpiry(app, jar, 'slug-1', clock.now() + HOUR);

    // Before expiry: the link resolves and plays.
    const before = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(before.statusCode).toBe(200);
    expect(before.json().watch).toMatchObject({ state: 'ready' });

    clock.advance(2 * HOUR);

    // An unknown slug's 404, for comparison.
    const unknown = await app.inject({ method: 'GET', url: '/api/watch/does-not-exist' });

    const after = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(after.statusCode).toBe(404);
    // Expired and unknown are byte-identical — no existence leak (ADR-0002).
    expect(after.json()).toEqual(unknown.json());
    expect(after.json()).toEqual({ error: 'not_found' });

    // The media is gone too.
    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
    const poster = await app.inject({ method: 'GET', url: '/api/watch/slug-1/poster.jpg' });
    expect(poster.statusCode).toBe(404);
  });

  it('works again once the Operator extends an expired link', async () => {
    const { app, jar, clock } = await signedIn();
    await uploadReady(current!, jar);
    await setExpiry(app, jar, 'slug-1', clock.now() + HOUR);
    clock.advance(2 * HOUR);

    // Expired.
    expect(
      (await app.inject({ method: 'GET', url: '/api/watch/slug-1' })).statusCode,
    ).toBe(404);

    // The Operator extends it into the future again.
    const extend = await setExpiry(app, jar, 'slug-1', clock.now() + HOUR);
    expect(extend.json().video).toMatchObject({ expired: false });

    const after = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(after.statusCode).toBe(200);
    expect(after.json().watch).toMatchObject({ state: 'ready' });
  });
});
