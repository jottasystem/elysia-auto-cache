import { describe, expect, test } from 'bun:test';
import { DEFAULT_BYPASS_HEADER, isBypassed } from '../src/plugin/bypass.js';

const req = (headers: Record<string, string> = {}) => new Request('https://x.test/', { headers });

describe('isBypassed', () => {
  test('defaults to x-auto-cache-bypass', () => {
    expect(DEFAULT_BYPASS_HEADER).toBe('x-auto-cache-bypass');
    expect(isBypassed(req({ 'x-auto-cache-bypass': '1' }))).toBe(true);
  });

  test('is false when the header is absent', () => {
    expect(isBypassed(req())).toBe(false);
  });

  test('honours a custom header name', () => {
    expect(isBypassed(req({ 'x-skip': '1' }), 'x-skip')).toBe(true);
    expect(isBypassed(req({ 'x-auto-cache-bypass': '1' }), 'x-skip')).toBe(false);
  });

  test('an explicit 0 or false is not a bypass', () => {
    expect(isBypassed(req({ 'x-auto-cache-bypass': '0' }))).toBe(false);
    expect(isBypassed(req({ 'x-auto-cache-bypass': 'false' }))).toBe(false);
    expect(isBypassed(req({ 'x-auto-cache-bypass': 'FALSE' }))).toBe(false);
  });

  test('any other value counts, so `true`, `yes` and an empty value all bypass', () => {
    expect(isBypassed(req({ 'x-auto-cache-bypass': 'true' }))).toBe(true);
    expect(isBypassed(req({ 'x-auto-cache-bypass': 'yes' }))).toBe(true);
    expect(isBypassed(req({ 'x-auto-cache-bypass': '' }))).toBe(true);
  });

  test('the header name is matched case-insensitively', () => {
    expect(isBypassed(req({ 'X-Auto-Cache-Bypass': '1' }))).toBe(true);
  });
});
