import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo, waitFor } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  return { ...current, jar: await setupOperator(current.app) };
}

/** Uploads a Video and drives it to Ready, faking the Rendition on disk. */
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

function setVideoDisabled(
  app: TestApp['app'],
  jar: Record<string, string>,
  slug: string,
  disabled: unknown,
) {
  return app.inject({
    method: 'POST',
    url: `/api/videos/${slug}/disabled`,
    cookies: jar,
    payload: { disabled },
  });
}

function setFolderDisabled(
  app: TestApp['app'],
  jar: Record<string, string>,
  slug: string,
  body: { disabled: unknown; cascade?: unknown },
) {
  return app.inject({
    method: 'POST',
    url: `/api/folders/${slug}/disabled`,
    cookies: jar,
    payload: body,
  });
}

async function createFolder(
  app: TestApp['app'],
  jar: Record<string, string>,
  name: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/folders',
    cookies: jar,
    payload: { name },
  });
  return res.json().folder.slug as string;
}

describe('disabling a Video Share Link (Operator)', () => {
  it('sets, reflects, and clears disabled in the Library and /api/links', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const off = await setVideoDisabled(app, jar, 'slug-1', true);
    expect(off.statusCode).toBe(200);
    expect(off.json().video).toMatchObject({ disabled: true });

    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos[0]).toMatchObject({ disabled: true });

    const links = await app.inject({ method: 'GET', url: '/api/links', cookies: jar });
    expect(links.json().videos[0]).toMatchObject({ slug: 'slug-1', disabled: true });

    const on = await setVideoDisabled(app, jar, 'slug-1', false);
    expect(on.json().video).toMatchObject({ disabled: false });
  });

  it('is allowed while a Video is still Processing', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // hold the transcode open so the Video stays Processing

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    const res = await setVideoDisabled(app, jar, 'slug-1', true);
    expect(res.statusCode).toBe(200);
    expect(res.json().video).toMatchObject({ state: 'processing', disabled: true });
  });

  it('is allowed on a Failed Video', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;
    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new Error('boom'));
    await worker.idle();

    const res = await setVideoDisabled(app, jar, 'slug-1', true);
    expect(res.statusCode).toBe(200);
    expect(res.json().video).toMatchObject({ state: 'failed', disabled: true });
  });

  it('rejects a non-boolean value with a technical 400 and requires an Operator', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const bad = await setVideoDisabled(app, jar, 'slug-1', 'yes');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_disabled' });

    const unknown = await setVideoDisabled(app, jar, 'nope', true);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: 'video_not_found' });

    const anon = await app.inject({
      method: 'POST',
      url: '/api/videos/slug-1/disabled',
      payload: { disabled: true },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('watching a disabled Video (Viewer)', () => {
  it('plays until disabled, then returns the generic 404 — byte-identical to unknown', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);

    const before = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(before.statusCode).toBe(200);
    expect(before.json().watch).toMatchObject({ state: 'ready' });

    await setVideoDisabled(app, jar, 'slug-1', true);

    const unknown = await app.inject({ method: 'GET', url: '/api/watch/does-not-exist' });
    const after = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(after.statusCode).toBe(404);
    // Disabled and unknown are indistinguishable — no existence leak (ADR-0002).
    expect(after.json()).toEqual(unknown.json());
    expect(after.json()).toEqual({ error: 'not_found' });

    // The media is sealed too.
    const playlist = await app.inject({
      method: 'GET',
      url: '/api/watch/slug-1/stream/index.m3u8',
    });
    expect(playlist.statusCode).toBe(404);
    const poster = await app.inject({ method: 'GET', url: '/api/watch/slug-1/poster.jpg' });
    expect(poster.statusCode).toBe(404);
  });

  it('works again once the Operator re-enables it', async () => {
    const { app, jar } = await signedIn();
    await uploadReady(current!, jar);
    await setVideoDisabled(app, jar, 'slug-1', true);

    expect(
      (await app.inject({ method: 'GET', url: '/api/watch/slug-1' })).statusCode,
    ).toBe(404);

    await setVideoDisabled(app, jar, 'slug-1', false);

    const after = await app.inject({ method: 'GET', url: '/api/watch/slug-1' });
    expect(after.statusCode).toBe(200);
    expect(after.json().watch).toMatchObject({ state: 'ready' });
  });
});

describe('disabling a Folder gallery (Operator)', () => {
  it('darkens only the gallery link by default, leaving member Videos playable', async () => {
    const { app, jar } = await signedIn();
    const folderSlug = await createFolder(app, jar, 'Team Reel');
    // Upload a Video straight into the Folder and drive it Ready.
    await uploadVideo(app, jar, {
      fields: { title: 'Inside', folderSlug },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await current!.worker.idle();
    const dir = join(current!.config.mediaDir, readdirSync(current!.config.mediaDir)[0]!);
    mkdirSync(join(dir, 'rendition'), { recursive: true });
    writeFileSync(join(dir, 'rendition', 'index.m3u8'), '#EXTM3U\n');
    writeFileSync(join(dir, 'poster.jpg'), 'JPEG');
    const videoSlug = 'slug-2'; // folder was slug-1, the video slug-2

    const res = await setFolderDisabled(app, jar, folderSlug, { disabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder).toMatchObject({ disabled: true });

    // The gallery link is gone for the Viewer…
    const gallery = await app.inject({ method: 'GET', url: `/api/watch/folder/${folderSlug}` });
    expect(gallery.statusCode).toBe(404);

    // …but the member Video's own /v/ link still plays (no cascade by default).
    const watch = await app.inject({ method: 'GET', url: `/api/watch/${videoSlug}` });
    expect(watch.statusCode).toBe(200);
    expect(watch.json().watch).toMatchObject({ state: 'ready' });

    const links = await app.inject({ method: 'GET', url: '/api/links', cookies: jar });
    expect(links.json().videos[0]).toMatchObject({ slug: videoSlug, disabled: false });
  });

  it('cascades to member Videos when cascade=true, but re-enable never cascades', async () => {
    const { app, jar } = await signedIn();
    const folderSlug = await createFolder(app, jar, 'Board Only');
    await uploadVideo(app, jar, {
      fields: { title: 'Inside', folderSlug },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await current!.worker.idle();
    const videoSlug = 'slug-2';

    const off = await setFolderDisabled(app, jar, folderSlug, {
      disabled: true,
      cascade: true,
    });
    expect(off.statusCode).toBe(200);

    // Both the gallery and the member Video's own link are now disabled.
    const links = await app.inject({ method: 'GET', url: '/api/links', cookies: jar });
    expect(links.json().folders[0]).toMatchObject({ slug: folderSlug, disabled: true });
    expect(links.json().videos[0]).toMatchObject({ slug: videoSlug, disabled: true });

    // Re-enabling the Folder restores only the gallery — the member Video stays
    // disabled (the cascade is a disable-time choice only, ADR-0014).
    const on = await setFolderDisabled(app, jar, folderSlug, {
      disabled: false,
      cascade: true,
    });
    expect(on.json().folder).toMatchObject({ disabled: false });
    const after = await app.inject({ method: 'GET', url: '/api/links', cookies: jar });
    expect(after.json().folders[0]).toMatchObject({ disabled: false });
    expect(after.json().videos[0]).toMatchObject({ slug: videoSlug, disabled: true });
  });

  it('rejects a non-boolean cascade with a technical 400', async () => {
    const { app, jar } = await signedIn();
    const folderSlug = await createFolder(app, jar, 'Reel');

    const res = await setFolderDisabled(app, jar, folderSlug, {
      disabled: true,
      cascade: 'yes',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_cascade' });
  });
});
