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

function createFolder(
  app: TestApp['app'],
  jar: Record<string, string>,
  name: string,
) {
  return app.inject({ method: 'POST', url: '/api/folders', cookies: jar, payload: { name } });
}

async function upload(
  app: TestApp['app'],
  jar: Record<string, string>,
  title: string,
): Promise<string> {
  const res = await uploadVideo(app, jar, {
    fields: { title },
    file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
  });
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

describe('creating and listing Folders', () => {
  it('creates a Folder with a name and an unguessable /f/<slug> link', async () => {
    const { app, jar } = await signedIn();

    const res = await createFolder(app, jar, 'Trips');
    expect(res.statusCode).toBe(201);
    const folder = res.json().folder;
    expect(folder).toMatchObject({ name: 'Trips', videoCount: 0 });
    expect(folder.slug).toBeTruthy();
    expect(folder.shareUrl).toBe(`/f/${folder.slug}`);

    const list = await app.inject({ method: 'GET', url: '/api/folders', cookies: jar });
    expect(list.json().folders).toHaveLength(1);
    expect(list.json().folders[0]).toMatchObject({ slug: folder.slug, name: 'Trips' });
  });

  it('rejects a blank Folder name with a technical 400', async () => {
    const { app, jar } = await signedIn();
    const res = await createFolder(app, jar, '   ');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'missing_name' });
  });

  it('requires an authenticated Operator for Folder routes', async () => {
    const { app } = await signedIn();
    expect((await app.inject({ method: 'POST', url: '/api/folders', payload: { name: 'X' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/folders' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/folders/anything' })).statusCode).toBe(401);
  });

  it('shows root (unfiled) Videos as having no Folder', async () => {
    const { app, jar } = await signedIn();
    await upload(app, jar, 'Loose clip');

    const list = await app.inject({ method: 'GET', url: '/api/videos', cookies: jar });
    expect(list.json().videos[0]).toMatchObject({ folderSlug: null });
  });
});

describe('organizing Videos into Folders', () => {
  it('moves a Video into exactly one Folder and back to the Library root', async () => {
    const { app, jar } = await signedIn();
    const folder = (await createFolder(app, jar, 'Trips')).json().folder;
    const slug = await upload(app, jar, 'Beach');

    const moved = await moveVideo(app, jar, slug, folder.slug);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().video).toMatchObject({ slug, folderSlug: folder.slug });

    // The Folder now reports the membership…
    const folders = await app.inject({ method: 'GET', url: '/api/folders', cookies: jar });
    expect(folders.json().folders[0]).toMatchObject({ slug: folder.slug, videoCount: 1 });

    // …and back to the root clears it.
    const back = await moveVideo(app, jar, slug, null);
    expect(back.json().video).toMatchObject({ slug, folderSlug: null });
    const after = await app.inject({ method: 'GET', url: '/api/folders', cookies: jar });
    expect(after.json().folders[0]).toMatchObject({ videoCount: 0 });
  });

  it('moving into a second Folder leaves the Video in only that one', async () => {
    const { app, jar } = await signedIn();
    const a = (await createFolder(app, jar, 'A')).json().folder;
    const b = (await createFolder(app, jar, 'B')).json().folder;
    const slug = await upload(app, jar, 'Clip');

    await moveVideo(app, jar, slug, a.slug);
    await moveVideo(app, jar, slug, b.slug);

    const inA = await app.inject({ method: 'GET', url: `/api/folders/${a.slug}`, cookies: jar });
    const inB = await app.inject({ method: 'GET', url: `/api/folders/${b.slug}`, cookies: jar });
    expect(inA.json().videos).toHaveLength(0);
    expect(inB.json().videos.map((v: { slug: string }) => v.slug)).toEqual([slug]);
  });

  it('browses only the Videos inside a Folder', async () => {
    const { app, jar } = await signedIn();
    const folder = (await createFolder(app, jar, 'Trips')).json().folder;
    const inside = await upload(app, jar, 'Beach');
    await upload(app, jar, 'Loose'); // stays in the root
    await moveVideo(app, jar, inside, folder.slug);

    const browse = await app.inject({
      method: 'GET',
      url: `/api/folders/${folder.slug}`,
      cookies: jar,
    });
    expect(browse.statusCode).toBe(200);
    expect(browse.json().folder).toMatchObject({ slug: folder.slug, name: 'Trips' });
    expect(browse.json().videos.map((v: { title: string }) => v.title)).toEqual(['Beach']);
  });

  it('returns technical 404s for an unknown Folder (browse) or Video (move)', async () => {
    const { app, jar } = await signedIn();
    const slug = await upload(app, jar, 'Clip');

    const browse = await app.inject({ method: 'GET', url: '/api/folders/nope', cookies: jar });
    expect(browse.statusCode).toBe(404);
    expect(browse.json()).toMatchObject({ error: 'folder_not_found' });

    const badFolder = await moveVideo(app, jar, slug, 'nope');
    expect(badFolder.statusCode).toBe(404);
    expect(badFolder.json()).toMatchObject({ error: 'folder_not_found' });

    const badVideo = await moveVideo(app, jar, 'nope-video', null);
    expect(badVideo.statusCode).toBe(404);
    expect(badVideo.json()).toMatchObject({ error: 'video_not_found' });
  });
});
