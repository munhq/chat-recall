/**
 * The device token of `chat-recall login`, read from the place where the kit store keeps it.
 *
 * `credentials.json` holds the server URL of a target and, for a login of the kit, a pointer to
 * the secret (`SecretWhere` of `@munhq/mcp-kit/cli`) and no token. The pointer names one of three
 * places: a file that only the owner can read, the keyring of the OS, or sealkeep. A process reads
 * the first two itself. sealkeep gives a secret only to a process that it starts, so a process
 * with a sealkeep pointer starts itself again under `sealkeep run -e <variable>=<name>` once
 * (`adoptSealkeepSecrets`), and reads the value from that variable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSecret, readSecretFile, type SecretWhere } from '@munhq/mcp-kit/cli';
import { envCredentials } from './credentials-env.js';
import { getDataDir } from './data-dir.js';

export type { SecretWhere };

/** Set in the process that `adoptSealkeepSecrets` started, so it does not start itself again. */
export const RELAUNCH_GUARD = 'CHAT_RECALL_UNDER_SEALKEEP';

type SealkeepWhere = Extract<SecretWhere, { kind: 'sealkeep' }>;

const isSealkeep = (w: SecretWhere | undefined): w is SealkeepWhere => w?.kind === 'sealkeep';

/** The environment variable that carries the sealkeep secret `name` into a process under `sealkeep run`. */
export function sealkeepEnvName(name: string): string {
  return `CHAT_RECALL_SECRET_${createHash('sha256').update(name).digest('hex').slice(0, 12).toUpperCase()}`;
}

/** How long a read of the keyring is kept. A login that another process wrote shows after this time. */
const KEYRING_TTL_MS = 30_000;
const keyringCache = new Map<string, { at: number; value: string }>();

/** Clears the kept keyring reads. A test calls it. */
export function clearTokenCache(): void {
  keyringCache.clear();
}

export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  readKeyring?: (where: Extract<SecretWhere, { kind: 'keyring' }>) => string | undefined;
}

/** The token that `where` holds, or an empty string when this process cannot read it. */
export function resolveSecret(where: SecretWhere | undefined, deps: ResolveDeps = {}): string {
  if (!where) return '';
  const env = deps.env ?? process.env;
  if (where.kind === 'file') return readSecretFile(where.path) ?? '';
  if (where.kind === 'sealkeep') return (env[sealkeepEnvName(where.name)] ?? '').trim();
  const now = (deps.now ?? Date.now)();
  const key = JSON.stringify(where);
  const hit = keyringCache.get(key);
  if (hit && now - hit.at < KEYRING_TTL_MS) return hit.value;
  const value = (deps.readKeyring ?? ((w) => readSecret(w)))(where) ?? '';
  keyringCache.set(key, { at: now, value });
  return value;
}

/** The token of a target: its own `token`, else the secret that its pointer names. */
export function targetToken(t: { token?: string; secret?: SecretWhere }, deps: ResolveDeps = {}): string {
  return t.token || resolveSecret(t.secret, deps);
}

/** The sealkeep names that the targets of `credentials.json` point to. */
export function sealkeepNamesOnDisk(dataDir: string = getDataDir()): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, 'credentials.json'), 'utf-8'));
  } catch {
    return [];
  }
  const targets = (parsed as { targets?: Array<{ secret?: SecretWhere }> })?.targets;
  if (!Array.isArray(targets)) return [];
  const names = targets.map((t) => t?.secret).filter(isSealkeep).map((w) => w.name);
  return [...new Set(names)];
}

/** The command that starts `argv` with each secret `names` in its variable. */
export function sealkeepCommand(names: string[], argv: string[]): string[] {
  return ['sealkeep', 'run', ...names.flatMap((n) => ['-e', `${sealkeepEnvName(n)}=${n}`]), '--', ...argv];
}

export interface AdoptDeps {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  /** The program and its arguments, as the process runs now. */
  argv?: string[];
  /** Runs a program to the end. Answers the exit code and the error text. */
  probe?: (command: string[], env: NodeJS.ProcessEnv) => { code: number; stderr: string };
  /** Starts the program again with the terminal of this process, and answers its exit code. */
  relaunch?: (command: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  say?: (line: string) => void;
  exit?: (code: number) => never;
}

function defaultProbe(command: string[], env: NodeJS.ProcessEnv): { code: number; stderr: string } {
  const r = spawnSync(command[0], command.slice(1), { env, encoding: 'utf-8', timeout: 15_000 });
  if (r.error) return { code: 127, stderr: r.error.message };
  return { code: r.status ?? 1, stderr: r.stderr ?? '' };
}

function defaultRelaunch(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit' });
    const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* gone */ } };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, forward(sig));
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Makes the sealkeep secrets of `credentials.json` readable in this process.
 *
 * If a target points to a sealkeep secret that this process does not hold, the process starts itself
 * again under `sealkeep run` and exits with the exit code of that run. If sealkeep does not give the
 * secret (not installed, keyring locked, name missing), the process goes on with no token for that
 * target and says why on stderr. A process that holds `CHAT_RECALL_TOKEN` and `CHAT_RECALL_SERVER`
 * needs nothing from the file, so it does not start again.
 */
export async function adoptSealkeepSecrets(deps: AdoptDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (env[RELAUNCH_GUARD]) return;
  if (envCredentials(env)) return;
  const missing = sealkeepNamesOnDisk(deps.dataDir).filter((n) => !env[sealkeepEnvName(n)]);
  if (missing.length === 0) return;
  const say = deps.say ?? ((l: string) => process.stderr.write(`${l}\n`));
  const argv = deps.argv ?? [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
  const childEnv = { ...env, [RELAUNCH_GUARD]: '1' };
  const probe = (deps.probe ?? defaultProbe)(
    sealkeepCommand(missing, ['sh', '-c', missing.map((n) => `test -n "$${sealkeepEnvName(n)}"`).join(' && ')]),
    childEnv,
  );
  if (probe.code !== 0) {
    const why = probe.stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${probe.code}`;
    say(`chat-recall: sealkeep did not give the login token (${why}). Run sealkeep unlock, then start this again.`);
    return;
  }
  const code = await (deps.relaunch ?? defaultRelaunch)(sealkeepCommand(missing, argv), childEnv);
  (deps.exit ?? process.exit)(code);
}
