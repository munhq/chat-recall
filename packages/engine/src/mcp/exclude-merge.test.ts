/**
 * "Also exclude this repo" must not drop the repos already excluded.
 *
 * The MCP takes one project at a time, because that is how the instruction
 * arrives — "do not put work on my board for this one". The naive shape of that
 * is `excludedProjects: [theOne]`, which REPLACES the list and silently un-excludes
 * every other repository, including a client's. Hence a merge against the
 * current value, and hence a test for it.
 */
import { describe, test, expect } from 'vitest';
import { mergeExcludedProjects } from './tools.js';

describe('merging the never-file list', () => {
  test('THE POINT: adding one keeps the others', () => {
    expect(mergeExcludedProjects(['a', 'b'], { add: 'c' })).toEqual(['a', 'b', 'c']);
  });

  test('removing one keeps the others', () => {
    expect(mergeExcludedProjects(['a', 'b', 'c'], { remove: 'b' })).toEqual(['a', 'c']);
  });

  test('adding one that is already there changes nothing', () => {
    expect(mergeExcludedProjects(['a', 'b'], { add: 'b' })).toEqual(['a', 'b']);
  });

  test('removing one that is not there changes nothing', () => {
    expect(mergeExcludedProjects(['a'], { remove: 'zzz' })).toEqual(['a']);
  });

  test('add and remove in one call both apply', () => {
    expect(mergeExcludedProjects(['a', 'b'], { add: 'c', remove: 'a' })).toEqual(['b', 'c']);
  });

  test('order is preserved, so the list does not churn between reads', () => {
    expect(mergeExcludedProjects(['z', 'a', 'm'], { add: 'b' })).toEqual(['z', 'a', 'm', 'b']);
  });

  test('a missing or malformed current list is an empty one, not a crash', () => {
    expect(mergeExcludedProjects(undefined, { add: 'a' })).toEqual(['a']);
    expect(mergeExcludedProjects(null, { add: 'a' })).toEqual(['a']);
    expect(mergeExcludedProjects('nope', { add: 'a' })).toEqual(['a']);
    expect(mergeExcludedProjects([1, {}, 'a', '  '], { add: 'b' })).toEqual(['a', 'b']);
  });

  test('duplicates already in the stored list collapse', () => {
    expect(mergeExcludedProjects(['a', 'a', ' a '], { add: 'b' })).toEqual(['a', 'b']);
  });

  test('whitespace around the argument does not create a twin', () => {
    expect(mergeExcludedProjects(['a'], { add: ' a ' })).toEqual(['a']);
  });
});
