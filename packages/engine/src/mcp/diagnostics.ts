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
  /** True for OUR no-card trial (not a Stripe card trial). Server-computed. */
  onTrial?: boolean;
  /** Whole days remaining, server-computed. Null when there is no end date. */
  trialDaysLeft?: number | null;
}

/**
 * How many days before the end the countdown starts.
 *
 * MUST match `stageFor()` in packages/server/src/services/trial-reminders.ts,
 * which sends the 'half' reminder email at the same threshold. Two channels
 * telling the same user two different deadlines is worse than one channel.
 */
export const TRIAL_WARN_DAYS = 3;

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
    // Say only what survives a lapse, and say it exactly. This sentence has been
    // wrong twice: "reads still work" (the blanket read-only contract), then
    // "the free plan keeps sync and recent-history search working" (which
    // outlived both the sync grant and the search window). Since 2026-08-25 a
    // lapsed account keeps two things and no others.
    parts.push('Nothing has been deleted: your history is intact and export still works.');
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
 * The line prepended to a tool result when the account has no live plan.
 *
 * Since 2026-08-25 a lapsed account is REFUSED, not degraded: the server answers
 * every value surface with 402 `no_plan`, so most tools reaching this point are
 * already returning an error rather than data. The banner exists for the few
 * that answer from local state, and to give the agent one sentence it can repeat
 * to the user instead of guessing why recall stopped working.
 *
 * Earlier versions of this text tried to caveat a degraded answer — "sync is
 * paused, search is read-only", then "reads cover the whole history, only new
 * work is missing". Both asked an agent to carry a caveat through to its own
 * conclusion, and an agent that skims banners will not. Refusing is the honest
 * version of the same message.
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
  return [
    `⚠ THIS ACCOUNT HAS NO ACTIVE PLAN — ${reason}.`,
    since ? `It lapsed ${since}${days !== null ? ` (${days} days ago)` : ''}.` : '',
    'Recall is switched off: searches and session reads are refused, and new sessions are not uploading.',
    'Nothing was deleted. Tell the user their history is intact, that export still works, and that '
      + 'subscribing plus one `chat-recall sync --full` brings the server current.',
    'Do not answer from memory or from earlier results in this conversation as if recall still worked.',
  ].filter(Boolean).join(' ');
}

/**
 * The countdown, for a trial that is still live but nearly spent.
 *
 * This exists for the user who has NEVER SEEN THE DASHBOARD. A connector user
 * arrives from claude.ai, signs in with Google, and works — they get no banner,
 * because they never load the SPA, and an emailed reminder reaches an inbox they
 * did not associate with this. The tool result is the only surface they are
 * reliably looking at, so it is the one that has to carry the deadline.
 *
 * It therefore does two things the email cannot: it names the ACCOUNT PAGE URL
 * on the server this MCP is actually pointed at (self-host included, which is
 * why the base is passed in rather than hardcoded), and it tells the agent to
 * relay the notice, because an agent that reads a banner and says nothing has
 * delivered it to nobody.
 *
 * Fires only inside TRIAL_WARN_DAYS, and only for our own no-card trial: a
 * customer with a card on file is Stripe's to remind, and telling them their
 * "trial ends" would be a lie about a subscription that renews.
 *
 * Returns null when entitled state is unknown, when the trial is not ours, and
 * when there is no deadline — the same "never warn about what you cannot
 * substantiate" rule as stalenessBanner.
 */
export function trialEndingBanner(state: SyncState | null, serverBase: string): string | null {
  if (!state || !state.entitled) return null;      // lapsed is stalenessBanner's job
  if (!state.onTrial) return null;
  const days = state.trialDaysLeft;
  if (typeof days !== 'number' || days > TRIAL_WARN_DAYS) return null;

  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  const account = `${serverBase.replace(/\/+$/, '')}/app?view=account`;
  return [
    // No trial LENGTH here. It is FREE_TRIAL_DAYS on the server, so a "7-day
    // trial" written into the CLI is a number that drifts the first time that is
    // tuned — and this file already carries two sentences that went stale that
    // exact way. Days REMAINING comes from the server and is always right.
    `⏳ TRIAL ENDS ${when.toUpperCase()} — this chat-recall account is on the free trial.`,
    'When it ends, recall switches off: searches and session reads stop, and new sessions stop syncing.',
    'Nothing is deleted — the history is kept and export keeps working.',
    `Tell the user now, and give them this link to subscribe or see the account: ${account}`,
  ].join(' ');
}
