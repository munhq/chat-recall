/**
 * Who wrote a `user` record in a Claude Code transcript.
 *
 * Claude Code writes much more than the person's prompts as `type:'user'`
 * records: background-task notifications, Stop-hook feedback, subagent
 * hand-backs, messages from other sessions, and the task prompt at the top of
 * every subagent transcript. Read as prompts, they made up about 20 of the 45
 * "user prompts" of one measured session, and hook feedback was scored as the
 * person being frustrated.
 *
 * Current transcripts say who wrote each record: `origin.kind` ('human',
 * 'task-notification', 'peer', …), `isMeta` for harness text and
 * `isSidechain` for subagent transcripts. Older transcripts and the
 * `queue-operation` records carry none of these, so the text prefixes the
 * harness writes are checked as well.
 *
 * A prompt typed while the agent works is delivered as an `attachment` record
 * of type `queued_command`, with the text in `attachment.prompt`. It is the
 * only record of that prompt with an author, so it is read as a prompt too.
 */

/** 'human' for text the person typed; otherwise the kind of injected text. */
export type PromptOrigin =
  | 'human'
  | 'subagent'
  | 'task-notification'
  | 'peer'
  | 'hook'
  | 'meta'
  | (string & {});

const INJECTED_PREFIXES: Array<[string, PromptOrigin]> = [
  ['<task-notification', 'task-notification'],
  ['<agent-message', 'peer'],
  ['Another Claude session sent a message:', 'peer'],
  ['Stop hook feedback:', 'hook'],
];

/** The origin a text prefix shows, or 'human' when it shows none. */
export function originFromText(text: string): PromptOrigin {
  const head = text.trimStart();
  for (const [prefix, origin] of INJECTED_PREFIXES) {
    if (head.startsWith(prefix)) return origin;
  }
  return 'human';
}

function declaredOrigin(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' && kind ? kind : undefined;
}

/** Who wrote the text of a `type:'user'` record. */
export function userRecordOrigin(obj: Record<string, unknown>, text: string): PromptOrigin {
  if (obj.isSidechain === true) return 'subagent';
  const declared = declaredOrigin(obj.origin);
  if (declared && declared !== 'human') return declared;
  if (obj.isMeta === true) return 'meta';
  if (declared === 'human') return 'human';
  return originFromText(text);
}

/** The text and author of a queued prompt delivered as an attachment, or null for any other record. */
export function queuedCommandPrompt(obj: Record<string, unknown>): { text: string; origin: PromptOrigin } | null {
  if (obj.type !== 'attachment') return null;
  const att = obj.attachment as Record<string, unknown> | undefined;
  if (!att || att.type !== 'queued_command') return null;
  const text = promptText(att.prompt);
  if (!text) return null;
  if (obj.isSidechain === true) return { text, origin: 'subagent' };
  const declared = declaredOrigin(att.origin);
  if (declared) return { text, origin: declared };
  return { text, origin: att.humanTurn === true ? 'human' : originFromText(text) };
}

/** A prompt is a string, or content blocks whose text parts are joined. */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
      && typeof (b as Record<string, unknown>).text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** A transcript message the person wrote: a user message with no harness origin. */
export function isPersonMessage(m: { role?: string; origin?: unknown }): boolean {
  return m.role === 'user' && !m.origin;
}
