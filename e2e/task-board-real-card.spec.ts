/**
 * Renders a card taken verbatim from PRODUCTION, to answer one question: does the
 * board actually show the change, or have I only been asserting that it does?
 *
 * The fixture is not hand-written. It is the JSON the live API returns for a card
 * this session worked and closed — `GetPriceRange copy-pasted 3×` — so what is
 * under test is the real shape, real diff text and real evidence a closer wrote,
 * not an idealised version of them.
 *
 * The API is mocked only to SERVE that captured payload; nothing about the
 * rendering is faked.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

const FIXTURE = process.env.REAL_CARD_FIXTURE
  ?? '/tmp/claude-1000/-home-adi-code-personal-chat-recall/44d087bd-26ff-49ff-bbe3-75c9506a4a58/scratchpad/real-card.json';

const REAL = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { tasks: any[] };
const CARD = REAL.tasks[0];

async function mock(page: Page) {
  await page.route('**/api/status', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"totalChunks":0,"totalSessions":0,"indexPath":"/x","projects":{}}' }));
  await page.route('**/api/status/stream', (r) => r.abort());
  await page.route('**/api/conversations/recent**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[],"count":0}' }));
  await page.route('**/api/conversations/*/outcome', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));
  await page.route('**/api/tasks**', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REAL) }));
  await page.route('**/api/tasks/policy', (r: Route) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        enabled: true, maxPri: 2, ceiling: 50, maxPerRun: 10, categories: null,
        excludedProjects: [], perProject: {}, lastRun: null, eligible: 40, filed: 25,
        openCards: 40, availableCategories: [], byProject: [],
      }),
    }));
}

test('a card closed in production shows the change it was closed with', async ({ page }) => {
  await mock(page);
  await page.goto('/?view=tasks');

  // The card is in the Done column, which is open by default.
  const card = page.getByTestId(`evidence-${CARD.id}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('fixed by');
  await expect(card).toContainText(CARD.doneEvidence.commits[0].slice(0, 7));

  await page.getByTestId(`evidence-toggle-${CARD.id}`).click();

  // The recorded diff, rendered from what the closer actually wrote down.
  const shown = page.getByTestId(`recorded-diff-${CARD.id}`);
  await expect(shown).toBeVisible();
  await expect(shown).toContainText('timeseries.InRange');
  await expect(shown).toContainText('internal/aster/websocket.go');

  await page.screenshot({
    path: 'test-results/real-card-evidence.png',
    fullPage: false,
  });
});
