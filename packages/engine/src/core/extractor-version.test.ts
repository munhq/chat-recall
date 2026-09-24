import { describe, test, expect } from 'vitest';
import { extractorVersionForTool, extractorVersionForId, extractorVersionForItem, toolOfId, EXTRACTOR_VERSION } from './extractor-version.js';

describe('toolOfId — works for item ids (plans/tasks), not just sessions', () => {
  test('derives the tool from the id prefix', () => {
    expect(toolOfId('agy_plan_c4d7feab_implementation_plan')).toBe('agy');
    expect(toolOfId('gemini_plan_sess_investigation')).toBe('gemini');
    expect(toolOfId('opencode_plan_x')).toBe('opencode');
    expect(toolOfId('cursor_plan_x')).toBe('cursor');
    expect(toolOfId('auth-rework')).toBe('claude'); // bare claude plan name
  });
  test('an agy item is version-stale against a base-seeded ledger, others are not', () => {
    // Seeded (unrecorded) tools default to base; only agy was bumped → only agy
    // items re-ship on the first run after the bump.
    const seed = EXTRACTOR_VERSION;
    expect(seed < extractorVersionForId('agy_plan_x')).toBe(true);   // agy re-ships
    expect(seed < extractorVersionForId('claude-plan')).toBe(true);  // claude re-ships too now
    expect(seed < extractorVersionForId('gemini_plan_x')).toBe(false);
  });
});

describe('per-tool extractor version', () => {
  test('a tool-specific bump does NOT raise other tools (no blanket resync)', () => {
    const claude = extractorVersionForTool('claude');
    const agy = extractorVersionForTool('agy');
    expect(claude).toBe(EXTRACTOR_VERSION + 1);        // queued-prompt fix
    expect(extractorVersionForTool('gemini')).toBe(EXTRACTOR_VERSION);
    expect(extractorVersionForTool('opencode')).toBe(EXTRACTOR_VERSION);
    expect(extractorVersionForTool('cursor')).toBe(EXTRACTOR_VERSION);
    expect(agy).toBe(EXTRACTOR_VERSION + 3);           // agy dropped the project fallback
  });

  test('derives the tool from the prefixed session id', () => {
    expect(extractorVersionForId('agy_abc')).toBe(EXTRACTOR_VERSION + 3);
    expect(extractorVersionForId('gemini_abc')).toBe(EXTRACTOR_VERSION);
    expect(extractorVersionForId('f8268be2-uuid')).toBe(EXTRACTOR_VERSION + 1); // claude, no prefix
  });

  test('a v=BASE ledger row re-ships ONLY for the bumped tool', () => {
    const rowV = EXTRACTOR_VERSION; // what every session recorded before the bumps
    expect(rowV < extractorVersionForTool('claude')).toBe(true);   // re-ship
    expect(rowV < extractorVersionForTool('agy')).toBe(true);     // re-ship
  });
});

describe('extractorVersionForItem — a per-tool source bump re-ships that tool alone', () => {
  // The Codex sources started reading installed plugins. Their items were
  // never uploaded and are older than the last sync, so only a version bump
  // ships them, and it must not re-ship every other tool's skills.
  test("codex skills and plugins sit one above other tools' skills and plugins", () => {
    const base = (id: string, t: string) => extractorVersionForTool(toolOfId(id)) + (t === 'mcp' ? 2 : 1);
    expect(extractorVersionForItem('codex_skill_x', 'skill')).toBe(base('codex_skill_x', 'skill') + 1);
    expect(extractorVersionForItem('codex_plugin_x', 'plugin')).toBe(extractorVersionForTool('codex') + 1);
    expect(extractorVersionForItem('claude_skill_x', 'skill')).toBe(base('claude_skill_x', 'skill'));
    expect(extractorVersionForItem('codex_mcp_x', 'mcp')).toBe(base('codex_mcp_x', 'mcp'));
  });
});
