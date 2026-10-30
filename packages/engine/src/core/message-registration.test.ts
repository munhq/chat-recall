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
