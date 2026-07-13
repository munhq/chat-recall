/**
 * Local shadow archive — the collector's own copy of the fullest-known
 * transcript for every session, so no upstream tool can destroy history we
 * once saw.
 *
 * WHY THIS EXISTS
 * ---------------
 * Claude Code 2.1.20x rewrites a session's `.jsonl` in place on `claude
 * --resume`: it keeps only the resumed continuation and discards the earlier
 * history from disk (verified 2026-07-09 — the tool keeps NO backup anywhere).
 * chat-recall's sync then re-extracts the truncated file and the shrunken
 * content replaces the server-side conversation items every viewer tab reads.
 * The server's `raw_sessions` archive is shrink-protected, but that only covers
 * content already synced — anything created between the last sync and a resume,
 * or on an offline/watcher-down/excluded machine, has no other copy.
 *
 * The shadow closes that hole locally: on every scan we compare the on-disk
 * transcript to the shadow and keep the UNION. A resume-truncated file is
 * detected (records the shadow has that the disk no longer does) and the
 * fuller merged transcript is what sync ships — the server never even sees a
 * shrink. Recovery becomes local, not a server round-trip.
 *
 * STORAGE: `~/.chat-recall/shadow/<tool>/<rawId>.gz` — one gzipped RawContainer
 * per session (same container format the raw archive and secret scan use, so it
 * round-trips through `parseTranscriptFromContainer` for every tool).
 *
 * MONOTONICITY: the shadow only ever grows. Each update writes back the merged
 * (fullest) container, so the invariant "shadow ⊇ everything we ever saw" holds
 * across resumes. Retention/size caps are a separate concern (see the incident
 * follow-ups task); at ~765MB for 10k sessions the whole corpus is sub-GB.
 */

import { gzipSync, gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'fs';
import { dirname, join } from 'path';

import { getDataDir } from '../core/paths.js';
import type { AiTool, RawSessionExport } from '../core/tool-backend.js';
import {
  buildRawContainer,
  containerSrcHash,
  type RawContainer,
} from './raw.js';

// ── Paths ────────────────────────────────────────────────────────────

/** Root of the shadow archive. Honors $CHAT_RECALL_DATA_DIR via getDataDir(). */
export function shadowRoot(): string {
  return join(getDataDir(), 'shadow');
}

/** Per-session shadow file. rawId is the tool-native id (no prefix). */
export function shadowFileFor(tool: AiTool, rawId: string): string {
  // rawId is a uuid / opaque id — safe as a filename — but guard anyway so a
  // hostile id can't escape the shadow dir.
  const safe = rawId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(shadowRoot(), tool, `${safe}.gz`);
}

// ── Read / write ─────────────────────────────────────────────────────

export function readShadowContainer(tool: AiTool, rawId: string): RawContainer | null {
  const path = shadowFileFor(tool, rawId);
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(gunzipSync(readFileSync(path)).toString('utf-8'));
    if (c?.v === 1 && Array.isArray(c.files)) return c as RawContainer;
  } catch { /* corrupt shadow — treat as absent, it'll be rewritten */ }
  return null;
}

/** Atomic write (tmp + rename) so a crash mid-write can't corrupt the shadow. */
export function writeShadowContainer(tool: AiTool, rawId: string, container: RawContainer): void {
  const path = shadowFileFor(tool, rawId);
  mkdirSync(dirname(path), { recursive: true });
  const gz = gzipSync(JSON.stringify(container), { level: 6 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, gz);
  renameSync(tmp, path);
}

// ── Merge ────────────────────────────────────────────────────────────

/** Tools whose transcript is a single opaque blob rewritten wholesale (no
 *  independent per-line records to union). Everything else is line-oriented
 *  (JSONL for claude/codex/agy, one-JSON-row-per-line dump for opencode). */
const WHOLE_FILE_TOOLS = new Set<AiTool>(['gemini']);

/** Record types Claude Code writes as singletons and rewrites in place
 *  (title/mode/etc.). When both sides have one, the CURRENT value wins — we
 *  must not accumulate stale copies. */
const SINGLETON_META = new Set(['mode', 'permission-mode', 'ai-title', 'last-prompt', 'pr-link', 'summary']);

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/**
 * Dedup key for one transcript line. Message records carry a stable `uuid`;
 * singleton-meta records dedup by type (current wins); anything else dedups by
 * content hash so identical lines collapse but differing ones are both kept.
 */
function lineKey(line: string): { key: string; singleton: boolean } {
  try {
    const o = JSON.parse(line);
    if (typeof o?.uuid === 'string' && o.uuid) return { key: `u:${o.uuid}`, singleton: false };
    if (typeof o?.type === 'string' && SINGLETON_META.has(o.type)) return { key: `m:${o.type}`, singleton: true };
  } catch { /* non-JSON line — hash it */ }
  return { key: `h:${sha1(line)}`, singleton: false };
}

export interface LineMergeResult {
  text: string;
  /** records present in the shadow that the current text no longer has —
   *  the fingerprint of a rewrite/truncation (>0 ⇒ history was recovered). */
  recovered: number;
  totalRecords: number;
}

/**
 * Union two line-oriented transcripts. `recovered` counts records the shadow
 * has that the current text lost — the fingerprint of a rewrite.
 *
 * Ordering: whichever side is a superset owns the ordering (its records ARE the
 * full set, already in the right order). Only on true divergence — each side
 * has records the other lacks — do we splice shadow-first then current-appended,
 * which yields old→new because the parser emits messages in file order. This
 * distinction matters: a partial local shadow merged with a fuller server copy
 * must adopt the server's order, not prepend the local fragment.
 */
export function mergeLineText(shadowText: string, currentText: string): LineMergeResult {
  const shadowLines = shadowText.split('\n').filter((l) => l.trim());
  const currentLines = currentText.split('\n').filter((l) => l.trim());

  const currentKeys = new Set<string>();
  for (const l of currentLines) currentKeys.add(lineKey(l).key);
  const shadowKeys = new Set<string>();
  for (const l of shadowLines) shadowKeys.add(lineKey(l).key);

  let recovered = 0;
  for (const k of shadowKeys) if (!currentKeys.has(k)) recovered++;

  // Current holds everything the shadow did (normal append, seed-from-fuller,
  // or identical) → current is authoritative; adopt it verbatim.
  if (recovered === 0) {
    return { text: currentText.endsWith('\n') ? currentText : currentText + '\n', recovered: 0, totalRecords: currentKeys.size };
  }

  // Divergence (incl. pure truncation): keep every shadow record, then append
  // current records the shadow lacks. Singleton-meta defers to the current one.
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const l of shadowLines) {
    const { key, singleton } = lineKey(l);
    if (singleton && currentKeys.has(key)) continue;
    if (emitted.has(key)) continue;
    out.push(l);
    emitted.add(key);
  }
  for (const l of currentLines) {
    const { key } = lineKey(l);
    if (emitted.has(key)) continue;
    out.push(l);
    emitted.add(key);
  }
  return { text: out.join('\n') + '\n', recovered, totalRecords: out.length };
}

export type ShadowStatus =
  | 'created'          // no prior shadow — current stored as-is
  | 'unchanged'        // current identical to shadow
  | 'grew'             // normal append — current is a superset of shadow
  | 'rewrite-merged'   // current LOST records the shadow had — merged to recover
  | 'unavailable';     // couldn't export the current transcript

export interface ShadowMerge {
  status: ShadowStatus;
  container: RawContainer;
  /** total records the shadow had that the current file no longer did */
  recovered: number;
}

/**
 * Merge a freshly-exported container against the stored shadow, file by file
 * (matched by name). Files only one side has pass through; files both have are
 * unioned per the tool's strategy. Returns the fullest-known container.
 */
export function mergeContainer(shadow: RawContainer, current: RawContainer): ShadowMerge {
  const wholeFile = WHOLE_FILE_TOOLS.has(current.tool);
  const byName = new Map<string, { s?: string; c?: string }>();
  for (const f of shadow.files) byName.set(f.name, { s: f.text });
  for (const f of current.files) byName.set(f.name, { ...(byName.get(f.name) ?? {}), c: f.text });

  const files: RawContainer['files'] = [];
  let recovered = 0;
  let anyGrew = false;

  for (const [name, { s, c }] of byName) {
    if (s === undefined && c !== undefined) { files.push({ name, text: c }); anyGrew = true; continue; }
    if (c === undefined && s !== undefined) { files.push({ name, text: s }); recovered++; continue; } // file the rewrite dropped
    // both present
    const sText = s!, cText = c!;
    if (sText === cText) { files.push({ name, text: cText }); continue; }
    if (wholeFile) {
      // No per-line records to union — keep the larger blob (shrink protection).
      if (cText.length >= sText.length) { files.push({ name, text: cText }); anyGrew = true; }
      else { files.push({ name, text: sText }); recovered++; }
      continue;
    }
    const m = mergeLineText(sText, cText);
    files.push({ name, text: m.text });
    if (m.recovered > 0) recovered += m.recovered;
    else if (m.text.length > sText.length) anyGrew = true;
  }

  // The merged container's mtime is the newest we've seen (current wins when it
  // moved forward; never regress below the shadow's).
  const mtime = Math.max(Math.floor(current.mtime) || 0, Math.floor(shadow.mtime) || 0);
  const container: RawContainer = { v: 1, tool: current.tool, mtime, files };

  let status: ShadowStatus;
  if (recovered > 0) status = 'rewrite-merged';
  else if (anyGrew) status = 'grew';
  else status = 'unchanged';
  return { status, container, recovered };
}

// ── Orchestration ────────────────────────────────────────────────────

export interface ShadowUpdate {
  status: ShadowStatus;
  sessionId: string;
  tool: AiTool;
  /** The fullest-known container (post-merge) — what sync should ship. Absent
   *  only when status is 'unavailable' AND no prior shadow existed. */
  container: RawContainer | null;
  recovered: number;
  path: string;
}

/**
 * Bring the shadow for one session up to date and return the fullest-known
 * container. Detects (and repairs) resume-truncation as a side effect.
 *
 * Best-effort by contract: any failure returns 'unavailable' rather than
 * throwing — the caller falls back to the live disk file, exactly as before
 * the shadow existed. It must never make a sync worse than no shadow at all.
 */
export function updateShadow(sessionId: string, exp: RawSessionExport | null): ShadowUpdate {
  // The backend was already resolved by the caller (it has the export); we only
  // need the tool + raw id, both on the export. Fall back to a claude-shaped id.
  const tool: AiTool = exp?.tool ?? 'claude';
  const rawId = sessionId; // callers pass the tool-native id
  const path = shadowFileFor(tool, rawId);

  const prior = readShadowContainer(tool, rawId);

  if (!exp) {
    // Can't read the live file. If we have a shadow, that IS the fullest-known
    // state — surface it so the caller can still ship history.
    return { status: 'unavailable', sessionId, tool, container: prior, recovered: 0, path };
  }

  let current: RawContainer;
  try { current = buildRawContainer(exp); }
  catch { return { status: 'unavailable', sessionId, tool, container: prior, recovered: 0, path }; }

  const curHash = containerSrcHash(current);

  if (!prior) {
    current.srcHash = curHash;
    try { writeShadowContainer(tool, rawId, current); } catch { /* disk full etc. — ship live anyway */ }
    return { status: 'created', sessionId, tool, container: current, recovered: 0, path };
  }

  // Fast path: the on-disk export is byte-identical (content, ignoring mtime) to
  // what last updated this shadow. The stored container IS the fullest-known
  // state, so return it WITHOUT the O(n) line-split + per-line SHA1 merge. This
  // is the hot path for a resume-truncated session re-evaluated repeatedly (the
  // disk stays truncated, the shadow stays full — every tick re-recovered the
  // same 1500 records before this gate) and for any mtime-only touch.
  if (prior.srcHash && prior.srcHash === curHash) {
    return { status: 'unchanged', sessionId, tool, container: prior, recovered: 0, path };
  }

  const merged = mergeContainer(prior, current);
  // Rewrite the shadow when its content advanced, OR when we merely need to
  // record the current srcHash (first time on a legacy shadow, or identical
  // content whose hash we hadn't stored yet) so the next tick can fast-path.
  // After that one write, an unchanged session never touches disk again.
  if (merged.status !== 'unchanged' || prior.srcHash !== curHash) {
    merged.container.srcHash = curHash;
    try { writeShadowContainer(tool, rawId, merged.container); } catch { /* ship merged in-memory regardless */ }
  }
  return {
    status: merged.status,
    sessionId,
    tool,
    container: merged.container,
    recovered: merged.recovered,
    path,
  };
}

/**
 * Snapshot a session's CURRENT on-disk state into the shadow, resolving the
 * backend itself. This is the resume-guard entry point: the watch daemon calls
 * it the instant `~/.claude/current-resume` changes — ideally BEFORE the
 * `--resume` rewrite truncates the file — so the full pre-resume transcript is
 * preserved even if the next scan would otherwise see only the truncated file.
 *
 * Dynamic import of the backend registry keeps this module free of a static
 * cycle (tool-backend → live-scan → … → transcript), matching raw.ts.
 */
export async function snapshotShadow(sessionId: string): Promise<ShadowUpdate> {
  // Side-effect import registers the four backends before we resolve one —
  // snapshotShadow must work regardless of whether the caller already loaded
  // them (e.g. a test, or an entry point that only imports the barrel).
  await import('../core/backends/index.js');
  const { getBackendForId, getBackend } = await import('../core/tool-backend.js');
  const backend = getBackendForId(sessionId) ?? getBackend('claude');
  const rawId = backend.toRawId(sessionId);
  let exp: RawSessionExport | null = null;
  try { exp = backend.exportRawSession(rawId); } catch { exp = null; }
  return updateShadow(rawId, exp);
}

/**
 * Seed the shadow from an externally-sourced container (e.g. the recovery
 * command decrypting an archived raw from the server). Merges with any existing
 * shadow so a partial server copy and a partial local copy combine. Returns the
 * merged container that is now the fullest-known state.
 */
export function seedShadow(sessionId: string, container: RawContainer): RawContainer {
  const tool = container.tool;
  const prior = readShadowContainer(tool, sessionId);
  const fullest = prior ? mergeContainer(prior, container).container : container;
  try { writeShadowContainer(tool, sessionId, fullest); } catch { /* best-effort */ }
  return fullest;
}

/** Bytes the shadow occupies on disk for a session (0 if none). Diagnostics. */
export function shadowSizeOnDisk(tool: AiTool, rawId: string): number {
  try { return statSync(shadowFileFor(tool, rawId)).size; } catch { return 0; }
}
