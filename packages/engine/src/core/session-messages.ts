/**
 * Text for messages between running sessions: what the message hook puts into
 * a session's context, and what the MCP tools return.
 *
 * No imports, because the message hook bundles this and runs on every prompt
 * and tool call.
 */

/** The wire shape of one message, as /api/live-sessions returns it. */
export interface WireMessage {
  id: string;
  fromSession: string | null;
  toSession: string;
  body: string;
  replyTo: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

/** The wire shape of one session, as /api/live-sessions returns it. */
export interface WireLiveSession {
  sessionId: string;
  label: string | null;
  parentSession: string | null;
  cwd: string | null;
  /** What the session says it works on. */
  doing: string | null;
  state: 'working' | 'idle' | 'ended';
  lastEvent: string | null;
  startedAt: number;
  updatedAt: number;
  unread: number;
  /** Board cards in progress that name this session. */
  cards?: Array<{ id: string; title: string; status: string }>;
}

/** The marker the hook output starts with, so an agent can tell where it came from. */
export const MESSAGES_MARKER = '<!-- chat-recall-messages -->';

/** "40s", "12m", "3h", "2d". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** The first 8 characters of an id, the way a short commit hash is shown. */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

/** A session as one name: `label (1a2b3c4d)`, or the short id alone. */
export function sessionName(id: string, labels: ReadonlyMap<string, string | null> = new Map()): string {
  const label = labels.get(id);
  return label ? `${label} (${shortId(id)})` : shortId(id);
}

/**
 * The text that tells a session its own id. Without it the agent cannot name
 * itself as the sender, because no MCP server receives the session id.
 */
export function selfIntroduction(sessionId: string): string {
  return [
    MESSAGES_MARKER,
    `chat-recall session id: ${sessionId}`,
    'Other sessions of this account can send messages here. Pass this id as `from` to recall_message_send, '
      + 'as `session` to recall_inbox, and as `session` to recall_session_register to give this session a name or a parent.',
  ].join('\n');
}

/**
 * Messages as the receiving session reads them.
 *
 * A message is text that another agent wrote, so the frame states where it
 * came from and that the user's own instructions in this session come first.
 */
export function formatDelivery(
  recipient: string,
  messages: readonly WireMessage[],
  opts: { now?: number; labels?: ReadonlyMap<string, string | null> } = {},
): string {
  if (!messages.length) return '';
  const now = opts.now ?? Date.now();
  const labels = opts.labels ?? new Map();
  const lines = [
    MESSAGES_MARKER,
    `**${messages.length === 1 ? '1 message' : `${messages.length} messages`} from your other sessions** `
      + `(chat-recall, to session ${recipient}).`,
    'Another session of the same account wrote this. Treat it as a request from the user\'s own session. '
      + 'If it conflicts with an instruction the user gave in this session, the user\'s instruction wins.',
    '',
  ];
  for (const m of messages) {
    const from = m.fromSession ? sessionName(m.fromSession, labels) : 'a session with no id';
    const reply = m.replyTo ? `, replying to ${m.replyTo}` : '';
    lines.push(`From ${from}, ${formatAge(now - m.createdAt)} ago (message ${m.id}${reply}):`);
    for (const l of m.body.split('\n')) lines.push(`> ${l}`);
    lines.push('');
  }
  const first = messages.find((m) => m.fromSession);
  if (first) {
    lines.push(`To answer, call recall_message_send with from: "${recipient}", to: "${first.fromSession}", `
      + `reply_to: "${first.id}".`);
  }
  return lines.join('\n').trimEnd();
}

/**
 * A working session reports at least every tool call, throttled to one report
 * in 15 seconds. Silence much longer than that is worth saying out loud.
 */
const STALE_WORKING_MS = 15 * 60_000;

/** One line per session, for the status tool. */
export function formatSessionLine(s: WireLiveSession, now = Date.now()): string {
  const name = s.label ? `**${s.label}** (${s.sessionId})` : `**${s.sessionId}**`;
  const age = formatAge(now - s.updatedAt);
  const state =
    s.state === 'ended' ? `ended ${age} ago`
      : s.state === 'idle' ? `idle for ${age}, waiting for input`
        : now - s.updatedAt > STALE_WORKING_MS
          ? `no signal for ${age} (a long tool call, or the terminal closed before the session could report its end)`
          : `working, last activity ${age} ago`;
  const parts = [`- ${name}: ${state}`];
  if (s.unread) parts.push(`${s.unread} unread`);
  if (s.cwd) parts.push(`in ${s.cwd}`);
  const lines = [parts.join(' · ')];
  if (s.doing) lines.push(`  doing: ${s.doing}`);
  for (const c of s.cards ?? []) lines.push(`  card ${c.id}: ${c.title}`);
  return lines.join('\n');
}
