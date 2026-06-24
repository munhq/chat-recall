/**
 * Tiny serialization helpers shared by the toolkit parsers and the
 * cross-tool artifact codec.
 *
 * The toolkit primitives (skills, commands, agents, instructions) are stored
 * in just two physical shapes across the four AI tools:
 *   - Markdown + YAML frontmatter  (Claude/OpenCode commands & agents,
 *                                    Codex prompts, every SKILL.md)
 *   - TOML                         (Gemini commands, Codex agents)
 *
 * We only ever need a handful of *scalar* fields out of these (name,
 * description, prompt/body, argument-hint, model), so these helpers are
 * deliberately small: a frontmatter splitter and a flat-scalar TOML
 * reader/writer that understands the one extension that matters in
 * practice — triple-quoted multi-line strings (`"""…"""` / `'''…'''`),
 * which is how Gemini and Codex store prompt bodies. Nested tables and
 * arrays are out of scope and left untouched.
 */

export interface Frontmatter {
  /** Parsed scalar frontmatter keys (lower-cased). */
  fm: Record<string, string>;
  /** Everything after the closing `---`. */
  body: string;
}

/** Split a markdown doc into its YAML frontmatter scalars + body. */
export function parseFrontmatter(text: string): Frontmatter {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2] ?? '' };
}

/** Render scalar frontmatter + body back to a markdown document. */
export function stringifyFrontmatter(fm: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${needsQuote(v as string) ? JSON.stringify(v) : v}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

function needsQuote(v: string): boolean {
  return /[:#]/.test(v) || /^\s|\s$/.test(v);
}

/**
 * Read top-level scalar keys from a TOML document. Supports single-line
 * `"…"`/`'…'` and multi-line `"""…"""`/`'''…'''` values. Stops collecting
 * once a `[table]` header is hit (nested tables aren't scalars). Good enough
 * for Gemini command files and Codex agent files, whose shareable content is
 * entirely top-level scalars.
 */
export function parseScalarToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\[.*\]$/.test(trimmed)) break; // entered a [table] — done with scalars

    const kv = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let rest = kv[2];

    // Multi-line triple-quoted string.
    const triple = rest.match(/^("""|''')/);
    if (triple) {
      const q = triple[1];
      let acc = rest.slice(3);
      // Same-line close?
      const endIdx = acc.indexOf(q);
      if (endIdx >= 0) {
        out[key] = acc.slice(0, endIdx);
        continue;
      }
      const parts: string[] = [acc];
      i++;
      for (; i < lines.length; i++) {
        const close = lines[i].indexOf(q);
        if (close >= 0) { parts.push(lines[i].slice(0, close)); break; }
        parts.push(lines[i]);
      }
      // Trim the newline that hugs each delimiter (TOML trims the leading one;
      // we trim the symmetric trailing one too for clean emit→parse identity).
      out[key] = parts.join('\n').replace(/^\n/, '').replace(/\n$/, '');
      continue;
    }

    // Single-line quoted or bare scalar.
    const sq = rest.match(/^"([^"]*)"|^'([^']*)'/);
    if (sq) out[key] = sq[1] ?? sq[2] ?? '';
    else out[key] = rest.replace(/\s*#.*$/, '').trim();
  }
  return out;
}

/** Render top-level scalar keys as a TOML document (triple-quote multi-line). */
export function stringifyScalarToml(obj: Record<string, string | undefined>): string {
  const esc = (v: string) => (v.includes('\n')
    ? `"""\n${v}\n"""`
    : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k} = ${esc(v as string)}`)
    .join('\n') + '\n';
}
