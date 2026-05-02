import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PlanSource } from './plan-source.js';

let tmpHome: string;
const origHome = process.env.HOME;
beforeEach(() => { tmpHome = mkdtempSync(join(tmpdir(), 'plan-')); process.env.HOME = tmpHome; });
afterEach(() => { process.env.HOME = origHome; rmSync(tmpHome, { recursive: true, force: true }); });

describe('PlanSource', () => {
  test('discovers Claude plans in ~/.claude/plans/*.md and tags tool=claude', async () => {
    const dir = join(tmpHome, '.claude', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth-rework.md'), `# Auth Rework Plan
## Context
Replace OAuth with passkeys.`);
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const claudePlan = items.find(i => i.extra?.tool === 'claude');
    expect(claudePlan).toBeDefined();
    expect(claudePlan.title).toMatch(/Auth Rework/);
  });

  test('flags agent plans (filename suffix -agent-<hash>)', async () => {
    const dir = join(tmpHome, '.claude', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'foo-agent-abcd123.md'), '# foo agent plan');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    expect(items[0].extra.isAgentPlan).toBe(true);
  });

  test('discovers Gemini plans under ~/.gemini/tmp/<sha>/<uuid>/plans/*.md', async () => {
    const dir = join(tmpHome, '.gemini', 'tmp', 'sha1', 'sess1', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'investigation.md'), '# Investigation\nbody');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const gemini = items.find(i => i.extra?.tool === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini.id).toMatch(/^gemini_plan_/);
  });

  test('discovers OpenCode plans at ~/.local/share/opencode/plans/*.md', async () => {
    const dir = join(tmpHome, '.local', 'share', 'opencode', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'event-driven.md'), '# Event-driven plan');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const oc = items.find(i => i.extra?.tool === 'opencode');
    expect(oc).toBeDefined();
  });

  test('parse() splits a plan by ## headers into multiple chunks', async () => {
    const dir = join(tmpHome, '.claude', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'p.md'), `# Title\n## Section A\n${'a '.repeat(40)}\n## Section B\n${'b '.repeat(40)}`);
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const chunks = await src.parse(items[0]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});
