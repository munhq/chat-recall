import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5174';
const OUT = process.env.OUT;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const DEVICES = (process.env.DEVICES || 'desktop,mobile').split(',');
const THEMES = (process.env.THEMES || 'dark,light').split(',');

// Sidebar destinations, by their visible label.
const NAV = ['Overview', 'Conversations', 'Projects', 'Memory Hub', 'Tasks', 'Toolkit', 'Security', 'System health'];

// Every leaf text node, scored for contrast against its COMPOSITED background.
// Compositing matters: a translucent surface over the ground scores as the blend,
// and skipping the blend invents failures on every tinted panel in the app.
import { AUDIT } from './design-audit-lib.mjs';

const b = await chromium.launch();
const findings = [];
for (const theme of THEMES) {
  for (const dev of DEVICES) {
    const [w, h] = dev === 'desktop' ? [1440, 900] : [390, 844];
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    // The app reads its theme from localStorage and ignores prefers-color-scheme,
    // so a colorScheme context option alone yields two identical captures.
    await ctx.addInitScript(`try { localStorage.setItem('cr-theme', '${theme}'); } catch {}`);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 160)));
    await p.goto(BASE, { waitUntil: 'networkidle' }).catch(() => {});
    await p.waitForTimeout(900);

    for (const label of ONLY || NAV) {
      // Deep views: a conversation open, a project workspace open, the settings
      // dialog up. NONE of these render on a top-level screen, so an audit that
      // only walked the nav missed every drawer, dialog and detail pane — which
      // is where the leftover radii and coloured bars were hiding.
      if (label === 'ConversationDetail') {
        await p.locator('.cr-nav-item', { hasText: 'Conversations' }).first().click().catch(() => {});
        await p.waitForTimeout(1200);
        await p.locator('.cr-conv-row').first().click().catch(() => {});
      } else if (label === 'ProjectWorkspace') {
        await p.locator('.cr-nav-item', { hasText: 'Projects' }).first().click().catch(() => {});
        await p.waitForTimeout(1200);
        await p.locator('.cr-schedule tbody tr').first().click().catch(() => {});
      } else if (label === 'Settings') {
        await p.locator('[title*="Settings" i], [aria-label*="settings" i]').first().click().catch(() => {});
      } else if (label !== 'Overview') {
        if (dev === 'mobile') {
          const burger = p.locator('.cr-mobile-only button, [aria-label*="menu" i]').first();
          if (await burger.count()) await burger.click().catch(() => {});
          await p.waitForTimeout(300);
        }
        const item = p.locator('.cr-nav-item', { hasText: label }).first();
        if (!(await item.count())) { console.log(`  ${label}: nav item not found`); continue; }
        await item.click().catch(() => {});
      }
      await p.waitForTimeout(1400);
      const a = await p.evaluate(AUDIT);
      const slug = label.toLowerCase().replace(/[^a-z]+/g, '-');
      await p.screenshot({ path: `${OUT}/${slug}-${theme}-${dev}.png`, fullPage: dev === 'desktop' });
      const flags = [];
      if (a.scrollWidth > w) flags.push(`OVERFLOW +${a.scrollWidth - w}`);
      if (a.contrast.length) flags.push(`contrast ${a.contrast.length}`);
      if (a.small.length) flags.push(`sub12px ${a.small.length}`);
      if (a.radius.length) flags.push(`radius ${a.radius.length}`);
      if (a.shadow.length) flags.push(`shadow ${a.shadow.length}`);
      if (a.panning?.length) flags.push(`pans ${a.panning.map((x) => x.cls + '+' + x.over).join(',')}`);
      console.log(`${slug.padEnd(14)} ${theme.padEnd(5)} ${dev.padEnd(7)} theme=${a.theme} ${flags.length ? flags.join(' · ') : 'clean'}`);
      findings.push({ screen: slug, theme, dev, ...a });
    }
    if (errs.length) console.log(`  pageerrors (${theme}/${dev}): ${[...new Set(errs)].slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
}
await b.close();
const fs = await import('node:fs');
fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(findings, null, 1));
console.log(`\naudit written to ${OUT}/audit.json`);
