/**
 * Which copy a matrix cell can actually perform.
 *
 * A `copy` sync intent is drained by the agent on the TARGET device, and that
 * agent resolves the source from its OWN filesystem (engine executeCopy →
 * discoverLocalArtifacts). Two hard constraints follow, and the grid used to
 * respect neither:
 *
 *   - the source must live on the SAME device as the target — there is no
 *     device-to-device transfer of artifact content;
 *   - the source tool must DIFFER from the target tool, or the copy is a no-op
 *     the server rejects with 400 "fromTool and toTool are the same".
 *
 * Picking "the first present cell" ignored the device half of the
 * `<device>:<tool>` presence key, so a laptop's opencode entry was offered as
 * the source for a desktop's opencode column — nine 400s in one apply.
 *
 * Pure, UI-free, and shared by every enqueue path so the rules can't drift.
 */
import type { ToolkitMatrix, SyncTool, SyncType } from './api';

/** Presence keys are `<deviceId>:<tool>`; tool ids never contain ':'. */
export function splitPresenceKey(key: string): { device: string; tool: SyncTool } {
  const i = key.lastIndexOf(':');
  return { device: key.slice(0, i), tool: key.slice(i + 1) as SyncTool };
}

/** A tool on `deviceId` that can serve as the copy source, or null if none can. */
export function sourceToolOnDevice(
  matrix: ToolkitMatrix,
  type: SyncType,
  name: string,
  deviceId: string,
  targetTool: SyncTool,
): SyncTool | null {
  const slot = matrix[type]?.[name] || {};
  for (const key of Object.keys(slot)) {
    if (!slot[key]) continue;
    const { device, tool } = splitPresenceKey(key);
    if (device === deviceId && tool !== targetTool) return tool;
  }
  return null;
}

/** Does this device hold the artifact under any tool at all? */
export function deviceHasArtifact(rowPresence: Record<string, unknown>, deviceId: string): boolean {
  return Object.keys(rowPresence)
    .some((k) => rowPresence[k] && splitPresenceKey(k).device === deviceId);
}

/** Why a cell can't be filled — the honest version, not "failed". */
export const noSourceMessage = (name: string, deviceId: string): string =>
  `"${name}" isn't on ${deviceId === 'local' ? 'this machine' : deviceId} under any other tool — `
  + `copies run on that machine and can't pull files from another device.`;
