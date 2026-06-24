import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readCommand, readAgent, readInstructions, emit, encodingFor, instructionsFilename,
} from './artifact-codec.js';

let tmp: string;
const origHome = process.env.HOME;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'codec-')); process.env.HOME = tmp; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmp, { recursive: true, force: true }); });

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
    expect(out.path).toMatch(/\.gemini\/commands\/review\.toml$/);
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
    expect(out.path).toMatch(/\.codex\/prompts\/test\.md$/);
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
    expect(out.path).toMatch(/\.codex\/agents\/auditor\.toml$/);
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
    expect(out.path).toBe('/work/proj/AGENTS.md');
    expect(out.content).toContain('Always use tabs.');
  });

  test('instructions global target uses tool home', () => {
    writeFileSync(join(tmp, 'x'), 'hi');
    const art = readInstructions(join(tmp, 'x'), 'g');
    const out = emit('instructions', art, 'gemini');
    expect(out.path).toMatch(/\.gemini\/GEMINI\.md$/);
  });
});
