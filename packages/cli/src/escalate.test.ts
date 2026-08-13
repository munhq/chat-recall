/**
 * Learnings extraction is a heuristic over messy transcripts, so the tests
 * pin BOTH directions: real corrections are caught (start-anchored rejections,
 * redirections, "that's not what I asked" phrases) AND the known noise
 * carriers (slash-command wrappers, caveat banners, interrupt markers, the
 * initial task prompt, giant pastes) never leak into the knowledge graph.
 */
import { describe, test, expect } from 'vitest';
import { extractCorrections, extractLearnings, clip, type ConvoMessage } from './escalate.js';

const u = (content: string): ConvoMessage => ({ role: 'user', content });
const a = (content: string): ConvoMessage => ({ role: 'assistant', content });

describe('extractCorrections', () => {
  test('catches start-anchored rejections and redirections', () => {
    const messages = [
      u('Build the sync command'),
      a('Done, I used the /tmp directory for state.'),
      u('No, use the XDG data dir instead of /tmp.'),
      a('Fixed.'),
      u("Don't hardcode the server URL, read it from credentials."),
      a('OK.'),
      u('Actually, the ledger should be append-only.'),
    ];
    expect(extractCorrections(messages)).toEqual([
      'No, use the XDG data dir instead of /tmp.',
      "Don't hardcode the server URL, read it from credentials.",
      'Actually, the ledger should be append-only.',
    ]);
  });

  test('catches contained "you got it wrong" phrases', () => {
    const messages = [
      u('task'),
      a('I refactored the whole module.'),
      u("hmm, that's not what I asked for — only rename the function."),
      a('reverted'),
      u('I think you misunderstood the ticket, it is about the CLI not the server.'),
    ];
    expect(extractCorrections(messages)).toEqual([
      "hmm, that's not what I asked for — only rename the function.",
      'I think you misunderstood the ticket, it is about the CLI not the server.',
    ]);
  });

  test('never treats the initial prompt as a correction, even if it matches', () => {
    const messages = [
      u("Don't use bash, port this script to nushell"),
      a('done'),
    ];
    expect(extractCorrections(messages)).toEqual([]);
  });

  test('skips noise carriers: command wrappers, caveats, interrupts, huge pastes', () => {
    const messages = [
      u('task'),
      a('working'),
      u('<command-name>/clear</command-name>'),
      u('Caveat: the messages below were generated...'),
      u('[Request interrupted by user]'),
      u('no, wrong file. ' + 'x'.repeat(5000)),
      u('<system-reminder>ignore</system-reminder>'),
    ];
    expect(extractCorrections(messages)).toEqual([]);
  });

  test('ignores plain approvals and questions', () => {
    const messages = [
      u('task'),
      a('done'),
      u('looks good, ship it'),
      u('can you also add tests?'),
      u('yes'),
    ];
    expect(extractCorrections(messages)).toEqual([]);
  });

  test('dedupes and caps at 5', () => {
    const messages: ConvoMessage[] = [u('task')];
    for (let i = 0; i < 8; i++) {
      messages.push(a('claim'));
      messages.push(u(`No, fix number ${i} properly.`));
      messages.push(u(`No, fix number ${i} properly.`)); // duplicate
    }
    const out = extractCorrections(messages);
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
  });
});

describe('extractLearnings', () => {
  const base = { project: 'chat-recall', messages: [u('task'), a('ok')] };

  test('maps decisions, corrections, and a terminal outcome to triples', () => {
    const learnings = extractLearnings({
      project: 'chat-recall',
      messages: [u('task'), a('claim'), u('No, use the pooler service instead.')],
      outcome: {
        status: 'shipped',
        reason: 'committed and pushed',
        decisions: [{ text: 'Use zstd for snapshot compression' }],
      },
    });
    expect(learnings).toEqual([
      { kind: 'decision', subject: 'chat-recall', predicate: 'decided', object: 'Use zstd for snapshot compression', confidence: 0.8 },
      { kind: 'correction', subject: 'chat-recall', predicate: 'user_corrected', object: 'No, use the pooler service instead.', confidence: 0.8 },
      { kind: 'outcome', subject: 'chat-recall', predicate: 'session_outcome', object: 'shipped: committed and pushed', confidence: 0.8 },
    ]);
  });

  test('drops non-terminal outcomes (in_progress / unknown) and missing outcome', () => {
    expect(extractLearnings({ ...base, outcome: { status: 'in_progress', reason: 'still going' } })).toEqual([]);
    expect(extractLearnings({ ...base, outcome: { status: 'unknown', reason: '?' } })).toEqual([]);
    expect(extractLearnings({ ...base, outcome: null })).toEqual([]);
  });

  test('caps decisions at 8', () => {
    const decisions = Array.from({ length: 12 }, (_, i) => ({ text: `decision ${i}` }));
    const learnings = extractLearnings({ ...base, outcome: { decisions } });
    expect(learnings.filter((l) => l.kind === 'decision')).toHaveLength(8);
  });
});

describe('clip', () => {
  test('collapses whitespace and cuts at a word boundary with an ellipsis', () => {
    expect(clip('a  b\n\nc')).toBe('a b c');
    const long = 'word '.repeat(60).trim();
    const clipped = clip(long, 50);
    expect(clipped.length).toBeLessThanOrEqual(51);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/wor…$/); // no mid-word cut
  });
});
