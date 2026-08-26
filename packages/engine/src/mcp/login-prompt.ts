/**
 * TURNING "not logged in" INTO A LOGIN.
 *
 * Every server-backed tool funnels through requireRemote(), and for a brand-new
 * user that threw:
 *
 *   "chat-recall is not logged in. Run `chat-recall login <server-url>` …"
 *
 * which names a command the user does not have. The published install for every
 * registry, badge and marketplace entry is
 * `npx -y -p chat-recall chat-recall-mcp` — npx runs the MCP out of a transient
 * cache and puts NOTHING on PATH. So the one instruction we gave was
 * `command not found`, and the honest description of the product at that moment
 * was: 27 tools advertised, none of them able to do anything, and no way out.
 *
 * The fix is not a better sentence. It is to start the login here, because the
 * MCP is the only part of the product that is actually running.
 *
 * WHY A URL IN THE RESPONSE AND NOT JUST A BROWSER. The agent renders the tool's
 * text to the user, so a link in the response is the reliable channel — an MCP
 * server may be running on a remote host, in a container, or over ssh, where
 * there is no browser to open and a silent `xdg-open` failure would leave the
 * user staring at nothing. This is how `gh auth login` and Claude Code behave:
 * show the code, offer the browser. We try to open one as a convenience and
 * never depend on it.
 *
 * The flow itself (RFC 8628 device authorization) already existed and already
 * works against production — it was simply unreachable. This module only decides
 * WHEN to start it and WHAT the user is told; the CLI injects HOW, because
 * writing credentials and opening browsers are its job and the engine must not
 * depend on it.
 */

/** What the injected starter reports back for display. */
export interface LoginPrompt {
  /** The URL to open — user_code already in the query where the server offers it. */
  url: string;
  /** The short code, shown so a user typing it by hand can. */
  userCode: string;
  /** Where to type the code, when the complete URL is not used. */
  verificationUri: string;
}

export type LoginStarter = (server: string) => Promise<LoginPrompt>;

let starter: LoginStarter | null = null;
/** In-flight or completed prompt, per server, so N tool calls start ONE login. */
const pending = new Map<string, { at: number; prompt: LoginPrompt | null; error?: string }>();

/** The device code's own lifetime is 10 minutes; re-prompt a little sooner. */
const PROMPT_TTL_MS = 9 * 60 * 1000;

/**
 * Installed by the CLI's MCP entry point. Absent in any host that cannot
 * complete a login (the remote /mcp endpoint serves many callers and must never
 * try), and then the message falls back to plain instructions.
 */
export function setLoginStarter(fn: LoginStarter | null): void { starter = fn; }
export function hasLoginStarter(): boolean { return starter !== null; }
export function _resetLoginPrompts(): void { pending.clear(); }

/** The default server a new user should be sent to. */
export function defaultLoginServer(): string {
  return (process.env.CHAT_RECALL_SERVER || 'https://chatrecall.dev').replace(/\/+$/, '');
}

/**
 * The message a tool throws when there are no credentials.
 *
 * Synchronous on purpose: requireRemote() is called at the top of 51 tools and
 * must not become async. So it reads whatever the background login has already
 * produced and starts one if nothing is running — the FIRST call therefore says
 * "starting" and the second, a moment later, carries the link. In practice the
 * agent retries immediately, which is exactly the behaviour we want and costs no
 * extra round trip to the user.
 */
export function loginInstruction(server = defaultLoginServer()): string {
  if (!starter) {
    return 'chat-recall is not logged in, and this host cannot start a login. '
      + `Install the CLI and log in: \`npm i -g chat-recall && chat-recall login ${server}\`. `
      + 'A free 7-day trial starts as soon as you sign up.';
  }

  const known = pending.get(server);
  if (known && Date.now() - known.at < PROMPT_TTL_MS) {
    if (known.prompt) return signInText(known.prompt, server);
    if (known.error) {
      return `chat-recall could not start a login automatically (${known.error}). `
        + `Sign up at ${server} and then run \`chat-recall login ${server}\`.`;
    }
    return 'chat-recall is starting a sign-in — call this tool again in a moment '
      + 'and it will show you the link.';
  }

  // Kick it off and report that we did. Deliberately not awaited: see above.
  pending.set(server, { at: Date.now(), prompt: null });
  void starter(server)
    .then((prompt) => { pending.set(server, { at: Date.now(), prompt }); })
    .catch((err) => {
      pending.set(server, { at: Date.now(), prompt: null, error: err instanceof Error ? err.message : String(err) });
    });

  return 'chat-recall is not connected yet — starting a sign-in now. '
    + 'Call this tool again in a moment and it will show you the link to open.';
}

/**
 * What the user actually reads. Written to be shown BY an assistant, so it says
 * what to do and what happens next rather than describing an error.
 */
function signInText(p: LoginPrompt, server: string): string {
  return [
    '**chat-recall needs one sign-in before it can recall anything.**',
    '',
    `Open: ${p.url}`,
    `Code: ${p.userCode}`,
    '',
    `(If the link does not carry the code, enter it at ${p.verificationUri}.)`,
    '',
    'Sign in with Google or GitHub and your free 7-day trial starts on the spot — no card.',
    'With an email address instead, confirm the 6-digit code we send and the trial starts then.',
    '',
    'Approving also finishes the setup for you: the chat-recall skills go into your AI',
    'tools, the MCP is registered with them, and a background service starts shipping new',
    'conversations. Your existing sessions then sync — the first pass reports progress, so',
    'a tool that says "still syncing" is working rather than broken.',
    '',
    'Nothing is read or uploaded until you approve. To keep a repo out afterwards:',
    '`recall_exclude_path`, or `chat-recall exclude project <path>`.',
  ].join('\n');
}
