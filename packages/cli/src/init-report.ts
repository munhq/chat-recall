/**
 * `init` says two things: installing, then done.
 *
 * ── What it used to say ───────────────────────────────────────────────────
 * Forty lines. A numbered heading per step, then a line per ITEM inside each
 * step — one per AI tool found AND per tool not found, one per MCP client
 * configured, one per skills directory, a four-line advert for an optional
 * companion, a sixty-name list of MCP tools, and the sync daemon's own log,
 * including "01758d3f… is 115MB (over the 64MB ceiling)".
 *
 * ── What it says now ──────────────────────────────────────────────────────
 *   chat-recall init  v0.5.27
 *   Installing…
 *   ✓ Done
 *
 * That is the whole contract. No step numbers, no counts, no per-item audit.
 *
 * The ONE exception is a thing the user must act on — a config file that would
 * not parse, an env var to set, a server that cannot be reached. Those print on
 * their own line, always. A quiet install that hides a failure is not quiet, it
 * is broken; every bug found on 2026-08-27 was one the output failed to name.
 */

export interface InitReporter {
  /** Show the single "Installing…" line. Idempotent — call it freely. */
  start: () => void;
  /** Something the user must act on. ALWAYS printed, on its own line. */
  warn: (text: string) => void;
  /** Clear the status line and print the closing line. */
  done: (text: string) => void;
}

export interface ReporterOpts {
  /** A TTY gets an in-place line it can overwrite; a pipe gets a plain one. */
  tty: boolean;
  write: (s: string) => void;
  line: (s: string) => void;
}

const INSTALLING = 'Installing…';

export function createInitReporter(opts: ReporterOpts): InitReporter {
  let painted = false;

  const clear = () => {
    if (painted && opts.tty) opts.write(`\r${' '.repeat(INSTALLING.length)}\r`);
    painted = false;
  };

  return {
    start() {
      if (painted) return;
      if (opts.tty) { opts.write(INSTALLING); painted = true; }
      else opts.line(INSTALLING);
    },
    warn(text) {
      // Clear first, or the warning lands on top of the status line.
      clear();
      opts.line(text);
    },
    done(text) {
      clear();
      opts.line(text);
    },
  };
}
