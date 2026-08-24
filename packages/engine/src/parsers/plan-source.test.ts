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

  test('frontmatter session_id links plan → session, cwd sets projectPath, body is stripped', async () => {
    const dir = join(tmpHome, '.claude', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'video-stack.md'), `---
session_id: 23e2a716-ea62-417c-8cd6-f4ada749abe4
cwd: /home/user/code/personal/example-app
timestamp: 2026-06-29T06:16:03Z
---

# Plan: Generative Video
## Context
Some detail here.`);
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const plan = items.find(i => i.id === 'video-stack');
    expect(plan).toBeDefined();
    expect(plan.projectPath).toBe('/home/user/code/personal/example-app');
    expect(plan.title).toBe('Plan: Generative Video');
    // Body preview must not contain the frontmatter fence.
    expect(plan.contentPreview).not.toMatch(/session_id:/);

    const links = await src.extractLinks(plan);
    const sessionLink = links.find(l => l.linkType === 'plan_for_session');
    expect(sessionLink).toBeDefined();
    expect(sessionLink!.targetType).toBe('session');
    expect(sessionLink!.targetId).toBe('23e2a716-ea62-417c-8cd6-f4ada749abe4');
    // cwd basename drives the project link.
    expect(links.find(l => l.linkType === 'plan_for_project')?.targetId).toBe('example-app');
  });

  test('UUID-named plan file links to the session of the same id', async () => {
    const dir = join(tmpHome, '.claude', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f8268be2-d488-4879-9ece-4d426718a78f.md'), '# A plan\n## Body\nx');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const plan = items.find(i => i.id.startsWith('f8268be2'));
    const links = await src.extractLinks(plan);
    expect(links.find(l => l.linkType === 'plan_for_session')?.targetId)
      .toBe('f8268be2-d488-4879-9ece-4d426718a78f');
  });

  test('agent plan resolves parent session via the subagent transcript', async () => {
    const plans = join(tmpHome, '.claude', 'plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'shiny-lark-agent-a12a956c6eb5d1285.md'), '# agent plan\nbody');
    // The subagent transcript lives under <project>/<parentSession>/subagents/.
    const subDir = join(tmpHome, '.claude', 'projects', '-home-user-code-personal-meal-planner',
      'addc79f4-ccd7-47a5-8eeb-daf7fa546271', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-a12a956c6eb5d1285.jsonl'), '{}\n');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const plan = items.find(i => i.id.startsWith('shiny-lark-agent-'));
    const links = await src.extractLinks(plan);
    expect(links.find(l => l.linkType === 'plan_for_session')?.targetId)
      .toBe('addc79f4-ccd7-47a5-8eeb-daf7fa546271');
    // And it still records the parent-plan relationship.
    expect(links.find(l => l.linkType === 'agent_plan_parent')?.targetId).toBe('shiny-lark');
  });

  test('gemini plan links to its gemini_-prefixed session', async () => {
    const dir = join(tmpHome, '.gemini', 'tmp', 'sha1', 'sess-uuid-1', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'investigation.md'), '# Investigation\nbody');
    const src = new PlanSource();
    const items: any[] = [];
    for await (const i of src.discover()) items.push(i);
    const gemini = items.find(i => i.extra?.tool === 'gemini');
    const links = await src.extractLinks(gemini);
    expect(links.find(l => l.linkType === 'plan_for_session')?.targetId).toBe('gemini_sess-uuid-1');
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
