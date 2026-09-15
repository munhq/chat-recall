/**
 * What these pin.
 *
 * `recall_smart_resume` covered ONE session, and a bare call took the globally
 * newest one. Asked to continue work in a repo, it answered with an unrelated
 * session from another project — the newest thing the machine had run — and
 * nothing in the output said which project it came from. The answer read as
 * authoritative and was about the wrong work.
 *
 * So two things are pinned: a digest always states its own project, and a set
 * that spans projects says so.
 */
import { describe, test, expect } from 'vitest';
import {
  formatDigest,
  crossProjectNote,
  digestTitle,
  projectName,
  splitSummary,
  bulletLines,
  type RecentRow,
} from './resume-digest.js';

const row: RecentRow = {
  sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
  projectPath: '/home/user/code/example',
  modified: '2026-09-13T17:50:11.000Z',
  firstPrompt: 'add the trial reminder sweep',
  summary: 'Added a dual-track reminder keyed on days remaining.',
  tool: 'claude',
};

describe('formatDigest', () => {
  test('states the project, so a cross-project row cannot read as this one', () => {
    const out = formatDigest({ row }).join('\n');
    expect(out).toContain('**Project:** example');
  });

  test('carries the session id, so the reader can open it', () => {
    expect(formatDigest({ row }).join('\n')).toContain(row.sessionId);
  });

  test('prints the outcome with its edit counts', () => {
    const out = formatDigest({
      row,
      outcome: {
        status: 'shipped', reason: 'commits landed',
        fileCount: 3, totalLinesAdded: 120, totalLinesRemoved: 4,
        commits: { totalCommits: 2 },
      },
    }).join('\n');
    expect(out).toContain('🚢 **shipped** — commits landed');
    expect(out).toContain('3 file(s) +120/−4');
    expect(out).toContain('2 commit(s)');
  });

  test('omits the edit counts when the session changed nothing', () => {
    const out = formatDigest({
      row,
      outcome: {
        status: 'abandoned', reason: 'no commits',
        fileCount: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
      },
    }).join('\n');
    expect(out).toContain('🪦 **abandoned**');
    expect(out).not.toContain('file(s)');
  });

  test('lists the decisions, because a choice two sessions back still governs', () => {
    const out = formatDigest({
      row,
      outcome: {
        status: 'shipped', reason: 'ok', fileCount: 1, totalLinesAdded: 1, totalLinesRemoved: 0,
        decisions: [{ text: 'We chose Postgres over SQLite.' }],
      },
    }).join('\n');
    expect(out).toContain('**Decisions:**');
    expect(out).toContain('We chose Postgres over SQLite.');
  });

  test('lists task links and ignores every other link type', () => {
    const out = formatDigest({
      row,
      related: {
        links: [
          { sourceType: 'task', title: 'Wire the sweep' },
          { sourceType: 'plan', title: 'Trial plan' },
        ],
      },
    }).join('\n');
    expect(out).toContain('**Task lists:**');
    expect(out).toContain('- Wire the sweep');
    expect(out).not.toContain('Trial plan');
  });

  test('trims a long summary rather than pasting a whole session in', () => {
    const long = 'x'.repeat(900);
    const out = formatDigest({ row: { ...row, summary: long } }, 400).join('\n');
    expect(out).toContain('…');
    expect(out).not.toContain('x'.repeat(500));
  });

  test('a missing outcome drops the line instead of printing a placeholder', () => {
    const out = formatDigest({ row, outcome: null }).join('\n');
    expect(out).not.toContain('❔');
    expect(out).not.toContain('undefined');
  });
});

describe('digestTitle', () => {
  test('a name the user gave wins over the tool title and the prompt', () => {
    expect(digestTitle({ ...row, userTitle: 'Trial mail', toolTitle: 'tool' })).toBe('Trial mail');
  });

  test('the tool title is used when the user named nothing', () => {
    expect(digestTitle({ ...row, userTitle: '   ', toolTitle: 'Tool named it' })).toBe('Tool named it');
  });

  test('newlines collapse, so one row stays one row', () => {
    expect(digestTitle({ ...row, userTitle: 'two\n\nlines' })).toBe('two lines');
  });

  test('a session with no prompt still renders', () => {
    expect(digestTitle({ sessionId: 's' })).toBe('(no prompt)');
  });
});

describe('projectName', () => {
  test('reduces a path to the name a person recognises', () => {
    expect(projectName('/home/user/code/example')).toBe('example');
  });

  test('a hashed or bare project survives unchanged', () => {
    expect(projectName('p_a760747a1301')).toBe('p_a760747a1301');
  });

  test('an absent path is empty, never the string "undefined"', () => {
    expect(projectName(undefined)).toBe('');
  });
});

describe('crossProjectNote', () => {
  test('warns when the resumed set spans more than one project', () => {
    const note = crossProjectNote('example', [
      { sessionId: 'b', projectPath: '/home/user/code/other' },
    ], false);
    expect(note).toContain('span 2 projects');
    expect(note).toContain('example');
    expect(note).toContain('other');
  });

  test('stays silent when every session is the same project', () => {
    expect(crossProjectNote('example', [
      { sessionId: 'b', projectPath: '/home/user/code/example' },
    ], false)).toBeNull();
  });

  test('stays silent when the caller already scoped the call', () => {
    expect(crossProjectNote('example', [
      { sessionId: 'b', projectPath: '/home/user/code/other' },
    ], true)).toBeNull();
  });

  test('an unknown project path never counts as a second project', () => {
    expect(crossProjectNote('example', [{ sessionId: 'b' }], false)).toBeNull();
  });
});

/**
 * The digest printed the REQUEST, every time.
 *
 * Every generated summary opens with **Request:** then **Plan:**, and slicing
 * the first 400 characters never reached past them. The reader got what was
 * asked — which the title already said — and never what happened or what was
 * left. These pin the two sections that actually answer "continue".
 */
const FULL_SUMMARY = [
  '**Request:**',
  '- Audit the marketing site for SEO.',
  '',
  '**Plan:**',
  '- Write a requirements document first.',
  '',
  '**What was done:**',
  '- Created SEO-REQUIREMENTS.md with 24 requirements.',
  '- Added a robotsTagFor function.',
  '',
  '**Remaining/Not done:**',
  '- The FAQ block is pending new copy.',
  '- Deployment pipeline did not trigger.',
].join('\n');

describe('splitSummary', () => {
  test('separates all four sections', () => {
    const s = splitSummary(FULL_SUMMARY);
    expect(s.request).toContain('Audit the marketing site');
    expect(s.plan).toContain('requirements document');
    expect(s.done).toContain('SEO-REQUIREMENTS.md');
    expect(s.remaining).toContain('FAQ block');
  });

  test('a section never bleeds into the next', () => {
    const s = splitSummary(FULL_SUMMARY);
    expect(s.done).not.toContain('FAQ block');
    expect(s.request).not.toContain('requirements document first');
  });

  test('a summary with no headings yields nothing, so the caller can fall back', () => {
    expect(splitSummary('just some prose about the session')).toEqual({});
  });

  test('an empty summary is safe', () => {
    expect(splitSummary('')).toEqual({});
  });

  test('a partial summary keeps the sections it has', () => {
    const s = splitSummary('**Request:**\n- do the thing\n\n**What was done:**\n- did it');
    expect(s.request).toContain('do the thing');
    expect(s.done).toContain('did it');
    expect(s.plan).toBeUndefined();
    expect(s.remaining).toBeUndefined();
  });
});

describe('bulletLines', () => {
  test('returns the bullets and drops the prose around them', () => {
    expect(bulletLines('intro line\n- one\n- two', 5)).toEqual(['one', 'two']);
  });

  test('flattens nested bullets, because the nesting says nothing here', () => {
    expect(bulletLines('- top\n  - nested', 5)).toEqual(['top', 'nested']);
  });

  test('stops at the cap', () => {
    expect(bulletLines('- a\n- b\n- c', 2)).toEqual(['a', 'b']);
  });

  test('truncates an over-long bullet', () => {
    const out = bulletLines(`- ${'x'.repeat(300)}`, 1, 50);
    expect(out[0]).toHaveLength(51); // 50 chars + the ellipsis
    expect(out[0].endsWith('…')).toBe(true);
  });

  test('an absent section is empty, not a crash', () => {
    expect(bulletLines(undefined, 3)).toEqual([]);
  });
});

describe('formatDigest — the conclusion, not the request', () => {
  const out = formatDigest({ row: { ...row, summary: FULL_SUMMARY } }).join('\n');

  test('shows what was done', () => {
    expect(out).toContain('**Did:**');
    expect(out).toContain('Created SEO-REQUIREMENTS.md with 24 requirements.');
  });

  test('shows what is still open — the reason to resume at all', () => {
    expect(out).toContain('**Still open:**');
    expect(out).toContain('The FAQ block is pending new copy.');
  });

  test('does not print the request or the plan; the title already carries the ask', () => {
    expect(out).not.toContain('Audit the marketing site for SEO.');
    expect(out).not.toContain('Write a requirements document first.');
  });

  test('an unstructured summary still shows its opening rather than nothing', () => {
    const plain = formatDigest({ row: { ...row, summary: 'we fixed the sync cooldown' } }).join('\n');
    expect(plain).toContain('we fixed the sync cooldown');
  });
});

/**
 * The generator groups bullets under bold labels. A label whose group is cut
 * off says nothing, and on a real session four of them filled the entire
 * budget — the digest reported a heading list and no work.
 */
describe('bulletLines — label-only bullets', () => {
  test('drops a bullet that is only a bold heading', () => {
    expect(bulletLines('- **Infrastructure/Debugging:**\n- Fixed the sync cooldown.', 4))
      .toEqual(['Fixed the sync cooldown.']);
  });

  test('keeps a label that carries its content on the same line', () => {
    expect(bulletLines('- **Documentation:** Created the requirements file.', 4))
      .toEqual(['**Documentation:** Created the requirements file.']);
  });

  test('a dropped label does not consume the budget', () => {
    const section = '- **A:**\n- **B:**\n- real one\n- real two';
    expect(bulletLines(section, 2)).toEqual(['real one', 'real two']);
  });
});
