import { describe, expect, test } from 'bun:test';
import { deriveRouteTags } from '../src/core/route-tags.js';

describe('deriveRouteTags', () => {
  test('drops the trailing id and keeps the collection plus the root (REQ-009 example)', () => {
    expect(deriveRouteTags('/campaigns/:id/targets/:targetId')).toEqual(['campaigns/:id/targets', 'campaigns']);
  });

  test('one static segment yields a single tag', () => {
    expect(deriveRouteTags('/campaigns')).toEqual(['campaigns']);
  });

  test('three static segments yield the specific path and the root', () => {
    expect(deriveRouteTags('/a/b/c')).toEqual(['a/b/c', 'a']);
  });

  test('a route that is only a param has nothing to tag', () => {
    expect(deriveRouteTags('/:id')).toEqual([]);
  });

  test('a wildcard is treated as dynamic', () => {
    expect(deriveRouteTags('/files/*')).toEqual(['files']);
  });

  test('the collection and the item route share their tags, so writing one clears the other', () => {
    expect(deriveRouteTags('/campaigns/:id')).toEqual(['campaigns']);
    expect(deriveRouteTags('/campaigns')).toEqual(['campaigns']);
  });
});
