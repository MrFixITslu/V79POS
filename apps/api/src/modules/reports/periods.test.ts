import { describe, expect, it } from 'vitest';
import { bucketFor, completedBuckets, relativeChange } from './periods.js';

describe('historical POS report periods', () => {
  const now = new Date('2026-11-09T14:30:00Z'); // 10:30 in Saint Lucia on Monday
  it('uses full Monday-to-Monday local weeks, excluding the current week', () => {
    const buckets = completedBuckets('week', 3, 'America/St_Lucia', now);
    expect(buckets.map(b => b.key)).toEqual(['2026-10-19','2026-10-26','2026-11-02']);
    expect(buckets[2].from.toISOString()).toBe('2026-11-02T04:00:00.000Z');
    expect(buckets[2].to.toISOString()).toBe('2026-11-09T04:00:00.000Z');
    expect(bucketFor(new Date('2026-11-09T04:00:00Z'), buckets)).toBe(-1);
    expect(bucketFor(new Date('2026-11-02T04:00:00Z'), buckets)).toBe(2);
  });
  it('uses local calendar months rather than 30-day rolling windows', () => {
    const buckets = completedBuckets('month', 2, 'America/St_Lucia', now);
    expect(buckets.map(b => b.key)).toEqual(['2026-09','2026-10']);
    expect(buckets[1].from.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(buckets[1].to.toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
  it('excludes the incomplete calendar year', () => {
    const buckets = completedBuckets('year', 3, 'America/St_Lucia', now);
    expect(buckets.map(b => b.key)).toEqual(['2023','2024','2025']);
  });
  it('uses timezone boundaries when daylight-saving changes occur', () => {
    const mar = completedBuckets('month', 2, 'America/New_York', new Date('2026-05-15T16:00:00Z'));
    expect(mar[0].key).toBe('2026-03');
    expect(mar[0].from.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(mar[0].to.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });
  it('does not invent a growth percentage from zero', () => {
    expect(relativeChange(10,0)).toBeNull();
    expect(relativeChange(0,0)).toBeNull();
    expect(relativeChange(5,10)).toBe(-50);
    expect(relativeChange(15,10)).toBe(50);
    expect(relativeChange(0,10)).toBe(-100);
  });
});
