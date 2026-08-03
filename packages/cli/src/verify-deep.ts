/**
 * `chat-recall verify --deep` — does the server actually hold what this machine
 * has, per session?
 *
 * Every silent-loss incident in this codebase was found by a human asking about
 * one specific session. Nothing reported them, because every symptom looks like
 * healthy operation: `15604 skipped` is what a fully-synced corpus prints too.
 * This is the check that turns "did session X make it?" from an investigation
 * into a command.
 *
 * It compares in the unit the server's shrink guard uses — `gzipContainer().size`
 * of the local union versus the archive's stored `size` — so a difference means
 * the server is genuinely missing records, not that two measurements disagree.
 * Sub-unit noise is ignored via a tolerance.
 *
 * Deliberately NOT an mtime comparison: the server stores the client-sent mtime,
 * which drifts sub-second against the file for essentially every session. An
 * mtime-based version of this check reported 9,975 of 10,032 sessions suspect
 * when the true number was 13.
 *
 * Classification matters as much as detection:
 *   pending   — the ledger knows there is more to send; it will go on its own
 *   STRANDED  — the ledger claims complete while the server holds less, so
 *               nothing will ever re-ship it. This is the actionable class.
 */

import { loadAllCredentials } from './sync-client.js';
import { getSyncedRows } from './sync-ledger.js';

export interface VerifyFinding {
  sessionId: string;
  projectPath: string;
  localSize: number;
  serverSize: number;
  deficit: number;
  /** Ledger claims complete ⇒ nothing will re-ship it without intervention. */
  stranded: boolean;
}

export interface VerifyReport {
  server: string;
  checked: number;
  complete: number;
  missingArchive: number;
  pending: VerifyFinding[];
  stranded: VerifyFinding[];
}

/** Below this, a size difference is container-encoding noise rather than
 *  missing records. */
const TOLERANCE_BYTES = 512;

interface Deps {
  listSessions(sinceMs: number): Array<{ rawId: string; prefixedId: string; projectPath: string; mtime: number }>;
  localContainerSize(rawId: string): number | null;
  fileSize(rawId: string): number;
  serverSizes(server: string, token: string): Promise<Map<string, number>>;
}

/**
 * Pure comparison, injectable so it can be tested without a server or a real
 * transcript corpus.
 */
export async function verifyAgainstServer(
  server: string,
  token: string,
  sinceMs: number,
  deps: Deps,
): Promise<VerifyReport> {
  const serverSize = await deps.serverSizes(server, token);
  const ledger = getSyncedRows(server);

  const report: VerifyReport = {
    server, checked: 0, complete: 0, missingArchive: 0, pending: [], stranded: [],
  };

  for (const s of deps.listSessions(sinceMs)) {
    const srv = serverSize.get(s.rawId);
    if (srv === undefined) { report.missingArchive++; continue; }

    const local = deps.localContainerSize(s.rawId);
    if (local === null) continue;              // unreadable/unparseable — not a finding
    report.checked++;

    const deficit = local - srv;
    if (deficit <= TOLERANCE_BYTES) { report.complete++; continue; }

    // The ledger's `s` is the server's confirmed byte cursor. If it is at or
    // past the local file size, the client believes there is nothing left to
    // send — so this session will never re-ship on its own.
    const row = ledger.get(s.prefixedId) ?? ledger.get(s.rawId);
    const cursor = row?.s ?? 0;
    const stranded = !!row && cursor >= deps.fileSize(s.rawId);

    const finding: VerifyFinding = {
      sessionId: s.rawId,
      projectPath: s.projectPath || '',
      localSize: local,
      serverSize: srv,
      deficit,
      stranded,
    };
    (stranded ? report.stranded : report.pending).push(finding);
  }

  report.stranded.sort((a, b) => b.deficit - a.deficit);
  report.pending.sort((a, b) => b.deficit - a.deficit);
  return report;
}

/** Every configured target, so a multi-server setup is verified as a whole. */
export function verifyTargets(): Array<{ serverUrl: string; token: string }> {
  return loadAllCredentials().map((c) => ({ serverUrl: c.serverUrl.replace(/\/+$/, ''), token: c.token }));
}
