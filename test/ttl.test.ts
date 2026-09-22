import { describe, expect, test } from 'bun:test';
import { assertTtl, resolveTtl, shouldStore } from '../src/core/ttl.js';

describe('resolveTtl', () => {
  test('accepts a positive number of seconds', () => {
    expect(resolveTtl(600, { ok: true })).toBe(600);
  });

  test('accepts a function of the result', () => {
    const ttl = (result: { found: boolean }) => (result.found ? 300 : -1);
    expect(resolveTtl(ttl, { found: true })).toBe(300);
    expect(resolveTtl(ttl, { found: false })).toBe(-1);
  });

  test('a negative ttl means do not store', () => {
    expect(shouldStore(resolveTtl(-1, null))).toBe(false);
    expect(shouldStore(600)).toBe(true);
  });

  test('ttl 0 throws unless infinite caching was opted into (REQ-027)', () => {
    expect(() => resolveTtl(0, null)).toThrow(/never expires/);
    expect(resolveTtl(0, null, true)).toBe(0);
  });

  test('a ttl function that returns 0 is caught too', () => {
    expect(() => resolveTtl(() => 0, null)).toThrow(/never expires/);
  });

  test('a non-finite ttl is rejected', () => {
    expect(() => assertTtl(Number.NaN)).toThrow(/finite number/);
    expect(() => assertTtl(Number.POSITIVE_INFINITY)).toThrow(/finite number/);
  });
});
