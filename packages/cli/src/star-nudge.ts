/**
 * Ask, once per machine, for a GitHub star — after a search that worked.
 *
 * WHY IT EXISTS. Measured 2026-09-13: npm reported 6,973 downloads in the last
 * month and 440 in the last week, while github.com/munhq/chat-recall had 2
 * stars, 0 forks and 0 watchers. People install this, use it, and leave no
 * public trace, and a star count is the signal both recommendation paths read —
 * the corpus a model is trained on, and the "best MCP servers" articles that
 * rank for the queries buyers actually type.
 *
 * WHERE IT IS SAFE TO PRINT. Here, and nowhere else. The MCP server is a
 * different entry point (mcp.ts, reached through mcp-relay.js) and speaks
 * JSON-RPC over stdio, where one stray line of text corrupts the stream. This
 * module is imported by cli.ts only. Keep it that way.
 *
 * Four conditions, all required:
 *   - the search returned results, so the ask follows something that worked
 *   - stderr is a TTY, so a piped or redirected run is untouched
 *   - no CI marker in the environment
 *   - the marker file is absent, so it has never been shown on this machine
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '@chat-recall/engine/core/paths.js';

const REPO = 'https://github.com/munhq/chat-recall';

/** One file, written once. Deliberately not a settings field: AppSettings is a
 *  versioned schema merged field by field, and a cosmetic one-shot marker is
 *  not worth a migration or a chance to corrupt a user's real settings. */
function markerPath(): string {
  return join(getDataDir(), '.star-asked');
}

/**
 * Environments that must never see it: CI, and anyone who has opted out.
 * CI=true is set by GitHub Actions, GitLab, CircleCI and Travis; the others are
 * belt and braces for runners that set only their own name.
 */
function suppressed(): boolean {
  const env = process.env;
  if (env.CHAT_RECALL_NO_STAR_PROMPT) return true;
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.TEAMCITY_VERSION);
}

export function shouldAskForStar(resultCount: number): boolean {
  if (resultCount <= 0) return false;
  if (suppressed()) return false;
  // stderr, because that is where the line goes. A run whose stdout is a pipe
  // but whose stderr is still the terminal is a person watching, so it shows.
  if (!process.stderr.isTTY) return false;
  try { return !existsSync(markerPath()); } catch { return false; }
}

/** Record that it has been shown. A failure here means it may be shown once
 *  more on the next run, which is the harmless direction to fail in. */
export function markStarAsked(): void {
  try {
    const p = markerPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${new Date().toISOString()}\n`);
  } catch { /* read-only home, or no disk — never worth failing a search over */ }
}

/**
 * Print the ask and record it. Writes to stderr so a piped stdout carries only
 * search results.
 *
 * `dim` is passed in rather than imported so this module pulls in no colour
 * dependency of its own and a caller can hand it a no-op.
 */
export function askForStar(resultCount: number, dim: (s: string) => string): void {
  if (!shouldAskForStar(resultCount)) return;
  markStarAsked();
  process.stderr.write(`${dim(`If this saved you time, a star helps other people find it: ${REPO}`)}\n`);
  process.stderr.write(`${dim('You will not be asked again. CHAT_RECALL_NO_STAR_PROMPT=1 disables it everywhere.')}\n`);
}
