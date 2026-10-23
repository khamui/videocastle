/**
 * Clock port.
 *
 * All time-dependent behaviour (notably Share Link expiry) reads the current
 * time through this port so tests can drive time deterministically instead of
 * waiting. `now()` returns epoch milliseconds.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
