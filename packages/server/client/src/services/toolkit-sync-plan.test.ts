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
  devices: ['adi-pc', 'laptop'],
  supportedTargets: {} as ToolkitMatrix['supportedTargets'],
});

describe('splitPresenceKey', () => {
  test('splits on the LAST colon so device ids may contain colons', () => {
    expect(splitPresenceKey('adi-pc:opencode')).toEqual({ device: 'adi-pc', tool: 'opencode' });
    expect(splitPresenceKey('dev:box:1:codex')).toEqual({ device: 'dev:box:1', tool: 'codex' });
  });
});

describe('sourceToolOnDevice', () => {
  const m = matrix({
    chatrecall: { 'laptop:opencode': 'row1', 'laptop:codex': 'row2', 'adi-pc:claude': 'row3' },
  });

  test('never returns the target tool itself (the 400 that started this)', () => {
    // The only opencode copy of this MCP lives on the laptop; the desktop's
    // opencode column must NOT be fed from it.
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'adi-pc', 'opencode')).toBe('claude');
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'laptop', 'opencode')).toBe('codex');
  });

  test('never crosses devices — a copy runs on the target machine only', () => {
    // adi-pc holds it under claude alone, so filling adi-pc's claude cell is
    // impossible even though the laptop has two other copies.
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'adi-pc', 'claude')).toBeNull();
  });

  test('a device with no copy at all has no source', () => {
    expect(sourceToolOnDevice(m, 'mcp', 'chatrecall', 'never-synced-pc', 'codex')).toBeNull();
  });

  test('falsy cells are not sources, and unknown names are safe', () => {
    const empty = matrix({ ghost: { 'adi-pc:claude': '' } });
    expect(sourceToolOnDevice(empty, 'mcp', 'ghost', 'adi-pc', 'codex')).toBeNull();
    expect(sourceToolOnDevice(empty, 'mcp', 'absent', 'adi-pc', 'codex')).toBeNull();
  });
});

describe('deviceHasArtifact', () => {
  const presence = { 'laptop:opencode': 'row1', 'adi-pc:claude': 'row2', 'other:codex': '' };

  test('true only when that device holds it under some tool', () => {
    expect(deviceHasArtifact(presence, 'laptop')).toBe(true);
    expect(deviceHasArtifact(presence, 'adi-pc')).toBe(true);
    expect(deviceHasArtifact(presence, 'other')).toBe(false);   // cell present but falsy
    expect(deviceHasArtifact(presence, 'unknown')).toBe(false);
  });
});

describe('noSourceMessage', () => {
  test('names the device and says why, instead of "failed"', () => {
    expect(noSourceMessage('ripgrep', 'adi-main-pc')).toContain('adi-main-pc');
    expect(noSourceMessage('ripgrep', 'adi-main-pc')).toContain("can't pull files from another device");
    expect(noSourceMessage('ripgrep', 'local')).toContain('this machine');
  });
});
