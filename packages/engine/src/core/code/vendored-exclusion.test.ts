/**
 * Vendored and generated code is not the user's to fix.
 *
 * Findings inside node_modules, vendor/, dist/ or a minified bundle are noise:
 * nobody refactors a bundle, and the fix for generated code is a change to its
 * generator. They also swamped the board — the auto-filer materialises every
 * suggested action above the floor.
 *
 * THIS FILE IMPORTS THE SHIPPED PREDICATE. The previous version copied the
 * pattern list into the test and asserted against the copy, with a comment
 * admitting the real one was module-private. That is not a test of anything:
 * delete a pattern from the collector and it stayed green. The same class of
 * mistake let `rejected` ship without a database column — two tests covered the
 * rule and both re-implemented it.
 */
import { describe, test, expect } from 'vitest';
import { isGenerated, GENERATED_PATTERNS } from './collector.js';
import { severityOfPri, PRI_SEVERITY } from '../../types/code-intel.js';

describe('excluding vendored and generated code', () => {
  test.each([
    ['node_modules/zod/index.js', 'a dependency, at the string start'],
    ['packages/app/node_modules/left-pad/index.js', 'a nested dependency'],
    ['vendor/github.com/pkg/errors/errors.go', 'a Go vendor tree'],
    ['third_party/protobuf/parser.cc', 'a third-party drop'],
    ['api/events.pb.go', 'protobuf output'],
    ['src/schema.gen.ts', 'a generator'],
    ['proto/service_pb2.py', 'python protobuf'],
    ['lib/models.g.dart', 'dart codegen'],
    ['generated/client.ts', 'a generated dir'],
    ['src/__generated__/types.ts', 'a generated dir, nested'],
    ['dist/main.js', 'a build output'],
    ['build/index.js', 'a build output'],
    ['out/app.js', 'a build output'],
    ['target/debug/thing.rs', 'a cargo target'],
    ['.next/server/page.js', 'a framework build dir'],
    ['coverage/lcov-report/base.css', 'coverage output'],
    ['static/app.min.js', 'a minified bundle'],
    ['static/app.min.css', 'minified css'],
    ['static/vendor.bundle.js', 'a bundle'],
    ['static/main-bundle.js', 'a bundle, dashed'],
    ['dist/app.js.map', 'a source map'],
    ['package-lock.json', 'a lockfile'],
    ['.venv/lib/python3.11/site-packages/requests/api.py', 'a virtualenv'],
  ])('excludes %s (%s)', (path) => {
    expect(isGenerated(path)).toBe(true);
  });

  test.each([
    ['src/index.ts'],
    ['packages/engine/src/core/collector.ts'],
    ['cmd/server/main.go'],
    ['app/models/user.rb'],
    // Near-misses that must NOT be swept up with the real thing.
    ['src/generator.ts'],
    ['src/regenerate.ts'],
    ['docs/distribution.md'],
    ['src/outbox.ts'],
    ['src/building-blocks.ts'],
  ])('keeps %s', (path) => {
    expect(isGenerated(path)).toBe(false);
  });

  test('the exported list is the one the predicate uses', () => {
    // Guards against the predicate being rewritten to consult something else,
    // which would make every case above pass while testing nothing.
    for (const pattern of GENERATED_PATTERNS) {
      const probe = pattern.startsWith('/') ? `x${pattern}y` : `x/${pattern}y`;
      expect(isGenerated(probe.replace(/^x\//, ''))).toBe(true);
    }
    expect(GENERATED_PATTERNS.length).toBeGreaterThan(15);
  });
});

describe('severity mapping', () => {
  test('every priority has a severity', () => {
    for (const pri of Object.keys(PRI_SEVERITY)) {
      expect(severityOfPri(Number(pri))).toBeTruthy();
    }
  });
});
