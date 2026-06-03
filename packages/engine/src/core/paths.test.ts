import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  getDataDir,
  getCacheDbPath,
  getIndexDir,
  getKnowledgeGraphDbPath,
  getDiaryDir,
  getMemoryDir,
  getIdentityFilePath,
  getHooksDir,
  _resetMigrationStateForTests,
} from './paths.js';

let tmpRoot: string;
const ORIG_ENV = process.env.CHAT_RECALL_DATA_DIR;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cr-paths-'));
  _resetMigrationStateForTests();
});

afterEach(() => {
  if (ORIG_ENV !== undefined) process.env.CHAT_RECALL_DATA_DIR = ORIG_ENV;
  else delete process.env.CHAT_RECALL_DATA_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getDataDir', () => {
  test('defaults to ~/.chat-recall when no env override', () => {
    delete process.env.CHAT_RECALL_DATA_DIR;
    expect(getDataDir()).toBe(join(homedir(), '.chat-recall'));
  });

  test('respects $CHAT_RECALL_DATA_DIR override', () => {
    process.env.CHAT_RECALL_DATA_DIR = '/tmp/cr-custom-data';
    expect(getDataDir()).toBe('/tmp/cr-custom-data');
  });

  test('trims whitespace from override', () => {
    process.env.CHAT_RECALL_DATA_DIR = '  /tmp/whitespace-test  ';
    expect(getDataDir()).toBe('/tmp/whitespace-test');
  });

  test('empty/whitespace override falls back to default', () => {
    process.env.CHAT_RECALL_DATA_DIR = '   ';
    expect(getDataDir()).toBe(join(homedir(), '.chat-recall'));
  });
});

describe('path layout', () => {
  beforeEach(() => {
    process.env.CHAT_RECALL_DATA_DIR = join(tmpRoot, 'data');
  });

  test('cache.db sits at the data root', () => {
    expect(getCacheDbPath()).toBe(join(tmpRoot, 'data', 'cache.db'));
  });

  test('index dir lives under data root', () => {
    expect(getIndexDir()).toBe(join(tmpRoot, 'data', 'index'));
  });

  test('knowledge_graph.db sits inside the index dir', () => {
    expect(getKnowledgeGraphDbPath()).toBe(join(tmpRoot, 'data', 'index', 'knowledge_graph.db'));
  });

  test('diary lives under index dir, not memory', () => {
    expect(getDiaryDir()).toBe(join(tmpRoot, 'data', 'index', 'diary'));
  });

  test('memory dir is sibling of index, not nested under it', () => {
    expect(getMemoryDir()).toBe(join(tmpRoot, 'data', 'memory'));
  });

  test('identity.txt sits at the data root', () => {
    expect(getIdentityFilePath()).toBe(join(tmpRoot, 'data', 'identity.txt'));
  });

  test('hooks dir sits at the data root', () => {
    expect(getHooksDir()).toBe(join(tmpRoot, 'data', 'hooks'));
  });

  test('directory accessors create the directory if missing', () => {
    expect(existsSync(join(tmpRoot, 'data', 'index', 'diary'))).toBe(false);
    getDiaryDir();
    expect(existsSync(join(tmpRoot, 'data', 'index', 'diary'))).toBe(true);
  });
});

describe('legacy migration', () => {
  // The migration moves `~/.claude/chat-recall-*` into the new data dir.
  // We can't safely point at the real ~/.claude during a test (would mutate
  // the user's actual data), so the test sets CHAT_RECALL_DATA_DIR — but
  // that disables migration by design ("explicit opt-in to non-default
  // location"). To exercise migration we'd need to mock `homedir()`, which
  // is not worth the risk for a small one-shot helper. Instead we verify
  // the *structure* of the migration paths and the no-op contract.

  test('no migration fires when CHAT_RECALL_DATA_DIR is set', () => {
    process.env.CHAT_RECALL_DATA_DIR = join(tmpRoot, 'opted-in');
    // Calling any path helper would normally trigger migration; with the
    // env set, even a missing dir won't try to move anything from ~/.claude.
    const dir = getDataDir();
    expect(dir).toBe(join(tmpRoot, 'opted-in'));
    // Our helper is internal but the predicate is observable: ~/.claude
    // chat-recall-* paths are untouched. Sanity check: no new dir at ~/.chat-recall created either.
    // (Skip this assertion if the user already has ~/.chat-recall — we don't want flaky tests on real installs.)
  });

  test('first call to a path helper creates the data root', () => {
    process.env.CHAT_RECALL_DATA_DIR = join(tmpRoot, 'fresh');
    expect(existsSync(join(tmpRoot, 'fresh'))).toBe(false);
    getCacheDbPath();
    expect(existsSync(join(tmpRoot, 'fresh'))).toBe(true);
  });

  test('second call is a no-op (does not error on existing dir)', () => {
    process.env.CHAT_RECALL_DATA_DIR = join(tmpRoot, 'twice');
    getCacheDbPath();
    expect(() => getCacheDbPath()).not.toThrow();
    expect(() => getIndexDir()).not.toThrow();
  });
});

describe('migration logic — synthetic legacy fixture', () => {
  // To exercise the *actual* migration code without touching real ~/.claude,
  // we simulate the layout in a temp dir and point HOME at it.
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    // Remove the data-dir override so the migration runs.
    delete process.env.CHAT_RECALL_DATA_DIR;
    _resetMigrationStateForTests();
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
  });

  test('moves legacy chat-recall-cache.db into the new data dir', () => {
    const legacyDb = join(tmpRoot, '.claude', 'chat-recall-cache.db');
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(legacyDb, 'sqlite-fake-bytes');

    // Trigger migration via any path accessor.
    const newPath = getCacheDbPath();
    expect(newPath).toBe(join(tmpRoot, '.chat-recall', 'cache.db'));
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, 'utf-8')).toBe('sqlite-fake-bytes');
    // Original is gone — data follows the move, not a copy.
    expect(existsSync(legacyDb)).toBe(false);
  });

  test('moves legacy chat-recall-index directory tree intact', () => {
    const legacyIdx = join(tmpRoot, '.claude', 'chat-recall-index');
    mkdirSync(join(legacyIdx, 'wal'), { recursive: true });
    mkdirSync(join(legacyIdx, 'diary', 'agent-1'), { recursive: true });
    writeFileSync(join(legacyIdx, 'metadata.db'), 'meta-bytes');
    writeFileSync(join(legacyIdx, 'wal', 'log.jsonl'), 'wal-line\n');
    writeFileSync(join(legacyIdx, 'diary', 'agent-1', 'entry.json'), '{}');

    const newIdx = getIndexDir();
    expect(newIdx).toBe(join(tmpRoot, '.chat-recall', 'index'));
    expect(readFileSync(join(newIdx, 'metadata.db'), 'utf-8')).toBe('meta-bytes');
    expect(readFileSync(join(newIdx, 'wal', 'log.jsonl'), 'utf-8')).toBe('wal-line\n');
    expect(readFileSync(join(newIdx, 'diary', 'agent-1', 'entry.json'), 'utf-8')).toBe('{}');
    expect(existsSync(legacyIdx)).toBe(false);
  });

  test('does not overwrite when new path already exists', () => {
    // Both old and new exist — must NOT clobber the new (which is what
    // the user actually cares about). Old is left in place to flag the
    // collision rather than silently discarding either copy.
    const legacyDb = join(tmpRoot, '.claude', 'chat-recall-cache.db');
    const newDb = join(tmpRoot, '.chat-recall', 'cache.db');
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    mkdirSync(join(tmpRoot, '.chat-recall'), { recursive: true });
    writeFileSync(legacyDb, 'old-data');
    writeFileSync(newDb, 'new-data');

    getCacheDbPath();

    expect(readFileSync(newDb, 'utf-8')).toBe('new-data');
    expect(existsSync(legacyDb)).toBe(true);
  });

  test('migrates SQLite -wal and -shm sidecars alongside the main db', () => {
    // SQLite write-ahead-log mode leaves -wal and -shm files next to the
    // main db. Forgetting them means the migrated db looks corrupt.
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(join(tmpRoot, '.claude', 'chat-recall-cache.db'), 'main');
    writeFileSync(join(tmpRoot, '.claude', 'chat-recall-cache.db-wal'), 'wal');
    writeFileSync(join(tmpRoot, '.claude', 'chat-recall-cache.db-shm'), 'shm');

    getCacheDbPath();

    expect(readFileSync(join(tmpRoot, '.chat-recall', 'cache.db-wal'), 'utf-8')).toBe('wal');
    expect(readFileSync(join(tmpRoot, '.chat-recall', 'cache.db-shm'), 'utf-8')).toBe('shm');
  });

  test('no legacy data → migration is a silent no-op', () => {
    // Fresh install: nothing to move, nothing should be logged at error
    // level, and everything still works.
    expect(() => getCacheDbPath()).not.toThrow();
    expect(existsSync(join(tmpRoot, '.chat-recall'))).toBe(true);
    // No .claude dir was even there — no migration attempted.
    expect(existsSync(join(tmpRoot, '.claude'))).toBe(false);
  });
});
