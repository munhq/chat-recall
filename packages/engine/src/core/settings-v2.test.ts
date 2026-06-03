/**
 * Tests for the v2 settings schema (sources / privacy / sync) and the
 * gates wired off it: tool-paths layered resolution, source-policy
 * filtering, and secret-redactor settings opt-in.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  loadSettings,
  saveSettings,
  redactSettings,
  mergeSettings,
} from './settings.js';
import { claudeHomeDir, _resetSourceSettingsCache } from './tool-paths.js';
import { isItemAllowed, _resetSourcePolicyCache, policyKeyFor } from './source-policy.js';
import {
  isRedactionEnabled,
  redactSecrets,
  redactFilePaths,
  _resetRedactorCache,
  _resetPrivacyCache,
} from './secret-redactor.js';
import type { MemoryItem } from '../types/memory.js';

let tmpRoot: string;
const ORIG_DATA_DIR = process.env.CHAT_RECALL_DATA_DIR;
const ORIG_CLAUDE_HOME = process.env.CHAT_RECALL_CLAUDE_HOME;
const ORIG_REDACT = process.env.CHAT_RECALL_REDACT_INDEX;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cr-settings-v2-'));
  process.env.CHAT_RECALL_DATA_DIR = tmpRoot;
  delete process.env.CHAT_RECALL_CLAUDE_HOME;
  delete process.env.CHAT_RECALL_REDACT_INDEX;
  _resetSourceSettingsCache();
  _resetSourcePolicyCache();
  _resetRedactorCache();
  _resetPrivacyCache();
});

afterEach(() => {
  if (ORIG_DATA_DIR !== undefined) process.env.CHAT_RECALL_DATA_DIR = ORIG_DATA_DIR;
  else delete process.env.CHAT_RECALL_DATA_DIR;
  if (ORIG_CLAUDE_HOME !== undefined) process.env.CHAT_RECALL_CLAUDE_HOME = ORIG_CLAUDE_HOME;
  else delete process.env.CHAT_RECALL_CLAUDE_HOME;
  if (ORIG_REDACT !== undefined) process.env.CHAT_RECALL_REDACT_INDEX = ORIG_REDACT;
  else delete process.env.CHAT_RECALL_REDACT_INDEX;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function settingsFile(): string {
  return join(tmpRoot, 'settings', 'settings.json');
}

function writeSettings(content: object): void {
  mkdirSync(join(tmpRoot, 'settings'), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(content));
  // Caches in tool-paths / source-policy / secret-redactor are mtime-keyed.
  // mkdtemp gives microsecond mtime resolution; explicit cache reset covers
  // the (rare) case where two writes land in the same mtime bucket.
  _resetSourceSettingsCache();
  _resetSourcePolicyCache();
  _resetRedactorCache();
  _resetPrivacyCache();
}

// ---------------------------------------------------------------------------
// Schema migration v1 → v2
// ---------------------------------------------------------------------------

describe('schema migration v1 → v3', () => {
  test('v1 file lacking sources/privacy/sync/team gets safe defaults filled in', () => {
    writeSettings({
      v: 1,
      embedding: { provider: 'ollama', ollamaModel: 'nomic-embed-text' },
      summary:   { provider: 'none' },
    });
    const s = loadSettings();
    expect(s.v).toBe(3);
    expect(s.embedding.provider).toBe('ollama');
    expect(s.sources.enabled.claude.sessions).toBe(true);
    expect(s.sources.enabled.gemini.brain).toBe(true);
    expect(s.privacy.redactIndex).toBe(false);
    expect(s.privacy.projectDenylist).toEqual([]);
    expect(s.sync.enabled).toBe(false);
    expect(s.sync.upload.findings).toBe(true);
    expect(s.team.enabled).toBe(false);
    expect(s.team.publishAllowed.skills).toBe(true);
    expect(s.team.publishAllowed.hooks).toBe(false);     // opt-in: code execution
    expect(s.team.publishAllowed.instructions).toBe(false);  // opt-in: project conventions
    expect(s.team.publishAllowed.plugins).toBe(true);
    expect(s.team.publishAllowed.mcps).toBe(true);
  });

  test('v2 file (no team block) gets team defaults filled in on load', () => {
    writeSettings({
      v: 2,
      embedding: { provider: 'none' },
      summary:   { provider: 'none' },
      sources: { enabled: { claude: { sessions: true } } },
      privacy: { projectDenylist: ['/x'] },
      sync:    { enabled: false, upload: {}, excludeTools: [], excludeProjects: [] },
    });
    const s = loadSettings();
    expect(s.v).toBe(3);
    expect(s.privacy.projectDenylist).toEqual(['/x']);  // preserved
    expect(s.team.enabled).toBe(false);
    expect(s.team.publishAllowed.skills).toBe(true);
  });

  test('partial v2 file keeps unspecified per-source toggles at default', () => {
    writeSettings({
      v: 2,
      embedding: { provider: 'none' },
      summary:   { provider: 'none' },
      sources: {
        enabled: { claude: { pasteCache: false } },
      },
    });
    const s = loadSettings();
    expect(s.sources.enabled.claude.pasteCache).toBe(false);
    expect(s.sources.enabled.claude.sessions).toBe(true);   // default kept
    expect(s.sources.enabled.gemini.sessions).toBe(true);   // sibling tool unaffected
  });

  test('redactSettings preserves new blocks but masks secrets', () => {
    const s = loadSettings();
    s.summary.anthropicApiKey = 'sk-test-1234567890';
    s.privacy.projectDenylist = ['/home/me/secret'];
    const r = redactSettings(s);
    expect(r.summary.anthropicApiKey?.startsWith('••••')).toBe(true);
    expect(r.privacy.projectDenylist).toEqual(['/home/me/secret']);
    expect(r.sources).toBeDefined();
    expect(r.sync).toBeDefined();
  });

  test('mergeSettings deep-merges per-tool enable maps without clobbering', () => {
    const cur = loadSettings();
    cur.sources.enabled.claude.pasteCache = true;
    const merged = mergeSettings(cur, {
      sources: { enabled: { gemini: { brain: false } } } as any,
    });
    expect(merged.sources.enabled.gemini.brain).toBe(false);
    expect(merged.sources.enabled.claude.pasteCache).toBe(true);  // unchanged
    expect(merged.sources.enabled.claude.sessions).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layered path resolver: env > settings > default
// ---------------------------------------------------------------------------

describe('tool-paths layered resolution', () => {
  test('env beats settings beats default', () => {
    // Default
    expect(claudeHomeDir().endsWith('.claude')).toBe(true);

    // Settings layer
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      sources: { claudeHome: '/tmp/from-settings', enabled: {} },
    });
    expect(claudeHomeDir()).toBe('/tmp/from-settings');

    // Env layer (highest)
    process.env.CHAT_RECALL_CLAUDE_HOME = '/tmp/from-env';
    expect(claudeHomeDir()).toBe('/tmp/from-env');
  });
});

// ---------------------------------------------------------------------------
// Source policy: enable flag + project allow/denylist + paste-cache hard-skip
// ---------------------------------------------------------------------------

function sessionItem(opts: { tool: 'claude' | 'gemini' | 'codex' | 'opencode'; project: string }): MemoryItem {
  return {
    id: 'sess-1', sourceType: 'session', title: 't',
    projectPath: opts.project, filePath: '/tmp/x.jsonl', mtime: 0,
    extra: { tool: opts.tool },
  };
}

describe('source-policy gating', () => {
  test('disabled source rejects items', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      sources: { enabled: { gemini: { sessions: false } } },
    });
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/p' }))).toBe(true);
    expect(isItemAllowed(sessionItem({ tool: 'gemini', project: '/p' }))).toBe(false);
  });

  test('project denylist filters items by exact + subtree + trailing /*', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: { projectDenylist: ['/home/me/secret', '/home/me/work/*'] },
    });
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/secret' }))).toBe(false);
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/secret/sub' }))).toBe(false);
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/work/foo' }))).toBe(false);
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/work/foo/deep' }))).toBe(true);  // /* is one level
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/public' }))).toBe(true);
  });

  test('non-empty allowlist rejects everything outside it', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: { projectAllowlist: ['/home/me/code'] },
    });
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/code/x' }))).toBe(true);
    expect(isItemAllowed(sessionItem({ tool: 'claude', project: '/home/me/elsewhere' }))).toBe(false);
  });

  test('paste-cache hard-skip beats source enable flag', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: { redactPasteCache: true },
      sources: { enabled: { claude: { pasteCache: true } } },
    });
    const paste: MemoryItem = {
      id: 'p1', sourceType: 'paste', title: 't', projectPath: '', filePath: '/x', mtime: 0,
    };
    expect(isItemAllowed(paste)).toBe(false);
  });

  test('policyKeyFor maps tool + sourceType correctly', () => {
    expect(policyKeyFor(sessionItem({ tool: 'gemini', project: '/p' }))).toBe('gemini.sessions');
    expect(policyKeyFor({ ...sessionItem({ tool: 'claude', project: '/p' }), sourceType: 'plugin', extra: { tool: 'gemini' } } as MemoryItem))
      .toBe('gemini.extensions');
    expect(policyKeyFor({ id: 'd', sourceType: 'diary', title: '', projectPath: '', filePath: '', mtime: 0 })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Secret redactor: settings opt-in, env still wins, custom rules merged
// ---------------------------------------------------------------------------

describe('secret-redactor settings integration', () => {
  test('disabled by default; enabled via settings', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
    });
    expect(isRedactionEnabled()).toBe(false);
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toBe('AKIAIOSFODNN7EXAMPLE');

    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: { redactIndex: true },
    });
    expect(isRedactionEnabled()).toBe(true);
    expect(redactSecrets('AKIAIOSFODNN7EXAMPLE')).toMatch(/\[REDACTED:aws-access-token\]/);
  });

  test('env wins over settings when set', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: { redactIndex: true },
    });
    process.env.CHAT_RECALL_REDACT_INDEX = 'false';
    expect(isRedactionEnabled()).toBe(false);
  });

  test('user redactionRules merge with defaults', () => {
    writeSettings({
      v: 2, embedding: { provider: 'none' }, summary: { provider: 'none' },
      privacy: {
        redactIndex: true,
        redactionRules: [{ label: 'tenant-token', pattern: 'TENANT_[A-Z0-9]{8}' }],
      },
    });
    const out = redactSecrets('value=TENANT_ABCDEF12 and AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED:tenant-token]');
    expect(out).toContain('[REDACTED:aws-access-token]');
  });

  test('redactFilePaths hashes absolute paths deterministically', () => {
    const t1 = redactFilePaths('open /home/me/secret/api.key here');
    const t2 = redactFilePaths('open /home/me/secret/api.key here');
    expect(t1).toBe(t2);
    expect(t1).toMatch(/\[path:[0-9a-f]{12}\]/);
    expect(t1).not.toContain('/home/me/secret/api.key');
  });
});
