/**
 * Record a product walkthrough from the DEMO account.
 *
 * The video this replaces was a screen capture of a real browser: it showed the
 * operator's ChatGPT sidebar with their own conversation titles, a private
 * conversation URL, their menu bar and their account chip. The product data in
 * it was already the demo tenant — the leak was everything AROUND the product.
 *
 * A headless recording has no chrome to leak. Same guard as the still captures:
 * it refuses to keep the file if forbidden text appears on any screen it visits.
 *
 *   BASE=http://127.0.0.1:5174 OUT=./out node scripts/record-demo-video.mjs
 */
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { readFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const OUT = process.env.OUT || 'out';
mkdirSync(OUT, { recursive: true });

const namesFile = process.env.CHAT_RECALL_PRIVATE_NAMES ||
  join(homedir(), '.config', 'chat-recall', 'private-names.txt');
const FORBIDDEN = [
  homedir(), 'packages/engine/src',
  ...(existsSync(namesFile)
    ? readFileSync(namesFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : []),
];

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1440, height: 810 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 810 } },
});
await ctx.addInitScript("try{localStorage.setItem('cr-theme','dark')}catch{}");
const p = await ctx.newPage();
let dirty = [];

async function beat(label, go, hold = 2600) {
  await go();
  await p.waitForTimeout(hold);
  const t = await p.evaluate(() => document.body.innerText || '');
  const hits = FORBIDDEN.filter((w) => t.includes(w));
  if (hits.length) dirty.push(`${label}: ${hits.join(', ')}`);
  console.log(`  ${label.padEnd(22)} ${hits.length ? 'DIRTY' : 'clean'}`);
}

await beat('overview',     () => p.goto(`${BASE}/?view=home`,     { waitUntil: 'networkidle' }), 3200);
await beat('conversations',() => p.goto(`${BASE}/?view=search`,   { waitUntil: 'networkidle' }));
await beat('one session',  async () => {
  const i = p.locator('[data-testid="session-item"]').filter({ hasText: 'timing out' }).first();
  await ((await i.count()) ? i : p.locator('[data-testid="session-item"]').first()).click();
}, 3600);
await beat('projects',     () => p.goto(`${BASE}/?view=projects`, { waitUntil: 'networkidle' }));
await beat('one project',  async () => {
  const r = p.locator('text=example-app').first();
  if (await r.count()) await r.click();
}, 3600);
await beat('security',     () => p.goto(`${BASE}/?view=security`, { waitUntil: 'networkidle' }), 3600);
await beat('toolkit',      () => p.goto(`${BASE}/?view=toolkit`,  { waitUntil: 'networkidle' }), 3200);

const video = p.video();
await ctx.close();
await b.close();
const raw = await video.path();

if (dirty.length) {
  rmSync(raw, { force: true });
  console.error('\nREFUSED — real data on screen:\n  ' + dirty.join('\n  '));
  process.exit(1);
}
renameSync(raw, join(OUT, 'walkthrough.webm'));
console.log('\nrecorded', join(OUT, 'walkthrough.webm'));
