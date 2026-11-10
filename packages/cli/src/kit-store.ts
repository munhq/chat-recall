/**
 * The login of `chat-recall`, with the kit of the fleet (`@munhq/mcp-kit/cli`) as an optional extra.
 *
 * Three jobs:
 *   1. `signIn`: the RFC 8628 sign-in of the person. With the kit, its `deviceLogin`; without it, `betterAuthDeviceLogin`.
 *   2. `keepDeviceToken`: with the kit, the token goes to sealkeep when it is installed, else to the keyring of the OS,
 *      else to a file that only the owner can read. Without the kit, it goes to that file. `credentials.json` keeps the
 *      pointer (`SecretWhere`), not the token.
 *   3. `registerRelay`: with the kit, puts the relay `chat-recall-mcp` into every AI tool of the machine. Without it,
 *      the writer of `chat-recall init` does that.
 *
 * The kit is private and the published package holds none of its code: `optionalKit()` loads it at run time when the
 * machine has it installed.
 */
import { join } from 'node:path';
import { getDataDir } from '@chat-recall/engine/core/data-dir.js';
import { resolveOnPath } from '@chat-recall/engine/core/which.js';
import {
  optionalKit, saveSecretFile,
  type Host, type Outcome, type SecretWhere,
} from '@chat-recall/engine/core/optional-kit.js';
import { betterAuthDeviceLogin } from './device-auth.js';

/** The error of a failed sign-in: the kit's own class when the kit is installed, else this one. */
class OwnLoginError extends Error {}
export const LoginError: new (message?: string) => Error = optionalKit()?.LoginError ?? OwnLoginError;

/** The name of the MCP server in each AI tool. */
export const MCP_NAME = 'chat-recall';

/** The client id that the server pins for the CLI (`validateClient` of the better-auth device plugin). */
export const CLI_CLIENT_ID = 'chat-recall-cli';

/** The longest that a program of the kit (sealkeep, secret-tool, an AI tool's `mcp add`) may take. A locked keyring waits for a prompt that no one answers. */
const RUN_TIMEOUT_MS = 30_000;

/** The machine for the kit: the real one, with a time limit on each program that the kit runs. Needs the kit. */
export function cliHost(env: NodeJS.ProcessEnv = process.env): Host {
  const kit = optionalKit(env);
  if (!kit) throw new Error('cliHost needs @munhq/mcp-kit, which is not installed');
  const base = kit.systemHost(env);
  return { ...base, run: (bin, args, opts) => base.run(bin, args, { timeoutMs: RUN_TIMEOUT_MS, ...opts }) };
}

/**
 * `CHAT_RECALL_SECRET_STORE` says where `login` keeps the device token:
 *   - unset or `auto`: the OS keyring, else a file that only the owner can read. The message hook runs at every turn
 *     and the daemon at every start, and each reads the token; `sealkeep run` takes about a second (its store is
 *     Vault), so a token in sealkeep would cost that second at each of them.
 *   - `sealkeep`: sealkeep when it is installed, then the keyring, then the file (the order of the kit). A process that
 *     needs the token starts itself again under `sealkeep run` (`adoptSealkeepSecrets` of the engine).
 *   - `file`: the file only: for a container, a CI job and a test, where the keyring is not a person's.
 * A machine without the kit keeps the token in the file whatever this says.
 */
type SecretStore = 'auto' | 'sealkeep' | 'file';
const secretStoreOf = (env: NodeJS.ProcessEnv): SecretStore => {
  const v = env.CHAT_RECALL_SECRET_STORE?.trim().toLowerCase();
  return v === 'sealkeep' || v === 'file' ? v : 'auto';
};

/** A machine on which the program `sealkeep` is not there, so `saveSecret` goes on to the keyring. */
function withoutSealkeep(host: Host): Host {
  return {
    ...host,
    run: (bin, args, opts) => (bin === 'sealkeep' ? { code: 127, stdout: '', stderr: 'sealkeep does not keep this token' } : host.run(bin, args, opts)),
  };
}

/** The part of a sealkeep name that tells the servers apart: `prod` for the default one, else the host. */
function envOf(serverUrl: string, defaultServer: string): string {
  const origin = (u: string) => { try { return new URL(u).origin; } catch { return u.replace(/\/+$/, ''); } };
  if (origin(serverUrl) === origin(defaultServer)) return 'prod';
  let host = serverUrl;
  try { host = new URL(serverUrl).host; } catch { /* not a URL: the text itself */ }
  return host.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

/** `personal/chat-recall/<prod or host>/DEVICE_TOKEN`: the name of the device token in sealkeep. */
export function tokenName(serverUrl: string, defaultServer: string): string {
  return `personal/${MCP_NAME}/${envOf(serverUrl, defaultServer)}/DEVICE_TOKEN`;
}

/** Keeps the device token of `serverUrl` and answers where it went. The token goes to no other place. */
export function keepDeviceToken(
  serverUrl: string,
  token: string,
  o: { defaultServer: string; host?: Host; dataDir?: string; env?: NodeJS.ProcessEnv },
): SecretWhere {
  const env = o.env ?? process.env;
  const name = tokenName(serverUrl, o.defaultServer);
  const file = join(o.dataDir ?? getDataDir(), 'tokens', name.split('/')[2]);
  const kit = optionalKit(env);
  if (!kit) return saveSecretFile(token, file);
  const store = secretStoreOf(env);
  const base = o.host ?? cliHost(env);
  return kit.saveSecret(token, {
    name,
    file,
    description: `The chat-recall device token of ${serverUrl}`,
    host: store === 'auto' ? withoutSealkeep(base) : base,
    forceFile: store === 'file',
  });
}

/** What the person reads after a login, for the place that holds the token. */
export function describeWhere(where: SecretWhere): string {
  if (where.kind === 'sealkeep') return `sealkeep (${where.name})`;
  if (where.kind === 'keyring') return `the OS keyring (${where.backend})`;
  return `a file that only you can read (${where.path})`;
}

export interface DeviceLoginPrompt { url: string; userCode: string; verificationUri: string }

/**
 * The device sign-in on the server's own better-auth provider. Answers the session token of the person who approved
 * the code. Nothing is printed and no browser opens: `onPrompt` gets the link and the code the moment the server
 * issues them, so the caller shows them as it shows every sign-in (`--prompt-json` for the MCP tool that relays them).
 */
export async function signIn(
  server: string,
  onPrompt: (p: DeviceLoginPrompt) => void,
  o: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const kit = optionalKit(o.env ?? process.env);
  if (!kit) return (await betterAuthDeviceLogin(server, onPrompt)).accessToken;
  const f = o.fetch ?? fetch;
  const watching: typeof fetch = async (input, init) => {
    const res = await f(input, init);
    if (String(input).endsWith('/api/auth/device/code') && res.ok) {
      try {
        const j = await res.clone().json() as { user_code?: string; verification_uri?: string; verification_uri_complete?: string };
        if (j.user_code && j.verification_uri) {
          onPrompt({ url: j.verification_uri_complete ?? j.verification_uri, userCode: j.user_code, verificationUri: j.verification_uri });
        }
      } catch { /* the kit reports a response that is not a device code */ }
    }
    return res;
  };
  return kit.deviceLogin({ server, clientId: CLI_CLIENT_ID, fetch: watching, noBrowser: true, write: () => undefined, sleep: o.sleep });
}

/** The command that an AI tool runs for the relay: `chat-recall-mcp` on the PATH, else the bundle beside this file. */
export function relayCommand(bundleDir: string): string[] {
  const bin = resolveOnPath('chat-recall-mcp');
  return bin ? [bin] : [process.execPath, join(bundleDir, 'mcp-relay.js')];
}

/**
 * Puts the relay into every AI tool of the machine that the kit knows. The other tools keep the writer of `init`, and
 * a machine without the kit leaves every tool to it.
 * `CHAT_RECALL_MCP_REGISTRATION=own` leaves the AI tools' own programs alone (`claude mcp add` and the like), for a
 * test or an image that must not run them; the writer of `init` still runs.
 */
export function registerRelay(server: string, bundleDir: string, host?: Host, env: NodeJS.ProcessEnv = process.env): Outcome[] {
  if (env.CHAT_RECALL_MCP_REGISTRATION?.trim().toLowerCase() === 'own') return [];
  const kit = optionalKit(env);
  if (!kit) return [];
  const machine = host ?? cliHost(env);
  const clients = kit.installedClients(machine);
  if (clients.length === 0) return [];
  return kit.addMcpServer(machine, clients, {
    name: MCP_NAME,
    url: `${server.replace(/\/+$/, '')}/mcp`,
    command: relayCommand(bundleDir),
  }).outcomes;
}
