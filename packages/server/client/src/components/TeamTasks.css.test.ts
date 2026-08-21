/**
 * Every `tt-*` class the board renders has a rule in TT_CSS.
 *
 * This exists because of a silent regression. The auto-file checkbox was
 * replaced by the AutoPanel, and the commit that did it deleted the CSS block
 * the checkbox happened to sit inside — which also held `.tt-sel`, `.tt-sel-sm`,
 * `.tt-new > :first-child` and the focus-visible rules for the selects and the
 * comment button. Nothing failed: TypeScript does not know about CSS, the
 * component still rendered, and the status and assignee pickers shipped to
 * production as unstyled browser controls on a dark board with no focus ring.
 *
 * The styles live in a template literal inside the component, so a plain text
 * comparison is the whole check — no DOM, no snapshot to bless.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'TeamTasks.tsx'), 'utf-8');

/** The `const TT_CSS = ` … `` block. */
function styleSheet(src: string): string {
  const start = src.indexOf('const TT_CSS = `');
  expect(start, 'TT_CSS block not found').toBeGreaterThan(-1);
  const from = start + 'const TT_CSS = `'.length;
  const end = src.indexOf('`;', from);
  expect(end, 'TT_CSS block is unterminated').toBeGreaterThan(from);
  return src.slice(from, end);
}

/**
 * Class tokens the component actually renders. Covers `className="a b"` and
 * `className={`a${x ? ' b' : ''}`}`; a token containing an interpolation is
 * skipped, because its final name is only known at runtime.
 */
function renderedClasses(src: string): Set<string> {
  const body = src.slice(0, src.indexOf('const TT_CSS = `'));
  const out = new Set<string>();
  for (const m of body.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    // A conditional inside a template literal contributes BOTH names, e.g.
    // `tt-col${on ? ' tt-col-over' : ''}` → tt-col and tt-col-over. So drop the
    // interpolation syntax and the quotes around the branch strings, then read
    // whatever class tokens remain.
    const raw = (m[1] ?? m[2] ?? '')
      .replace(/\$\{|\}/g, ' ')
      .replace(/[`'"?:]/g, ' ');
    for (const tok of raw.split(/\s+/)) {
      const t = tok.trim();
      if (/^tt-[a-z0-9-]+$/.test(t)) out.add(t);
    }
  }
  return out;
}

describe('TeamTasks styles', () => {
  const css = styleSheet(SRC);
  const used = renderedClasses(SRC);

  test('the extraction is non-trivial (guards a broken regex passing vacuously)', () => {
    expect(used.size).toBeGreaterThan(12);
    expect(used.has('tt-card')).toBe(true);
    expect(css.length).toBeGreaterThan(2000);
  });

  test('every rendered tt-* class has a rule', () => {
    const missing = [...used].filter((c) => !css.includes(`.${c}`)).sort();
    expect(missing, `no CSS rule for: ${missing.join(', ')}`).toEqual([]);
  });

  test('the controls that lost their styling once keep it', () => {
    // Named explicitly: these are the exact rules the regression removed, and a
    // generic check would pass again the moment someone deletes only the base
    // rule and leaves a layout-only `.tt-foot .tt-sel-sm` behind.
    expect(css, 'base rule for the selects').toMatch(/\.tt-sel\s*,\s*\.tt-sel-sm\s*\{/);
    expect(css, 'the new-task input must take the row').toContain('.tt-new > :first-child');
    expect(css, 'keyboard focus must be visible on the selects and the comment button')
      .toMatch(/\.tt-sel:focus-visible[^{]*\{[^}]*outline/);
    expect(css).toMatch(/\.tt-cmt:focus-visible/);
  });

  test('no rule references a colour outside the design tokens', () => {
    // The previous version of this file styled itself with `var(--border,#e3e3e8)`
    // and hardcoded hex fallbacks, so it rendered light grey inside a dark app.
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    expect(hexes, `hardcoded colours: ${hexes.join(', ')}`).toEqual([]);
  });
});
