/**
 * The private kit `@munhq/mcp-kit/cli`, as an optional extra.
 *
 * The public package `chat-recall` holds no code of a private kit and installs on
 * a machine that has none. A machine that has the kit installed (the hosted
 * image, a developer's machine) gets the kit's keyring and sealkeep storage, its
 * device login and its client registration. Any other machine gets the fallbacks
 * in this file and in `kit-store.ts`.
 *
 * The kit is loaded at run time with `require`, never imported, so the bundler
 * leaves it out of the package. `packages/cli/scripts/bundle.mjs` fails the
 * build when kit code reaches a bundle. The types below are the shapes the
 * repository calls: the compiler needs no kit to build.
 */
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type KeyringBackend = 'secret-service' | 'keychain' | 'credential-manager';

/** Where a secret is kept. `credentials.json` holds this pointer, never the secret. */
export type SecretWhere =
  | { kind: 'sealkeep'; name: string }
  | { kind: 'keyring'; service: string; account: string; backend: KeyringBackend }
  | { kind: 'file'; path: string };

export type Run = (
  bin: string,
  args: string[],
  opts?: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => { code: number; stdout: string; stderr: string };

/** The machine as the kit sees it: its files, its programs and its environment. */
export interface Host {
  home: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  read(path: string): string | undefined;
  write(path: string, text: string, opts?: { mode?: number; dirMode?: number }): void;
}

export interface Outcome {
  client: string;
  ok: boolean;
  changed: boolean;
  message: string;
}

/** The calls of `@munhq/mcp-kit/cli` that this repository makes. */
export interface McpKitCli {
  LoginError: new (message?: string) => Error;
  deviceLogin(o: {
    server: string;
    clientId: string;
    noBrowser?: boolean;
    fetch?: typeof fetch;
    write?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<string>;
  saveSecret(
    value: string,
    o: { name: string; file: string; description?: string; forceFile?: boolean; host?: Host },
  ): SecretWhere;
  readSecret(where: SecretWhere, o?: { run?: Run }): string | undefined;
  systemHost(env?: NodeJS.ProcessEnv): Host;
  installedClients(h: Host, only?: string[]): unknown[];
  addMcpServer(
    h: Host,
    clients: unknown[],
    server: { name: string; url: string; command?: string[] },
  ): { outcomes: Outcome[]; logins: unknown[] };
}

const nodeRequire = createRequire(import.meta.url);
/** The name sits in a variable so that no bundler reads it as a dependency. */
const KIT_MODULE = ['@munhq', 'mcp-kit', 'cli'].join('/');

let loaded: McpKitCli | null | undefined;

/**
 * The kit, or null when this machine has none (or has a Node that cannot
 * `require` an ES module: before 22.12). Set `CHAT_RECALL_NO_KIT=1` to behave as
 * a machine without the kit.
 */
export function optionalKit(env: NodeJS.ProcessEnv = process.env): McpKitCli | null {
  if (env.CHAT_RECALL_NO_KIT === '1') return null;
  if (loaded !== undefined) return loaded;
  try {
    loaded = nodeRequire(KIT_MODULE) as McpKitCli;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** Forget what `optionalKit` found. A test calls it. */
export function clearOptionalKitCache(): void {
  loaded = undefined;
}

/** The secret in a file, or undefined when the file is missing or empty. */
export function readSecretFile(path: string): string | undefined {
  try {
    const v = readFileSync(path, 'utf-8').trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a secret in a file that only the owner can read, and answers the pointer to it. */
export function saveSecretFile(value: string, file: string): SecretWhere {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  // The mode of `writeFileSync` applies to a new file only; an old file keeps its own.
  chmodSync(file, 0o600);
  return { kind: 'file', path: file };
}
