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
} from '../src/ports/transcoder';

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

/** A transcoder that records requests and returns a canned result (or fails). */
export interface FakeTranscoder extends Transcoder {
  requests: TranscodeRequest[];
  result: TranscodeResult;
  failWith: Error | undefined;
}

export function createFakeTranscoder(): FakeTranscoder {
  const fake: FakeTranscoder = {
    requests: [],
    result: {
      playlistPath: 'rendition/index.m3u8',
      posterPath: 'poster.jpg',
      durationSeconds: 42,
    },
    failWith: undefined,
    transcode(request) {
      fake.requests.push(request);
      if (fake.failWith) return Promise.reject(fake.failWith);
      return Promise.resolve(fake.result);
    },
  };
  return fake;
}

export interface TestApp {
  app: FastifyInstance;
  clock: FakeClock;
  slugGenerator: FakeSlugGenerator;
  transcoder: FakeTranscoder;
  db: DatabaseHandle;
  config: Config;
  close(): Promise<void>;
}

/**
 * Builds the application against an in-memory SQLite database and the injected
 * fakes, ready to drive with `testApp.app.inject(...)`. An existing
 * `DatabaseHandle` can be passed to simulate a restart (a fresh app over the
 * same persisted data).
 */
export async function buildTestApp(
  overrides: { db?: DatabaseHandle; env?: NodeJS.ProcessEnv } = {},
): Promise<TestApp> {
  const db = overrides.db ?? openDatabase(':memory:');
  const clock = createFakeClock();
  const slugGenerator = createFakeSlugGenerator();
  const transcoder = createFakeTranscoder();
  const config = loadConfig({ ...overrides.env });

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
    db,
    config,
    close: async () => {
      await app.close();
      // Only close the database if we opened it (not a caller-owned handle).
      if (!overrides.db) db.close();
    },
  };
}
