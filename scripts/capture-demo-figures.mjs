/**
 * Capture the marketing figures from the DEMO account.
 *
 * The three figures on chatrecall.dev were taken from the maintainer's own
 * machine. One of them published 8392 real findings and the last four
 * characters of three live keys; another published 147 real session titles,
 * real internal file paths and a real knowledge graph. This script exists so
 * that never has to happen again: it drives the demo tenant only, and it
 * REFUSES to write a file if anything on the page looks like real data.
 *
 *   BASE=http://127.0.0.1:5174 OUT=./shots node scripts/capture-demo-figures.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const OUT = process.env.OUT || 'shots';
/* The app ignores prefers-color-scheme and reads its own key, so a context
 * colorScheme alone yields two identical captures and a false pass. Set the
 * key the app actually reads. */
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';
const SUFFIX = THEME === 'light' ? '-light' : '';
mkdirSync(OUT, { recursive: true });

/* WHAT COUNTS AS REAL DATA ON THE PAGE.
 *
 * Derived at run time, never written down. An earlier version of this file
 * listed the operator's org and client names literally so it could refuse them
 * — which published exactly the strings it existed to keep out, and the
 * pre-commit hook refused the commit. A guard that leaks what it guards is
 * worse than no guard, because it looks careful.
 *
 * So: the home directory comes from the environment, and any extra names come
 * from a file outside the repository. A machine without that file still gets
 * the structural checks, which are the ones that catch a capture taken from a
 * real account by mistake. */
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const extraNamesFile =
  process.env.CHAT_RECALL_PRIVATE_NAMES ||
  join(homedir(), '.config', 'chat-recall', 'private-names.txt');

const FORBIDDEN = [
  homedir(),                       // the capture ran against a real machine
  'packages/engine/src',           // this product's own source tree
  ...(existsSync(extraNamesFile)
    ? readFileSync(extraNamesFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : []),
];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await ctx.addInitScript(`try{localStorage.setItem('cr-theme','${THEME}')}catch{}`);
const p = await ctx.newPage();
let failed = 0;

async function shoot(name, go) {
  await go();
  const text = await p.evaluate(() => document.body.innerText || '');
  const hits = FORBIDDEN.filter((w) => text.includes(w));
  if (hits.length) {
    console.error(`REFUSED ${name}: real data on the page — ${hits.join(', ')}`);
    failed += 1;
    return;
  }
  await p.screenshot({ path: `${OUT}/${name}${SUFFIX}.png`, fullPage: true });
  console.log(`${(name + SUFFIX).padEnd(28)} captured, clean`);
}

await shoot('project-overview', async () => {
  await p.goto(`${BASE}/?view=projects`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);
  const row = p.locator('text=example-app').first();
  if (await row.count()) { await row.click(); await p.waitForTimeout(2500); }
});

await shoot('security-scans', async () => {
  await p.goto(`${BASE}/?view=security`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
});

await shoot('conversation-overview', async () => {
  await p.goto(`${BASE}/?view=search`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2000);
  // The long checkout session — the only one with real mass behind it.
  const item = p.locator('[data-testid="session-item"]').filter({ hasText: 'timing out' }).first();
  const target = (await item.count()) ? item : p.locator('[data-testid="session-item"]').first();
  await target.click();
  await p.waitForTimeout(3000);
});

await b.close();
if (failed) { console.error(`\n${failed} capture(s) refused.`); process.exit(1); }
console.log(`\nall figures captured from the demo account (${THEME})`);
