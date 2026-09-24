/**
 * Who runs background sync on this machine, decided again on every tick.
 *
 * The watch service owns continuous sync while it runs, and the MCP process
 * stays a light tool server. When the service is not running, the MCP process
 * syncs. The MCP process used to ask this question once, at startup, and keep
 * the answer: on 2026-09-16 the service stopped, every MCP daemon that had
 * started while it ran kept standing by, and nothing synced for eight days.
 *
 * The answer can change in both directions, so it is asked on every interval:
 * the MCP process takes over when the service goes away and stands by again
 * when it comes back.
 *
 * Two writers never run at once. Every writer — the service, and each MCP
 * process — goes through `syncIncremental()`, which takes one O_EXCL lock and
 * skips its tick when another writer holds it. A tick this process already
 * started when the service came back finishes under that lock, and the service
 * waits for it.
 */

export type SyncScope = 'full' | 'changed';
export type SyncOwner = 'service' | 'mcp';

export interface SyncSupervisorOpts {
  /** Is the watch service running right now? A throw counts as "no". */
  serviceRunning: () => boolean;
  /** One sync pass. Errors are the caller's to log; a rejection is ignored here. */
  tick: (scope: SyncScope) => Promise<void>;
  /** Time between checks, and between sync passes while this process owns sync. */
  intervalMs: number;
  /** Time before the first check, so startup finishes before any sync work. */
  firstCheckMs: number;
  /** Called once, the first time this process takes over sync. */
  onFirstTakeover?: () => void;
  log?: (msg: string) => void;
}

export interface SyncSupervisor {
  /** Run one check now (the timers call this too). */
  check(): Promise<void>;
  /** Who owned sync at the last check; null before the first one. */
  owner(): SyncOwner | null;
  stop(): void;
}

export function createSyncSupervisor(opts: SyncSupervisorOpts): SyncSupervisor {
  let owner: SyncOwner | null = null;
  let inFlight = false;
  let tookOver = false;
  const log = opts.log ?? (() => {});

  const serviceRunning = (): boolean => {
    try {
      return opts.serviceRunning();
    } catch {
      return false;
    }
  };

  const check = async (): Promise<void> => {
    if (serviceRunning()) {
      if (owner !== 'service') {
        log(owner === 'mcp'
          ? 'watch service is running again — it owns sync; MCP background sync stands by'
          : 'watch service active — MCP will not run background sync (the service syncs)');
      }
      owner = 'service';
      return;
    }

    // A pass right after taking over walks the whole ledger, so whatever piled
    // up while nobody synced is shipped. Later passes walk recent changes.
    const scope: SyncScope = owner === 'mcp' ? 'changed' : 'full';
    if (owner !== 'mcp') {
      log(owner === 'service'
        ? 'watch service is no longer running — MCP takes over background sync'
        : 'no watch service running — MCP runs background sync');
      if (!tookOver) {
        tookOver = true;
        opts.onFirstTakeover?.();
      }
    }
    owner = 'mcp';

    // A full walk over a large history can outlast one interval. The next
    // check must not start a second pass beside it.
    if (inFlight) return;
    inFlight = true;
    try {
      await opts.tick(scope);
    } catch {
      /* the tick logs its own failures; the next interval tries again */
    } finally {
      inFlight = false;
    }
  };

  const first = setTimeout(() => { void check(); }, opts.firstCheckMs);
  first.unref?.();
  const every = setInterval(() => { void check(); }, opts.intervalMs);
  every.unref?.();

  return {
    check,
    owner: () => owner,
    stop: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
