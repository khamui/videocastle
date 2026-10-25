import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildTestApp, type TestApp } from './helpers';
import { setupOperator, uploadVideo } from './support';

/**
 * What the Dashboard is told about storage, and about the Host Configuration it
 * runs under. The figures are stated plainly, including the uncomfortable ones:
 * over-quota reports over 100% rather than a bar clamped to full, and a value
 * the Operator mistyped is called out rather than silently replaced.
 */

let current: TestApp | undefined;

afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function signedIn(
  env: NodeJS.ProcessEnv = {},
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

interface StorageReportBody {
  totalBytes: number;
  quotaBytes: number | null;
  minFreeDiskBytes: number;
  freeDiskBytes: number | null;
  writableBytes: number | null;
  warnPercent: number;
  usedPercent: number | null;
  pressure: 'ok' | 'warning' | 'full';
  databaseBytes: number | null;
}

async function storageOf(
  app: TestApp['app'],
  jar: Record<string, string>,
): Promise<StorageReportBody> {
  const res = await app.inject({ method: 'GET', url: '/api/status', cookies: jar });
  return res.json().storage;
}

describe('QUOTA_WARN_PERCENT', () => {
  it('defaults to 80', () => {
    expect(loadConfig({}).quotaWarnPercent).toBe(80);
  });

  it('is configurable, because 80% is a guess about someone else’s disk', () => {
    expect(loadConfig({ QUOTA_WARN_PERCENT: '95' }).quotaWarnPercent).toBe(95);
    expect(loadConfig({ QUOTA_WARN_PERCENT: '50' }).quotaWarnPercent).toBe(50);
  });

  it('rejects thresholds that could never warn anyone', () => {
    // 0 would fire on an empty instance; 100 would fire only once writes are
    // already being refused. Neither is a warning.
    for (const value of ['0', '100', '120', '-5', 'most']) {
      expect(loadConfig({ QUOTA_WARN_PERCENT: value }).quotaWarnPercent).toBe(80);
    }
  });
});

describe('the storage report', () => {
  it('invents no denominator when no Quota is set', async () => {
    const { app, jar } = await signedIn();
    const storage = await storageOf(app, jar);

    // No ceiling means no percentage: a bar at some arbitrary fill would be a
    // lie, so the Dashboard shows what is held and what is free instead.
    expect(storage.quotaBytes).toBeNull();
    expect(storage.usedPercent).toBeNull();
    expect(storage.pressure).toBe('ok');
    // `writableBytes` is still a real number — with no Quota the binding limit
    // is the host's actual free disk, which is finite and worth stating.
    expect(storage.writableBytes).toBeGreaterThan(0);
  });

  it('reports usage against the Quota, with what is still writable', async () => {
    const { app, jar } = await signedIn({ STORAGE_QUOTA_BYTES: '10000' });
    await upload(app, jar, 'Half of it', 5000);

    const storage = await storageOf(app, jar);
    expect(storage).toMatchObject({
      totalBytes: 5000,
      quotaBytes: 10000,
      usedPercent: 50,
      writableBytes: 5000,
      warnPercent: 80,
      pressure: 'ok',
    });
  });

  it('enters the warning band at the configured percentage', async () => {
    const { app, jar } = await signedIn({
      STORAGE_QUOTA_BYTES: '10000',
      QUOTA_WARN_PERCENT: '60',
    });
    await upload(app, jar, 'Past the band', 6500);

    const storage = await storageOf(app, jar);
    expect(storage.usedPercent).toBe(65);
    expect(storage.pressure).toBe('warning');
  });

  it('stays ok just below the band', async () => {
    const { app, jar } = await signedIn({
      STORAGE_QUOTA_BYTES: '10000',
      QUOTA_WARN_PERCENT: '60',
    });
    await upload(app, jar, 'Under it', 5000);
    expect((await storageOf(app, jar)).pressure).toBe('ok');
  });

  it('reports over 100% rather than clamping, and calls it full', async () => {
    const roomy = await signedIn({ STORAGE_QUOTA_BYTES: '100000' });
    await upload(roomy.app, roomy.jar, 'Already here', 8000);
    const db = roomy.db;
    const mediaDir = roomy.config.mediaDir;
    await roomy.app.close();

    // The Operator lowers the ceiling below what is held (ADR-0011).
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

    const storage = await storageOf(tight.app, jar);
    expect(storage.totalBytes).toBe(8000);
    expect(storage.usedPercent).toBe(800);
    expect(storage.writableBytes).toBe(0);
    expect(storage.pressure).toBe('full');
  });

  it('is full when the free-disk floor is unreachable, with no Quota at all', async () => {
    current = await buildTestApp({ env: { MIN_FREE_DISK_BYTES: '1PiB' } });
    const jar = await setupOperator(current.app);

    const storage = await storageOf(current.app, jar);
    expect(storage.quotaBytes).toBeNull();
    expect(storage.usedPercent).toBeNull();
    expect(storage.writableBytes).toBe(0);
    expect(storage.pressure).toBe('full');
  });

  it('reports the free-disk figures and the database separately from media', async () => {
    const { app, jar } = await signedIn({ MIN_FREE_DISK_BYTES: '2GiB' });
    const storage = await storageOf(app, jar);

    expect(storage.minFreeDiskBytes).toBe(2 * 1024 ** 3);
    expect(storage.freeDiskBytes).toBeGreaterThan(0);
    // The DB is counted nowhere in the media totals — it is shown beside them.
    expect(storage.totalBytes).toBe(0);
  });
});

describe('the Host Configuration view', () => {
  it('requires an authenticated Operator', async () => {
    current = await buildTestApp();
    await current.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'operator', password: 'correct horse battery' },
    });
    const res = await current.app.inject({ method: 'GET', url: '/api/server-config' });
    expect(res.statusCode).toBe(401);
  });

  it('says which values came from the environment and which are defaults', async () => {
    const { app, jar } = await signedIn({ TRANSCODE_CONCURRENCY: '1' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/server-config',
      cookies: jar,
    });

    const settings = res
      .json()
      .sections.flatMap((s: { settings: unknown[] }) => s.settings) as Array<{
      key: string;
      value: string;
      source: string;
      rejected?: string;
    }>;
    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));

    expect(byKey.TRANSCODE_CONCURRENCY).toMatchObject({
      value: '1',
      source: 'environment',
    });
    // Untouched, so it must read as a default rather than look configured.
    expect(byKey.RATE_LIMIT_MAX).toMatchObject({ value: '600', source: 'default' });
    expect(byKey.STORAGE_QUOTA_BYTES).toMatchObject({
      value: 'unlimited',
      source: 'default',
    });
    expect(byKey.FFMPEG_THREADS).toMatchObject({ source: 'default' });
  });

  it('calls out a value it could not read instead of silently defaulting', async () => {
    const { app, jar } = await signedIn({ STORAGE_QUOTA_BYTES: 'loads' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/server-config',
      cookies: jar,
    });

    const quota = res
      .json()
      .sections.flatMap((s: { settings: Array<{ key: string }> }) => s.settings)
      .find((s: { key: string }) => s.key === 'STORAGE_QUOTA_BYTES');

    // ADR-0007: the Operator is told their typo, and what is in force instead.
    expect(quota).toMatchObject({
      value: 'unlimited',
      source: 'invalid',
      rejected: 'loads',
    });
  });

  it('never sends the session secret, only whether one is set', async () => {
    const secret = 'super-secret-signing-key';
    const { app, jar } = await signedIn({ SESSION_SECRET: secret });
    const res = await app.inject({
      method: 'GET',
      url: '/api/server-config',
      cookies: jar,
    });

    expect(res.body).not.toContain(secret);
    const found = res
      .json()
      .sections.flatMap((s: { settings: Array<{ key: string }> }) => s.settings)
      .find((s: { key: string }) => s.key === 'SESSION_SECRET');
    expect(found).toMatchObject({ value: 'set (hidden)', source: 'environment' });
  });

  it('reports an auto-generated secret as generated, not as absent', async () => {
    const { app, jar } = await signedIn();
    const res = await app.inject({
      method: 'GET',
      url: '/api/server-config',
      cookies: jar,
    });
    const found = res
      .json()
      .sections.flatMap((s: { settings: Array<{ key: string }> }) => s.settings)
      .find((s: { key: string }) => s.key === 'SESSION_SECRET');
    expect(found).toMatchObject({ value: 'auto-generated' });
  });
});
