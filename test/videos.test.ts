import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers';

type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

const OPERATOR = { username: 'operator', password: 'correct horse battery' };

/** Builds an app and completes first-run setup, returning it plus the session jar. */
async function signedIn(): Promise<TestApp & { jar: Record<string, string> }> {
  current = await buildTestApp();
  const res = await current.app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: OPERATOR,
  });
  expect(res.statusCode).toBe(201);
  return { ...current, jar: cookieJar(res) };
}

function cookieJar(res: InjectResponse): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const cookie of res.cookies) jar[cookie.name] = cookie.value;
  return jar;
}

/** Builds a `multipart/form-data` body: the field parts first, then one file. */
function multipart(parts: {
  fields?: Record<string, string>;
  file?: { fieldname: string; filename: string; content: string | Buffer };
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----vctest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (parts.file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${parts.file.fieldname}"; filename="${parts.file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.isBuffer(parts.file.content)
        ? parts.file.content
        : Buffer.from(parts.file.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function uploadVideo(
  app: TestApp['app'],
  jar: Record<string, string>,
  parts: Parameters<typeof multipart>[0],
): Promise<InjectResponse> {
  const { payload, headers } = multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/videos',
    cookies: jar,
    headers,
    payload,
  });
}

/** Polls until a condition holds, so a test can await the async worker picking up a job. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('uploading a Video', () => {
  it('returns immediately with the Video Processing and a usable Share Link', async () => {
    const { app, jar, transcoder } = await signedIn();
    transcoder.auto = false; // keep it Processing so we can observe that state

    const res = await uploadVideo(app, jar, {
      fields: { title: 'My Interview' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'raw bytes' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().video).toMatchObject({
      title: 'My Interview',
      state: 'processing',
      progress: 0,
      shareUrl: '/v/slug-1',
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos).toHaveLength(1);
    expect(list.json().videos[0]).toMatchObject({
      state: 'processing',
      shareUrl: '/v/slug-1',
    });
  });

  it('streams the Source to disk rather than returning before it is saved', async () => {
    const { app, jar, config, worker } = await signedIn();

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'the source bytes' },
    });
    await worker.idle();

    // Exactly one Video directory, keyed by the Video's id, holding the Source.
    const dirs = readdirSync(config.mediaDir);
    expect(dirs).toHaveLength(1);
    const source = readFileSync(join(config.mediaDir, dirs[0]!, 'source'), 'utf8');
    expect(source).toBe('the source bytes');
  });

  it('rejects an upload with no file part', async () => {
    const { app, jar } = await signedIn();

    const res = await uploadVideo(app, jar, { fields: { title: 'No file' } });

    expect(res.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos).toHaveLength(0);
  });

  it('rejects an upload with no title', async () => {
    const { app, jar } = await signedIn();

    const res = await uploadVideo(app, jar, {
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('requires an authenticated Operator to upload or list', async () => {
    current = await buildTestApp();
    await current.app.inject({ method: 'POST', url: '/api/setup', payload: OPERATOR });

    const upload = await current.app.inject({ method: 'POST', url: '/api/videos' });
    expect(upload.statusCode).toBe(401);

    const list = await current.app.inject({ method: 'GET', url: '/api/videos' });
    expect(list.statusCode).toBe(401);
  });
});

describe('transcoding to Ready', () => {
  it('transcodes via the Transcoder port to Ready with one Rendition and a poster', async () => {
    const { app, jar, transcoder, worker, db } = await signedIn();

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await worker.idle();

    // Reached the port with the Video's Source path.
    expect(transcoder.requests).toHaveLength(1);
    expect(transcoder.requests[0]!.sourcePath).toMatch(/\/source$/);

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos[0]).toMatchObject({
      state: 'ready',
      progress: 100,
      durationSeconds: 42,
    });

    // Exactly one Rendition + one Poster recorded for the Video.
    const row = db.raw
      .prepare('SELECT playlist_path, poster_path FROM videos')
      .get() as { playlist_path: string | null; poster_path: string | null };
    expect(row.playlist_path).toBe('rendition/index.m3u8');
    expect(row.poster_path).toBe('poster.jpg');
  });

  it('surfaces transcoding progress in the Library while Processing', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    await transcoder.progress(50);
    const mid = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(mid.json().videos[0]).toMatchObject({ state: 'processing', progress: 50 });

    await transcoder.complete();
    await worker.idle();
    const done = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(done.json().videos[0]).toMatchObject({ state: 'ready', progress: 100 });
  });

  it('marks the Video Failed when the transcode errors', async () => {
    const { app, jar, transcoder, worker } = await signedIn();
    transcoder.auto = false;

    await uploadVideo(app, jar, {
      fields: { title: 'Clip' },
      file: { fieldname: 'file', filename: 'clip.mp4', content: 'bytes' },
    });
    await waitFor(() => transcoder.requests.length === 1);

    await transcoder.fail(new Error('ffmpeg blew up'));
    await worker.idle();

    const list = await app.inject({
      method: 'GET',
      url: '/api/videos',
      cookies: jar,
    });
    expect(list.json().videos[0]).toMatchObject({ state: 'failed' });
  });
});
