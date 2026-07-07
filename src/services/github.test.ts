import { describe, it, expect, beforeAll } from 'vitest';
import { toLocalDate } from './github.js';

describe('toLocalDate', () => {
  beforeAll(() => {
    // Node re-reads process.env.TZ at runtime (assigning it calls tzset + notifies V8), so
    // this pins the timezone deterministically regardless of where the suite runs.
    process.env.TZ = 'America/Chicago';
  });

  it('formats a UTC timestamp as a local YYYY-MM-DD date', () => {
    // 2026-07-06 15:30 UTC = 10:30 CDT — same calendar day in Central.
    expect(toLocalDate('2026-07-06T15:30:00Z')).toBe('2026-07-06');
  });

  it('buckets a late-evening Central timestamp to the local day, not the UTC day', () => {
    // 2026-07-06 23:30 CDT = 2026-07-07 04:30 UTC. UTC slicing would call this July 7;
    // local bucketing must keep it on July 6 for a Central user.
    expect(toLocalDate('2026-07-07T04:30:00Z')).toBe('2026-07-06');
  });

  it('uses 1-indexed, zero-padded months', () => {
    expect(toLocalDate('2026-12-09T18:00:00Z')).toBe('2026-12-09');
  });
});
