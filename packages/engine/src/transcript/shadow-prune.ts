/**
 * Bound the shadow archive. It grew forever, on the user's own disk.
 *
 * ── What the shadow is for, and why that bounds it ────────────────────────
 * The shadow is a per-session copy of the transcript, kept so a resume that
 * TRUNCATES or rewrites the live file cannot destroy records that were never
 * shipped. Its whole job is to survive the gap between "the tool wrote it" and
 * "the server has it".
 *
 * Once the server HAS it — acked, on every configured target — the shadow is a
 * second copy of data that is already safe somewhere else. That is what makes
 * pruning safe, and it is also the only thing that does: an unacked shadow may
 * be the last copy of records that exist nowhere else, so this never touches
 * one, at any age, at any size.
 *
 * ── Measured on the maintainer's machine ─────────────────────────────────
 *   1.3 GB across 15,720 files, with no retention policy of any kind.
 *
 * That is a background agent quietly consuming a gigabyte-plus of someone
 * else's laptop, and growing with every session they ever have. It is the kind
 * of thing a user discovers while hunting for disk space, and then uninstalls.
 *
 * ── The policy ───────────────────────────────────────────────────────────
 * Two limits, both applied only to fully-acked shadows:
 *   1. AGE — nothing needs resume protection 90 days after it stopped changing.
 *   2. SIZE — a total ceiling, oldest deleted first, for the corpus that is
 *      young enough to pass the age test but too large in aggregate.
 *
 * Size is enforced after age so the cheap, obviously-correct rule does most of
 * the work and the ceiling only trims what remains.
 */
import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { shadowRoot } from './shadow.js';
import type { AiTool } from '../core/tool-backend.js';

/** Nothing needs resume protection three months after it last changed. */
export const DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Total ceiling for the whole shadow archive. */
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface PruneShadowOpts {
  maxAgeMs?: number;
  maxTotalBytes?: number;
  /**
   * Has every configured sync target acked this session?
   *
   * REQUIRED, with no default, deliberately. A default of "assume acked" would
   * delete the last copy of unshipped records the first time someone forgot to
   * pass it; a default of "assume unacked" would silently do nothing and look
   * like the pruner was broken. The caller owns the ledger, so the caller
   * answers.
   */
  isFullyAcked: (tool: AiTool, rawId: string) => boolean;
  /** Injected so a test needs no clock. */
  now?: number;
  /** Report only — compute the decisions, delete nothing. */
  dryRun?: boolean;
}

export interface PruneShadowResult {
  scanned: number;
  deleted: number;
  freedBytes: number;
  /** Shadows left alone because the server does not have them yet. */
  keptUnacked: number;
  /** Bytes still on disk after the prune. */
  remainingBytes: number;
}

interface Entry { tool: AiTool; rawId: string; path: string; size: number; mtimeMs: number; acked: boolean }

/** Every shadow file with the facts needed to judge it. */
function listShadows(isFullyAcked: PruneShadowOpts['isFullyAcked']): Entry[] {
  const out: Entry[] = [];
  const root = shadowRoot();
  let tools: string[];
  try { tools = readdirSync(root); } catch { return out; }
  for (const tool of tools) {
    const dir = join(root, tool);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.gz')) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile()) continue;
      const rawId = name.slice(0, -'.gz'.length);
      let acked = false;
      // A predicate that throws must mean "keep", never "delete".
      try { acked = isFullyAcked(tool as AiTool, rawId); } catch { acked = false; }
      out.push({ tool: tool as AiTool, rawId, path, size: st.size, mtimeMs: st.mtimeMs, acked });
    }
  }
  return out;
}

export function pruneShadow(opts: PruneShadowOpts): PruneShadowResult {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const now = opts.now ?? Date.now();

  const all = listShadows(opts.isFullyAcked);
  const result: PruneShadowResult = {
    scanned: all.length, deleted: 0, freedBytes: 0,
    keptUnacked: all.filter((e) => !e.acked).length,
    remainingBytes: all.reduce((n, e) => n + e.size, 0),
  };

  const remove = (e: Entry): void => {
    if (!opts.dryRun) {
      try { unlinkSync(e.path); } catch { return; }   // already gone, or read-only
    }
    result.deleted++;
    result.freedBytes += e.size;
    result.remainingBytes -= e.size;
  };

  // Only ever candidates. Unacked shadows are untouchable.
  const candidates = all.filter((e) => e.acked).sort((a, b) => a.mtimeMs - b.mtimeMs);

  // 1. AGE.
  const tooOld = new Set<Entry>();
  for (const e of candidates) {
    if (now - e.mtimeMs > maxAgeMs) { remove(e); tooOld.add(e); }
  }

  // 2. SIZE, oldest first, over whatever survived the age pass.
  if (result.remainingBytes > maxTotalBytes) {
    for (const e of candidates) {
      if (result.remainingBytes <= maxTotalBytes) break;
      if (tooOld.has(e)) continue;
      remove(e);
    }
  }

  return result;
}
