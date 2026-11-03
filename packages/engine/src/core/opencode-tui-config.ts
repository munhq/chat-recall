/**
 * The "plugin" list of OpenCode's TUI config, edited in place.
 *
 * OpenCode loads a TUI plugin only when its entry is in the "plugin" list of
 * `tui.jsonc` (or `tui.json`) in the OpenCode config folder. The TUI package is
 * written next to the server plugins, but the list is the only thing that makes
 * OpenCode load it, so install-hooks adds one entry to that list.
 *
 * The file is JSONC and belongs to the user: comments, other entries and the
 * layout stay as they are. The edit replaces only the bytes of our entry, so a
 * file that is valid JSONC after the edit keeps every other byte.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { opencodeConfigDir, opencodePluginDir } from './guard-registration.js';
import { OPENCODE_TUI_PACKAGE } from './message-registration.js';

/** The TUI config file: the one that exists, `tui.jsonc` first, else `tui.json` to create. */
export function tuiConfigPath(configDir: string = opencodeConfigDir()): string {
  const jsonc = join(configDir, 'tui.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(configDir, 'tui.json');
}

/**
 * Our entry, as OpenCode resolves it: a path relative to the config folder,
 * with forward slashes, to the `tui.js` of the TUI package.
 */
export function tuiPluginEntry(configDir: string = opencodeConfigDir()): string {
  const file = join(opencodePluginDir(), OPENCODE_TUI_PACKAGE, 'tui.js');
  return `./${relative(configDir, file).split(sep).join('/')}`;
}

// ── A small JSONC reader: positions are kept so an edit touches only its bytes.

type Tok =
  | { t: 'p'; v: string; start: number; end: number }
  | { t: 's'; v: string; start: number; end: number }
  | { t: 'a'; v: string; start: number; end: number };

type Node =
  | { k: 'obj'; start: number; end: number; closeStart: number; props: Array<{ key: string; value: Node }> }
  | { k: 'arr'; start: number; end: number; closeStart: number; items: Node[]; commas: Array<number | null> }
  | { k: 'str'; start: number; end: number; v: string }
  | { k: 'atom'; start: number; end: number; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) throw new SyntaxError(`unterminated comment at ${i}`);
      i = e + 2;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      out.push({ t: 'p', v: c, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      if (j >= src.length) throw new SyntaxError(`unterminated string at ${i}`);
      out.push({ t: 's', v: JSON.parse(src.slice(i, j + 1)) as string, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s,:{}[\]"/]/.test(src[j])) j += 1;
    if (j === i) throw new SyntaxError(`unexpected character at ${i}`);
    out.push({ t: 'a', v: src.slice(i, j), start: i, end: j });
    i = j;
  }
  return out;
}

/** The JSON literals that are not strings: true, false, null and a number. */
const ATOM = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$/;

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private at(): Tok | undefined { return this.toks[this.i]; }
  private isP(t: Tok | undefined, v: string): boolean { return !!t && t.t === 'p' && t.v === v; }

  value(): Node {
    const t = this.at();
    if (!t) throw new SyntaxError('unexpected end of file');
    if (t.t === 's') { this.i += 1; return { k: 'str', start: t.start, end: t.end, v: t.v }; }
    if (t.t === 'a') {
      if (!ATOM.test(t.v)) throw new SyntaxError(`unknown word "${t.v}" at ${t.start}`);
      this.i += 1;
      return { k: 'atom', start: t.start, end: t.end, v: t.v };
    }
    if (this.isP(t, '{')) return this.object(t);
    if (this.isP(t, '[')) return this.array(t);
    throw new SyntaxError(`unexpected "${t.v}" at ${t.start}`);
  }

  private object(open: Tok): Node {
    this.i += 1;
    const props: Array<{ key: string; value: Node }> = [];
    for (;;) {
      const k = this.at();
      if (this.isP(k, '}')) {
        this.i += 1;
        return { k: 'obj', start: open.start, end: k!.end, closeStart: k!.start, props };
      }
      if (!k || k.t !== 's') throw new SyntaxError(`expected a key at ${k ? k.start : 'end'}`);
      this.i += 1;
      if (!this.isP(this.at(), ':')) throw new SyntaxError(`expected ":" after key at ${k.start}`);
      this.i += 1;
      props.push({ key: k.v, value: this.value() });
      const n = this.at();
      if (this.isP(n, ',')) { this.i += 1; continue; }
      if (this.isP(n, '}')) continue;
      throw new SyntaxError(`expected "," or "}" at ${n ? n.start : 'end'}`);
    }
  }

  private array(open: Tok): Node {
    this.i += 1;
    const items: Node[] = [];
    const commas: Array<number | null> = [];
    for (;;) {
      const n = this.at();
      if (this.isP(n, ']')) {
        this.i += 1;
        return { k: 'arr', start: open.start, end: n!.end, closeStart: n!.start, items, commas };
      }
      items.push(this.value());
      const c = this.at();
      if (this.isP(c, ',')) { commas.push(c!.start); this.i += 1; continue; }
      commas.push(null);
      if (!this.isP(this.at(), ']')) throw new SyntaxError(`expected "," or "]" at ${c ? c.start : 'end'}`);
    }
  }
}

/** The root object of a JSONC text, or null for a text with no content (empty or comments only). */
function parseRoot(src: string): Node | null {
  const toks = tokenize(src);
  if (toks.length === 0) return null;
  const p = new Parser(toks);
  const root = p.value();
  if (root.k !== 'obj') throw new SyntaxError('the top level is not an object');
  // Anything after the root value is an error.
  const rest = toks.findIndex((t) => t.start >= root.end);
  if (rest !== -1) throw new SyntaxError(`unexpected "${toks[rest].v}" after the top-level object`);
  return root;
}

/** The JavaScript value of a parsed JSONC node. */
export function jsoncValue(node: Node): unknown {
  switch (node.k) {
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const p of node.props) out[p.key] = jsoncValue(p.value);
      return out;
    }
    case 'arr': return node.items.map(jsoncValue);
    case 'str': return node.v;
    case 'atom': return JSON.parse(node.v) as unknown;
  }
}

/** The JavaScript value of a JSONC text. Throws a SyntaxError when the text is not JSONC. */
export function parseJsonc(src: string): unknown {
  const root = parseRoot(src);
  return root ? jsoncValue(root) : {};
}

function pluginArray(root: Node | null): { arr?: Extract<Node, { k: 'arr' }>; error?: string } {
  if (!root || root.k !== 'obj') return {};
  const prop = root.props.find((p) => p.key === 'plugin');
  if (!prop) return {};
  if (prop.value.k !== 'arr') return { error: '"plugin" is not a list' };
  return { arr: prop.value };
}

export type TuiEdit =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: string };

function splice(src: string, from: number, to: number, insert: string): string {
  return src.slice(0, from) + insert + src.slice(to);
}

/** Whether the "plugin" list of the text holds the entry. A text that is not JSONC holds nothing. */
export function hasTuiPluginEntry(src: string, entry: string): boolean {
  try {
    const { arr } = pluginArray(parseRoot(src));
    return !!arr && arr.items.some((it) => it.k === 'str' && it.v === entry);
  } catch {
    return false;
  }
}

/**
 * Add the entry to the "plugin" list. The list is created when the text has no
 * such key, and the text is created when it has no content. An entry already in
 * the list is not added twice.
 */
export function addTuiPluginEntry(src: string, entry: string): TuiEdit {
  let root: Node | null;
  try {
    root = parseRoot(src);
  } catch (e) {
    return { ok: false, reason: `not valid JSONC: ${(e as Error).message}` };
  }
  const literal = JSON.stringify(entry);
  if (!root) {
    return { ok: true, changed: true, text: `{\n  "plugin": [${literal}]\n}\n` };
  }
  const { arr, error } = pluginArray(root);
  if (error) return { ok: false, reason: error };
  if (arr) {
    if (arr.items.some((it) => it.k === 'str' && it.v === entry)) return { ok: true, changed: false, text: src };
    const last = arr.items[arr.items.length - 1];
    // An empty list takes the entry before its "]"; a list with items takes it after the last item.
    const text = last
      ? splice(src, last.end, last.end, `, ${literal}`)
      : splice(src, arr.closeStart, arr.closeStart, literal);
    return { ok: true, changed: true, text };
  }
  const props = (root as Extract<Node, { k: 'obj' }>).props;
  if (props.length === 0) {
    return { ok: true, changed: true, text: splice(src, root.start + 1, root.start + 1, `\n  "plugin": [${literal}]\n`) };
  }
  const lastValue = props[props.length - 1].value;
  return { ok: true, changed: true, text: splice(src, lastValue.end, lastValue.end, `,\n  "plugin": [${literal}]`) };
}

/**
 * Remove every copy of the entry from the "plugin" list. The other entries and
 * the comments stay. A list that becomes empty stays as an empty list.
 */
export function removeTuiPluginEntry(src: string, entry: string): TuiEdit {
  let text = src;
  let changed = false;
  for (;;) {
    let root: Node | null;
    try {
      root = parseRoot(text);
    } catch (e) {
      return { ok: false, reason: `not valid JSONC: ${(e as Error).message}` };
    }
    const { arr, error } = pluginArray(root);
    if (error) return { ok: false, reason: error };
    if (!arr) break;
    const i = arr.items.findIndex((it) => it.k === 'str' && it.v === entry);
    if (i === -1) break;
    const item = arr.items[i];
    const comma = arr.commas[i];
    if (comma !== null) {
      // The item and the comma after it.
      text = splice(text, item.start, comma + 1, '');
    } else if (i > 0 && arr.commas[i - 1] !== null) {
      // The last item: the comma before it goes with it.
      text = splice(text, arr.commas[i - 1]!, item.end, '');
    } else {
      text = splice(text, item.start, item.end, '');
    }
    changed = true;
  }
  return { ok: true, changed, text };
}

/** Write a text file through a temporary file, so a reader never sees half of it. */
export function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export type TuiRegistration =
  | { status: 'added' | 'present'; path: string }
  | { status: 'unparseable'; path: string; reason: string };

/** Add our entry to the TUI config file, which is created when it does not exist. */
export function registerTuiPlugin(path: string = tuiConfigPath(), entry: string = tuiPluginEntry()): TuiRegistration {
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const edit = addTuiPluginEntry(current, entry);
  if (!edit.ok) return { status: 'unparseable', path, reason: edit.reason };
  if (!edit.changed) return { status: 'present', path };
  writeTextAtomic(path, edit.text);
  return { status: 'added', path };
}

/** Remove our entry from the TUI config file. A file that is absent or not JSONC is left alone. */
export function unregisterTuiPlugin(path: string = tuiConfigPath(), entry: string = tuiPluginEntry()): { removed: boolean; path: string } {
  if (!existsSync(path)) return { removed: false, path };
  const edit = removeTuiPluginEntry(readFileSync(path, 'utf-8'), entry);
  if (!edit.ok || !edit.changed) return { removed: false, path };
  writeTextAtomic(path, edit.text);
  return { removed: true, path };
}
