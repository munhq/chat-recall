#!/usr/bin/env node
/**
 * Vendor the three brand webfonts into public/fonts/ and emit src/fonts.css.
 *
 * WHY VENDOR AT ALL
 * index.css used to open with `@import url('https://fonts.googleapis.com/...')`.
 * That costs three things, and the security one is why this script exists:
 *
 *   1. Security. A stylesheet from another origin has to be allowed by the CSP
 *      (server.ts), which means keeping fonts.googleapis.com and
 *      fonts.gstatic.com in style-src and font-src. A third party that can serve
 *      CSS to your origin can restyle anything on the page. Vendoring lets both
 *      directives collapse to 'self'.
 *   2. Privacy. Every visitor's IP reaches Google before the page paints.
 *   3. Speed. @import inside a stylesheet is the worst case for a font: the
 *      browser cannot even discover the request until index.css has been fetched
 *      and parsed, so it is two serial round trips to another origin before any
 *      text can render in the right face.
 *
 * SUBSETS
 * latin and latin-ext only. latin-ext is not optional here: it carries the
 * Romanian set (ă â î ș ț), and dropping it silently falls back to a system font
 * mid-word. cyrillic, greek and vietnamese are dropped, which is 24 of the 42
 * files Google offers for these families.
 *
 * LICENCE
 * All three families are SIL Open Font License 1.1, which permits redistribution
 * with the licence text. See public/fonts/OFL.txt.
 *
 * Re-run after changing a weight in the FAMILIES query below:
 *   node scripts/sync-fonts.mjs
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(HERE, '..');
const FONT_DIR = resolve(CLIENT, 'public/fonts');
const OUT_CSS = resolve(CLIENT, 'src/fonts.css');

// The exact weights the design system uses. Adding a weight here without using
// it ships bytes nobody renders; using one that is not here silently synthesises
// a fake bold, which looks subtly wrong and is hard to attribute later.
// Archivo is a VARIABLE font on both axes, which is why the parser below reads
// a weight RANGE and a font-stretch. It is the marketing site's display voice:
// chatrecall.dev sets its sheet titles in Archivo at ~84-88% width, which is a
// single axis position rather than a second file.
const QUERY =
  'family=Martian+Mono:wght@500;700' +
  '&family=Hanken+Grotesk:wght@400;500;600;700' +
  '&family=JetBrains+Mono:wght@400;500;600' +
  '&family=Archivo:wdth,wght@62..125,400..900' +
  '&display=swap';

const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

// Google serves different formats per User-Agent. A modern Chrome UA gets woff2,
// which every browser we support has handled for years.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  await mkdir(FONT_DIR, { recursive: true });

  const res = await fetch(`https://fonts.googleapis.com/css2?${QUERY}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`google fonts css: HTTP ${res.status}`);
  const css = await res.text();

  // Each @font-face is preceded by a /* subset */ comment. Split on it so the
  // subset label stays attached to the block it describes.
  const blocks = [...css.matchAll(/\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]+\})/gi)];
  if (!blocks.length) throw new Error('parsed zero @font-face blocks — the CSS format changed');

  const out = [];
  let kept = 0;
  let skipped = 0;

  for (const [, subset, block] of blocks) {
    if (!KEEP_SUBSETS.has(subset)) { skipped++; continue; }

    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    // A variable font declares a RANGE ("400 900"); a static one a single value.
    // Both are valid font-weight, so keep whatever Google wrote and only
    // normalise it for the filename.
    const weight = /font-weight:\s*([\d\s]+?)\s*;/.exec(block)?.[1];
    const stretch = /font-stretch:\s*([^;]+);/.exec(block)?.[1];
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] || 'normal';
    const url = /src:\s*url\(([^)]+)\)/.exec(block)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
    if (!family || !weight || !url) throw new Error(`incomplete @font-face block for subset ${subset}`);

    // "400 900" is not a filename. A variable face is one file per subset, so
    // it is named for the axis rather than for a weight it does not have.
    const wSlug = /\s/.test(weight) ? 'var' : weight;
    const name = `${slug(family)}-${wSlug}-${subset}.woff2`;
    const dest = resolve(FONT_DIR, name);
    if (!existsSync(dest)) {
      const font = await fetch(url, { headers: { 'user-agent': UA } });
      if (!font.ok) throw new Error(`${name}: HTTP ${font.status}`);
      await writeFile(dest, Buffer.from(await font.arrayBuffer()));
    }

    out.push(
      `@font-face {\n` +
      `  font-family: '${family}';\n` +
      `  font-style: ${style};\n` +
      `  font-weight: ${weight};\n` +
      (stretch ? `  font-stretch: ${stretch};\n` : '') +
      // swap: show fallback text immediately and restyle when the font lands.
      // The alternative blocks first paint on a font download, which is a blank
      // page on a slow connection.
      `  font-display: swap;\n` +
      `  src: url('/fonts/${name}') format('woff2');\n` +
      (range ? `  unicode-range: ${range};\n` : '') +
      `}`,
    );
    kept++;
  }

  const header =
    `/* GENERATED by scripts/sync-fonts.mjs — do not edit by hand.\n` +
    ` *\n` +
    ` * Self-hosted so the CSP can keep style-src and font-src at 'self'. See the\n` +
    ` * script for why, and public/fonts/OFL.txt for the licence.\n` +
    ` * Subsets: ${[...KEEP_SUBSETS].join(', ')} (latin-ext carries ă â î ș ț).\n` +
    ` */\n`;
  await writeFile(OUT_CSS, `${header}\n${out.join('\n\n')}\n`);

  console.log(`fonts: ${kept} faces vendored, ${skipped} dropped (other subsets)`);
  console.log(`css:   ${OUT_CSS}`);
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
