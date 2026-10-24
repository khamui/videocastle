import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { openDatabase, type DatabaseHandle } from '../src/db/client';
import { loadConfig, type Config } from '../src/config';
import type { Clock } from '../src/ports/clock';
import type { SlugGenerator } from '../src/ports/slug';
import type {
  Transcoder,
  TranscodeRequest,
  TranscodeResult,
  TranscoderAvailability,
} from '../src/ports/transcoder';
import type { VideoWorker } from '../src/videos/transcode-worker';

/** A clock whose time tests can set and advance. */
export interface FakeClock extends Clock {
  set(epochMs: number): void;
  advance(ms: number): void;
}

export function createFakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  return {
    now: () => current,
    set: (t) => {
      current = t;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/** A slug generator that returns a predictable, inspectable sequence. */
export interface FakeSlugGenerator extends SlugGenerator {
  issued: string[];
}

export function createFakeSlugGenerator(prefix = 'slug'): FakeSlugGenerator {
  const issued: string[] = [];
  return {
    issued,
    next() {
      const slug = `${prefix}-${issued.length + 1}`;
      issued.push(slug);
      return slug;
    },
  };
}

/**
 * A transcoder tests can drive. In the default `auto` mode `transcode` resolves
 * immediately (the common "it reaches Ready" case). Set `auto = false` to hold
 * the job open and drive it by hand — `progress(pct)` fires the request's
 * `onProgress`, `complete()` resolves it, `fail()` rejects it — so a test can
 * observe the Processing state and intermediate progress deterministically.
 */
export interface FakeTranscoder extends Transcoder {
  requests: TranscodeRequest[];
  result: TranscodeResult;
  auto: boolean;
  /** Whether `checkAvailable` reports transcoding as usable (default true). */
  available: boolean;
  progress(percent: number): Promise<void>;
  complete(result?: TranscodeResult): Promise<void>;
  fail(err: Error): Promise<void>;
}

export function createFakeTranscoder(): FakeTranscoder {
  let pending:
    | {
        request: TranscodeRequest;
        resolve: (result: TranscodeResult) => void;
        reject: (err: unknown) => void;
      }
    | undefined;

  const fake: FakeTranscoder = {
    requests: [],
    result: {
      playlistPath: 'rendition/index.m3u8',
      posterPath: 'poster.jpg',
      durationSeconds: 42,
    },
    auto: true,
    available: true,
    checkAvailable(): Promise<TranscoderAvailability> {
      return Promise.resolve(
        fake.available
          ? { available: true, version: 'fake-1.0', error: undefined }
          : { available: false, version: undefined, error: 'fake unavailable' },
      );
    },
    transcode(request) {
      fake.requests.push(request);
      if (fake.auto) return Promise.resolve(fake.result);
      return new Promise<TranscodeResult>((resolve, reject) => {
        pending = { request, resolve, reject };
      });
    },
    async progress(percent) {
      if (!pending) throw new Error('No in-flight transcode to drive');
      await pending.request.onProgress?.(percent);
    },
    async complete(result) {
      if (!pending) throw new Error('No in-flight transcode to complete');
      const job = pending;
      pending = undefined;
      job.resolve(result ?? fake.result);
    },
    async fail(err) {
      if (!pending) throw new Error('No in-flight transcode to fail');
      const job = pending;
      pending = undefined;
      job.reject(err);
    },
  };
  return fake;
}

export interface TestApp {
  app: FastifyInstance;
  clock: FakeClock;
  slugGenerator: FakeSlugGenerator;
  transcoder: FakeTranscoder;
  worker: VideoWorker;
  db: DatabaseHandle;
  config: Config;
  close(): Promise<void>;
}

/**
 * Builds the application against an in-memory SQLite database, a fresh temp
 * media directory, and the injected fakes, ready to drive with
 * `testApp.app.inject(...)`. An existing `DatabaseHandle` can be passed to
 * simulate a restart (a fresh app over the same persisted data).
 */
export async function buildTestApp(
  overrides: {
    db?: DatabaseHandle;
    env?: NodeJS.ProcessEnv;
    /** Boot the app with transcoding reported (un)available (default true). */
    transcoderAvailable?: boolean;
  } = {},
): Promise<TestApp> {
  const db = overrides.db ?? openDatabase(':memory:');
  const clock = createFakeClock();
  const slugGenerator = createFakeSlugGenerator();
  const transcoder = createFakeTranscoder();
  if (overrides.transcoderAvailable === false) transcoder.available = false;
  const mediaDir = mkdtempSync(join(tmpdir(), 'vc-media-'));
  const config = loadConfig({ MEDIA_DIR: mediaDir, ...overrides.env });

  const app = await buildApp({
    db: db.db,
    clock,
    slugGenerator,
    transcoder,
    config,
  });

  return {
    app,
    clock,
    slugGenerator,
    transcoder,
    worker: app.videoWorker,
    db,
    config,
    close: async () => {
      await app.close();
      // Only close the database if we opened it (not a caller-owned handle).
      if (!overrides.db) db.close();
      rmSync(mediaDir, { recursive: true, force: true });
    },
  };
}
