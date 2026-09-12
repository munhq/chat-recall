/**
 * One guard, five harnesses.
 *
 * Every tool chat-recall indexes can intercept a call before it runs, and every
 * one of them spells it differently. Rather than five hooks each carrying their
 * own idea of what a decision is, each harness gets a thin adapter: read its
 * payload into one shape, and write one verdict back in its own dialect.
 *
 * ── What each harness actually offers ───────────────────────────────────────
 *
 *   claude   PreToolUse                       allow · deny
 *   codex    PreToolUse (modelled on Claude)  allow · deny
 *   agy      PreToolUse                       allow · deny · ASK · force_ask
 *   cursor   beforeShellExecution             allow · deny
 *            afterFileEdit                    AFTER the fact — observe only
 *   opencode tool.execute.before (plugin)     throw to block
 *
 * Two of those are not full coverage and the docs must say so rather than imply
 * it. Cursor sees shell commands before they run but file edits only after, so
 * an import added there is reported, not prevented. OpenCode's plugin hook does
 * not fire for subagent tool calls at all (anomalyco/opencode#5894), so an
 * agent that delegates routes around it.
 *
 * ── Why `ask` degrades to a message, not a block ────────────────────────────
 *
 * Antigravity is alone in having a first-class "ask the user" verdict. Everyone
 * else has allow or deny, and emulating ask with deny would turn a warning into
 * a burned turn on four harnesses out of five. So the canonical verdict is
 * carried as CONTEXT the agent reads, and blocking is reserved for a caller who
 * explicitly asked for it.
 */

import { introducedBy, type GuardInput } from './decision-guard.js';

export type Harness = 'claude' | 'codex' | 'agy' | 'cursor' | 'opencode';
export type Verdict = 'allow' | 'warn' | 'ask' | 'deny';

export interface Finding {
  name: string;
  area: string | null;
  instead: string | null;
  since: string | null;
  source_session: string | null;
  reason: string;
}

/** Coverage, stated per harness so the docs cannot drift from the code. */
export const COVERAGE: Record<Harness, { commands: boolean; edits: 'before' | 'after' | 'none'; note?: string }> = {
  claude: { commands: true, edits: 'before' },
  codex: { commands: true, edits: 'before' },
  agy: { commands: true, edits: 'before' },
  cursor: {
    commands: true, edits: 'after',
    note: 'Cursor exposes beforeShellExecution but only afterFileEdit, so an import added in an edit is reported after the write, not prevented.',
  },
  opencode: {
    commands: true, edits: 'before',
    note: 'OpenCode plugin hooks do not fire for subagent tool calls (anomalyco/opencode#5894), so an agent that delegates bypasses this.',
  },
};

/**
 * Read a harness's hook payload into the shape the matcher understands.
 *
 * Every field is optional in every harness — a payload that carries none of
 * them yields nothing to check, which is the right answer rather than an error.
 */
export function readPayload(harness: Harness, payload: unknown): GuardInput {
  const p = (payload ?? {}) as Record<string, any>;

  switch (harness) {
    case 'claude':
    case 'codex': {
      // { tool_name, tool_input: { command | file_path + new_string/content } }
      const input = p.tool_input ?? p.toolInput ?? {};
      return {
        tool: p.tool_name ?? p.toolName ?? null,
        command: input.command ?? null,
        path: input.file_path ?? input.path ?? null,
        content: input.new_string ?? input.content ?? input.new_str ?? null,
      };
    }
    case 'agy': {
      // Antigravity sends protojson: { toolCall: { name, args: { CommandLine,
      // Cwd, … } } }, with the args capitalised. Reading tool_input here found
      // nothing, so every Antigravity call looked like it introduced no names.
      const call = p.toolCall ?? p.tool_call ?? {};
      const input = call.args ?? p.tool_input ?? p.args ?? {};
      return {
        tool: call.name ?? p.tool_name ?? p.tool ?? null,
        command: input.CommandLine ?? input.command ?? input.cmd ?? null,
        path: input.TargetFile ?? input.AbsolutePath ?? input.file_path ?? input.path ?? null,
        content: input.CodeContent ?? input.ReplacementContent ?? input.content ?? input.new_string ?? null,
      };
    }
    case 'cursor': {
      // beforeShellExecution: { command }. afterFileEdit: { file_path, edits[] }.
      const edits = Array.isArray(p.edits) ? p.edits : [];
      return {
        tool: p.hook_event_name ?? null,
        command: p.command ?? null,
        path: p.file_path ?? null,
        content: edits.map((e: any) => e?.new_string ?? e?.newText ?? '').join('\n') || p.content || null,
      };
    }
    case 'opencode': {
      // tool.execute.before: (input {tool, sessionID}, output {args})
      const args = p.args ?? p.output?.args ?? {};
      return {
        tool: p.tool ?? p.input?.tool ?? null,
        command: args.command ?? null,
        path: args.filePath ?? args.path ?? null,
        content: args.content ?? args.newString ?? null,
      };
    }
  }
}

/** The names a payload would introduce — the whole client-side job. */
export function namesFrom(harness: Harness, payload: unknown): ReturnType<typeof introducedBy> {
  return introducedBy(readPayload(harness, payload));
}

/**
 * The message a person reads. One line per finding, and it names what to do.
 *
 * Written to be read by an agent mid-task, so it leads with the decision rather
 * than with chat-recall: the agent needs the fact, not the provenance of the
 * tool that supplied it.
 */
export function explain(findings: Finding[]): string {
  if (!findings.length) return '';
  const lines = findings.map((f) => {
    const head = f.instead
      ? `${f.name} was ruled out — ${f.instead} is the decision`
      : `${f.name} was ruled out`;
    const when = f.since ? ` (${f.since})` : '';
    const where = f.source_session ? ` · session ${f.source_session}` : '';
    return `- ${head}${when}${where}`;
  });
  return [
    'chat-recall: this reaches for something already decided against.',
    ...lines,
    'Proceed only if this is a deliberate reversal. If it is, record it:',
    'recall_decision_record with the area, so the old decision is closed rather than contradicted.',
  ].join('\n');
}

/**
 * Write the verdict in the harness's own dialect.
 *
 * `warn` never blocks anywhere: it is returned as context the agent reads.
 * `ask` blocks only where the harness has a real ask verdict (Antigravity);
 * everywhere else it degrades to warn rather than to deny, because a burned
 * turn is a worse failure than an unheeded warning.
 */
export function writeVerdict(
  harness: Harness, verdict: Verdict, message: string,
): { json?: unknown; exitCode: number; stderr?: string } {
  if (verdict === 'allow' || !message) return { exitCode: 0 };

  switch (harness) {
    case 'claude':
    case 'codex': {
      if (verdict === 'deny') {
        return {
          json: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } },
          exitCode: 0,
        };
      }
      // Additional context on stdout, exit 0: the call proceeds and the agent
      // reads the decision alongside its own plan.
      return {
        json: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } },
        exitCode: 0,
      };
    }
    case 'agy': {
      const decision = verdict === 'deny' ? 'deny' : verdict === 'ask' ? 'ask' : 'allow';
      return { json: { decision, reason: message }, exitCode: 0 };
    }
    case 'cursor': {
      // Cursor's hook reference prints the response fields as user_message and
      // agent_message; its published type definitions spell them userMessage
      // and agentMessage. Both are written, and the reader takes the one it
      // knows.
      if (verdict === 'deny') {
        return { json: { permission: 'deny', user_message: message, userMessage: message }, exitCode: 0 };
      }
      return {
        json: { permission: 'allow', agent_message: message, agentMessage: message },
        exitCode: 0,
      };
    }
    case 'opencode': {
      // The plugin throws to block; anything else is surfaced as text.
      return { json: { block: verdict === 'deny', message }, exitCode: 0 };
    }
  }
}
