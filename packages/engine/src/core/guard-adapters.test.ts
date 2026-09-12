import { describe, test, expect } from 'vitest';
import {
  readPayload, namesFrom, explain, writeVerdict, COVERAGE,
  type Harness, type Finding,
} from './guard-adapters.js';

const HARNESSES: Harness[] = ['claude', 'codex', 'agy', 'cursor', 'opencode'];

describe('every harness reads its own payload shape', () => {
  test('claude / codex PreToolUse — a bash call', () => {
    const got = namesFrom('claude', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install auth0' },
    });
    expect(got.names).toEqual(['auth0']);
  });

  test('claude / codex PreToolUse — an edit', () => {
    const got = namesFrom('codex', {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/auth.ts', new_string: 'import Keycloak from "keycloak-js";' },
    });
    expect(got.names).toEqual(['keycloak-js']);
  });

  test('antigravity keeps the Gemini BeforeTool shape', () => {
    const got = namesFrom('agy', { tool_name: 'run_shell', args: { command: 'pip install keycloak' } });
    expect(got.names).toEqual(['keycloak']);
  });

  test('antigravity sends the command under toolCall.args.CommandLine', () => {
    const got = namesFrom('agy', {
      toolCall: { name: 'run_command', args: { CommandLine: 'npm install auth0', Cwd: '/workspace' } },
    });
    expect(got.names).toContain('auth0');
    expect(got.via).toBe('install');
  });

  test('antigravity file writes are read from CodeContent', () => {
    const got = namesFrom('agy', {
      toolCall: { name: 'write_to_file', args: { TargetFile: '/w/app.ts', CodeContent: "import Keycloak from 'keycloak-js';" } },
    });
    expect(got.names).toContain('keycloak-js');
  });

  test('cursor beforeShellExecution', () => {
    expect(namesFrom('cursor', { command: 'pnpm add stripe' }).names).toEqual(['stripe']);
  });

  test('cursor afterFileEdit carries an edits array', () => {
    const got = namesFrom('cursor', {
      file_path: 'src/db.ts',
      edits: [{ new_string: 'import mysql from "mysql2";' }],
    });
    expect(got.names).toEqual(['mysql2']);
  });

  test('opencode passes args under output', () => {
    expect(namesFrom('opencode', { tool: 'bash', output: { args: { command: 'cargo add tokio' } } }).names)
      .toEqual(['tokio']);
  });

  test('an empty or foreign payload yields nothing rather than throwing', () => {
    for (const h of HARNESSES) {
      expect(namesFrom(h, {}).names).toEqual([]);
      expect(namesFrom(h, null).names).toEqual([]);
      expect(namesFrom(h, { unexpected: true }).names).toEqual([]);
    }
  });

  test('readPayload never invents fields', () => {
    const p = readPayload('claude', { tool_name: 'Read', tool_input: { file_path: 'x.ts' } });
    expect(p.command).toBeNull();
    expect(p.content).toBeNull();
    expect(p.path).toBe('x.ts');
  });
});

describe('verdicts are written in each harness dialect', () => {
  const msg = 'chat-recall: already decided';

  test('allow is silent everywhere', () => {
    for (const h of HARNESSES) {
      expect(writeVerdict(h, 'allow', msg).json).toBeUndefined();
      expect(writeVerdict(h, 'allow', msg).exitCode).toBe(0);
    }
  });

  test('warn NEVER blocks, on any harness', () => {
    // The load-bearing rule: a wrong block burns the user's turn and teaches
    // them to uninstall the guard.
    const claude = writeVerdict('claude', 'warn', msg).json as any;
    expect(claude.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(claude.hookSpecificOutput.additionalContext).toBe(msg);

    expect((writeVerdict('agy', 'warn', msg).json as any).decision).toBe('allow');
    // Cursor's reference prints snake_case and its type definitions camelCase.
    const cursor = writeVerdict('cursor', 'warn', msg).json as any;
    expect(cursor.agent_message).toBe(msg);
    expect(cursor.agentMessage).toBe(msg);
    expect((writeVerdict('cursor', 'warn', msg).json as any).permission).toBe('allow');
    expect((writeVerdict('opencode', 'warn', msg).json as any).block).toBe(false);

    for (const h of HARNESSES) expect(writeVerdict(h, 'warn', msg).exitCode).toBe(0);
  });

  test('ask blocks only where the harness has a real ask verdict', () => {
    // Antigravity is the only one with it.
    expect((writeVerdict('agy', 'ask', msg).json as any).decision).toBe('ask');
    // Everywhere else it degrades to a warning, not to deny.
    expect((writeVerdict('claude', 'ask', msg).json as any).hookSpecificOutput.additionalContext).toBe(msg);
    expect((writeVerdict('cursor', 'ask', msg).json as any).permission).toBe('allow');
    expect((writeVerdict('opencode', 'ask', msg).json as any).block).toBe(false);
  });

  test('deny is honoured where it exists', () => {
    expect((writeVerdict('claude', 'deny', msg).json as any).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((writeVerdict('agy', 'deny', msg).json as any).decision).toBe('deny');
    expect((writeVerdict('cursor', 'deny', msg).json as any).permission).toBe('deny');
    expect((writeVerdict('opencode', 'deny', msg).json as any).block).toBe(true);
  });

  test('an empty message never produces a verdict', () => {
    for (const h of HARNESSES) expect(writeVerdict(h, 'deny', '').json).toBeUndefined();
  });
});

describe('coverage is declared, not implied', () => {
  test('every harness has an entry', () => {
    for (const h of HARNESSES) expect(COVERAGE[h]).toBeDefined();
  });

  test('the two partial harnesses say so', () => {
    // Hiding these would be the dishonest version of "works everywhere".
    expect(COVERAGE.cursor.edits).toBe('after');
    expect(COVERAGE.cursor.note).toContain('afterFileEdit');
    expect(COVERAGE.opencode.note).toContain('subagent');
  });

  test('the three complete ones claim before-edit coverage', () => {
    for (const h of ['claude', 'codex', 'agy'] as Harness[]) {
      expect(COVERAGE[h].edits).toBe('before');
      expect(COVERAGE[h].note).toBeUndefined();
    }
  });
});

describe('explain', () => {
  const f: Finding = {
    name: 'keycloak', area: 'auth', instead: 'BetterAuth',
    since: '2026-03-14', source_session: '8f2c1a4e', reason: 'auth is decided',
  };

  test('leads with the decision and says what to do', () => {
    const out = explain([f]);
    expect(out).toContain('keycloak was ruled out');
    expect(out).toContain('BetterAuth is the decision');
    expect(out).toContain('2026-03-14');
    expect(out).toContain('session 8f2c1a4e');
    expect(out).toContain('recall_decision_record');
  });

  test('no findings, no message', () => {
    expect(explain([])).toBe('');
  });
});
