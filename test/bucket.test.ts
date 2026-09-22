import { describe, expect, test } from 'bun:test';
import { normalizeForBucket, parseBucket } from '../src/core/bucket.js';

describe('parseBucket', () => {
  test('parses seconds, minutes and hours', () => {
    expect(parseBucket('60s')).toBe(60);
    expect(parseBucket('5m')).toBe(300);
    expect(parseBucket('1h')).toBe(3600);
  });

  test('throws on an unparsable value (REQ-017)', () => {
    expect(() => parseBucket('nope')).toThrow(/unparsable bucket/);
    expect(() => parseBucket('10')).toThrow(/unparsable bucket/);
    expect(() => parseBucket('0s')).toThrow(/greater than zero/);
  });
});

describe('normalizeForBucket', () => {
  const window = 60;

  test('two millisecond timestamps one second apart in the same window collapse', () => {
    const a = { to: 1_767_225_600_000 };
    const b = { to: 1_767_225_601_000 };
    expect(normalizeForBucket(a, window)).toEqual(normalizeForBucket(b, window));
  });

  test('the next window does not collapse into the previous one', () => {
    const a = { to: 1_767_225_600_000 };
    const next = { to: 1_767_225_660_000 };
    expect(normalizeForBucket(a, window)).not.toEqual(normalizeForBucket(next, window));
  });

  test('second-precision timestamps round too, and stay in seconds', () => {
    expect(normalizeForBucket({ to: 1_767_225_659 }, window)).toEqual({ to: 1_767_225_600 });
  });

  test('ISO-8601 strings round to the boundary', () => {
    expect(normalizeForBucket({ from: '2026-01-01T00:00:59.000Z' }, window)).toEqual({
      from: '2026-01-01T00:00:00.000Z',
    });
  });

  test('a Date becomes its rounded ISO string', () => {
    expect(normalizeForBucket({ at: new Date('2026-01-01T00:00:59.000Z') }, window)).toEqual({
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  test('small numbers are left alone — a page is not a timestamp', () => {
    expect(normalizeForBucket({ page: 2, limit: 50 }, window)).toEqual({ page: 2, limit: 50 });
  });

  test('walks nested structures', () => {
    expect(normalizeForBucket({ range: { to: 1_767_225_601_000 }, ids: ['a'] }, window)).toEqual({
      range: { to: 1_767_225_600_000 },
      ids: ['a'],
    });
  });


  test('a numeric query-param string rounds and stays a string — the case this exists for', () => {
    expect(normalizeForBucket({ to: '1767225601000' }, window)).toEqual({ to: '1767225600000' });
    expect(normalizeForBucket({ to: '1767225659' }, window)).toEqual({ to: '1767225600' });
  });

  test('a short digit string is not a timestamp and is left alone', () => {
    expect(normalizeForBucket({ page: '2' }, window)).toEqual({ page: '2' });
  });

  test('non-datetime strings are untouched', () => {
    expect(normalizeForBucket({ q: 'campanha' }, window)).toEqual({ q: 'campanha' });
  });
});
