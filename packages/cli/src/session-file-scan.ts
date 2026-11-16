/**
 * Secret findings for the files of one session, read from disk a piece at a
 * time.
 *
 * A session whose files add up to more than the build ceiling is never held in
 * memory as one export. This reads each file in pieces that end at a line end,
 * scans each piece, and gives the findings the line numbers the scan of the
 * joined container gives: the files follow each other, main file first, and the
 * container puts one newline between two files.
 */
import { open } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { scanTextForFindings } from '@chat-recall/engine/core/secret-redactor.js';
import { scanTenantRules } from '@chat-recall/engine/core/secret-scanner.js';
import { readSessionGroupText, type SessionContentGroup } from '@chat-recall/engine/core/live-session-scan.js';

export interface SessionFileFinding {
  session_id: string;
  detector: string;
  rule: string;
  line: number;
  preview: string;
}

/** Bytes of a piece. A line longer than a piece makes its own larger piece. */
export const SCAN_PIECE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/** Bytes the files of the groups occupy on disk: the most an export of them holds. */
export function sessionGroupsBytes(groups: SessionContentGroup[]): number {
  let total = 0;
  for (const g of groups) {
    for (const p of g.paths) {
      try { total += statSync(p).size; } catch { /* a file that went away adds nothing */ }
    }
  }
  return total;
}

/** The pieces of one file. Each piece but the last ends with a newline. */
export async function* readLinePieces(path: string, pieceBytes = SCAN_PIECE_BYTES): AsyncGenerator<{ text: string; newlines: number }> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(pieceBytes);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, pieceBytes, null);
      if (bytesRead === 0) break;
      const joined = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const cut = joined.lastIndexOf(NEWLINE);
      if (cut < 0) { carry = Buffer.from(joined); continue; }
      const piece = joined.subarray(0, cut + 1);
      carry = Buffer.from(joined.subarray(cut + 1));
      yield { text: piece.toString('utf8'), newlines: countNewlines(piece) };
    }
    if (carry.length) yield { text: carry.toString('utf8'), newlines: 0 };
  } finally {
    await fh.close();
  }
}

function countNewlines(b: Buffer): number {
  let n = 0;
  for (let i = b.indexOf(NEWLINE); i >= 0; i = b.indexOf(NEWLINE, i + 1)) n++;
  return n;
}

export async function scanSessionGroupsChunked(
  sessionId: string,
  groups: SessionContentGroup[],
  tenantRules?: Array<{ name: string; regex: string }>,
  pieceBytes = SCAN_PIECE_BYTES,
): Promise<SessionFileFinding[]> {
  const findings: SessionFileFinding[] = [];
  let lineBase = 0;
  const scan = (text: string) => {
    try {
      for (const x of scanTextForFindings(text)) {
        findings.push({ session_id: sessionId, detector: 'builtin', rule: x.rule, line: x.line + lineBase, preview: x.preview });
      }
    } catch { /* best-effort */ }
    if (tenantRules && tenantRules.length > 0) {
      try {
        for (const x of scanTenantRules(text, tenantRules)) {
          findings.push({ session_id: sessionId, detector: x.detector, rule: x.rule, line: x.line + lineBase, preview: x.preview });
        }
      } catch { /* best-effort */ }
    }
  };
  for (const group of groups) {
    if (group.paths.length === 1) {
      let any = false;
      for await (const piece of readLinePieces(group.paths[0], pieceBytes)) {
        any = true;
        scan(piece.text);
        lineBase += piece.newlines;
      }
      // The container puts one newline after a file, so the next file starts one line below the last line of this one.
      // An empty file is not in the container.
      if (any) lineBase += 1;
    } else {
      // One file with copies in several homes: the copies are merged as text, as the export does.
      const { text } = readSessionGroupText(group);
      if (!text) continue;
      scan(text);
      lineBase += (text.match(/\n/g)?.length ?? 0) + 1;
    }
  }
  return findings;
}

/**
 * Secret findings for a capture a backend gives as lines (a database dump), one
 * piece of lines at a time. Every line ends with a newline, so the line numbers
 * are the positions of the lines in the capture.
 */
export function scanLinesChunked(
  sessionId: string,
  lines: Iterable<string>,
  tenantRules?: Array<{ name: string; regex: string }>,
  pieceBytes = SCAN_PIECE_BYTES,
): SessionFileFinding[] {
  const findings: SessionFileFinding[] = [];
  let lineBase = 0;
  let piece: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (piece.length === 0) return;
    const text = piece.join('');
    try {
      for (const x of scanTextForFindings(text)) {
        findings.push({ session_id: sessionId, detector: 'builtin', rule: x.rule, line: x.line + lineBase, preview: x.preview });
      }
    } catch { /* best-effort */ }
    if (tenantRules && tenantRules.length > 0) {
      try {
        for (const x of scanTenantRules(text, tenantRules)) {
          findings.push({ session_id: sessionId, detector: x.detector, rule: x.rule, line: x.line + lineBase, preview: x.preview });
        }
      } catch { /* best-effort */ }
    }
    lineBase += piece.length;
    piece = [];
    bytes = 0;
  };
  for (const line of lines) {
    piece.push(line);
    bytes += line.length;
    if (bytes >= pieceBytes) flush();
  }
  flush();
  return findings;
}
