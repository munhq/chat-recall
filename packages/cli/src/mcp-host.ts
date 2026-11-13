/**
 * The local MCP host of this machine, which serves chat-recall to every session.
 *
 * A client holds a URL, `http://127.0.0.1:<port>/chat-recall`. One host starts
 * `dist/mcp.js` once for the whole machine, and every session of every AI tool
 * reaches that one process.
 *
 * The host belongs to `@munhq/mcp-kit`. chat-recall adds its server to
 * `<home>/.config/mcp-kit/host.json` and installs the one service of the
 * machine through the kit. chat-recall keeps no service, no timer and no job
 * of its own. The kit is vendored (`scripts/vendor-mcp-kit.mjs`), because a
 * public install has no token for GitHub Packages.
 */
import { join } from 'node:path';
import { systemHost } from './vendor/mcp-kit/host.js';
import type { Host } from './vendor/mcp-kit/host.js';
import {
  DEFAULT_PORT, LOOPBACK, addServer, configPath, hostArgv, hostStatus, installHost, readConfig, restartHost, uninstallHost,
} from './vendor/mcp-kit/registry.js';
import type { HostConfig } from './vendor/mcp-kit/registry.js';

/** The name of the chat-recall server in the file of the machine. The last part of the URL is this name. */
export const HOST_SERVER_NAME = 'chat-recall';

/**
 * The heap cap of the server process. A hook or a client owns the spawn, so
 * NODE_OPTIONS is the only knob that works: `v8.setFlagsFromString` cannot
 * change the limit after start.
 */
const SERVER_ENV = { NODE_OPTIONS: '--max-old-space-size=1024' };

/** The machine and the platform to write to. A test passes a Host that holds no system. */
export interface McpHostDeps {
  host?: Host;
  platform?: NodeJS.Platform;
  /** The program that runs the server. */
  execPath?: string;
}

/** Can this machine keep a host? The kit writes a systemd unit on Linux and a launch agent on a Mac. */
export function hostSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

function machineOf(deps: McpHostDeps): Host {
  return deps.host ?? systemHost();
}

/**
 * The config of the machine, or an empty one.
 *
 * `readConfig` throws on a file that is not JSON, so that a person sees the
 * damage. `init` must not stop on it: it reads the port and the servers only
 * to write a client entry, and the kit refuses the same file at install time
 * with the message that names it.
 */
export function machineConfig(deps: McpHostDeps = {}): HostConfig {
  const host = machineOf(deps);
  try {
    return readConfig(host.home, host.read);
  } catch {
    return { port: DEFAULT_PORT, host: LOOPBACK, servers: [] };
  }
}

/** The URL that a client holds for chat-recall on this machine. */
export function localMcpUrl(deps: McpHostDeps = {}): string {
  const config = machineConfig(deps);
  return `http://${config.host}:${config.port}/${HOST_SERVER_NAME}`;
}

export interface HostInstall {
  /** The URL that a client holds. */
  url: string;
  /** The entry of chat-recall changed, so a host that already ran holds the old command. */
  changed: boolean;
  /** The files that the kit wrote. */
  written: string[];
  /** Why the install stopped, when it did. */
  problem?: string;
}

/**
 * Add chat-recall to the file of the machine and install the host.
 *
 * A second run writes nothing and restarts nothing: `addServer` keeps an entry
 * that is the same, and the kit keeps a service whose text is the same.
 */
export function installMcpHost(distDir: string, deps: McpHostDeps = {}): HostInstall {
  const host = machineOf(deps);
  const platform = deps.platform ?? process.platform;
  const url = localMcpUrl(deps);
  if (!hostSupported(platform)) {
    return { url, changed: false, written: [], problem: `the host of this machine needs Linux or macOS, not ${platform}` };
  }
  try {
    const spec = {
      name: HOST_SERVER_NAME,
      command: deps.execPath ?? process.execPath,
      args: [join(distDir, 'mcp.js')],
      env: { ...SERVER_ENV },
    };
    // A host that runs before the entry changes keeps the old command until one restart, because the kit writes the
    // service again only when its text changes.
    const ranBefore = hostStatus(host, platform) === 'running';
    const { config, changed } = addServer(host, spec);
    const argv = hostArgv({ node: spec.command, main: join(distDir, 'vendor', 'mcp-kit', 'host-main.js'), config: configPath(host.home) });
    const { written } = installHost(host, { argv, platform });
    if (changed && ranBefore) restartHost(host, platform);
    return { url: `http://${config.host}:${config.port}/${HOST_SERVER_NAME}`, changed, written };
  } catch (err) {
    return { url, changed: false, written: [], problem: (err as Error).message };
  }
}

/**
 * Remove chat-recall from the file of the machine.
 *
 * The host starts every server of the file and stops when the file holds none,
 * so the last server to leave stops the service with it. The config file stays,
 * because the other products of the machine share it.
 */
export function removeMcpHost(deps: McpHostDeps = {}): string[] {
  const host = machineOf(deps);
  const platform = deps.platform ?? process.platform;
  if (!hostSupported(platform)) return [];
  const config = machineConfig(deps);
  const servers = config.servers.filter((server) => server.name !== HOST_SERVER_NAME);
  if (servers.length === config.servers.length) return [];
  const file = configPath(host.home);
  host.write(file, `${JSON.stringify({ ...config, servers }, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  if (servers.length === 0) return uninstallHost(host, platform);
  restartHost(host, platform);
  return [file];
}
