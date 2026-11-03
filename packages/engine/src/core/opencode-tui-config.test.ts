import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTuiPluginEntry, hasTuiPluginEntry, parseJsonc, registerTuiPlugin, removeTuiPluginEntry,
  tuiConfigPath, unregisterTuiPlugin,
} from './opencode-tui-config.js';

const ENTRY = './plugins/chat-recall-tui/tui.js';
const HERDR = './herdr-tui-session.js';

function pluginOf(src: string): unknown {
  return (parseJsonc(src) as { plugin?: unknown }).plugin;
}

describe('addTuiPluginEntry', () => {
  test('a text with no content becomes a config with the entry', () => {
    const r = addTuiPluginEntry('', ENTRY);
    expect(r).toMatchObject({ ok: true, changed: true });
    if (!r.ok) return;
    expect(pluginOf(r.text)).toEqual([ENTRY]);
  });

  test('a text of comments only becomes a config with the entry', () => {
    const r = addTuiPluginEntry('// nothing here yet\n', ENTRY);
    expect(r.ok && pluginOf(r.text)).toEqual([ENTRY]);
  });

  test('comments and a foreign plugin stay, and the entry is added after the foreign one', () => {
    const src = [
      '// the owner\'s TUI settings',
      '{',
      '  /* the theme comes first */',
      '  "theme": "dark",',
      '  "plugin": [',
      `    "${HERDR}", // herdr`,
      '  ],',
      '}',
      '',
    ].join('\n');
    const r = addTuiPluginEntry(src, ENTRY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("// the owner's TUI settings");
    expect(r.text).toContain('/* the theme comes first */');
    expect(r.text).toContain('// herdr');
    expect(pluginOf(r.text)).toEqual([HERDR, ENTRY]);
    expect((parseJsonc(r.text) as { theme: string }).theme).toBe('dark');
  });

  test('an entry already in the list is not added twice', () => {
    const once = addTuiPluginEntry(`{ "plugin": ["${HERDR}"] }`, ENTRY);
    if (!once.ok) throw new Error(once.reason);
    const twice = addTuiPluginEntry(once.text, ENTRY);
    expect(twice).toEqual({ ok: true, changed: false, text: once.text });
    expect(pluginOf(twice.ok ? twice.text : '')).toEqual([HERDR, ENTRY]);
  });

  test('a config with no plugin key gets the list, and its other keys stay', () => {
    const r = addTuiPluginEntry('{\n  "theme": "dark",\n}\n', ENTRY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(pluginOf(r.text)).toEqual([ENTRY]);
    expect((parseJsonc(r.text) as { theme: string }).theme).toBe('dark');
  });

  test('an empty list takes the entry', () => {
    const r = addTuiPluginEntry('{ "plugin": [] }', ENTRY);
    expect(r.ok && pluginOf(r.text)).toEqual([ENTRY]);
  });

  test('a plugin value that is not a list is refused and nothing is written', () => {
    expect(addTuiPluginEntry('{ "plugin": "x" }', ENTRY)).toEqual({ ok: false, reason: '"plugin" is not a list' });
  });

  test('a text that is not JSONC is refused', () => {
    const r = addTuiPluginEntry('{ "plugin": [ ', ENTRY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not valid JSONC/);
  });

  test('an unknown word is refused, because it is not JSONC', () => {
    expect(addTuiPluginEntry('{ "plugin": [], "theme": dark }', ENTRY).ok).toBe(false);
  });
});

describe('removeTuiPluginEntry', () => {
  test('removes only our entry, and keeps the foreign one and the comments', () => {
    const src = `// keep\n{\n  "plugin": [\n    "${HERDR}", // herdr\n    "${ENTRY}",\n  ],\n}\n`;
    const r = removeTuiPluginEntry(src, ENTRY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.text).toContain('// keep');
    expect(r.text).toContain('// herdr');
    expect(pluginOf(r.text)).toEqual([HERDR]);
  });

  test('removes the last entry when it has no trailing comma', () => {
    const r = removeTuiPluginEntry(`{ "plugin": ["${HERDR}", "${ENTRY}"] }`, ENTRY);
    expect(r.ok && pluginOf(r.text)).toEqual([HERDR]);
  });

  test('removes the only entry and leaves an empty list', () => {
    const r = removeTuiPluginEntry(`{ "plugin": ["${ENTRY}"] }`, ENTRY);
    expect(r.ok && pluginOf(r.text)).toEqual([]);
  });

  test('removes every copy of the entry', () => {
    const r = removeTuiPluginEntry(`{ "plugin": ["${ENTRY}", "${HERDR}", "${ENTRY}"] }`, ENTRY);
    expect(r.ok && pluginOf(r.text)).toEqual([HERDR]);
  });

  test('a list without the entry is left as it is', () => {
    const src = `{ "plugin": ["${HERDR}"] }`;
    expect(removeTuiPluginEntry(src, ENTRY)).toEqual({ ok: true, changed: false, text: src });
  });

  test('a text without a plugin key is left as it is', () => {
    const src = '{ "theme": "dark" }';
    expect(removeTuiPluginEntry(src, ENTRY)).toEqual({ ok: true, changed: false, text: src });
  });

  test('add then remove gives back a list with the same entries', () => {
    const src = `{ "plugin": ["${HERDR}"] }`;
    const added = addTuiPluginEntry(src, ENTRY);
    if (!added.ok) throw new Error(added.reason);
    const removed = removeTuiPluginEntry(added.text, ENTRY);
    expect(removed.ok && pluginOf(removed.text)).toEqual([HERDR]);
  });

  test('a text that is not JSONC is refused', () => {
    expect(removeTuiPluginEntry('{ "plugin": [', ENTRY).ok).toBe(false);
  });
});

describe('hasTuiPluginEntry', () => {
  test('finds the entry only in the plugin list', () => {
    expect(hasTuiPluginEntry(`{ "plugin": ["${ENTRY}"] }`, ENTRY)).toBe(true);
    expect(hasTuiPluginEntry(`{ "theme": "${ENTRY}" }`, ENTRY)).toBe(false);
    expect(hasTuiPluginEntry('not jsonc {', ENTRY)).toBe(false);
  });
});

describe('the files on disk', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cr-tui-config-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a missing file is created as tui.json with the entry', () => {
    const path = tuiConfigPath(dir);
    expect(path).toBe(join(dir, 'tui.json'));
    expect(registerTuiPlugin(path, ENTRY)).toEqual({ status: 'added', path });
    expect(pluginOf(readFileSync(path, 'utf-8'))).toEqual([ENTRY]);
  });

  test('tui.jsonc is used when it exists', () => {
    writeFileSync(join(dir, 'tui.jsonc'), '{}');
    expect(tuiConfigPath(dir)).toBe(join(dir, 'tui.jsonc'));
  });

  test('a second registration leaves the file as it was', () => {
    const path = join(dir, 'tui.jsonc');
    writeFileSync(path, `// mine\n{ "plugin": ["${HERDR}"] }\n`);
    expect(registerTuiPlugin(path, ENTRY).status).toBe('added');
    const after = readFileSync(path, 'utf-8');
    expect(registerTuiPlugin(path, ENTRY).status).toBe('present');
    expect(readFileSync(path, 'utf-8')).toBe(after);
    expect(pluginOf(after)).toEqual([HERDR, ENTRY]);
  });

  test('a file that is not JSONC is reported and left alone', () => {
    const path = join(dir, 'tui.jsonc');
    writeFileSync(path, '{ broken');
    expect(registerTuiPlugin(path, ENTRY).status).toBe('unparseable');
    expect(readFileSync(path, 'utf-8')).toBe('{ broken');
  });

  test('unregister removes only our entry from the file', () => {
    const path = join(dir, 'tui.jsonc');
    writeFileSync(path, `{ "plugin": ["${HERDR}"] }`);
    registerTuiPlugin(path, ENTRY);
    expect(unregisterTuiPlugin(path, ENTRY)).toEqual({ removed: true, path });
    expect(pluginOf(readFileSync(path, 'utf-8'))).toEqual([HERDR]);
  });

  test('unregister leaves an absent file absent', () => {
    const path = join(dir, 'tui.json');
    expect(unregisterTuiPlugin(path, ENTRY)).toEqual({ removed: false, path });
    expect(() => readFileSync(path)).toThrow();
  });

  test('the file is written in place, with no temporary file left behind', () => {
    mkdirSync(join(dir, 'sub'));
    const path = join(dir, 'tui.jsonc');
    writeFileSync(path, '{}');
    registerTuiPlugin(path, ENTRY);
    expect(pluginOf(readFileSync(path, 'utf-8'))).toEqual([ENTRY]);
    expect(readFileSync(path, 'utf-8').includes('.tmp')).toBe(false);
  });
});
