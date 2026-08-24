/**
 * Project resolution for the dossier.
 *
 * The defect these tests pin down: the dossier runs on the SERVER, `project_path`
 * describes the USER'S machine, and `resolveProjectId` works by reading the git
 * remote of a directory. On the server that directory does not exist, so every
 * documented way of naming a project except the internal `git:` id resolved to
 * `path:/home/…`, matched nothing, and produced a report that looked like an
 * empty project rather than a failed lookup.
 */

import { describe, expect, test } from 'vitest';

import { resolveAgainstIndex, type ProjectLookup } from './project-dossier.js';
import type { MemoryMetadataRow } from '../types/memory.js';

const row = (id: string, projectId: string): MemoryMetadataRow => ({
  id,
  source_type: 'session',
  project_id: projectId,
  project_path: '',
  mtime: 1,
} as unknown as MemoryMetadataRow);

/** An index holding one busy repo, one nested repo inside it, and a stray. */
function lookup(): ProjectLookup {
  const items: Record<string, number> = {
    'git:github.com/acme/example-app': 400,
    'git:github.com/acme/example-app-sub': 12,
    'git:github.com/acme/other': 3,
    'path:/home/user/code/example-app': 1,   // a stale low-count duplicate
  };
  const paths = [
    { project_id: 'git:github.com/acme/example-app', project_path: '/home/user/code/example-app' },
    { project_id: 'git:github.com/acme/example-app-sub', project_path: '/home/user/code/example-app/vendor/sub' },
    { project_id: 'git:github.com/acme/other', project_path: '/home/user/code/other' },
    { project_id: 'path:/home/user/code/example-app', project_path: '/home/user/code/example-app' },
  ];
  return {
    async listItemsByProjectId(_t, projectId) {
      const n = items[projectId] ?? 0;
      return Array.from({ length: n }, (_, i) => row(`${projectId}#${i}`, projectId));
    },
    async listAllProjectIdPaths() { return paths; },
    async listProjectsSummary() {
      return Object.entries(items).map(([project_id, n]) => ({ project_id, items: n, last_mtime: 1 }));
    },
  };
}

describe('resolveAgainstIndex', () => {
  test('an explicit project id is used as given', async () => {
    const got = await resolveAgainstIndex(lookup(), 'git:github.com/acme/example-app');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
    expect(got?.rows.length).toBe(400);
  });

  test('an explicit id with no rows reports that id, not a different project', async () => {
    // Being told about someone else's project is worse than being told nothing.
    const got = await resolveAgainstIndex(lookup(), 'git:github.com/acme/never-indexed');
    expect(got?.projectId).toBe('git:github.com/acme/never-indexed');
    expect(got?.rows).toEqual([]);
  });

  test('THE BUG: an absolute path resolves through the index, not the local git remote', async () => {
    // This is the call the MCP tool makes. It used to yield `path:/home/…`,
    // which matches nothing on the server.
    const got = await resolveAgainstIndex(lookup(), '/home/user/code/example-app');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
    expect(got?.rows.length).toBe(400);
  });

  test('a path match prefers the busiest project over a stale duplicate id', async () => {
    // Two ids claim the same path; the one-row `path:` leftover must not win.
    const got = await resolveAgainstIndex(lookup(), '/home/user/code/example-app/');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
  });

  test('a subdirectory resolves to the deepest checkout containing it', async () => {
    const got = await resolveAgainstIndex(lookup(), '/home/user/code/example-app/vendor/sub/src');
    expect(got?.projectId).toBe('git:github.com/acme/example-app-sub');
  });

  test('a subdirectory of only the outer repo resolves to that repo', async () => {
    const got = await resolveAgainstIndex(lookup(), '/home/user/code/example-app/packages/cli');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
  });

  test('a bare name resolves by display name — what a human actually types', async () => {
    const got = await resolveAgainstIndex(lookup(), 'example-app');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
  });

  test('name matching is case-insensitive', async () => {
    const got = await resolveAgainstIndex(lookup(), 'Example-App');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
  });

  test('a substring that is no display name still finds the busiest owner', async () => {
    const got = await resolveAgainstIndex(lookup(), 'acme');
    expect(got?.projectId).toBe('git:github.com/acme/example-app');
  });

  test('nothing matching returns null, so the caller can say so instead of showing an empty project', async () => {
    expect(await resolveAgainstIndex(lookup(), '/home/user/code/no-such-repo')).toBeNull();
    expect(await resolveAgainstIndex(lookup(), 'no-such-name')).toBeNull();
  });
});
