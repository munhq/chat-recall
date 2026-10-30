import { describe, test, expect } from 'vitest';
import {
  MESSAGES_ID, isOurPluginSource, messageCommand, messageWrapperSource, opencodeMessagesSource, piMessagesSource,
  registerMessages, unregisterMessages,
} from './message-registration.js';

const WRAPPER = '/home/user/.chat-recall/hooks/chat_recall_messages_codex.sh';

describe('registerMessages', () => {
  test('Codex: one entry on each turn event, and foreign entries stay', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/other-hook' }] };
    const config = { hooks: { Stop: [foreign], PreToolUse: [foreign] } };
    const merged = registerMessages('codex', registerMessages('codex', config, WRAPPER), WRAPPER);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
      const ours = merged.hooks[event].filter((e: any) => e.hooks[0].command === WRAPPER);
      expect(ours).toHaveLength(1);
    }
    expect(merged.hooks.Stop).toContainEqual(foreign);
    expect(merged.hooks.PreToolUse).toEqual([foreign]);

    const { config: stripped, removed } = unregisterMessages('codex', merged);
    expect(removed).toBe(4);
    expect(stripped.hooks).toEqual({ Stop: [foreign], PreToolUse: [foreign] });
  });

  test('Antigravity: our group passes the event to the hook, and other groups stay', () => {
    const config = { herdr: { PreInvocation: [{ command: 'herdr session' }] } };
    const merged = registerMessages('agy', config, '/w.sh');
    expect(merged.herdr).toEqual(config.herdr);
    expect(merged[MESSAGES_ID].SessionStart[0].command).toBe('/w.sh --event SessionStart');
    expect(merged[MESSAGES_ID].PreInvocation[0].command).toBe('/w.sh --event PreInvocation');
    expect(merged[MESSAGES_ID].Stop[0].command).toBe('/w.sh --event Stop');
    expect(unregisterMessages('agy', merged)).toEqual({ config, removed: 1 });
  });

  test('Cursor: version 1 and one entry per event', () => {
    const merged = registerMessages('cursor', registerMessages('cursor', {}, WRAPPER), WRAPPER);
    expect(merged.version).toBe(1);
    for (const event of ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd']) {
      expect(merged.hooks[event].filter((e: any) => e.command === WRAPPER)).toHaveLength(1);
    }
    expect(unregisterMessages('cursor', merged).removed).toBe(4);
  });
});

describe('the wrapper and the plugin files', () => {
  test('the wrapper runs the hook bundle for its tool', () => {
    const src = messageWrapperSource('cursor', '/usr/bin/node', '/opt/chat-recall/dist/message-hook.js');
    expect(src).toContain('exec "/usr/bin/node" "/opt/chat-recall/dist/message-hook.js" --tool cursor "$@"');
  });

  test('a path with a space is quoted', () => {
    expect(messageCommand('/home/user/My Files/w.sh')).toBe('"/home/user/My Files/w.sh"');
  });

  test('the plugin files carry the marker uninstall looks for, and name the wrapper', () => {
    for (const src of [opencodeMessagesSource('/w.sh'), piMessagesSource('/w.sh')]) {
      expect(isOurPluginSource(src)).toBe(true);
      expect(src).toContain('const HOOK = "/w.sh"');
    }
    expect(isOurPluginSource('export const Other = async () => ({})')).toBe(false);
  });

  test('the opencode plugin and the pi extension parse as modules', async () => {
    for (const src of [opencodeMessagesSource('/w.sh'), piMessagesSource('/w.sh')]) {
      const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    }
  });
});

describe('the opencode 2.x plugin wakes an idle session', () => {
  test('a message that arrives after a run ends becomes the next prompt', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cr-oc-waiter-'));
    const hook = join(dir, 'hook.sh');
    // The turn hook prints nothing; the waiter prints the message and exits.
    writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\nif [ "$1" = "--wait" ]; then echo "message from the manager"; fi\n');
    chmodSync(hook, 0o755);
    const mod = await import(`data:text/javascript,${encodeURIComponent(opencodeMessagesSource(hook))}`);

    let promptHook: ((e: any) => Promise<void>) | undefined;
    const prompts: Array<{ sessionID: string; text: string }> = [];
    let push: ((v: any) => void) | undefined;
    const events = (async function* () {
      yield await new Promise((r) => { push = r; });
    })();
    await mod.default.setup({
      location: { directory: '/home/user/code/example' },
      session: {
        hook: async (name: string, fn: (e: any) => Promise<void>) => { if (name === 'prompt') promptHook = fn; },
        get: async () => ({ id: 'ses_1' }),
        prompt: async (p: { sessionID: string; text: string }) => { prompts.push(p); },
      },
      event: { subscribe: () => events },
    });

    await promptHook!({ sessionID: 'ses_1', prompt: { text: 'start' } });
    await new Promise((r) => setTimeout(r, 50));
    push!({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    for (let i = 0; i < 50 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(prompts).toEqual([{ sessionID: 'ses_1', text: 'message from the manager' }]);
  });
});

describe('the opencode 2.x plugin after a reload', () => {
  test('a session that was open before the plugin loaded gets a waiter when its run ends', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'cr-oc-reload-'));
    const hook = join(dir, 'hook.sh');
    writeFileSync(hook, '#!/bin/sh\ncat >/dev/null\nif [ "$1" = "--wait" ]; then echo "message after the reload"; fi\n');
    chmodSync(hook, 0o755);
    const mod = await import(`data:text/javascript,${encodeURIComponent(opencodeMessagesSource(hook))}#reload`);
    const prompts: Array<{ sessionID: string; text: string }> = [];
    let push: ((v: any) => void) | undefined;
    const events = (async function* () { yield await new Promise((r) => { push = r; }); })();
    await mod.default.setup({
      location: { directory: '/home/user/code/example' },
      session: { hook: async () => {}, get: async () => ({ id: 'ses_open' }), prompt: async (p: any) => { prompts.push(p); } },
      event: { subscribe: () => events },
    });
    // No prompt reaches this plugin instance: the session started before it loaded.
    push!({ type: 'session.execution.succeeded', data: { sessionID: 'ses_open' } });
    for (let i = 0; i < 50 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(prompts).toEqual([{ sessionID: 'ses_open', text: 'message after the reload' }]);
  });
});

describe('the opencode plugin keeps the session id out of the prompt', () => {
  test('the context hook adds the intro to the system context, not for a subagent', async () => {
    const mod = await import(`data:text/javascript,${encodeURIComponent(opencodeMessagesSource('/w.sh'))}#intro`);
    let contextHook: ((e: any) => Promise<void>) | undefined;
    const events = (async function* () { /* none */ })();
    await mod.default.setup({
      location: { directory: '/home/user/code/example' },
      session: {
        hook: async (name: string, fn: (e: any) => Promise<void>) => { if (name === 'context') contextHook = fn; },
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: sessionID === 'ses_child' ? 'ses_main' : undefined }),
        prompt: async () => {},
      },
      event: { subscribe: () => events },
    });
    const main = { sessionID: 'ses_main', system: [] as Array<{ type: string; text: string }> };
    await contextHook!(main);
    expect(main.system).toHaveLength(1);
    expect(main.system[0].text).toContain('chat-recall session id: opencode_ses_main');
    const child = { sessionID: 'ses_child', system: [] as unknown[] };
    await contextHook!(child);
    expect(child.system).toEqual([]);
  });
});
