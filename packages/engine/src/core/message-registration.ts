/**
 * Registering the message hook in the AI tools that are not Claude Code.
 *
 * Messages between sessions reached only Claude Code sessions: a send to an
 * Antigravity session answered "No session matches", because no hook of that
 * tool ever reported the session or took its messages. Each tool below runs
 * the same hook (`message-hook.js --tool <id>`) at the events it has:
 *
 *   codex     ~/.codex/hooks.json             SessionStart, UserPromptSubmit, Stop, SessionEnd
 *   agy       ~/.gemini/config/hooks.json     SessionStart, PreInvocation, Stop; keyed by a name
 *   cursor    ~/.cursor/hooks.json            sessionStart, beforeSubmitPrompt, stop, sessionEnd
 *   opencode  ~/.config/opencode/plugins/     a plugin: session events and chat.message
 *   pi        ~/.pi/agent/extensions/         an extension: session_start, before_agent_start
 *
 * The merge functions take a parsed config and return a new one, so the CLI
 * owns the reading and writing and these stay testable without a filesystem.
 * Each one drops our earlier entries first and keeps every entry of another
 * program.
 */

import { homedir } from 'os';
import { join } from 'path';
import { codexBackend, agyBackend, cursorBackend } from './backends/index.js';
import { opencodeConfigDir, opencodePluginDir } from './guard-registration.js';
import { selfIntroduction } from './session-messages.js';

export type MessageTool = 'codex' | 'agy' | 'cursor' | 'opencode' | 'pi';

/** The name of our Antigravity hook group, and the marker in our plugin files. */
export const MESSAGES_ID = 'chat-recall-messages';

/** Seconds a tool waits for the hook. The hook gives up on the server after 6. */
const TIMEOUT_SECS = 10;

export interface MessageTarget {
  tool: MessageTool;
  label: string;
  /** The file this tool reads the registration from. */
  configPath: string;
  /** The tool's own directory. A machine without it gets no file for the tool. */
  homeDir: string;
  /** What the user still has to do by hand, when anything. */
  note?: string;
}

/** pi's config directory: PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir && dir.trim() ? dir : join(homedir(), '.pi', 'agent');
}

export function messageTargets(): MessageTarget[] {
  return [
    {
      tool: 'codex',
      label: 'Codex',
      configPath: join(codexBackend.homeDir(), 'hooks.json'),
      homeDir: codexBackend.homeDir(),
      // Codex binds its approval to the hook's hash, and only a person can give it.
      note: 'Codex asks you to approve a hook before it runs one. Run /hooks in Codex once to approve the message hook.',
    },
    {
      tool: 'agy',
      label: 'Antigravity',
      configPath: agyBackend.sharedHooksFile(),
      homeDir: agyBackend.homeDir(),
    },
    {
      tool: 'cursor',
      label: 'Cursor',
      configPath: join(cursorBackend.homeDir(), 'hooks.json'),
      homeDir: cursorBackend.homeDir(),
      note: 'Cursor delivers a message at the start of a session and when the agent stops, as a follow-up prompt.',
    },
    {
      tool: 'opencode',
      label: 'OpenCode',
      configPath: join(opencodePluginDir(), `${MESSAGES_ID}.js`),
      homeDir: opencodeConfigDir(),
    },
    {
      tool: 'pi',
      label: 'pi',
      configPath: join(piAgentDir(), 'extensions', `${MESSAGES_ID}.js`),
      homeDir: piAgentDir(),
    },
  ];
}

/** The file name of the per-tool wrapper that runs the hook. */
export function messageWrapperName(tool: MessageTool): string {
  return `chat_recall_messages_${tool}.sh`;
}

/**
 * A wrapper that runs the message hook for one tool. A tool's config then
 * holds a bare path, the one form every one of these tools executes. An
 * Antigravity entry adds the event after the path, which its shell passes on.
 */
export function messageWrapperSource(tool: MessageTool, nodePath: string, hookEntry: string): string {
  return `#!/bin/sh
# Written by \`chat-recall install-hooks\`. Re-running replaces it.
exec ${JSON.stringify(nodePath)} ${JSON.stringify(hookEntry)} --tool ${tool} "$@"
`;
}

/** What a tool's config records: the wrapper's path, quoted only when it has a space. */
export function messageCommand(wrapperPath: string, args = ''): string {
  const p = wrapperPath.includes(' ') ? `"${wrapperPath}"` : wrapperPath;
  return args ? `${p} ${args}` : p;
}

const isOurs = (cmd: unknown): boolean => typeof cmd === 'string' && cmd.includes('chat_recall_messages_');
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): any => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : {});

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd'];

/** Codex: { hooks: { <Event>: [ { matcher?, hooks: [ {type, command, timeout} ] } ] } } */
function mergeCodex(config: unknown, command: string): any {
  const c = obj(config);
  const hooks = obj(c.hooks);
  for (const event of CODEX_EVENTS) {
    const kept = asArray(hooks[event]).filter((e) => !asArray(e?.hooks).some((h: any) => isOurs(h?.command)));
    kept.push({ hooks: [{ type: 'command', command, timeout: TIMEOUT_SECS }] });
    hooks[event] = kept;
  }
  c.hooks = hooks;
  return c;
}

function stripCodex(config: unknown): { config: any; removed: number } {
  const c = obj(config);
  const hooks = obj(c.hooks);
  let removed = 0;
  for (const event of CODEX_EVENTS) {
    const before = asArray(hooks[event]);
    const kept = before.filter((e) => !asArray(e?.hooks).some((h: any) => isOurs(h?.command)));
    removed += before.length - kept.length;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) c.hooks = hooks;
  else delete c.hooks;
  return { config: c, removed };
}

/** Antigravity: top-level keys name a hook group, and ours owns one key. */
function mergeAgy(config: unknown, command: string): any {
  const c = obj(config);
  const run = (event: string) => [{ type: 'command', command: `${command} --event ${event}`, timeout: TIMEOUT_SECS }];
  c[MESSAGES_ID] = {
    enabled: true,
    SessionStart: run('SessionStart'),
    PreInvocation: run('PreInvocation'),
    Stop: run('Stop'),
  };
  return c;
}

function stripAgy(config: unknown): { config: any; removed: number } {
  const c = obj(config);
  const had = Object.prototype.hasOwnProperty.call(c, MESSAGES_ID) ? 1 : 0;
  delete c[MESSAGES_ID];
  return { config: c, removed: had };
}

/** Cursor: { version: 1, hooks: { <event>: [ { command } ] } } */
function mergeCursor(config: unknown, command: string): any {
  const c = obj(config);
  c.version = typeof c.version === 'number' ? c.version : 1;
  const hooks = obj(c.hooks);
  for (const event of CURSOR_EVENTS) {
    const kept = asArray(hooks[event]).filter((e) => !isOurs(e?.command));
    kept.push({ command, timeout: TIMEOUT_SECS });
    hooks[event] = kept;
  }
  c.hooks = hooks;
  return c;
}

function stripCursor(config: unknown): { config: any; removed: number } {
  const c = obj(config);
  const hooks = obj(c.hooks);
  let removed = 0;
  for (const event of CURSOR_EVENTS) {
    const before = asArray(hooks[event]);
    const kept = before.filter((e) => !isOurs(e?.command));
    removed += before.length - kept.length;
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  c.hooks = hooks;
  return { config: c, removed };
}

type ConfigTool = Exclude<MessageTool, 'opencode' | 'pi'>;

/** Merge our message-hook entries into one tool's parsed config. */
export function registerMessages(tool: ConfigTool, config: unknown, command: string): any {
  switch (tool) {
    case 'codex': return mergeCodex(config, command);
    case 'agy': return mergeAgy(config, command);
    case 'cursor': return mergeCursor(config, command);
  }
}

/** Remove our message-hook entries from one tool's parsed config. */
export function unregisterMessages(tool: ConfigTool, config: unknown): { config: any; removed: number } {
  switch (tool) {
    case 'codex': return stripCodex(config);
    case 'agy': return stripAgy(config);
    case 'cursor': return stripCursor(config);
  }
}

/** True for a plugin or extension file that this module wrote. */
export function isOurPluginSource(source: string): boolean {
  return source.includes(`${MESSAGES_ID}: written by`);
}

/** True for the TUI plugin entry that install-hooks wrote. */
export function isOurTuiSource(source: string): boolean {
  return source.startsWith('// Written by `chat-recall install-hooks`');
}

/**
 * The shared part of the opencode plugin and the pi extension: run the hook
 * with a payload in Claude's shape and return what it printed. Silent on
 * every failure, as the hook is.
 */
function runnerSource(wrapperPath: string): string {
  return `import { spawn } from "child_process";

const HOOK = ${JSON.stringify(wrapperPath)};

/**
 * The process this plugin runs in. The headless service a TUI starts reports
 * events for the same sessions, so the kind is what tells a coordinator which
 * row has a window. The first argument is the subcommand ("serve", "run", or
 * none for the TUI itself).
 */
const KIND = (() => {
  const args = process.argv.slice(1).filter((a) => !a.startsWith("-"));
  if (args.includes("serve")) return "serve";
  if (args[0] === "run") return "run";
  return undefined;
})();

function payload(sessionId, event, cwd) {
  const p = { session_id: sessionId, hook_event_name: event, cwd, pid: process.pid };
  if (KIND) p.kind = KIND;
  return p;
}

function runHook(sessionId, event, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(HOOK, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const done = setTimeout(() => { child.kill(); resolve(""); }, ${TIMEOUT_SECS * 1000});
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", () => { clearTimeout(done); resolve(""); });
    child.on("close", () => { clearTimeout(done); resolve(out.trim()); });
    child.stdin.end(JSON.stringify(payload(sessionId, event, cwd)));
  });
}

/**
 * Wait for a message to an idle session. The hook long-polls the server and
 * prints the messages when one arrives; onText gets them. One waiter per
 * session; stopWaiter ends it when the session gets a prompt.
 */
const waiters = new Map();

function startWaiter(sessionId, cwd, onText) {
  if (waiters.has(sessionId)) return;
  let out = "";
  let child;
  try {
    child = spawn(HOOK, ["--wait"], { stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return;
  }
  waiters.set(sessionId, child);
  child.stdout.on("data", (c) => { out += c; });
  child.on("error", () => { waiters.delete(sessionId); });
  child.on("close", () => {
    if (waiters.get(sessionId) === child) waiters.delete(sessionId);
    const text = out.trim();
    if (text) Promise.resolve().then(() => onText(text)).catch(() => {});
  });
  child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: "Stop", cwd }));
}

function stopWaiter(sessionId) {
  const child = waiters.get(sessionId);
  if (!child) return;
  waiters.delete(sessionId);
  try { child.kill(); } catch { /* gone */ }
}
`;
}

/**
 * The opencode plugin, for opencode 1.x and 2.x.
 *
 * opencode 2.x loads only a default export with an `id` and `setup(ctx)`; it
 * refused the named 1.x export with "Plugin must export a default definition
 * with an id and an effect or setup function" (opencode 2.2.0, 2026-10-30).
 * 1.x calls `server` of the same object.
 *
 * The session id goes into the system context of each model call, so the
 * agent knows it and the user's prompts stay as typed: appended to the
 * prompt, it showed in the user's own message, and again after each reload.
 *
 * 2.x: the `prompt` hook reports the session at its first prompt and adds the
 * waiting messages to the prompt text; the end of a run reports the session
 * idle and starts a waiter, whose message becomes the next prompt through
 * `ctx.session.prompt`, so an idle session acts on it without its user. 1.x: a session is reported when it is created, and the text goes into
 * the next prompt as a synthetic part. A child session (a subagent) is left
 * out in both: its context is not the one the message was sent to.
 */
export function opencodeMessagesSource(wrapperPath: string): string {
  return `// ${MESSAGES_ID}: written by \`chat-recall install-hooks\`. Re-running replaces it.
//
// Reports each opencode session to chat-recall and adds the messages that
// other sessions sent it to the next prompt.
${runnerSource(wrapperPath)}
const RUN_END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"]);
const INTRO = ${JSON.stringify(selfIntroduction('\u0000SESSION\u0000'))};
const intro = (id) => INTRO.replace("\u0000SESSION\u0000", "opencode_" + id);

async function setup(ctx) {
  const dir = ctx?.location?.directory;
  // A session of a shared \`opencode serve\` belongs to the folder it was made
  // in, and that is not this plugin instance's folder: the service sends one
  // plugin instance the events of every project it serves. Asking the session
  // is the only source that stays right. The instance's folder is the fallback
  // for a session that cannot be read (just deleted, or an old server).
  const dirOf = async (id) => {
    try {
      const s = await ctx.session.get({ sessionID: id });
      const d = s?.location?.directory ?? s?.directory;
      if (typeof d === "string" && d) return d;
    } catch { /* unknown session: the instance folder is the best guess */ }
    return dir;
  };
  const children = new Set();
  const isChild = async (id) => {
    if (children.has(id)) return true;
    try {
      const s = await ctx.session.get({ sessionID: id });
      if (s?.parentID) { children.add(id); return true; }
    } catch { /* unknown: treat as a main session */ }
    return false;
  };
  await ctx.session.hook("prompt", async (event) => {
    const id = event?.sessionID;
    if (!id || !event.prompt || (await isChild(id))) return;
    stopWaiter("opencode_" + id);
    // The first prompt registers the session; the hook adds only waiting messages.
    const text = await runHook("opencode_" + id, "UserPromptSubmit", await dirOf(id));
    if (text) event.prompt.text = [event.prompt.text, text].filter(Boolean).join("\\n\\n");
  });
  // The session id goes into the system context of each model call: the agent
  // always knows it, the user does not see it, and no prompt repeats it.
  await ctx.session.hook("context", async (event) => {
    const id = event?.sessionID;
    if (!id || !Array.isArray(event.system) || (await isChild(id))) return;
    event.system.push({ type: "text", text: intro(id) });
  });
  const controller = new AbortController();
  (async () => {
    try {
      for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
        const id = ev?.data?.sessionID ?? ev?.properties?.sessionID;
        // A session that was open before this plugin loaded (a reload, an
        // update) is not in started, and still gets its waiter.
        if (!id || (await isChild(id))) continue;
        if (RUN_END.has(ev.type)) {
          const at = await dirOf(id);
          await runHook("opencode_" + id, "Stop", at);
          // An idle session acts on a message from another session by itself:
          // the text becomes its next prompt.
          startWaiter("opencode_" + id, at, (text) => ctx.session.prompt({ sessionID: id, text }));
        } else if (ev.type === "session.deleted") {
          stopWaiter("opencode_" + id);
          await runHook("opencode_" + id, "SessionEnd", await dirOf(id));
        }
      }
    } catch { /* the subscription ends with the plugin */ }
  })();
  return () => {
    controller.abort();
    for (const id of [...waiters.keys()]) stopWaiter(id);
  };
}

const pending = new Map();
const children = new Set();
let seq = 0;

function partId() {
  seq += 1;
  return "prt_" + Date.now().toString(16) + seq.toString(16).padStart(4, "0") + "chatrecall";
}

async function server({ directory }) {
  return {
    event: async ({ event }) => {
      const info = event?.properties?.info;
      if (event?.type === "session.created" && info?.id) {
        if (info.parentID) { children.add(info.id); return; }
        const text = await runHook("opencode_" + info.id, "SessionStart", directory);
        if (text) pending.set(info.id, text);
      } else if (event?.type === "session.idle" && event.properties?.sessionID && !children.has(event.properties.sessionID)) {
        await runHook("opencode_" + event.properties.sessionID, "Stop", directory);
      } else if (event?.type === "session.deleted" && info?.id) {
        children.delete(info.id);
        pending.delete(info.id);
        await runHook("opencode_" + info.id, "SessionEnd", directory);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      const id = input?.sessionID;
      if (!id || children.has(id) || !Array.isArray(output?.system)) return;
      output.system.push(intro(id));
    },
    "chat.message": async (input, output) => {
      const id = input?.sessionID;
      if (!id || children.has(id) || !output?.message) return;
      const before = pending.get(id) ?? "";
      pending.delete(id);
      const now = await runHook("opencode_" + id, "UserPromptSubmit", directory);
      const text = [before, now].filter(Boolean).join("\\n\\n");
      if (!text) return;
      output.parts.push({ id: partId(), sessionID: id, messageID: output.message.id, type: "text", text, synthetic: true });
    },
  };
}

export default { id: "${MESSAGES_ID}", server, setup };
`;
}

/**
 * The TUI plugin that gives an idle opencode window an address.
 *
 * A TUI reports nothing to chat-recall until it has a session, so a message
 * sent to the folder it is open in had no recipient. This plugin registers the
 * folder from the moment the TUI opens (`message-hook.js --presence`), and
 * when a message arrives it creates the session, shows it, and sends the
 * message as the first prompt — the first turn the TUI would have run.
 *
 * It also reports the session the TUI shows as kind `tui`. The headless
 * service that the TUI starts in the same folder reports `serve` for the same
 * session on every prompt; the store never lets a later kind overwrite `tui`,
 * which is how a coordinator sees which row has a window.
 *
 * A package directory: opencode discovers both the server entry and the
 * `./tui` entry, and needs no entry in opencode.json (2.2.5).
 */
export function opencodeTuiSource(wrapperPath: string): string {
  return `// Written by \`chat-recall install-hooks\`. Re-running replaces it.
//
// Registers this opencode TUI with chat-recall before it has a session, so a
// message sent to the folder reaches it: the message becomes the TUI's first
// session and first prompt. Also reports the session the TUI shows as "tui".
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Plugin } from "@opencode/plugin/tui";

const HOOK = ${JSON.stringify(wrapperPath)};
const PID = process.pid;
const POLL_MS = 4000;
const RUN_MS = 8000;

// One state per process, not per module instance. opencode loads this entry
// more than once in one TUI process, and a reload keeps the old instance
// alive; two instances would each open a presence loop, and the folder would
// answer as two windows.
const STATE = Symbol.for("chat-recall.tui-plugin");
const state = globalThis[STATE] ??= { api: undefined, presence: undefined, timer: undefined, reported: undefined, disposed: false, id: undefined };
state.id ??= "tui_" + randomBytes(8).toString("hex");

/** Run the hook once and return what it printed. */
function run(payload, args) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(HOOK, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    const done = setTimeout(() => { child.kill(); resolve(""); }, RUN_MS);
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", () => { clearTimeout(done); resolve(""); });
    child.on("close", () => { clearTimeout(done); resolve(out.trim()); });
    child.stdin.end(JSON.stringify(payload));
  });
}

function route(api) {
  try {
    const r = api.ui.router.current();
    return r && typeof r === "object" ? r : undefined;
  } catch {
    return undefined;
  }
}

function sessionOf(api) {
  const r = route(api);
  return r && r.type === "session" && typeof r.sessionID === "string" ? r.sessionID : undefined;
}

async function report(api, sessionID) {
  if (!sessionID || sessionID === state.reported) return;
  state.reported = sessionID;
  await run({ session_id: "opencode_" + sessionID, cwd: api.location.directory, kind: "tui", pid: PID }, ["--report"]);
}

function stopPresence() {
  const child = state.presence;
  state.presence = undefined;
  if (child) {
    try { child.kill(); } catch { /* already gone */ }
  }
}

/**
 * Register the folder while the TUI shows no session. A message for the folder
 * arrives on stdout as {"text", "ids"}; the lease expires if this plugin dies
 * before the prompt lands, and the message is delivered again.
 */
function startPresence(api) {
  if (state.disposed || state.presence) return;
  const dir = api.location.directory;
  let child;
  try {
    child = spawn(HOOK, ["--presence"], { stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return;
  }
  state.presence = child;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line || state.presence !== child) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      stopPresence();
      openFirst(api, dir, msg).catch(() => {});
      break;
    }
  });
  child.on("error", () => { if (state.presence === child) state.presence = undefined; });
  child.on("close", () => { if (state.presence === child) state.presence = undefined; });
  child.stdin.end(JSON.stringify({ session_id: state.id, cwd: dir, pid: PID }));
}

/** The message becomes the TUI's first session and first prompt. */
async function openFirst(api, dir, msg) {
  const text = typeof msg.text === "string" ? msg.text : "";
  const ids = Array.isArray(msg.ids) ? msg.ids.filter((i) => typeof i === "string") : [];
  if (!text) return;
  let id;
  try {
    const created = await api.client.session.create({ title: "chat-recall message", location: { directory: dir } });
    id = created?.data?.data?.id ?? created?.data?.id ?? created?.id;
  } catch {
    return;
  }
  if (typeof id !== "string" || !id) return;
  try { api.ui.router.navigate({ type: "session", sessionID: id }); } catch { /* the route follows the new session */ }
  await report(api, id);
  try {
    await api.client.session.prompt({ sessionID: id, text });
  } catch {
    // The session exists but the prompt did not land. Leave the messages
    // unacknowledged: their lease returns them.
    return;
  }
  if (ids.length) await run({ session_id: state.id, ids }, ["--ack"]);
}

/** Follow the route: report the session it shows, register the folder otherwise. */
function tick() {
  const api = state.api;
  if (state.disposed || !api) return;
  const id = sessionOf(api);
  if (id) {
    report(api, id).catch(() => {});
    stopPresence();
  } else {
    startPresence(api);
  }
}

function shutdown() {
  state.disposed = true;
  if (state.timer) { clearInterval(state.timer); state.timer = undefined; }
  stopPresence();
}

export default Plugin.define({
  id: "chat-recall-tui",
  async setup(api) {
    // Only the TUI has a renderer and a route. A headless process that loads
    // this entry has neither, and must not answer for anyone's folder.
    if (!api?.renderer || !api?.location?.directory || !api?.ui?.router) return;
    // A reload after dispose starts a new life on the same process-wide state.
    if (state.disposed) { state.disposed = false; state.timer = undefined; state.reported = undefined; }
    state.api = api;
    tick();
    if (!state.timer) {
      state.timer = setInterval(tick, POLL_MS);
      if (typeof state.timer.unref === "function") state.timer.unref();
    }
    try { api.attention?.dispose?.(shutdown); } catch { /* no dispose registry */ }
  },
});
`;
}

/**
 * The folder name of the TUI plugin package that install-hooks writes under
 * opencodePluginDir(). opencode finds `./tui` through the package.json exports
 * and needs no entry in opencode.json.
 */
export const OPENCODE_TUI_PACKAGE = 'chat-recall-tui';

/** The files of that package, in the order install-hooks writes them. */
export function opencodeTuiFiles(wrapperPath: string): Array<{ name: string; source: string }> {
  return [
    {
      name: 'package.json',
      source: JSON.stringify({
        name: OPENCODE_TUI_PACKAGE, private: true, type: 'module',
        exports: { '.': './index.js', './tui': './tui.js' },
      }, null, 2) + '\n',
    },
    {
      // The package's server entry. The message plugin next to it is the
      // server plugin; this one only has to exist for the package to load.
      name: 'index.js',
      source: `// Written by \`chat-recall install-hooks\`. Re-running replaces it.\nexport default { id: "${OPENCODE_TUI_PACKAGE}", setup() {} };\n`,
    },
    { name: 'tui.js', source: opencodeTuiSource(wrapperPath) },
  ];
}

/**
 * The pi extension. What the hook prints at session_start waits for the first
 * prompt, because pi adds a message to a run only from before_agent_start. At
 * agent_end a waiter starts; its message starts a turn through sendUserMessage.
 */
export function piMessagesSource(wrapperPath: string): string {
  return `// ${MESSAGES_ID}: written by \`chat-recall install-hooks\`. Re-running replaces it.
//
// Reports each pi session to chat-recall and adds the messages that other
// sessions sent it to the next prompt.
${runnerSource(wrapperPath)}
export default function (pi) {
  let pending = "";
  const idOf = (ctx) => "pi_" + ctx.sessionManager.getSessionId();
  const cwdOf = (ctx) => ctx.sessionManager.getCwd();

  pi.on("session_start", async (_event, ctx) => {
    pending = await runHook(idOf(ctx), "SessionStart", cwdOf(ctx));
  });
  pi.on("before_agent_start", async (event, ctx) => {
    stopWaiter(idOf(ctx));
    if (event.messageType !== "user") return;
    const now = await runHook(idOf(ctx), "UserPromptSubmit", cwdOf(ctx));
    const text = [pending, now].filter(Boolean).join("\\n\\n");
    pending = "";
    if (!text) return;
    return { message: { customType: "${MESSAGES_ID}", content: text, display: true } };
  });
  pi.on("agent_end", async (_event, ctx) => {
    await runHook(idOf(ctx), "Stop", cwdOf(ctx));
    // An idle session acts on a message from another session by itself.
    startWaiter(idOf(ctx), cwdOf(ctx), (text) => pi.sendUserMessage(text));
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    stopWaiter(idOf(ctx));
    await runHook(idOf(ctx), "SessionEnd", cwdOf(ctx));
  });
}
`;
}
