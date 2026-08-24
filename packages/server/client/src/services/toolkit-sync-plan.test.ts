/**
 * The rules that stop the sync matrix queueing copies that cannot run.
 *
 * The bug this pins: with an MCP present on a laptop's opencode and nowhere on
 * the desktop, ticking the desktop's opencode cell used to send
 * fromTool=opencode → toTool=opencode (the laptop cell picked as source, its
 * device thrown away), which the server rejects 400 "fromTool and toTool are
 * the same". Nine of those in one apply is what started this.
 */
import { describe, test, expect } from 'vitest';
import { splitPresenceKey, sourceToolOnDevice, deviceHasArtifact, noSourceMessage } from './toolkit-sync-plan';
import type { ToolkitMatrix } from './api';

const matrix = (mcp: Record<string, Record<string, string>>): ToolkitMatrix => ({
  skill: {}, mcp, command: {}, agent: {}, instructions: {},
  devices: ['desktop', 'laptop'],
  supportedTargets: {} as ToolkitMatrix['supportedTargets'],
});

describe('splitPresenceKey', () => {
  test('splits on the LAST colon so device ids may contain colons', () => {
    expect(splitPresenceKey('desktop:opencode')).toEqual({ device: 'desktop', tool: 'opencode' });
    expect(splitPresenceKey('dev:box:1:codex')).toEqual({ device: 'dev:box:1', tool: 'codex' });
  });
});

describe('sourceToolOnDevice', () => {
  const m = matrix({
    chatrecall: { 'laptop:opencode': 'row1', 'laptop:codex': 'row2', 'desktop:claude': 'row3' },
  });

  test('never returns the target tool itself (the 400 that started this)', () => {
    // The only opencode copy of this MCP lives on the laptop; the desktop's
    // opencode column must NOT be fed from it.
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'desktop', 'opencode')).toBe('claude');
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'laptop', 'opencode')).toBe('codex');
  });

  test('never crosses devices — a copy runs on the target machine only', () => {
    // desktop holds it under claude alone, so filling desktop's claude cell is
    // impossible even though the laptop has two other copies.
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'desktop', 'claude')).toBeNull();
  });

  test('a device with no copy at all has no source', () => {
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'never-synced-pc', 'codex')).toBeNull();
  });

  test('falsy cells are not sources, and unknown names are safe', () => {
    const empty = matrix({ ghost: { 'desktop:claude': '' } });
    expect(sourceToolOnDevice(empty, 'mcp', 'ghost', 'desktop', 'codex')).toBeNull();
    expect(sourceToolOnDevice(empty, 'mcp', 'absent', 'desktop', 'codex')).toBeNull();
  });
});

describe('deviceHasArtifact', () => {
  const presence = { 'laptop:opencode': 'row1', 'desktop:claude': 'row2', 'other:codex': '' };

  test('true only when that device holds it under some tool', () => {
    expect(deviceHasArtifact(presence, 'laptop')).toBe(true);
    expect(deviceHasArtifact(presence, 'desktop')).toBe(true);
    expect(deviceHasArtifact(presence, 'other')).toBe(false);   // cell present but falsy
    expect(deviceHasArtifact(presence, 'unknown')).toBe(false);
  });
});

describe('noSourceMessage', () => {
  test('names the device and says why, instead of "failed"', () => {
    expect(noSourceMessage('ripgrep', 'desktop-pc')).toContain('desktop-pc');
    expect(noSourceMessage('ripgrep', 'desktop-pc')).toContain("can't pull files from another device");
    expect(noSourceMessage('ripgrep', 'local')).toContain('this machine');
  });
});
