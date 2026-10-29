/**
 * Pi backend contract: id handling, session listing from the
 * `<agent dir>/sessions/--<cwd>--/<timestamp>_<id>.jsonl` layout, and the
 * canonical events the generic engine consumes.
 *
 * Fixtures use invented paths (`/home/user/code/example-app`) so the test
 * asserts a string transformation and publishes nobody's home directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { PiBackend, piBackend } from './pi.js';

const CWD = '/home/user/code/example-app';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `chat-recall-${prefix}-`));
}

/** The lines Pi writes for a two-turn session that edits one file. */
function sessionLines(opts: { name?: string; summary?: string } = {}): string[] {
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: SESSION_ID,
      timestamp: '2026-05-06T06:00:00.000Z',
      cwd: CWD,
    }),
    JSON.stringify({
      type: 'message',
      id: 'a1b2c3d4',
      parentId: null,
      timestamp: '2026-05-06T06:00:01.000Z',
      message: {
        role: 'user',
        content: 'please fix the greeting in src/app.ts',
        timestamp: 1778053201000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'b2c3d4e5',
      parentId: 'a1b2c3d4',
      timestamp: '2026-05-06T06:00:02.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing the greeting now.' },
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'edit',
            arguments: {
              path: 'src/app.ts',
              edits: [{ oldText: "greeting = 'hi'", newText: "greeting = 'hello'" }],
            },
          },
        ],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: 1778053202000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'c3d4e5f6',
      parentId: 'b2c3d4e5',
      timestamp: '2026-05-06T06:00:03.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'edit applied' }],
        isError: false,
        timestamp: 1778053203000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'd4e5f6a7',
      parentId: 'c3d4e5f6',
      timestamp: '2026-05-06T06:00:04.000Z',
      message: {
        role: 'bashExecution',
        command: 'npm test',
        output: 'all green',
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1778053204000,
      },
    }),
    JSON.stringify({
      type: 'message',
      id: 'e5f6a7b8',
      parentId: 'd4e5f6a7',
      timestamp: '2026-05-06T06:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'The greeting is fixed.' }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1778053205000,
      },
    }),
  ];
  if (opts.name) {
    lines.push(JSON.stringify({
      type: 'session_info', id: 'f6a7b8c9', parentId: 'e5f6a7b8',
      timestamp: '2026-05-06T06:00:06.000Z', name: opts.name,
    }));
  }
  if (opts.summary) {
    lines.push(JSON.stringify({
      type: 'compaction', id: 'g7b8c9d0', parentId: 'e5f6a7b8',
      timestamp: '2026-05-06T06:00:07.000Z', summary: opts.summary,
      firstKeptEntryId: 'g7b8c9d0', tokensBefore: 5000,
    }));
  }
  return lines;
}

describe('PiBackend', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedSessions: string | undefined;

  beforeEach(() => {
    home = makeTmpDir('pi');
    savedHome = process.env.CHAT_RECALL_PI_HOME;
    savedSessions = process.env.CHAT_RECALL_PI_SESSION_DIR;
    process.env.CHAT_RECALL_PI_HOME = home;
    delete process.env.CHAT_RECALL_PI_SESSION_DIR;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CHAT_RECALL_PI_HOME;
    else process.env.CHAT_RECALL_PI_HOME = savedHome;
    if (savedSessions === undefined) delete process.env.CHAT_RECALL_PI_SESSION_DIR;
    else process.env.CHAT_RECALL_PI_SESSION_DIR = savedSessions;
    delete process.env.PI_CODING_AGENT_SESSION_DIR;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSession(lines: string[], id = SESSION_ID, dir = '--home-user-code-example-app--'): string {
    const sessionDir = join(home, 'sessions', dir);
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, `2026-05-06T06-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  /** The global key the backend assigns to the fixture session. */
  function key(): string {
    return new PiBackend().listSessions({ previews: false })[0].rawId;
  }

  it('homeDir and session root respect the env overrides', () => {
    const b = new PiBackend();
    expect(b.homeDir()).toBe(home);
    expect(b.sessionDirs()).toEqual([]);           // nothing written yet
    mkdirSync(join(home, 'sessions'), { recursive: true });
    expect(new PiBackend().sessionDirs()).toEqual([join(home, 'sessions')]);
    process.env.CHAT_RECALL_PI_SESSION_DIR = join(home, 'elsewhere');
    expect(new PiBackend().sessionDirs()).toEqual([]);
    mkdirSync(join(home, 'elsewhere'), { recursive: true });
    expect(new PiBackend().sessionDirs()).toEqual([join(home, 'elsewhere')]);
  });

  it('reads an absolute sessionDir from Pi settings.json', () => {
    const custom = join(home, 'custom-sessions');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionDir: custom }));
    expect(new PiBackend().sessionDirs()).toEqual([custom]);
  });

  it('ignores a relative sessionDir, which Pi resolves per working directory', () => {
    // Pi resolves `sessionDir: "sessions"` from whatever cwd it was started in,
    // so there is no one folder this machine could scan for it.
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionDir: 'sessions' }));
    expect(new PiBackend().sessionDirs()).toEqual([join(home, 'sessions')]);
  });

  it('expands a leading ~ in Pi path settings', () => {
    // os.homedir() reads HOME on Unix and USERPROFILE on Windows.
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      mkdirSync(join(home, 'tilde-sessions'), { recursive: true });
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionDir: '~/tilde-sessions' }));
      expect(new PiBackend().sessionDirs()).toEqual([join(home, 'tilde-sessions')]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    }
  });

  it('re-reads the settings file when its mtime changes', () => {
    const first = join(home, 'first');
    const second = join(home, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    const settings = join(home, 'settings.json');
    writeFileSync(settings, JSON.stringify({ sessionDir: first }));
    expect(new PiBackend().sessionDirs()).toEqual([first]);

    writeFileSync(settings, JSON.stringify({ sessionDir: second }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(settings, later, later);
    expect(new PiBackend().sessionDirs()).toEqual([second]);
  });

  it('isAvailable is false until a session root exists', () => {
    expect(new PiBackend().isAvailable()).toBe(false);
    mkdirSync(join(home, 'sessions'), { recursive: true });
    expect(new PiBackend().isAvailable()).toBe(true);
  });

  it('id round-trip', () => {
    expect(piBackend.matchesId('pi_' + SESSION_ID)).toBe(true);
    expect(piBackend.matchesId(SESSION_ID)).toBe(false);
    expect(piBackend.toRawId('pi_' + SESSION_ID)).toBe(SESSION_ID);
    expect(piBackend.toPrefixedId(SESSION_ID)).toBe('pi_' + SESSION_ID);
  });

  it('listSessions reads the header cwd, the first prompt and the message count', () => {
    writeSession(sessionLines());
    const sessions = new PiBackend().listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].toolId).toBe('pi');
    expect(sessions[0].rawId).toMatch(new RegExp(`^${SESSION_ID}~[0-9a-f]{8}$`));
    expect(sessions[0].prefixedId).toBe('pi_' + sessions[0].rawId);
    expect(sessions[0].projectPath).toBe(CWD);
    expect(sessions[0].firstPrompt).toContain('fix the greeting');
    // The count is conversation turns (user + assistant); tool results and
    // `!` shell commands are events, not messages.
    expect(sessions[0].messageCount).toBe(3);
  });

  it('listSessions ignores JSONL files that are not Pi sessions', () => {
    const sessionDir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '2026-05-06T06-00-00-000Z_other.jsonl'), '{"role":"user"}\n');
    writeFileSync(join(sessionDir, 'notes.jsonl'), '{"role":"assistant","content":"not a session"}\n');
    expect(new PiBackend().listSessions()).toEqual([]);
  });

  it('listSessions with previews false lists the session without reading content', () => {
    writeSession(sessionLines());
    const [ref] = new PiBackend().listSessions({ previews: false });
    expect(ref.rawId).toMatch(new RegExp(`^${SESSION_ID}~[0-9a-f]{8}$`));
    expect(ref.firstPrompt).toBe('');
    expect(ref.messageCount).toBe(0);
  });

  it('readEvents turns the JSONL into user / assistant / tool use / result events', () => {
    writeSession(sessionLines());
    const events = new PiBackend().readEvents(key());
    expect(events.map((e) => e.kind)).toEqual([
      'user', 'assistant_text', 'tool_use', 'tool_result', 'tool_use', 'tool_result', 'assistant_text',
    ]);
    expect(events[0].text).toContain('fix the greeting');
    expect(events[2].toolName).toBe('edit');
    expect(events[2].toolUseId).toBe('call_1');
    expect(events[3].toolUseId).toBe('call_1');
    expect(events[3].resultBody).toBe('edit applied');
    // A `!` shell command the user ran is a use + result pair, with its command.
    expect(events[4].toolName).toBe('bash');
    expect(events[4].command).toBe('npm test');
    expect(events[5].resultBody).toBe('all green');
  });

  it('extractTurns finds both prompts and the tool call', () => {
    writeSession(sessionLines());
    const turns = new PiBackend().extractTurns(key());
    expect(turns.found).toBe(true);
    expect(turns.turns.length).toBeGreaterThanOrEqual(1);
    expect(turns.turns[0].text).toContain('fix the greeting');
  });

  it('liveScanEdits records write/edit but not bash', () => {
    writeSession([
      JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
      JSON.stringify({
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'src/new.ts', content: 'a\nb\n' } },
            { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'touch src/x.ts' } },
            { type: 'toolCall', id: 'c3', name: 'read', arguments: { path: 'src/app.ts' } },
          ],
          timestamp: 1778053201000,
        },
      }),
    ]);
    const result = new PiBackend().liveScanEdits(key());
    expect(result.found).toBe(true);
    expect(result.tool).toBe('pi');
    expect(result.projectPath).toBe(CWD);
    expect(result.edits.map((e) => `${e.op}:${e.file}`)).toEqual([
      'write:src/new.ts',
      'read:src/app.ts',
    ]);
  });

  it('replay counts the lines a write and a multi-edit landed', () => {
    writeSession([
      JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
      JSON.stringify({
        type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'src/new.ts', content: 'a\nb\n' } },
            {
              type: 'toolCall', id: 'c2', name: 'edit',
              arguments: {
                path: 'src/app.ts',
                // Both fragments end with a newline, so the diff counts the
                // replaced lines alone.
                edits: [
                  { oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
                  { oldText: 'alpha\n', newText: 'ALPHA\n' },
                ],
              },
            },
          ],
          timestamp: 1778053201000,
        },
      }),
    ]);
    const diff = new PiBackend().replay(key());
    expect(diff.found).toBe(true);
    const byFile = Object.fromEntries(diff.files.map((f) => [f.file, f]));
    expect(byFile['src/new.ts'].linesAdded).toBe(2);
    // Two disjoint fragments, joined into one before/after pair.
    expect(byFile['src/app.ts'].linesAdded).toBe(2);
    expect(byFile['src/app.ts'].linesRemoved).toBe(2);
  });

  it('getNativeTitle reads the newest session_info name', () => {
    writeSession(sessionLines({ name: 'Greeting fix' }));
    expect(new PiBackend().getNativeTitle(key())).toBe('Greeting fix');
  });

  it('getNativeTitle is null when the session was never named', () => {
    writeSession(sessionLines());
    expect(new PiBackend().getNativeTitle(key())).toBeNull();
  });

  it('a compaction entry becomes a summary event', () => {
    writeSession(sessionLines({ summary: 'Earlier: the greeting lived in app.ts.' }));
    const events = new PiBackend().readEvents(key());
    const summary = events.find((e) => e.kind === 'summary');
    expect(summary?.text).toContain('greeting lived in app.ts');
  });

  it('exportRawSession returns the transcript file verbatim', () => {
    const path = writeSession(sessionLines());
    const raw = new PiBackend().exportRawSession(key());
    expect(raw?.tool).toBe('pi');
    expect(raw?.files).toHaveLength(1);
    expect(raw?.files[0].name).toBe(`2026-05-06T06-00-00-000Z_${SESSION_ID}.jsonl`);
    expect(raw?.files[0].bytes.length).toBeGreaterThan(0);
    expect(path.endsWith(raw!.files[0].name)).toBe(true);
  });

  it('keeps both conversations when two projects reuse one session id', () => {
    // `pi --session-id <id>` creates that id in whichever project runs it, so
    // the same id can name two different conversations.
    const id = 'shared-session';
    const write = (dir: string, cwd: string, prompt: string, mtime: number) => {
      const projectDir = join(home, 'sessions', dir);
      mkdirSync(projectDir, { recursive: true });
      const path = join(projectDir, `2026-05-06T06-00-00-000Z_${id}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-05-06T06:00:00.000Z', cwd }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
          message: { role: 'user', content: prompt, timestamp: 1778053201000 } }),
      ].join('\n') + '\n');
      utimesSync(path, new Date(mtime), new Date(mtime));
      return path;
    };
    const aPath = write('--a--', '/home/user/code/a', 'prompt from a', Date.now() - 60_000);
    write('--b--', '/home/user/code/b', 'prompt from b', Date.now());

    const sessions = new PiBackend().listSessions();
    expect(sessions).toHaveLength(2);

    const keys = sessions.map((s) => s.rawId).sort();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k).toMatch(new RegExp(`^${id}~[0-9a-f]{8}$`));
    // Each project has its own key, and the key names the project it came from.
    const byProject = new Map(sessions.map((s) => [s.projectPath, s.rawId]));
    expect(byProject.get('/home/user/code/a')).toMatch(new RegExp(`^${id}~[0-9a-f]{8}$`));
    expect(byProject.get('/home/user/code/b')).toMatch(new RegExp(`^${id}~[0-9a-f]{8}$`));
    expect(byProject.get('/home/user/code/a')).not.toBe(byProject.get('/home/user/code/b'));

    for (const s of sessions) {
      const events = new PiBackend().readEvents(s.prefixedId);
      expect(events.some((e) => e.kind === 'user')).toBe(true);
    }

    // An append changes an mtime, and the keys must not move with it.
    appendFileSync(aPath, JSON.stringify({
      type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-05-06T06:10:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'later answer' }], timestamp: 1778053800000 },
    }) + '\n');
    const after = new PiBackend().listSessions();
    expect(after.map((s) => `${s.rawId}|${s.projectPath}`).sort())
      .toEqual(sessions.map((s) => `${s.rawId}|${s.projectPath}`).sort());
  });

  it('separates two projects when sessionDir is one flat folder', () => {
    // A custom sessionDir writes every project's files into one folder, so the
    // containing folder cannot name the project. The header cwd can.
    const flat = join(home, 'flat-sessions');
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionDir: flat }));
    const id = 'shared-flat';
    const write = (stamp: string, cwd: string, prompt: string, mtime: number) => {
      const path = join(flat, `${stamp}_${id}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-05-06T06:00:00.000Z', cwd }),
        JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
          message: { role: 'user', content: prompt, timestamp: 1778053201000 } }),
      ].join('\n') + '\n');
      utimesSync(path, new Date(mtime), new Date(mtime));
    };
    write('2026-05-06T06-00-00-000Z', '/home/user/code/a', 'prompt from a', Date.now() - 60_000);
    write('2026-05-06T06-00-01-000Z', '/home/user/code/b', 'prompt from b', Date.now());

    const sessions = new PiBackend().listSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((s) => s.rawId)).size).toBe(2);
    expect(sessions.map((s) => s.projectPath).sort())
      .toEqual(['/home/user/code/a', '/home/user/code/b']);
  });

  it('uses the header id when the file name carries another one', () => {
    // `/import` can name a copy differently; the header id is what Pi resumes.
    const dir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-05-06T06-00-00-000Z_copy-1.jsonl'), [
      JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
        message: { role: 'user', content: 'hi', timestamp: 1778053201000 } }),
    ].join('\n') + '\n');
    const [ref] = new PiBackend().listSessions();
    expect(ref.rawId).toMatch(new RegExp(`^${SESSION_ID}~[0-9a-f]{8}$`));
  });

  it('follows the live file when a copy of the session exists', () => {
    const dir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(dir, { recursive: true });
    const lines = (text: string) => [
      JSON.stringify({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
        message: { role: 'user', content: text, timestamp: 1778053201000 } }),
    ].join('\n') + '\n';
    const live = join(dir, `2026-05-06T06-00-00-000Z_${SESSION_ID}.jsonl`);
    const copy = join(dir, `2026-05-06T06-10-00-000Z_${SESSION_ID}-1.jsonl`);
    writeFileSync(live, lines('live prompt'));
    writeFileSync(copy, lines('copied prompt'));
    utimesSync(live, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    utimesSync(copy, new Date(Date.now()), new Date(Date.now()));

    const backend = new PiBackend();
    const key = backend.listSessions()[0].rawId;
    expect(backend.findSession(key)?.path).toBe(copy);

    // The live file keeps writing; it is the one the next lookup must read.
    appendFileSync(live, JSON.stringify({
      type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-05-06T06:20:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'later' }], timestamp: 1778054400000 },
    }) + '\n');
    expect(backend.findSession(key)?.path).toBe(live);
  });

  it('stops syncing a custom session root the operator declined', async () => {
    const custom = join(home, 'declined-sessions');
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ sessionDir: custom }));

    const savedData = process.env.CHAT_RECALL_DATA_DIR;
    process.env.CHAT_RECALL_DATA_DIR = join(home, 'data');
    const { loadSettings, saveSettings } = await import('../settings.js');
    const { _resetSourceSettingsCache } = await import('../tool-paths.js');
    try {
      const settings = loadSettings();
      settings.sources.declinedHomes = [custom];
      saveSettings(settings);
      _resetSourceSettingsCache();
      expect(new PiBackend().sessionDirs()).toEqual([]);
    } finally {
      if (savedData === undefined) delete process.env.CHAT_RECALL_DATA_DIR;
      else process.env.CHAT_RECALL_DATA_DIR = savedData;
      _resetSourceSettingsCache();
    }
  });

  it('lists a session whose header completes without a directory change', () => {
    const dir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `2026-05-06T06-00-00-000Z_${SESSION_ID}.jsonl`);
    writeFileSync(path, '{"type":"session","vers');
    const backend = new PiBackend();
    expect(backend.listSessions()).toEqual([]);

    // Finish the header in place: the folder mtime does not move.
    writeFileSync(path, sessionLines().join('\n') + '\n');
    expect(backend.listSessions()).toHaveLength(1);
  });

  it('handles a session id that starts with the tool prefix', () => {
    // `pi --session-id` allows `_`, so an id can start with `pi_`.
    const id = 'pi_probe';
    const dir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `2026-05-06T06-00-00-000Z_${id}.jsonl`), [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-05-06T06:00:00.000Z', cwd: CWD }),
      JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-05-06T06:00:01.000Z',
        message: { role: 'user', content: 'prefixed id', timestamp: 1778053201000 } }),
    ].join('\n') + '\n');

    const backend = new PiBackend();
    const [ref] = backend.listSessions();
    expect(ref.rawId).toMatch(new RegExp(`^${id}~[0-9a-f]{8}$`));
    expect(ref.prefixedId).toBe(`pi_${ref.rawId}`);
    expect(backend.readEvents(ref.prefixedId).some((e) => e.kind === 'user')).toBe(true);
    expect(backend.exportRawSession(ref.prefixedId)).not.toBeNull();
    expect(backend.fileSize(ref.prefixedId)).toBeGreaterThan(0);
    expect(backend.toRawId(ref.prefixedId)).toBe(ref.rawId);
  });

  it('a torn trailing line does not break the parse', () => {
    const sessionDir = join(home, 'sessions', '--home-user-code-example-app--');
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, `2026-05-06T06-00-00-000Z_${SESSION_ID}.jsonl`);
    writeFileSync(path, sessionLines().join('\n') + '\n{"type":"message","id":"torn');
    const events = new PiBackend().readEvents(key());
    expect(events.some((e) => e.kind === 'user')).toBe(true);
  });
});
