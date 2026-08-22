/**
 * Credentials from the environment, for the runs that have no login on disk.
 *
 * Both credential readers — the MCP server's `remoteCredentials()` and the
 * sync client's `loadAllCredentials()` — used to require
 * `~/.chat-recall/credentials.json`. That file is written by `chat-recall login`
 * on a developer's machine, and it does not exist in the three places that now
 * matter for distribution:
 *
 *   1. A CONTAINER. Glama builds an image and runs the MCP server in its
 *      sandbox; the Docker MCP catalog does the same. Neither can run an
 *      interactive login, so both pass configuration as environment variables —
 *      and without this the server started, found no credentials, and answered
 *      every tool call with "run `chat-recall login` first".
 *   2. CI, where a workflow holds the token in a secret.
 *   3. A headless box syncing under systemd with no home directory to speak of.
 *
 * `CHAT_RECALL_TOKEN` is the switch: when it is set, the environment is the
 * authority and the file is not read at all. Set alone, `CHAT_RECALL_SERVER`
 * keeps its older and narrower meaning — pick which of the logged-in targets to
 * use — so an existing login is never re-pointed by an unrelated variable.
 */

export interface EnvCredentials {
  serverUrl: string;
  token: string;
}

/** Trailing slashes are stripped so a base URL concatenates cleanly with a path. */
const normalise = (u: string) => u.trim().replace(/\/+$/, '');

/**
 * Read `CHAT_RECALL_SERVER` + `CHAT_RECALL_TOKEN`.
 *
 * Returns null unless BOTH are present and non-empty. A token without a server
 * has nowhere to go, and a server without a token is the target-selection case
 * described above — not a credential.
 */
export function envCredentials(env: NodeJS.ProcessEnv = process.env): EnvCredentials | null {
  const token = (env.CHAT_RECALL_TOKEN || '').trim();
  const server = (env.CHAT_RECALL_SERVER || '').trim();
  if (!token || !server) return null;
  if (!/^https?:\/\//i.test(server)) return null;  // a hostname alone is a config mistake, not a base URL
  return { serverUrl: normalise(server), token };
}
