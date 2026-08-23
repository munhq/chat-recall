/**
 * The watch daemon's log — readable by a human by default, JSON when a machine
 * is going to read it.
 *
 * ── Why this is not just `createLogger()` ────────────────────────────────
 * The engine's logger emits JSON to stdout, which is right for a server pod whose
 * output goes to Loki. This daemon's output goes somewhere different: a file on
 * the user's own laptop that THEY tail, that `chat-recall doctor` points them at,
 * and that is the first thing anyone reads when their sync looks wrong. And
 * `pino-pretty` is not a dependency of this package — the native-free guard keeps
 * the collector's dependency list minimal — so LOG_PRETTY silently falls back to
 * JSON here.
 *
 * Converting 48 `console.*` calls to JSON would therefore have made the one
 * surface a user actually reads unreadable, in exchange for structure nothing was
 * consuming. So: human-readable lines by default, identical in shape to what the
 * daemon has always printed, and `CHAT_RECALL_LOG_JSON=1` for an operator
 * shipping to Loki or Vector.
 *
 * ── What this buys over console.* ────────────────────────────────────────
 *   LEVELS      `CHAT_RECALL_LOG_LEVEL=warn` silences the routine chatter. There
 *               was no way to turn down a daemon that logs a heartbeat a minute.
 *   STRUCTURE   fields travel alongside the message, so the JSON mode is
 *               genuinely parseable rather than a string to regex.
 *   ONE PLACE   the timestamp format, the level filter and the destination are
 *               decided once instead of at 48 call sites.
 */

/** Ordered so a threshold comparison is a number comparison. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.CHAT_RECALL_LOG_LEVEL || process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

const asJson = (): boolean => {
  const v = (process.env.CHAT_RECALL_LOG_JSON || '').trim();
  return v === '1' || v.toLowerCase() === 'true';
};

/** The daemon's existing prefix format: `[ISO-8601] message`. */
const stamp = (): string => `[${new Date().toISOString()}]`;

export interface DaemonLog {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;
  // stderr for warn/error, stdout otherwise — so a shell can separate them even
  // though the unit sends both to the same place.
  const out = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (asJson()) {
    out.write(`${JSON.stringify({ t: Date.now(), level, msg, ...fields })}\n`);
    return;
  }
  // Human mode: the message first, because that is what the reader is scanning
  // for. Fields are appended compactly and only when present — a trailing
  // `{...}` on every line would defeat the point of the human format.
  const extra = fields && Object.keys(fields).length > 0
    ? ` ${Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`
    : '';
  const prefix = level === 'warn' || level === 'error' ? `${stamp()} ${level.toUpperCase()}` : stamp();
  out.write(`${prefix} ${msg}${extra}\n`);
}

/** Compact enough to sit on a log line without wrapping it. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /\s/.test(s) ? JSON.stringify(s) : s;
}

export const daemonLog: DaemonLog = {
  debug: (m, f) => emit('debug', m, f),
  info: (m, f) => emit('info', m, f),
  warn: (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};
