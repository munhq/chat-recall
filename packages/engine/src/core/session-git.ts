/**
 * Session ↔ git linking.
 *
 * Given a session's edited files and time window, finds the git commits that
 * landed during that window in the repos those files belong to. This closes
 * the gap between "edits happened in this session" and "this is what made it
 * into a commit" — important for distinguishing session work that shipped
 * from work that was rolled back or stayed local.
 *
 * Multi-repo aware: a session that touches both ~/code/personal/k8s_gpu and
 * ~/code/personal/munbot returns commits from each repo grouped by repo root.
 */

import { execFileSync } from 'child_process';
import { findRepoRoot } from './session-replay.js';

export interface SessionCommit {
  repo: string;            // absolute repo root
  repoName: string;        // basename of repo root
  sha: string;             // full sha
  shortSha: string;
  authorIso: string;       // author date in ISO 8601
  authorName: string;
  subject: string;
  body: string;            // commit body, may be empty
  files: string[];         // files changed in the commit
  linesAdded: number;      // from --shortstat
  linesRemoved: number;
  matchedSessionFiles: string[];   // intersection with session-touched files
}

export interface SessionCommitsResult {
  sessionId: string;
  startMs: number;
  endMs: number;
  repos: Array<{
    repo: string;
    repoName: string;
    commits: SessionCommit[];
  }>;
  totalCommits: number;
}

/**
 * Group a flat list of file paths by detected repo root. Files outside any
 * git repo are dropped from the result; if you need them too, look at
 * the input filesTouched directly.
 */
export function groupFilesByRepo(files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    const repo = findRepoRoot(f);
    if (!repo) continue;
    if (!out.has(repo)) out.set(repo, []);
    out.get(repo)!.push(f);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Run git log within [startMs, endMs] for one repo.
 *
 * Parsing strategy: use `-z` so each commit record is null-byte terminated and
 * `--numstat` so per-file diff stats are tab-separated lines that cannot be
 * confused with the commit body. Earlier we tried `--shortstat --name-only`
 * with newline parsing and got bitten — body lines like "What lands:\n-
 * blackbox..." were indistinguishable from a file list. With -z + numstat the
 * format is unambiguous:
 *
 *   <header fields…>\x1f<body>\n\n<added>\t<deleted>\t<path>\n…\0
 *
 * `-z` also means commit bodies retain their newlines verbatim — no escaping
 * games — and `\0` cleanly terminates each record.
 */
function gitLogRepo(repo: string, startIso: string, endIso: string): Array<Omit<SessionCommit, 'matchedSessionFiles' | 'repo' | 'repoName'>> {
  const FIELD = '\x1f';
  // Use git's own %x1f placeholder rather than embedding a literal 0x1f byte
  // in the format string — esbuild/tsx will emit a different byte sequence
  // when transforming a literal `\x1f` inside a template string and git's
  // -z handling then drops the trailing NUL between body and first numstat,
  // collapsing the first file into the body. Going through %x1f lets git
  // emit the separator itself, byte-correct.
  const fmt = `--pretty=format:%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b`;
  let raw: string;
  try {
    raw = execFileSync('git', [
      '-C', repo,
      'log',
      `--since=${startIso}`,
      `--until=${endIso}`,
      fmt,
      '-z',
      '--numstat',
    ], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return [];
  }

  // With -z + --numstat, the canonical byte layout per commit is:
  //
  //   <header fields…\x1f><body with raw \n>\0<numstat-line>\0<numstat-line>\0…
  //
  // and successive commits are concatenated with the next commit's hash
  // starting immediately after the previous commit's last NUL.
  //
  // Caveat: when running through tsx (esbuild loader) we observe one NUL
  // byte being lost at the body→first-numstat boundary, so the *first*
  // numstat row can end up appended to segment 0 (the header+body) joined
  // by `\n\n` instead of a real \0 split. We compensate by detecting
  // a trailing numstat-shaped tail at the end of the body and treating it
  // as the commit's first numstat row. Plain Node (without tsx) doesn't
  // need this, but the parser is correct under both.
  type Builder = Omit<SessionCommit, 'matchedSessionFiles' | 'repo' | 'repoName'>;
  const out: Builder[] = [];
  let current: Builder | null = null;

  const segments = raw.split('\0');
  const NUMSTAT = /^[\d-]+\t[\d-]+\t/;
  const TRAILING_NUMSTAT = /\n([\d-]+\t[\d-]+\t[^\n]+)$/;

  const recordNumstat = (line: string) => {
    if (!current) return;
    const tabIdx1 = line.indexOf('\t');
    const tabIdx2 = line.indexOf('\t', tabIdx1 + 1);
    if (tabIdx1 === -1 || tabIdx2 === -1) return;
    const a = Number(line.slice(0, tabIdx1));
    const d = Number(line.slice(tabIdx1 + 1, tabIdx2));
    const file = line.slice(tabIdx2 + 1);
    if (Number.isFinite(a)) current.linesAdded += a;
    if (Number.isFinite(d)) current.linesRemoved += d;
    if (file) current.files.push(file);
  };

  for (let seg of segments) {
    // Each segment after the first commit may have a leading newline (the
    // newline that separated the previous numstat block from the next commit).
    seg = seg.replace(/^\n+/, '');
    if (!seg) continue;

    // Look for a header: something with 5 FIELD separators near the start.
    const fieldPositions: number[] = [];
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === FIELD) {
        fieldPositions.push(i);
        if (fieldPositions.length === 5) break;
      }
    }
    const looksLikeHeader = fieldPositions.length === 5 && fieldPositions[0] === 40;

    if (looksLikeHeader) {
      if (current) out.push(current);
      const sha       = seg.slice(0, fieldPositions[0]);
      const shortSha  = seg.slice(fieldPositions[0] + 1, fieldPositions[1]);
      const authorIso = seg.slice(fieldPositions[1] + 1, fieldPositions[2]);
      const authorName= seg.slice(fieldPositions[2] + 1, fieldPositions[3]);
      const subject   = seg.slice(fieldPositions[3] + 1, fieldPositions[4]);
      let body        = seg.slice(fieldPositions[4] + 1);

      current = {
        sha, shortSha, authorIso, authorName, subject, body: '',
        files: [], linesAdded: 0, linesRemoved: 0,
      };

      // Recover any first-numstat row that got appended to the body because
      // a NUL was lost at the boundary (see comment above). Walk the trailing
      // numstat-shaped lines off the body in reverse so multiple consecutively-
      // glued numstat rows would also be captured (defensive — observed only
      // one in practice).
      const recovered: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = TRAILING_NUMSTAT.exec(body))) {
        recovered.unshift(m[1]);
        body = body.slice(0, body.length - m[0].length);
      }
      current.body = body.trim();
      for (const line of recovered) recordNumstat(line);
    } else if (NUMSTAT.test(seg)) {
      recordNumstat(seg);
    }
    // else: stray empty segment between commits, ignore.
  }
  if (current) out.push(current);
  return out;
}

/**
 * Public API: given a session's edit window and the files it touched, return
 * matching commits per repo. Buffer the window slightly on each side because
 * the commit timestamp can lag the in-session edit by a few minutes.
 */
export function getSessionCommits(
  sessionId: string,
  filesTouched: string[],
  startMs: number,
  endMs: number,
  bufferMinutes: number = 30,
): SessionCommitsResult {
  const repoFiles = groupFilesByRepo(filesTouched);
  const startIso = new Date(startMs - bufferMinutes * 60 * 1000).toISOString();
  const endIso = new Date(endMs + bufferMinutes * 60 * 1000).toISOString();

  const repos: SessionCommitsResult['repos'] = [];
  let totalCommits = 0;
  for (const [repo, files] of repoFiles) {
    const fileSet = new Set(files);
    const commitsRaw = gitLogRepo(repo, startIso, endIso);
    const commits: SessionCommit[] = commitsRaw.map(c => {
      // A commit's `files` list is repo-relative; session files are absolute.
      // Compare by suffix match against the absolute paths so we surface the
      // overlap accurately.
      const matched: string[] = [];
      for (const cf of c.files) {
        const absCandidate = `${repo}/${cf}`;
        if (fileSet.has(absCandidate)) matched.push(absCandidate);
      }
      return {
        ...c,
        repo,
        repoName: basename(repo),
        matchedSessionFiles: matched,
      };
    });
    repos.push({ repo, repoName: basename(repo), commits });
    totalCommits += commits.length;
  }

  // Sort repos by number of matched commits desc.
  repos.sort((a, b) => b.commits.length - a.commits.length);
  return { sessionId, startMs, endMs, repos, totalCommits };
}
