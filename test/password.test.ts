import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';
import { cookieJar, setupOperator, uploadVideo } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  return { ...current, jar: await setupOperator(current.app) };
}

/** Uploads one clip and drives it to Ready, writing the Rendition files to serve. */
async function uploadReady(
  app: TestApp,
  jar: Record<string, string>,
): Promise<void> {
  await uploadVideo(app.app, jar, {
    fields: { title: 'My Interview', description: 'a chat' },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await app.worker.idle();
  const [id] = readdirSync(app.config.mediaDir);
  const dir = join(app.config.mediaDir, id!);
  mkdirSync(join(dir, 'rendition'), { recursive: true });
  writeFileSync(join(dir, 'rendition', 'index.m3u8'), '#EXTM3U\n');
  writeFileSync(join(dir, 'poster.jpg'), 'JPEG');
}

describe('setting a Video password (Operator)', () => {
  it('enables and disables a per-Video password, reflected in the Library', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const set = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/password',
      cookies: jar,
      payload: { password: 'open sesame' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().video).toMatchObject({ slug: 'slug-1', protected: true });

    const listed = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(listed.json().videos[0]).toMatchObject({ protected: true });
    // The hash is never exposed over the API.
    expect(listed.body).not.toContain('open sesame');
    expect(listed.body).not.toContain('scrypt');

    const clear = await app.inject({
      method: 'DELETE',
      url: '/api/videos/slug-1/password',
      cookies: jar,
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().video).toMatchObject({ protected: false });
  });

  it('rejects an empty password with a technical 400 (ADR-0007)', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const res = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/password',
      cookies: jar,
      payload: { password: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'missing_password' });
  });

  it('returns a technical 404 for an unknown slug', async () => {
    const { app, jar } = await signedIn();

    const res = await app.inject({
      method: 'POST',
      url: '/api/videos/does-not-exist/password',
      cookies: jar,
      payload: { password: 'x' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'video_not_found' });
    expect(res.json().detail).toContain('does-not-exist');
  });

  it('requires an authenticated Operator to set or clear a password', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const set = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/password',
      payload: { password: 'x' },
    });
    expect(set.statusCode).toBe(401);

    const clear = await app.inject({ method: 'DELETE', url: '/api/videos/slug-1/password' });
    expect(clear.statusCode).toBe(401);
  });
});

describe('watching a password-protected Video (Viewer)', () => {
  async function protect(
    app: TestApp,
    jar: Record<string, string>,
    password: string,
  ): Promise<void> {
    await uploadReady(app, jar);
    const res = await app.app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/password',
      cookies: jar,
      payload: { password },
    });
    expect(res.statusCode).toBe(200);
  }

  it('prompts before playback instead of revealing the Video', async () => {
    const { app, jar } = await signedIn();
    await protect(current!, jar, 'open sesame');

    const view = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(view.statusCode).toBe(200);
    expect(view.json().watch).toEqual({ state: 'protected' });
    // Nothing about the Video leaks before the password is given.
    expect(view.body).not.toContain('My Interview');
    expect(view.body).not.toContain('playlistUrl');

    // The media itself stays sealed without an unlock grant.
    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
    const poster = await app.inject({ method: 'GET', url: '/api/watch/slug-1/poster.jpg' });
    expect(poster.statusCode).toBe(404);
  });

  it('grants playback for the correct password and seals it for a wrong one', async () => {
    const { app, jar } = await signedIn();
    await protect(current!, jar, 'open sesame');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/watch/slug-1/unlock',
      payload: { password: 'guess' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'incorrect_password' });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/watch/slug-1/unlock',
      payload: { password: 'open sesame' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().watch).toMatchObject({
      state: 'ready',
      title: 'My Interview',
      playlistUrl: '/api/watch/slug-1/stream/index.m3u8',
    });

    // The unlock grant is a cookie; with it, the view and the media open up.
    const grant = cookieJar(ok);
    const view = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1',
      cookies: grant,
    });
    expect(view.json().watch).toMatchObject({ state: 'ready', title: 'My Interview' });

    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
      cookies: grant,
    });
    expect(playlist.statusCode).toBe(200);
  });

  it('returns the generic 404 when unlocking an unknown slug (no existence leak)', async () => {
    const { app } = await signedIn();

    const res = await app.inject({
      method: 'POST',
      url: '/api/watch/nope-nope/unlock',
      payload: { password: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('an unlock grant for one Video does not open another', async () => {
    const { app, jar } = await signedIn();
    await protect(current!, jar, 'first');
    // A second protected Video.
    await uploadVideo(app, jar, {
      fields: { title: 'Second' },
      file: { fieldname: 'file', filename: 'b.mp4', content: 'bytes' },
    });
    await current!.worker.idle();
    await app.inject({
      method: 'POST',
      url: '/api/videos/slug-2/password',
      cookies: jar,
      payload: { password: 'second' },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/watch/slug-1/unlock',
      payload: { password: 'first' },
    });
    const grant = cookieJar(ok);

    // The grant is slug-scoped: slug-2 is still sealed.
    const other = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-2',
      cookies: grant,
    });
    expect(other.json().watch).toEqual({ state: 'protected' });
  });
});
