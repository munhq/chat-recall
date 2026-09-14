import { describe, test, expect } from 'vitest';
import {
  extractTaskIds, parseCommitLog, planCloses, parseChangedFiles,
  mayClaim, mayClose, COMMIT_LOG_FORMAT, MAX_EVIDENCE_COMMITS, MAX_EVIDENCE_FILES,
} from './task-hook.js';

/** The id SHAPE: `t_` plus 18 hex characters. Invented, not read off a board. */
const ID_A = 't_0123456789abcdef01';
const ID_B = 't_fedcba9876543210fe';

describe('extractTaskIds', () => {
  test('finds an id in a sentence', () => {
    expect(extractTaskIds(`please work on ${ID_A} now`)).toEqual([ID_A]);
  });

  test('finds several, in order, deduped', () => {
    const text = `${ID_B} then ${ID_A} then ${ID_B} again`;
    expect(extractTaskIds(text)).toEqual([ID_B, ID_A]);
  });

  test('accepts the id as it is written in upper case', () => {
    expect(extractTaskIds(ID_A.toUpperCase())).toEqual([ID_A]);
  });

  test('ignores an id that is part of a longer token', () => {
    expect(extractTaskIds(`${ID_A}00`)).toEqual([]);
    expect(extractTaskIds(`x${ID_A}`)).toEqual([]);
  });

  test('ignores the wrong length and non-hex characters', () => {
    expect(extractTaskIds('t_0123456789abcdef0')).toEqual([]);       // 17
    expect(extractTaskIds('t_0123456789abcdefzz')).toEqual([]);      // z is not hex
    expect(extractTaskIds('t_')).toEqual([]);
  });

  test('empty input answers with nothing', () => {
    expect(extractTaskIds('')).toEqual([]);
    expect(extractTaskIds(null)).toEqual([]);
    expect(extractTaskIds(undefined)).toEqual([]);
  });

  test('a second call is not affected by the first', () => {
    // A module-level /g regex keeps `lastIndex`; matchAll must not leak it.
    expect(extractTaskIds(ID_A)).toEqual([ID_A]);
    expect(extractTaskIds(ID_A)).toEqual([ID_A]);
  });
});

describe('parseCommitLog', () => {
  const record = (sha: string, message: string) => `${sha}\x1f${message}\x1e`;

  test('reads sha and full multi-line message', () => {
    const raw = record('a1b2c3d4e5f6a7b8', `fix the leak\n\nCloses ${ID_A}\n`);
    const got = parseCommitLog(raw);
    expect(got).toHaveLength(1);
    expect(got[0].sha).toBe('a1b2c3d4e5f6a7b8');
    expect(got[0].message).toContain(ID_A);
  });

  test('reads several commits', () => {
    const raw = record('aaaaaaa', 'one') + record('bbbbbbb', 'two');
    expect(parseCommitLog(raw).map((c) => c.sha)).toEqual(['aaaaaaa', 'bbbbbbb']);
  });

  test('drops a record with no separator or a sha that is not hex', () => {
    expect(parseCommitLog('garbage\x1e')).toEqual([]);
    expect(parseCommitLog(record('nothex!', 'msg'))).toEqual([]);
  });

  test('empty input answers with nothing', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog(null)).toEqual([]);
  });

  test('the format string asks git for exactly what the parser reads', () => {
    expect(COMMIT_LOG_FORMAT).toBe('%H%x1f%B%x1e');
  });
});

describe('planCloses', () => {
  test('groups every commit that names a card', () => {
    const got = planCloses([
      { sha: 'aaaaaaa', message: `part one of ${ID_A}` },
      { sha: 'bbbbbbb', message: `part two of ${ID_A}` },
    ]);
    expect(got).toEqual([{ id: ID_A, commits: ['aaaaaaa', 'bbbbbbb'] }]);
  });

  test('one commit naming two cards counts for both', () => {
    const got = planCloses([{ sha: 'aaaaaaa', message: `${ID_A} and ${ID_B}` }]);
    expect(got).toEqual([
      { id: ID_A, commits: ['aaaaaaa'] },
      { id: ID_B, commits: ['aaaaaaa'] },
    ]);
  });

  test('a commit naming nothing produces no intent', () => {
    expect(planCloses([{ sha: 'aaaaaaa', message: 'a normal commit' }])).toEqual([]);
  });

  test('the same sha is recorded once', () => {
    const got = planCloses([{ sha: 'aaaaaaa', message: `${ID_A} ${ID_A}` }]);
    expect(got[0].commits).toEqual(['aaaaaaa']);
  });

  test('the evidence list is capped', () => {
    const commits = Array.from({ length: MAX_EVIDENCE_COMMITS + 5 }, (_, i) => ({
      sha: `${i}`.padStart(7, '0'),
      message: ID_A,
    }));
    expect(planCloses(commits)[0].commits).toHaveLength(MAX_EVIDENCE_COMMITS);
  });
});

describe('parseChangedFiles', () => {
  test('reads repo-relative paths and dedupes', () => {
    const raw = 'packages/cli/src/cli.ts\npackages/cli/src/cli.ts\nhooks/x.sh\n';
    expect(parseChangedFiles(raw)).toEqual(['packages/cli/src/cli.ts', 'hooks/x.sh']);
  });

  test('drops a path that climbs out of the repository', () => {
    // The server refuses these; dropping them here keeps the rest of the
    // evidence from being refused with them.
    const raw = '/etc/passwd\n~/secret\n../other-repo/file.ts\nsrc/ok.ts\n';
    expect(parseChangedFiles(raw)).toEqual(['src/ok.ts']);
  });

  test('ignores blank lines', () => {
    expect(parseChangedFiles('\n\n  \nsrc/a.ts\n')).toEqual(['src/a.ts']);
  });

  test('the file list is capped', () => {
    const raw = Array.from({ length: MAX_EVIDENCE_FILES + 10 }, (_, i) => `src/f${i}.ts`).join('\n');
    expect(parseChangedFiles(raw)).toHaveLength(MAX_EVIDENCE_FILES);
  });

  test('empty input answers with nothing', () => {
    expect(parseChangedFiles('')).toEqual([]);
    expect(parseChangedFiles(null)).toEqual([]);
  });
});

describe('mayClaim', () => {
  const S = 'sess-1';

  test('claims a card nobody has started', () => {
    expect(mayClaim('todo', null, S)).toBe(true);
  });

  test('leaves a card another session is working on', () => {
    expect(mayClaim('in_progress', 'sess-2', S)).toBe(false);
  });

  test('does not re-claim a card this session already holds', () => {
    expect(mayClaim('in_progress', S, S)).toBe(false);
  });

  test('never reopens a verdict', () => {
    for (const status of ['done', 'closed', 'rejected', 'blocked']) {
      expect(mayClaim(status, null, S)).toBe(false);
    }
  });

  test('without a session id nothing is claimed', () => {
    // The card asserts that a session did the work; with no id there is
    // nothing for the board to check.
    expect(mayClaim('todo', null, '')).toBe(false);
  });
});

describe('mayClose', () => {
  test('closes an open card', () => {
    expect(mayClose('todo')).toBe(true);
    expect(mayClose('in_progress')).toBe(true);
  });

  test('a card that already ended stays as it is', () => {
    for (const status of ['done', 'closed', 'rejected']) {
      expect(mayClose(status)).toBe(false);
    }
  });

  test('an unknown status is not closed', () => {
    expect(mayClose(undefined)).toBe(false);
    expect(mayClose('surprise')).toBe(false);
  });
});
