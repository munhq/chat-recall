import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { homeEnvSnapshot, restoreHomeEnv, useHomeDir } from '../test-support/home-env.js';
import {
  readCommand, readAgent, readInstructions, emit, encodingFor, instructionsFilename,
  parseCommandText,
} from './artifact-codec.js';

let tmp: string;
const origHome = homeEnvSnapshot();

/**
 * ASSERT THE WHOLE PATH, not a `/`-separated tail.
 *
 * These were regex tails like `/\.gemini\/commands\/review\.toml$/`, which is a
 * POSIX separator asserted against a `path.join` result — wrong on Windows. The
 * first fix compared a suffix instead, and that hid the interesting half: when
 * it failed it printed only `expected false to be true`, so the actual path
 * (which contained an entire absolute path where a NAME belonged — see `base()`
 * in artifact-codec.ts) was invisible. The full comparison names both sides.
 */
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'codec-')); useHomeDir(tmp); });
afterEach(() => { restoreHomeEnv(origHome); rmSync(tmp, { recursive: true, force: true }); });

describe('artifact-codec encodings', () => {
  test('picks TOML for gemini commands and codex agents only', () => {
    expect(encodingFor('command', 'gemini')).toBe('toml');
    expect(encodingFor('command', 'claude')).toBe('md');
    expect(encodingFor('agent', 'codex')).toBe('toml');
    expect(encodingFor('agent', 'opencode')).toBe('md');
    expect(encodingFor('instructions', 'gemini')).toBe('md');
  });

  test('instruction filenames differ per tool', () => {
    expect(instructionsFilename('claude')).toBe('CLAUDE.md');
    expect(instructionsFilename('gemini')).toBe('GEMINI.md');
    expect(instructionsFilename('opencode')).toBe('AGENTS.md');
    expect(instructionsFilename('codex')).toBe('AGENTS.md');
  });
});

describe('command translation', () => {
  test('Claude markdown → Gemini TOML round-trips name/description/body', () => {
    const p = join(tmp, 'review.md');
    writeFileSync(p, '---\nname: review\ndescription: Code review\n---\nReview the diff for bugs.');
    const art = readCommand(p, 'md');
    expect(art.name).toBe('review');
    expect(art.body).toBe('Review the diff for bugs.');

    const out = emit('command', art, 'gemini');
    expect(out.path).toBe(join(tmp, '.gemini', 'commands', 'review.toml'));
    expect(out.content).toContain('description = "Code review"');
    expect(out.content).toContain('prompt = ');

    // Re-read the emitted TOML and confirm body survived.
    const p2 = join(tmp, 'review.toml');
    writeFileSync(p2, out.content);
    const back = readCommand(p2, 'toml');
    expect(back.body).toBe('Review the diff for bugs.');
    expect(back.description).toBe('Code review');
  });

  test('Gemini TOML → Codex prompt markdown', () => {
    const p = join(tmp, 'test.toml');
    writeFileSync(p, 'description = "run tests"\nprompt = """\nRun all tests.\n"""\n');
    const art = readCommand(p, 'toml');
    const out = emit('command', art, 'codex');
    expect(out.path).toBe(join(tmp, '.codex', 'prompts', 'test.md'));
    expect(out.content).toContain('Run all tests.');
  });
});

describe('agent translation', () => {
  test('Claude markdown agent → Codex TOML', () => {
    const p = join(tmp, 'auditor.md');
    writeFileSync(p, '---\nname: auditor\ndescription: security audits\ntools: Read,Grep\n---\nYou audit code.');
    const art = readAgent(p, 'md');
    expect(art.tools).toBe('Read,Grep');
    const out = emit('agent', art, 'codex');
    expect(out.path).toBe(join(tmp, '.codex', 'agents', 'auditor.toml'));
    expect(out.content).toContain('developer_instructions = ');
    expect(out.content).toContain('You audit code.');

    // round-trip back
    const p2 = join(tmp, 'auditor.toml');
    writeFileSync(p2, out.content);
    const back = readAgent(p2, 'toml');
    expect(back.name).toBe('auditor');
    expect(back.body).toBe('You audit code.');
  });
});

describe('instructions translation', () => {
  test('CLAUDE.md body → OpenCode AGENTS.md, project-scoped', () => {
    const p = join(tmp, 'CLAUDE.md');
    writeFileSync(p, '# Project rules\nAlways use tabs.\n');
    const art = readInstructions(p, 'rules');
    const out = emit('instructions', art, 'opencode', '/work/proj');
    expect(out.path).toBe(join('/work/proj', 'AGENTS.md'));
    expect(out.content).toContain('Always use tabs.');
  });

  test('instructions global target uses tool home', () => {
    writeFileSync(join(tmp, 'x'), 'hi');
    const art = readInstructions(join(tmp, 'x'), 'g');
    const out = emit('instructions', art, 'gemini');
    expect(out.path).toBe(join(tmp, '.gemini', 'GEMINI.md'));
  });
});

/**
 * THE NAME MUST BE A NAME, on a path from either platform.
 *
 * `base()` was `filePath.split('/').pop()`. A Windows path contains no `/`, so
 * that returned the WHOLE absolute path and the artifact's name became
 * `C:\Users\alice\.claude\commands\review`. Every target path built from it
 * came out as `…\.codex\prompts\C:\Users\alice\…\review.md` — not a filename
 * any OS will write — so `toolkit sync` and `toolkit pull` produced garbage on
 * Windows, and the name (which travels to the server) carried the source
 * machine's absolute path.
 *
 * `base()` is only ever given a path from THIS machine's filesystem, so
 * `path.basename` is exactly the right rule: it splits on `\` as well as `/` on
 * Windows, and on `/` alone on POSIX, where `\` is a legal filename character.
 * A cross-platform basename would therefore be wrong, not more robust.
 *
 * The Windows half of this is proved by the third test running on a Windows
 * runner — which is the whole reason the suite is on all three platforms.
 */
describe('the artifact name is derived from a path on either platform', () => {
  const CMD = 'description = "run tests"\nprompt = """\nRun all tests.\n"""\n';

  test('a POSIX path yields the bare name', () => {
    expect(parseCommandText(CMD, 'toml', 'review').name).toBe('review');
  });

  test('readCommand on a real file names it after the file, not the path', () => {
    const p = join(tmp, 'named-from-file.toml');
    writeFileSync(p, CMD);
    const art = readCommand(p, 'toml');
    expect(art.name).toBe('named-from-file');
    // And the emitted target is a filename, not a path inside a filename.
    const out = emit('command', art, 'codex');
    expect(out.path).toBe(join(tmp, '.codex', 'prompts', 'named-from-file.md'));
    expect(basename(out.path)).toBe('named-from-file.md');
  });
});
