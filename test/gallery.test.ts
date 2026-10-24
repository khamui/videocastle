import { afterEach, describe, expect, it } from 'vitest';
import { TranscodeError } from '../src/ports/transcoder';
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

function createFolder(app: TestApp['app'], jar: Record<string, string>, name: string) {
  return app.inject({ method: 'POST', url: '/api/folders', cookies: jar, payload: { name } });
}

/** Uploads a clip and drives the (auto) fake transcoder to Ready; returns its slug. */
async function uploadReady(app: TestApp, jar: Record<string, string>, title: string): Promise<string> {
  const res = await uploadVideo(app.app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
  await app.worker.idle();
  return res.json().video.slug as string;
}

function moveVideo(
  app: TestApp['app'],
  jar: Record<string, string>,
  slug: string,
  folderSlug: string | null,
) {
  return app.inject({
    method: 'POST',
    url: `/api/videos/${slug}/folder`,
    cookies: jar,
    payload: { folderSlug },
  });
}

describe('viewing a Folder as a gallery via /f/<slug>', () => {
  it('shows a tiled gallery of the Folder’s Ready Videos (no account needed)', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Trips')).json().folder;
    const beach = await uploadReady(app, app.jar, 'Beach');
    const hike = await uploadReady(app, app.jar, 'Hike');
    await moveVideo(app.app, app.jar, beach, folder.slug);
    await moveVideo(app.app, app.jar, hike, folder.slug);

    // No cookies: possession of the /f/<slug> link is the sole permission.
    const res = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder).toMatchObject({ slug: folder.slug, name: 'Trips' });
    const tiles = res.json().folder.videos as Array<{ slug: string; title: string; posterUrl: string }>;
    expect(tiles.map((t) => t.title).sort()).toEqual(['Beach', 'Hike']);
    const beachTile = tiles.find((t) => t.slug === beach)!;
    expect(beachTile).toMatchObject({
      posterUrl: `/api/watch/${beach}/poster.jpg`,
      protected: false,
    });
  });

  it('leaves a still-Processing Video out of the gallery (nothing to watch yet)', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // hold the upload in Processing, never completing
    const folder = (await createFolder(app, jar, 'Mixed')).json().folder;

    await uploadVideo(app, jar, {
      fields: { title: 'Still cooking' },
      file: { fieldname: 'file', filename: 'a.mp4', content: 'x' },
    });
    await waitFor(() => transcoder.requests.length === 1);
    await moveVideo(app, jar, 'slug-1', folder.slug);

    const res = await app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.videos).toEqual([]);
  });

  it('leaves a Failed Video out of the gallery', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;
    const folder = (await createFolder(app, jar, 'Mixed')).json().folder;

    await uploadVideo(app, jar, {
      fields: { title: 'Broke' },
      file: { fieldname: 'file', filename: 'b.mp4', content: 'x' },
    });
    await waitFor(() => transcoder.requests.length === 1);
    await transcoder.fail(new TranscodeError('encode_failed', 'boom'));
    await worker.idle();
    await moveVideo(app, jar, 'slug-1', folder.slug);

    const res = await app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().folder.videos).toEqual([]);
  });

  it('opens a tile at /f/<slug>/<vslug> and plays that Video', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Trips')).json().folder;
    const slug = await uploadReady(app, app.jar, 'Beach');
    await moveVideo(app.app, app.jar, slug, folder.slug);

    const res = await app.app.inject({
      method: 'GET',
      url: `/api/watch/folder/${folder.slug}/${slug}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().watch).toMatchObject({
      state: 'ready',
      title: 'Beach',
      playlistUrl: `/api/watch/${slug}/stream/index.m3u8`,
      posterUrl: `/api/watch/${slug}/poster.jpg`,
    });
  });

  it('refuses to open a Video that isn’t in the Folder (no cross-Folder probing)', async () => {
    const app = await signedIn();
    const trips = (await createFolder(app.app, app.jar, 'Trips')).json().folder;
    const other = (await createFolder(app.app, app.jar, 'Other')).json().folder;
    const inTrips = await uploadReady(app, app.jar, 'Beach');
    const atRoot = await uploadReady(app, app.jar, 'Loose');
    await moveVideo(app.app, app.jar, inTrips, trips.slug);

    // A Video that lives in a different Folder (here: the root / another Folder)
    // collapses to the one generic 404 when probed through this Folder's link.
    for (const vslug of [atRoot, inTrips]) {
      const url =
        vslug === inTrips
          ? `/api/watch/folder/${other.slug}/${inTrips}` // real Video, wrong Folder
          : `/api/watch/folder/${trips.slug}/${atRoot}`; // real Video, not filed here
      const res = await app.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('returns the generic 404 for an unknown Folder (gallery and in-Folder Video)', async () => {
    const app = await signedIn();
    const slug = await uploadReady(app, app.jar, 'Beach');

    const gallery = await app.app.inject({ method: 'GET', url: '/api/watch/folder/nope' });
    expect(gallery.statusCode).toBe(404);
    expect(gallery.json()).toEqual({ error: 'not_found' });

    const video = await app.app.inject({ method: 'GET', url: `/api/watch/folder/nope/${slug}` });
    expect(video.statusCode).toBe(404);
    expect(video.json()).toEqual({ error: 'not_found' });
  });
});

describe('a direct /v/<slug> link never reveals its Folder or siblings', () => {
  it('shows only the Video — no Folder, no sibling slugs — even when it’s filed', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Confidential')).json().folder;
    const target = await uploadReady(app, app.jar, 'The one shared');
    const sibling = await uploadReady(app, app.jar, 'A secret sibling');
    await moveVideo(app.app, app.jar, target, folder.slug);
    await moveVideo(app.app, app.jar, sibling, folder.slug);

    const res = await app.app.inject({ method: 'GET', url: `/api/watch/${target}` });
    expect(res.statusCode).toBe(200);
    // The watch view carries nothing about the owning Folder or its siblings.
    expect(res.body).not.toContain(folder.slug);
    expect(res.body).not.toContain(sibling);
    expect(res.body).not.toContain('A secret sibling');
    expect(res.json().watch).not.toHaveProperty('folderSlug');
  });
});

describe('a Video with its own password inside an unprotected Folder', () => {
  it('seals its tile poster but cascades open from the Folder; its /v/ link still prompts', async () => {
    const app = await signedIn();
    const folder = (await createFolder(app.app, app.jar, 'Trips')).json().folder;
    const slug = await uploadReady(app, app.jar, 'Locked clip');
    await moveVideo(app.app, app.jar, slug, folder.slug);
    await app.app.inject({
      method: 'POST',
      url: `/api/videos/${slug}/password`,
      cookies: app.jar,
      payload: { password: 'open sesame' },
    });

    // In the gallery the tile still appears (it's Ready) but exposes no poster —
    // a protected Video keeps its frame sealed until it is actually opened.
    const gallery = await app.app.inject({ method: 'GET', url: `/api/watch/folder/${folder.slug}` });
    expect(gallery.json().folder.videos).toEqual([
      expect.objectContaining({ slug, protected: true, posterUrl: null }),
    ]);

    // Opening it from within the (unprotected) Folder plays straight away — the
    // Folder's access cascades, so there is no second prompt (spec: story 37).
    const opened = await app.app.inject({
      method: 'GET',
      url: `/api/watch/folder/${folder.slug}/${slug}`,
    });
    expect(opened.json().watch).toMatchObject({ state: 'ready', title: 'Locked clip' });

    // …but the Video's own standalone link still enforces its password (story 39).
    const direct = await app.app.inject({ method: 'GET', url: `/api/watch/${slug}` });
    expect(direct.json().watch).toEqual({ state: 'protected' });
  });
});
