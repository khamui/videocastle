import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Clock } from '../ports/clock';

/**
 * A tiny fixed-window, per-key request counter. Deliberately explicit rather
 * than a plugin (ADR-0001): one Map of `{ windowStart, count }` per key, with
 * the window judged against the injected {@link Clock} so behaviour is
 * deterministic and testable through the HTTP seam. Single-process only, which
 * is all the single-container deploy needs (ADR-0004).
 */
export interface RateLimiter {
  /**
   * Records one hit for `key` and reports whether it is within the limit.
   * The first hit of a new window resets the count; the window slides forward
   * only once the current one has fully elapsed.
   */
  hit(key: string): boolean;
}

export interface RateLimiterOptions {
  /** Max allowed hits per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  clock: Clock;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key) {
      const now = options.clock.now();
      const current = windows.get(key);
      if (!current || now - current.start >= options.windowMs) {
        // New (or fully elapsed) window. Opportunistically drop stale entries so
        // the Map can't grow unbounded over a long-lived process.
        if (windows.size > 1024) {
          for (const [k, w] of windows) {
            if (now - w.start >= options.windowMs) windows.delete(k);
          }
        }
        windows.set(key, { start: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= options.limit;
    },
  };
}

export interface RateLimitDeps {
  clock: Clock;
  windowMs: number;
  /** General per-IP ceiling for all public viewer endpoints. */
  generalMax: number;
  /** Stricter per-IP ceiling for password attempts (Video + Folder unlock). */
  passwordMax: number;
}

/**
 * Guards the public Viewer surface (`/api/watch/*`) with two per-IP limiters: a
 * general flood guard on every viewer request, and a stricter one on the unlock
 * endpoints to slow password brute-forcing (spec: Rate limiting). Operator and
 * SPA routes are untouched — the Operator is authenticated and trusted. Over the
 * limit returns a generic 429 with `Retry-After` (no existence leak, ADR-0002).
 */
export function registerRateLimiting(app: FastifyInstance, deps: RateLimitDeps): void {
  const general = createRateLimiter({
    limit: deps.generalMax,
    windowMs: deps.windowMs,
    clock: deps.clock,
  });
  const password = createRateLimiter({
    limit: deps.passwordMax,
    windowMs: deps.windowMs,
    clock: deps.clock,
  });
  const retryAfterSeconds = Math.max(1, Math.ceil(deps.windowMs / 1000));

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/watch')) return; // only the public Viewer API

    const ip = request.ip;
    // Password attempts face the tighter bucket first, so a brute-force run is
    // throttled by the strict limit well before the general one would notice.
    if (path.endsWith('/unlock') && !password.hit(ip)) {
      return tooMany(reply, retryAfterSeconds);
    }
    if (!general.hit(ip)) {
      return tooMany(reply, retryAfterSeconds);
    }
  });
}

function tooMany(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header('retry-after', retryAfterSeconds);
  return reply.code(429).send({ error: 'rate_limited' });
}
