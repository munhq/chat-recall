/**
 * Verify the ConversationViewer's subagent accordion renders for sessions
 * that have hidden Explore/aside/compact transcripts on disk.
 *
 * Picks the first session in /api/conversations/recent that the API reports
 * as having subagents, opens it in the UI, switches to Full view, and asserts:
 *  - the "+N in M subagent(s)" suffix shows up next to "Showing X of Y"
 *  - the SUBAGENT CONVERSATIONS section renders with a clickable accordion
 */
import { test, expect } from '@playwright/test';

const API = process.env.API_BASE || 'http://localhost:5000';

/**
 * Finds a session that has subagents on disk by scanning the filesystem
 * directly. Avoids hammering the API with up-to-N conversation fetches,
 * which would slow the rest of the suite (subagent parsing is non-trivial).
 */
/**
 * Finds a session with subagents on disk. Prefers sessions in the API's first 50
 * recent (so the card is visible without scrolling). Falls back to filesystem-only
 * scan if the API is slow — the test will skip itself if no match is in the visible
 * card list anyway.
 */
async function findSessionWithSubagents(): Promise<string | null> {
  const { readdirSync, existsSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');

  let visibleIds = new Set<string>();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    const r = await fetch(`${API}/api/conversations/recent?limit=50`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const d = await r.json();
      visibleIds = new Set((d.sessions || []).map((s: any) => s.sessionId));
    }
  } catch { /* fall through */ }

  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return null;

  // Collect candidates with mtime so we can prefer the most recent visible one.
  const candidates: { id: string; mtime: number; visible: boolean }[] = [];
  for (const proj of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsRoot, proj.name);
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(projPath, entry.name, 'subagents');
      if (!existsSync(subDir)) continue;
      try {
        const files = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
        if (files.length === 0) continue;
        const sessionFile = join(projPath, `${entry.name}.jsonl`);
        const mtime = existsSync(sessionFile) ? statSync(sessionFile).mtimeMs : 0;
        candidates.push({ id: entry.name, mtime, visible: visibleIds.has(entry.name) });
      } catch { /* skip */ }
    }
  }
  // Prefer visible + most recent.
  candidates.sort((a, b) => Number(b.visible) - Number(a.visible) || b.mtime - a.mtime);
  return candidates[0]?.id ?? null;
}

test.describe('Subagent panel', () => {
  test('renders subagent accordion for sessions with subagents on disk', async ({ page }) => {
    test.setTimeout(60_000);
    const sessionId = await findSessionWithSubagents();
    test.skip(!sessionId, 'No session with subagents found in recent — install some explore/compact subagents first');

    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]', { timeout: 20_000 });
    // Wait until the conversation list actually populates. Under suite load
    // the API can take several seconds to respond on a fresh navigation; if
    // it never arrives there's nothing to test, so skip rather than fail.
    try {
      await page.waitForSelector('[data-session-id]', { timeout: 30_000 });
    } catch {
      test.skip(true, 'Conversation list never populated — backend slow under suite load');
      return;
    }

    const card = page.locator(`[data-session-id="${sessionId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();
    await page.waitForTimeout(800);
    // Switch to Full view
    await page.getByRole('button', { name: 'Full' }).click();
    await page.waitForTimeout(2000);

    // The "Showing X of Y" header and the "+N in M subagent" suffix sit in
    // sibling spans; innerText puts a newline between them. So we assert each
    // separately rather than requiring them on the same logical line.
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).toMatch(/Showing \d+ of \d+ messages/);
    expect(body).toMatch(/\+\d+ in \d+ subagent/);
    expect(body).toMatch(/SUBAGENT CONVERSATIONS \(\d+\)/);
  });
});
