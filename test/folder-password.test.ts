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

function createFolder(app: TestApp['app'], jar: Record<string, string>, name: string) {
  return app.inject({ method: 'POST', url: '/api/folders', cookies: jar, payload: { name } });
}

/** Uploads a clip, drives the fake transcoder to Ready, and returns its slug. */
async function uploadReady(app: TestApp, jar: Record<string, string>, title: string): Promise<string> {
  const res = await uploadVideo(app.app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await app.worker.idle();
  return res.json().video.slug as string;
}

function moveVideo(app: TestApp['app'], jar: Record<string, string>, slug: string, folderSlug: string | null) {
  return app.inject({
    method: 'POST',
    url: `/api/videos/${slug}/folder`,
    cookies: jar,
    payload: { folderSlug },
  });
}

/** Writes the Rendition + Poster the real transcoder would have produced for the only Video. */
function writeRendition(mediaDir: string): void {
  const [id] = readdirSync(mediaDir);
  const dir = join(mediaDir, id!);
  mkdirSync(join(dir, 'rendition'), { recursive: true });
  writeFileSync(join(dir, 'rendition', 'index.m3u8'), '#EXTM3U\nseg_000.ts\n');
  writeFileSync(join(dir, 'rendition', 'seg_000.ts'), 'TS');
  writeFileSync(join(dir, 'poster.jpg'), 'JPEG');
}

describe('setting a Folder password and expiry (Operator)', () => {
  it('protects and re-opens a Folder, reflecting it in the Library view', async () => {
    const { app, jar } = await signedIn();
    const folder = (await createFolder(app, jar, 'Trips')).json().folder;
    expect(folder).toMatchObject({ protected: false, expiresAt: null, expired: false });

    const set = await app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/password`,
      cookies: jar,
      payload: { password: 'open sesame' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().folder).toMatchObject({ protected: true });
    // The hash never leaks to the Operator surface.
    expect(set.body).not.toContain('open sesame');

    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/folders/${folder.slug}/password`,
      cookies: jar,
    });
    expect(cleared.json().folder).toMatchObject({ protected: false });
  });

  it('rejects a blank Folder password and an unknown Folder (technical errors)', async () => {
    const { app, jar } = await signedIn();
    const folder = (await createFolder(app, jar, 'Trips')).json().folder;

    const blank = await app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/password`,
      cookies: jar,
      payload: { password: '   ' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ error: 'missing_password' });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/folders/nope/password',
      cookies: jar,
      payload: { password: 'x' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'folder_not_found' });
  });

  it('requires an authenticated Operator for the Folder password/expiry routes', async () => {
    const { app, jar } = await signedIn();
    const folder = (await createFolder(app, jar, 'Trips')).json().folder;
    for (const call of [
      app.inject({ method: 'POST', url: `/api/folders/${folder.slug}/password`, payload: { password: 'x' } }),
      app.inject({ method: 'DELETE', url: `/api/folders/${folder.slug}/password` }),
      app.inject({ method: 'POST', url: `/api/folders/${folder.slug}/expiry`, payload: { expiresAt: null } }),
    ]) {
      expect((await call).statusCode).toBe(401);
    }
  });
});

describe('a protected Folder prompts once, then its Videos cascade open', () => {
  it('gates the gallery, unlocks with the password, and plays Videos without a second prompt', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Private trip')).json().folder;
    const slug = await uploadReady(app, app.jar, 'Beach');
    writeRendition(app.config.mediaDir);
    await moveVideo(app.app, app.jar, slug, folder.slug);
    // Protect the Folder *and* give the Video its own password — the cascade must
    // play it from within the Folder with neither prompted a second time.
    await app.app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/password`,
      cookies: app.jar,
      payload: { password: 'folder secret' },
    });
    await app.app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/password`,
      cookies: app.jar,
      payload: { password: 'video secret' },
    });

    // Locked: the gallery reveals nothing but that it needs a password…
    const locked = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(locked.json().folder).toEqual({ protected: true });
    // …and opening a Video asks for the *Folder* password, not the Video's.
    const lockedVideo = await app.app.inject({
      method: 'GET',
      url: `/api/watch/folder/${folder.slug}/${slug}`,
    });
    expect(lockedVideo.json().watch).toEqual({ state: 'protected' });

    // Wrong password stays opaque.
    const wrong = await app.app.inject({
      method: 'POST',
      url: `/api/watch/folder/${folder.slug}/unlock`,
      payload: { password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    // Correct password unlocks the Folder and returns the open gallery.
    const unlock = await app.app.inject({
      method: 'POST',
      url: `/api/watch/folder/${folder.slug}/unlock`,
      payload: { password: 'folder secret' },
    });
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().folder).toMatchObject({ protected: false, name: 'Private trip' });
    const folderJar = cookieJar(unlock);

    // With the Folder grant, the gallery lists its Videos…
    const open = await app.app.inject({
      method: 'GET',
      url: `/api/watch/folder/${folder.slug}`,
      cookies: folderJar,
    });
    expect(open.json().folder.videos.map((v: { slug: string }) => v.slug)).toEqual([slug]);

    // …and opening the Video cascades: it plays, with no Video-password prompt,
    // and mints the Video's own grant so its media serves.
    const played = await app.app.inject({
      method: 'GET',
      url: `/api/watch/folder/${folder.slug}/${slug}`,
      cookies: folderJar,
    });
    expect(played.json().watch).toMatchObject({ state: 'ready', title: 'Beach' });
    const playedJar = { ...folderJar, ...cookieJar(played) };

    const stream = await app.app.inject({
      method: 'GET',
      url: `/api/watch/${slug}/stream/index.m3u8`,
      cookies: playedJar,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('seg_000.ts');
  });

  it('still enforces the Video’s own password on its standalone /v/ link (independent)', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Private trip')).json().folder;
    const slug = await uploadReady(app, app.jar, 'Beach');
    await moveVideo(app.app, app.jar, slug, folder.slug);
    await app.app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/password`,
      cookies: app.jar,
      payload: { password: 'folder secret' },
    });
    await app.app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/password`,
      cookies: app.jar,
      payload: { password: 'video secret' },
    });

    // Unlock the Folder (grant cookie in hand)…
    const unlock = await app.app.inject({
      method: 'POST',
      url: `/api/watch/folder/${folder.slug}/unlock`,
      payload: { password: 'folder secret' },
    });
    const folderJar = cookieJar(unlock);

    // …yet the direct /v/<slug> link ignores the Folder grant entirely: it still
    // demands the Video's own password (spec: story 39, independent protection).
    const direct = await app.app.inject({
      method: 'GET',
      url: `/api/watch/${slug}`,
      cookies: folderJar,
    });
    expect(direct.json().watch).toEqual({ state: 'protected' });
  });

  it('an unlock grant for one Folder does not open another', async () => {
    const app = await signedIn();
    const a = (await createFolder(app.app, app.jar, 'A')).json().folder;
    const b = (await createFolder(app.app, app.jar, 'B')).json().folder;
    for (const f of [a, b]) {
      await app.app.inject({
        method: 'POST',
        url: `/api/folders/${f.slug}/password`,
        cookies: app.jar,
        payload: { password: `${f.slug} secret` },
      });
    }

    const unlockA = await app.app.inject({
      method: 'POST',
      url: `/api/watch/folder/${a.slug}/unlock`,
      payload: { password: `${a.slug} secret` },
    });
    const jarA = cookieJar(unlockA);

    // The grant for A must not unlock B.
    const b2 = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${b.slug}`, cookies: jarA });
    expect(b2.json().folder).toEqual({ protected: true });
  });
});

describe('an expired Folder returns the generic 404', () => {
  it('hides an expired gallery from Viewers but keeps it manageable for the Operator', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Trips')).json().folder;
    const slug = await uploadReady(app, app.jar, 'Beach');
    await moveVideo(app.app, app.jar, slug, folder.slug);

    // Expire the gallery one minute in the past.
    await app.app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/expiry`,
      cookies: app.jar,
      payload: { expiresAt: app.clock.now() - 60_000 },
    });

    // Viewer surface: the gallery and its in-Folder Videos collapse to the 404.
    const gallery = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(gallery.statusCode).toBe(404);
    expect(gallery.json()).toEqual({ error: 'not_found' });
    const video = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}/${slug}` });
    expect(video.statusCode).toBe(404);
    // Unlocking an expired Folder is equally opaque.
    const unlock = await app.app.inject({ method: 'POST', url: `/api/watch/folder/${folder.slug}/unlock`, payload: { password: 'x' } });
    expect(unlock.statusCode).toBe(404);

    // Operator surface (ADR-0007): still listed, flagged expired, and re-enablable.
    const list = await app.app.inject({ method: 'GET', url: '/api/folders', cookies: app.jar });
    expect(list.json().folders[0]).toMatchObject({ slug: folder.slug, expired: true });

    await app.app.inject({
      method: 'POST',
      url: `/api/folders/${folder.slug}/expiry`,
      cookies: app.jar,
      payload: { expiresAt: app.clock.now() + 60_000 },
    });
    const revived = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(revived.statusCode).toBe(200);
    expect(revived.json().folder.videos.map((v: { slug: string }) => v.slug)).toEqual([slug]);
  });
});
