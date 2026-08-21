/**
 * Vendored and generated code is not a task.
 *
 * A real board filled with cards about three.js bundles ("inflate copy-pasted 4×
 * (899 lines each)") and Go ABI bindings (events.gen.go). Nobody refactors a
 * minified bundle, and the fix for generated code is a change to its generator,
 * so neither belongs in findings or on the plan.
 */
import { describe, test, expect } from 'vitest';
import { severityOfPri, PRI_SEVERITY } from '../../types/code-intel.js';

// The predicate is module-private, so the pattern list is asserted through the
// exact shape it is built from: '/' + rel, matched by includes().
const GENERATED = [
  'generated/', '__generated__/', '.pb.go', '.gen.', '_pb2.py', '/gen/', '.g.dart',
  '/node_modules/', '/vendor/', '/third_party/', '/site-packages/', '.lock',
  '/dist/', '/build/', '/out/', '/target/', '/.next/', '/coverage/',
  '.min.js', '.min.css', '.bundle.js', '-bundle.js', '.map',
];
const isGenerated = (rel: string) => GENERATED.some((g) => ('/' + rel).includes(g));

describe('what counts as vendored or generated', () => {
  test('the files that actually polluted the board', () => {
    for (const f of [
      'covalidator/abi/generated/AcmeLightning/events.gen.go',
      'web/static/js/three.min.js',
      'app/dist/bundle.js',
      'node_modules/three/build/three.module.js',
      'vendor/github.com/pkg/errors/errors.go',
      'target/debug/build/x.rs',
      '.next/static/chunks/main.js',
      'coverage/lcov-report/index.html',
    ]) expect(isGenerated(f), f).toBe(true);
  });

  test('real source is never mistaken for vendored', () => {
    for (const f of [
      'src/services/auto-tasks.ts',
      'packages/engine/src/core/code/collector.ts',
      'contracts/lightning/src/libs/acmeLightning.sol',
      'cmd/server/main.go',
      'app/distribution/pricing.ts',   // 'dist' as a substring of a real word
      'src/outbox/queue.ts',           // 'out' as a substring of a real word
    ]) expect(isGenerated(f), f).toBe(false);
  });
});

describe('severityOfPri is the one mapping', () => {
  test('the collector range', () => {
    expect(severityOfPri(0)).toBe('critical');
    expect(severityOfPri(1)).toBe('high');
    expect(severityOfPri(2)).toBe('medium');
    expect(severityOfPri(3)).toBe('low');
  });
  test('junk fails to the most urgent, and anything past the scale is low', () => {
    expect(severityOfPri(-4)).toBe('critical');
    expect(severityOfPri(NaN)).toBe('critical');
    expect(severityOfPri(99)).toBe('low');
    expect(PRI_SEVERITY.length).toBe(4);
  });
});
