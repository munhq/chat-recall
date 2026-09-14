/**
 * The card id is the link between the board and the work.
 *
 * A card moved to `in_progress` or `done` only when someone called
 * `recall_task_update` by hand, and that call was the step that got skipped
 * whenever the work itself went well. `t_73f0aed74703924a96` carried a
 * production OOM fix in `f6864bd3` and still read `todo` a day later, because
 * the session that shipped the commit never told the board. The board reported
 * zero cards ever claimed, across its whole history.
 *
 * These helpers read one signal: a `t_…` id written in the prompt that starts
 * the work, or in the message of a commit that finished it. An id is exact, so
 * a move is always about the card the writer named.
 *
 * Every function here is pure. The hook command in the CLI owns stdin, git and
 * the network; this file owns what counts as an id and which move is allowed.
 */

/**
 * `t_` followed by 18 hex characters — `pg.ts` mints ids as
 * `'t_' + randomBytes(9).toString('hex')`.
 *
 * Word-bounded at both ends, so an id inside a longer token is left alone.
 */
export const TASK_ID_PATTERN = /\bt_[0-9a-f]{18}\b/g;

/** One commit, as the close path reads it. */
export interface CommitRef {
  sha: string;
  message: string;
}

/** One card to close, with the commits that name it. */
export interface CloseIntent {
  id: string;
  commits: string[];
}

/**
 * A card the hook may claim is one nobody has started. `in_progress` already
 * carries a session, `done`, `closed` and `rejected` are verdicts, and a hook
 * that overwrote any of them would erase a person's decision.
 */
export const CLAIMABLE_STATUSES: ReadonlySet<string> = new Set(['todo']);

/**
 * A card the hook may close is one that is still open. Re-running the close
 * path over the same commits then changes nothing, which is what makes the
 * hook safe to fire at the end of every session.
 */
export const CLOSEABLE_STATUSES: ReadonlySet<string> = new Set(['todo', 'in_progress']);

/** Commits per card sent as evidence. */
export const MAX_EVIDENCE_COMMITS = 20;

/** Files per card sent as evidence. */
export const MAX_EVIDENCE_FILES = 50;

/**
 * Every `t_…` id in a piece of text, lower-cased and deduped, in the order
 * they appear.
 */
export function extractTaskIds(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(TASK_ID_PATTERN)) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    out.push(match[0]);
  }
  return out;
}

/**
 * The `--pretty` format the close path asks git for: the sha, a unit
 * separator, the full message, a record separator.
 *
 * A commit message carries newlines and can carry anything a person types, so
 * the two delimiters are control characters git never emits from `%H` or `%B`.
 */
export const COMMIT_LOG_FORMAT = '%H%x1f%B%x1e';

/** Parse what `git log --pretty=format:COMMIT_LOG_FORMAT` printed. */
export function parseCommitLog(raw: string | null | undefined): CommitRef[] {
  if (!raw) return [];
  const out: CommitRef[] = [];
  for (const record of raw.split('\x1e')) {
    const sep = record.indexOf('\x1f');
    if (sep < 0) continue;
    const sha = record.slice(0, sep).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    out.push({ sha, message: record.slice(sep + 1) });
  }
  return out;
}

/**
 * Group commits by the cards their messages name.
 *
 * A commit that names two cards counts for both: one change can finish two
 * pieces of work, and the reader of either card gets the sha that did it.
 */
export function planCloses(commits: CommitRef[]): CloseIntent[] {
  const byId = new Map<string, string[]>();
  for (const commit of commits) {
    for (const id of extractTaskIds(commit.message)) {
      const shas = byId.get(id) ?? [];
      if (!shas.includes(commit.sha) && shas.length < MAX_EVIDENCE_COMMITS) shas.push(commit.sha);
      byId.set(id, shas);
    }
  }
  return [...byId].map(([id, shas]) => ({ id, commits: shas }));
}

/**
 * Parse `git show --name-only` output into repo-relative paths.
 *
 * The server refuses a path that climbs out of the card's repository, so an
 * absolute path or a `..` segment is dropped here and the rest of the evidence
 * still lands.
 */
export function parseChangedFiles(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    if (file.startsWith('/') || file.startsWith('~')) continue;
    if (/(^|\/)\.\.(\/|$)/.test(file)) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(file);
    if (out.length >= MAX_EVIDENCE_FILES) break;
  }
  return out;
}

/**
 * Whether the hook may claim this card for this session.
 *
 * A card this session already claimed answers false — the work is recorded and
 * a second PATCH would say nothing new.
 */
export function mayClaim(
  status: string | null | undefined,
  linkedSessionId: string | null | undefined,
  sessionId: string,
): boolean {
  if (!sessionId) return false;
  if (linkedSessionId === sessionId && status === 'in_progress') return false;
  return CLAIMABLE_STATUSES.has(String(status ?? ''));
}

/** Whether the hook may close this card. */
export function mayClose(status: string | null | undefined): boolean {
  return CLOSEABLE_STATUSES.has(String(status ?? ''));
}
