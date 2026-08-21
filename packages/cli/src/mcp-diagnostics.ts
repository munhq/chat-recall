/**
 * What the MCP tells an agent when something is refused or stale.
 *
 * Pure functions, in their own module so they are testable without importing
 * mcp.ts — which registers handlers and starts a server on import.
 *
 * Both exist because of the same class of bug: an answer that looks fine and
 * isn't. A 402 that read "request rejected" told an agent nothing, and a search
 * over a history that stopped growing three weeks ago looked exactly like a
 * search over a current one.
 */

/** The tenant's entitlement, as the server reports it. */
export interface SyncState {
  /** The server's OWN answer. Never re-derived here from status and dates: that
   *  is a second copy of the gate's decision, and a second copy drifts. */
  entitled: boolean;
  status: string;
  periodEnd: number | null;
}

/**
 * Turn a failed response into something an agent can act on.
 *
 * The status alone is not enough, and 402 proved it: every payment and
 * entitlement refusal fell through to "request rejected", so an agent whose sync
 * had stopped learned nothing, retried, and reported a vague failure. The server
 * already answers precisely — `error`, `detail`, `checkoutHint`, `resendHint`,
 * and for a feature gate `feature` / `requires` / `upgradeUrl` — and all of it
 * was being discarded in favour of the number.
 */
export async function buildHttpError(path: string, res: Response): Promise<Error> {
  const status = res.status;
  let body: Record<string, unknown> | null = null;
  try { body = await res.clone().json() as Record<string, unknown>; } catch { /* not JSON */ }
  const str = (k: string) => (typeof body?.[k] === 'string' ? body[k] as string : '');

  if (status === 402) {
    // Three distinct reasons with three distinct fixes. Telling someone to
    // subscribe when they need to click a link in their inbox is a wrong
    // message, not a terse one.
    const parts = [str('error') || 'payment required'];
    if (str('detail')) parts.push(str('detail'));
    if (str('feature')) {
      parts.push(`This is the "${str('feature')}" capability${str('requires') ? `, on the ${str('requires')} plan` : ''}.`);
    }
    if (str('upgradeUrl')) parts.push(`Upgrade: ${str('upgradeUrl')}`);
    if (str('checkoutHint')) parts.push(str('checkoutHint'));
    if (str('resendHint')) parts.push(str('resendHint'));
    // "Reads still work" was the OLD lapse contract (blanket read-only). The
    // free tier replaced it: feature-level 402s refuse READS of paid tools too,
    // so promising reads on the error a failed read raised gaslights the agent.
    parts.push('Nothing has been deleted. The free plan keeps sync and recent-history search working.');
    return new Error(`server ${path}: ${parts.join(' ')}`);
  }

  const hint =
    status === 401 || status === 403 ? 'auth failed — re-run `chat-recall login <server-url>`' :
    status === 404 ? 'not found — the id may be wrong, or the server is older than this CLI' :
    status === 429 ? 'rate limited — retry in a moment' :
    status >= 500 ? 'server error — check the chat-recall server logs' :
    str('error') || str('detail') || 'request rejected';
  return new Error(`server ${path}: HTTP ${status} (${hint})`);
}

/**
 * The line prepended to every successful read while sync is paused.
 *
 * A lapsed tenant keeps read access, so searches keep answering — from data that
 * stopped growing when the subscription ended. The agent cannot see that, so it
 * will state that work does not exist when it simply was not indexed. The banner
 * therefore does three things: says sync stopped, says when, and tells the agent
 * what conclusion NOT to draw.
 *
 * Returns null when entitled, and when the state is unknown — an unreachable
 * billing endpoint must not decorate every answer with a warning it cannot
 * substantiate.
 */
export function stalenessBanner(state: SyncState | null): string | null {
  if (!state || state.entitled) return null;
  const since = state.periodEnd ? new Date(state.periodEnd).toISOString().slice(0, 10) : null;
  const days = state.periodEnd
    ? Math.max(0, Math.floor((Date.now() - state.periodEnd) / 86_400_000))
    : null;
  const reason = state.status === 'trialing'
    ? 'the trial has ended'
    : state.status === 'past_due'
      ? 'a payment has not gone through'
      : 'the subscription has lapsed';
  // The free tier keeps sync running under a monthly quota and windows search
  // to recent history — "sync is paused" was the OLD lapse contract and is no
  // longer true. What IS true, and what the agent must know: search reaches
  // only the recent window, so older work exists but will not come back.
  return [
    `⚠ FREE PLAN — ${reason}.`,
    'Search and lists cover only the recent window (default 7 days); older history is stored but locked.',
    since ? `The plan lapsed ${since}${days !== null ? ` (${days} days ago)` : ''}.` : '',
    'Do not tell the user their older work does not exist; say it is locked behind the free plan and unlocks on upgrade.',
    'Sync continues under a monthly quota, export always works, and nothing has been deleted.',
  ].filter(Boolean).join(' ');
}
