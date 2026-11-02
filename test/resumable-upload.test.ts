import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator } from './support';

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const TUS = '1.0.0';

/** A signed-in, listening app and the Cookie header for its Operator session. */
async function listeningSignedIn(
  env?: NodeJS.ProcessEnv,
): Promise<{ test: TestApp; base: string; cookie: string }> {
  current = await buildTestApp({ env });
  const jar = await setupOperator(current.app);
  const cookie = Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  const base = await current.app.listen({ port: 0, host: '127.0.0.1' });
  return { test: current, base, cookie };
}

/** Encodes a tus `Upload-Metadata` header from plain key/value pairs. */
function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`)
    .join(',');
}

/** Creates a tus Upload and returns its absolute URL (the `Location`). */
async function createUpload(
  base: string,
  cookie: string,
  size: number,
  meta: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Tus-Resumable': TUS,
    'Upload-Length': String(size),
    Cookie: cookie,
  };
  // An empty Upload-Metadata header is malformed; send it only when there is
  // metadata (an untitled, unfiled upload legitimately has none).
  const encoded = encodeMetadata(meta);
  if (encoded) headers['Upload-Metadata'] = encoded;
  return fetch(`${base}/api/uploads`, { method: 'POST', headers });
}

/** The Operator's Library over HTTP (the inject GET would need the cookie too). */
async function listVideos(base: string, cookie: string): Promise<Array<{ title: string; state: string }>> {
  const res = await fetch(`${base}/api/videos`, { headers: { Cookie: cookie } });
  return ((await res.json()) as { videos: Array<{ title: string; state: string }> }).videos;
}

/** Sends one PATCH chunk at `offset`; returns the response. */
async function patchChunk(
  url: string,
  cookie: string,
  offset: number,
  chunk: Buffer,
): Promise<Response> {
  return fetch(url, {
    method: 'PATCH',
    headers: {
      'Tus-Resumable': TUS,
      'Upload-Offset': String(offset),
      'Content-Type': 'application/offset+octet-stream',
      Cookie: cookie,
    },
    // A Uint8Array view satisfies BodyInit (a bare Buffer does not, per the DOM types).
    body: new Uint8Array(chunk),
  });
}

/** Resolves a (possibly relative) tus `Location` against the server base. */
function absolute(base: string, location: string): string {
  return location.startsWith('http') ? location : `${base}${location}`;
}

describe('resumable (tus) uploads', () => {
  it('uploads a file and creates a Processing Video on completion', async () => {
    const { test, base, cookie } = await listeningSignedIn();
    const body = Buffer.from('the resumable source bytes');

    const create = await createUpload(base, cookie, body.length, { title: 'From a phone' });
    expect(create.status).toBe(201);
    const url = absolute(base, create.headers.get('location')!);

    const done = await patchChunk(url, cookie, 0, body);
    expect(done.status).toBe(200);
    const created = (await done.json()) as { video: { title: string; state: string; slug: string } };
    expect(created.video).toMatchObject({ title: 'From a phone', state: 'processing' });

    // The Video is in the Library with a Share Link, exactly like a legacy upload.
    const videos = await listVideos(base, cookie);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ title: 'From a phone', state: 'processing' });

    await test.worker.idle();
  });

  it('resumes from the last offset across two PATCH requests (the pocket scenario)', async () => {
    const { test, base, cookie } = await listeningSignedIn();
    const body = Buffer.from('first-half|second-half');
    const split = body.indexOf('|') + 1;

    const create = await createUpload(base, cookie, body.length, { title: 'Interrupted' });
    const url = absolute(base, create.headers.get('location')!);

    // Phone locks after the first chunk: the server holds the offset.
    const part1 = await patchChunk(url, cookie, 0, body.subarray(0, split));
    expect(part1.status).toBe(204);
    expect(Number(part1.headers.get('upload-offset'))).toBe(split);

    // Phone wakes: the client HEADs to learn the offset, then resumes from it.
    const head = await fetch(url, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': TUS, Cookie: cookie },
    });
    expect(Number(head.headers.get('upload-offset'))).toBe(split);

    const part2 = await patchChunk(url, cookie, split, body.subarray(split));
    expect(part2.status).toBe(200);

    expect(await listVideos(base, cookie)).toHaveLength(1);
    await test.worker.idle();
  });

  it('names an untitled tus upload "Unnamed video"', async () => {
    const { base, cookie } = await listeningSignedIn();
    const body = Buffer.from('untitled bytes');

    const create = await createUpload(base, cookie, body.length, {});
    const url = absolute(base, create.headers.get('location')!);
    const done = await patchChunk(url, cookie, 0, body);

    expect(done.status).toBe(200);
    expect((await done.json()).video.title).toBe('Unnamed video');
  });

  it('refuses a new upload once MAX_UPLOAD_BATCH are already in flight', async () => {
    const { base, cookie } = await listeningSignedIn({ MAX_UPLOAD_BATCH: '1' });

    // One incomplete upload created and left in flight.
    const first = await createUpload(base, cookie, 100, { title: 'One' });
    expect(first.status).toBe(201);

    // The second is refused: the single slot is taken.
    const second = await createUpload(base, cookie, 100, { title: 'Two' });
    expect(second.status).toBe(429);
    expect(await second.text()).toContain('too_many_uploads');
  });

  it('rejects an upload targeting an unknown Folder at creation', async () => {
    const { base, cookie } = await listeningSignedIn();

    const create = await createUpload(base, cookie, 100, { title: 'Misfiled', folderSlug: 'nope' });
    expect(create.status).toBe(404);
    expect(await create.text()).toContain('folder_not_found');
  });

  it('requires an authenticated Operator to create an upload', async () => {
    const { base } = await listeningSignedIn();
    const res = await fetch(`${base}/api/uploads`, {
      method: 'POST',
      headers: { 'Tus-Resumable': TUS, 'Upload-Length': '10' },
    });
    expect(res.status).toBe(401);
  });
});
