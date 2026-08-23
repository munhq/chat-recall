import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerBackend,
  getBackend,
  tryGetBackend,
  getBackendForId,
  listAllBackends,
  listAvailableBackends,
  _resetRegistryForTests,
  type ToolBackend,
} from './tool-backend.js';

// We import the bootstrap module separately so tests can choose whether to
// rely on the auto-registered production backends or wire up their own.
async function bootstrapProduction(): Promise<void> {
  const { bootstrapBackends } = await import('./backends/index.js');
  bootstrapBackends();
}

function makeBackend(id: ToolBackend['id'], idPrefix: string, available = true): ToolBackend {
  const emptyCommits = { sessionId: '', startMs: 0, endMs: 0, totalCommits: 0, repos: [] };
  const emptyMarkers = {
    total: 0, interrupt: 0, frustrated: 0, correction: 0, approval: 0,
    question: 0, directive: 0, clarification_request: 0, peakIntensity: 0,
  };
  return {
    id,
    idPrefix,
    displayName: id[0].toUpperCase() + id.slice(1),
    homeDir: () => `/tmp/${id}-home`,
    isAvailable: () => available,
    matchesId: (s) => idPrefix ? s.startsWith(idPrefix) : !s.includes('_'),
    toRawId: (s) => idPrefix && s.startsWith(idPrefix) ? s.slice(idPrefix.length) : s,
    toPrefixedId: (s) => idPrefix && !s.startsWith(idPrefix) ? idPrefix + s : s,
    findSession: () => null,
    listSessions: () => [],
    readEvents: () => [],
    fileToolMap: {},
    collectRecentEdits: () => [],
    extractTurns: (sid) => ({ sessionId: sid, found: false, turns: [], startMs: 0, endMs: 0 }),
    liveScanEdits: () => ({ found: false, projectPath: '', projectDir: '', edits: [], fileMtime: 0, tool: id }),
    replay: (sid) => ({ sessionId: sid, found: false, projectPath: '', files: [], totalLinesAdded: 0, totalLinesRemoved: 0 }),
    computeOutcome: (sid) => ({
      sessionId: sid, found: false, status: 'unknown', reason: '', startMs: 0, endMs: 0,
      decisions: [], blockers: [], claimReaction: {},
      prompts: [], promptMarkers: emptyMarkers, commits: emptyCommits,
      fileCount: 0, filesChanged: [], totalLinesAdded: 0, totalLinesRemoved: 0,
    }),
    getCommits: () => emptyCommits,
  };
}

describe('ToolBackend registry', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  it('register + getBackend round-trip', () => {
    const claude = makeBackend('claude', '');
    registerBackend(claude);
    expect(getBackend('claude')).toBe(claude);
  });

  it('tryGetBackend returns null for missing tool, throws on getBackend', () => {
    expect(tryGetBackend('gemini')).toBeNull();
    expect(() => getBackend('gemini')).toThrow(/No backend registered/);
  });

  it('getBackendForId routes prefixed ids to the correct backend', () => {
    const claude = makeBackend('claude', '');
    const gemini = makeBackend('gemini', 'gemini_');
    const opencode = makeBackend('opencode', 'opencode_');
    const codex = makeBackend('codex', 'codex_');
    const agy = makeBackend('agy', 'agy_');
    const cursor = makeBackend('cursor', 'cursor_');
    [claude, gemini, opencode, codex, agy, cursor].forEach(registerBackend);

    expect(getBackendForId('gemini_abc')?.id).toBe('gemini');
    expect(getBackendForId('opencode_xyz')?.id).toBe('opencode');
    expect(getBackendForId('codex_q1')?.id).toBe('codex');
    expect(getBackendForId('agy_d1')?.id).toBe('agy');
    expect(getBackendForId('cursor_e1')?.id).toBe('cursor');
    expect(getBackendForId('550e8400-e29b-41d4-a716-446655440000')?.id).toBe('claude');
  });

  it('getBackendForId returns null for ids no backend matches', () => {
    const claude = makeBackend('claude', '');
    // Custom matcher: claude only matches uuid-like strings, not plain words.
    claude.matchesId = (s) => /^[0-9a-f-]{8,}$/i.test(s);
    registerBackend(claude);
    expect(getBackendForId('plain-word')).toBeNull();
  });

  it('listAllBackends returns every registered backend; listAvailableBackends filters', () => {
    registerBackend(makeBackend('claude', '', true));
    registerBackend(makeBackend('gemini', 'gemini_', false));
    registerBackend(makeBackend('opencode', 'opencode_', true));

    expect(listAllBackends().map((b) => b.id).sort()).toEqual(['claude', 'gemini', 'opencode']);
    expect(listAvailableBackends().map((b) => b.id).sort()).toEqual(['claude', 'opencode']);
  });

  it('production bootstrap registers every AI tool', async () => {
    await bootstrapProduction();
    const ids = listAllBackends().map((b) => b.id).sort();
    expect(ids).toEqual(['agy', 'claude', 'codex', 'cursor', 'gemini', 'opencode']);
  });
});

/**
 * Registration is DEFERRED to first registry access (to dodge a circular-import
 * race), so every accessor has to bootstrap on its way in. `getBackend` did not,
 * which made it succeed or throw depending on whether anything else had touched
 * the registry first.
 *
 * That is not a theoretical ordering concern: it broke the server's self-heal
 * sweep in production. The sweep runs on a timer during startup, before any
 * request path warms the registry, so `getBackend('claude')` threw for every
 * session and the sweep reported `healed: 0` indefinitely — while the backends
 * sat registered, one sibling call away.
 */
describe('registry accessors work on a COLD registry', () => {
  // Deliberately no beforeEach warm-up: each test must be the FIRST access.
  beforeEach(async () => {
    _resetRegistryForTests();
    // Importing the barrel re-arms the deferred bootstrapper without registering
    // anything, which is exactly the state a freshly-booted process is in.
    await import('./backends/index.js');
  });

  it('getBackend resolves without any prior registry access', () => {
    // The regression: this threw "No backend registered for tool 'claude'".
    expect(getBackend('claude').id).toBe('claude');
  });

  it.each(['claude', 'gemini', 'opencode', 'codex', 'agy', 'cursor'] as const)(
    'getBackend(%s) resolves cold',
    (id) => {
      _resetRegistryForTests();
      expect(getBackend(id).id).toBe(id);
    },
  );

  it('every accessor is order-independent — none depends on being called second', async () => {
    const probes: Array<[string, () => unknown]> = [
      ['getBackend', () => getBackend('claude')],
      ['tryGetBackend', () => tryGetBackend('claude')],
      ['getBackendForId', () => getBackendForId('gemini_abc123')],
      ['listAllBackends', () => listAllBackends()],
      ['listAvailableBackends', () => listAvailableBackends()],
    ];
    for (const [name, probe] of probes) {
      _resetRegistryForTests();
      await import('./backends/index.js');
      expect(() => probe(), `${name} must not throw as the first registry access`).not.toThrow();
      expect(probe(), `${name} returned nothing on a cold registry`).toBeTruthy();
    }
  });

  it('an unknown tool still errors, and names what IS registered', () => {
    // The old message told the reader to check an import that was already
    // present. After bootstrapping, an empty result means the id is genuinely
    // unknown, so the error should say so.
    expect(() => getBackend('nope' as never)).toThrow(/Known tools: .*claude/);
  });
});
