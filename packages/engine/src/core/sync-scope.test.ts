/**
 * The scope preview must agree with the sync gate.
 *
 * A preview is only worth printing if it is the same answer the upload will
 * reach. If it drifts, it stops being a decision the user makes and becomes a
 * reassurance we invented — which is worse than printing nothing, because the
 * user acts on it.
 *
 * These tests drive the preview through a throwaway CHAT_RECALL_CLAUDE_HOME and
 * assert the counts move when a RULE moves, including the hyphenated-path case
 * that made `exclude project` silently not match (see project-path-match.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summariseSyncScope } from './sync-scope.js';
import { saveSettings, loadSettings, _resetSettingsCacheForTests } from './settings.js';
import { resetProjectResolverCache } from './project-resolver.js';

let root = '';

/** A transcript in the shape the Claude backend lists: the project folder is the
 *  path with separators replaced by '-', which is the lossy encoding the gate
 *  has to cope with. */
function plant(projectPath: string, sessionId: string): void {
  const dir = join(root, 'claude', 'projects', projectPath.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = (role: string, content: string, uuid: string) => JSON.stringify({
    parentUuid: null, isSidechain: false, type: role,
    message: { role, content }, uuid,
    timestamp: new Date().toISOString(), cwd: projectPath,
    sessionId, version: '2.0.0', gitBranch: 'main',
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${line('user', 'hello', 'u1')}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scope-'));
  process.env.CHAT_RECALL_CLAUDE_HOME = join(root, 'claude');
  process.env.CHAT_RECALL_DATA_DIR = join(root, 'data');
  // Every other backend points at nothing, so the counts are the fixtures alone.
  for (const v of ['CHAT_RECALL_GEMINI_HOME', 'CHAT_RECALL_CODEX_HOME', 'CHAT_RECALL_AGY_HOME',
    'CHAT_RECALL_CURSOR_HOME', 'CHAT_RECALL_CURSOR_IDE_HOME']) process.env[v] = join(root, 'none');
  process.env.CHAT_RECALL_OPENCODE_DB = join(root, 'none.db');
  mkdirSync(join(root, 'claude', 'projects'), { recursive: true });
  _resetSettingsCacheForTests?.();
  resetProjectResolverCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _resetSettingsCacheForTests?.();
  resetProjectResolverCache();
});

function setRules(mutate: (sync: ReturnType<typeof loadSettings>['sync']) => void): void {
  const s = loadSettings();
  mutate(s.sync);
  saveSettings(s);
  _resetSettingsCacheForTests?.();
  resetProjectResolverCache();
}

describe('summariseSyncScope', () => {
  test('with no rules, every session counts as included', () => {
    plant('/work/alpha', '11111111-1111-4111-8111-111111111111');
    plant('/work/beta', '22222222-2222-4222-8222-222222222222');
    const scope = summariseSyncScope();
    expect(scope.included).toBe(2);
    expect(scope.heldBack).toBe(0);
    expect(scope.projects).toHaveLength(2);
  });

  test('an excluded path moves from included to held back, with the reason', () => {
    plant('/work/alpha', '11111111-1111-4111-8111-111111111111');
    plant('/work/beta', '22222222-2222-4222-8222-222222222222');
    setRules((sync) => { sync.excludeProjects.push('/work/beta'); });

    const scope = summariseSyncScope();
    expect(scope.included).toBe(1);
    expect(scope.heldBack).toBe(1);
    expect(scope.projects.find((p) => p.projectPath.includes('beta'))?.heldBackBy).toBe('excluded-project');
  });

  test('THE HYPHEN CASE: a rule for a hyphenated path is reflected in the preview', () => {
    // `-work-chat-recall` decodes to /work/chat/recall, so a preview using a raw
    // substring test would report this project as uploading while the (fixed)
    // gate holds it back — the exact disagreement this file exists to prevent.
    plant('/work/chat-recall', '33333333-3333-4333-8333-333333333333');
    setRules((sync) => { sync.excludeProjects.push('/work/chat-recall'); });

    const scope = summariseSyncScope();
    expect(scope.included).toBe(0);
    expect(scope.heldBack).toBe(1);
    expect(scope.projects[0].heldBackBy).toBe('excluded-project');
  });

  test('an excluded tool holds back everything it produced', () => {
    plant('/work/alpha', '11111111-1111-4111-8111-111111111111');
    setRules((sync) => { sync.excludeTools.push('claude'); });

    const scope = summariseSyncScope();
    expect(scope.included).toBe(0);
    expect(scope.projects[0].heldBackBy).toBe('excluded-tool');
    expect(scope.byTool).toHaveLength(0);
  });

  test('allowlist mode reports the projects it leaves out', () => {
    plant('/work/alpha', '11111111-1111-4111-8111-111111111111');
    plant('/work/beta', '22222222-2222-4222-8222-222222222222');
    setRules((sync) => {
      sync.syncMode = 'only';
      sync.syncOnlyProjects = ['/work/alpha'];
    });

    const scope = summariseSyncScope();
    expect(scope.allowlistMode).toBe(true);
    expect(scope.included).toBe(1);
    expect(scope.projects.find((p) => p.projectPath.includes('beta'))?.heldBackBy).toBe('not-in-allowlist');
  });

  test('sessions with no project path are counted, because no path rule reaches them', () => {
    // A tool that stores transcripts under a hash rather than a project directory
    // yields an empty projectPath. `exclude project` cannot hold those back at
    // any value, and the preview has to say so rather than let a user believe
    // one path rule covered their history.
    const dir = join(root, 'claude', 'projects', 'not-a-path-shape');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '44444444-4444-4444-8444-444444444444.jsonl'),
      `${JSON.stringify({ parentUuid: null, type: 'user', message: { role: 'user', content: 'x' }, uuid: 'u1', timestamp: new Date().toISOString(), sessionId: '44444444-4444-4444-8444-444444444444' })}\n`);
    plant('/work/alpha', '11111111-1111-4111-8111-111111111111');

    const scope = summariseSyncScope();
    // Every session still counts as uploading; the point is that the no-path
    // ones are called out separately.
    expect(scope.included).toBe(2);
    expect(scope.noPathSessions + scope.projects.filter((p) => p.projectPath).reduce((n, p) => n + p.sessions, 0))
      .toBe(scope.included);
  });

  test('an empty machine reports zero rather than throwing', () => {
    const scope = summariseSyncScope();
    expect(scope.included).toBe(0);
    expect(scope.heldBack).toBe(0);
    expect(scope.projects).toEqual([]);
  });
});
