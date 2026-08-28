/**
 * The task board's controls, driven through the browser.
 *
 * Everything under these was unit-tested and none of it was covered here, so the
 * things a person actually touches — the reason a card needs before it leaves,
 * the counts in the panel, the never-file toggle — were only ever verified by
 * reading the code.
 *
 * All API calls are mocked: what needs proving is what the UI SENDS and SHOWS,
 * not that Express works.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const STATUS_FIXTURE = { totalChunks: 0, totalSessions: 0, indexPath: '/tmp/fake', projects: {} };

/** A board mid-life: work earned, work the machine closed, and one open card. */
const TASKS = [
  {
    id: 't_open', projectId: 'git:h/o/example-app', title: '[high] Unwrap in start — possible panic',
    description: '', status: 'todo', assigneeSub: null, createdBy: 'auto-tasks',
    blocks: [], blockedBy: [], linkedSessionId: null, linkedFindingId: 'cf_1',
    closedReason: null, doneEvidence: null, due: null, createdAt: 1, updatedAt: 1,
  },
  {
    id: 't_done', projectId: 'git:h/o/example-app', title: '[critical] Panic in list — possible panic',
    description: '', status: 'done', assigneeSub: null, createdBy: 'auto-tasks',
    blocks: [], blockedBy: [], linkedSessionId: 'sess_1', linkedFindingId: 'cf_2',
    closedReason: null, doneEvidence: { commits: ['a1b2c3d4', 'e5f6a7b8'], files: ['src/main.rs'] },
    due: null, createdAt: 1, updatedAt: 1,
  },
  {
    id: 't_closed', projectId: 'git:h/o/example-app', title: '[medium] slice copy-pasted 3×',
    description: '', status: 'closed', assigneeSub: null, createdBy: 'auto-tasks',
    blocks: [], blockedBy: [], linkedSessionId: null, linkedFindingId: null,
    closedReason: 'the collector stopped reporting its finding', doneEvidence: null,
    due: null, createdAt: 1, updatedAt: 1,
  },
];

const POLICY = {
  enabled: true, maxPri: 2, ceiling: 50, maxPerRun: 10, categories: null,
  excludedProjects: [] as string[],
  lastRun: { at: Date.now() - 120_000, created: 3, closed: 0, repointed: 0, backfilled: 0, reopened: 0, deduped: 0 },
  eligible: 1763, filed: 4, openCards: 50,
  availableCategories: ['clone', 'security', 'stability'],
  byProject: [{ projectId: 'git:h/o/example-app', counts: { high: 2 }, eligible: 7 }],
};

async function mockBoard(page: Page, opts: {
  onPatch?: (id: string, body: any) => void;
  onPolicyPut?: (body: any) => void;
  policy?: Partial<typeof POLICY>;
} = {}) {
  await page.route('**/api/status', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS_FIXTURE) }));
  await page.route('**/api/status/stream', (r) => r.abort());
  await page.route('**/api/conversations/recent**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[],"count":0}' }));
  await page.route('**/api/conversations/*/outcome', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"found":false}' }));

  await page.route('**/api/tasks**', (r: Route) => {
    const url = r.request().url();
    const method = r.request().method();
    const m = /\/api\/tasks\/(t_[a-z_]+)$/.exec(url.split('?')[0]);
    if (method === 'PATCH' && m) {
      const body = JSON.parse(r.request().postData() || '{}');
      opts.onPatch?.(m[1], body);
      const task = { ...TASKS.find((t) => t.id === m[1]), ...body };
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task }) });
    }
    if (method === 'POST') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: '{"comment":{}}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: TASKS }) });
  });

  // AFTER the catch-all on purpose: Playwright tries the most recently added
  // route first, so registering this earlier lets `**/api/tasks**` answer the
  // policy request with a task list.
  await page.route('**/api/tasks/policy', (r: Route) => {
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData() || '{}');
      opts.onPolicyPut?.(body);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...POLICY, ...body }) });
    }
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...POLICY, ...(opts.policy ?? {}) }),
    });
  });
}

/** The panel's own Settings link — the app chrome has one with the same name. */
async function openAutoSettings(page: Page) {
  await page.locator('.tt-auto-bar').getByRole('button', { name: 'Settings', exact: true }).click();
}

async function openBoard(page: Page) {
  await page.goto('/?view=tasks');
  await expect(page.getByTestId('auto-headline')).toBeVisible();
}

test.describe('the auto-file panel', () => {
  test('leads with work FINISHED, not only the backlog', async ({ page }) => {
    // It used to print "1763 still eligible — close some to let more in" beside a
    // collapsed Done column, so a board that had finished work showed none of it.
    await mockBoard(page);
    await openBoard(page);

    const sub = page.getByTestId('auto-sub');
    await expect(sub).toContainText('1 worked');
    await expect(sub).toContainText('1 closed unworked');
    await expect(sub).toContainText('1763 waiting');
  });

  test('a full board says filing is paused rather than demanding work', async ({ page }) => {
    await mockBoard(page);
    await openBoard(page);
    await expect(page.getByTestId('auto-headline')).toContainText('Board full');
    await expect(page.getByTestId('auto-headline')).toContainText('filing paused');
  });

  test('room left shows the ratio instead', async ({ page }) => {
    await mockBoard(page, { policy: { openCards: 12 } });
    await openBoard(page);
    await expect(page.getByTestId('auto-sub')).toContainText('12/50 open');
  });
});

test.describe('a card leaving the board', () => {
  test('THE POINT: closing asks for a reason, and sends it', async ({ page }) => {
    const patches: Array<{ id: string; body: any }> = [];
    await mockBoard(page, { onPatch: (id, body) => patches.push({ id, body }) });
    await openBoard(page);

    await page.getByLabel('Status of [high] Unwrap in start — possible panic').selectOption('closed');

    // Nothing is sent until the reason exists — the server would refuse it.
    await expect(page.getByTestId('reason-prompt')).toBeVisible();
    expect(patches).toHaveLength(0);
    await expect(page.getByTestId('reason-confirm')).toBeDisabled();

    await page.getByTestId('reason-input').fill('superseded by the roll-up card');
    await page.getByTestId('reason-confirm').click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].id).toBe('t_open');
    expect(patches[0].body).toMatchObject({ status: 'closed', closedReason: 'superseded by the roll-up card' });
  });

  test('cancelling leaves the card where it was', async ({ page }) => {
    const patches: Array<{ id: string; body: any }> = [];
    await mockBoard(page, { onPatch: (id, body) => patches.push({ id, body }) });
    await openBoard(page);

    await page.getByLabel('Status of [high] Unwrap in start — possible panic').selectOption('rejected');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('reason-prompt')).toHaveCount(0);
    expect(patches).toHaveLength(0);
  });

  test('rejecting records the reason as a comment too, since that column cannot show one', async ({ page }) => {
    const patches: Array<{ id: string; body: any }> = [];
    let comments = 0;
    await mockBoard(page, { onPatch: (id, body) => patches.push({ id, body }) });
    page.on('request', (r) => { if (r.method() === 'POST' && /\/comments$/.test(r.url())) comments++; });
    await openBoard(page);

    await page.getByLabel('Status of [high] Unwrap in start — possible panic').selectOption('rejected');
    await page.getByTestId('reason-input').fill('versioned artifacts, duplication is deliberate');
    await page.getByTestId('reason-confirm').click();

    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].body.status).toBe('rejected');
    await expect.poll(() => comments).toBe(1);
  });

  test('done is NOT offered in the dropdown — it needs a session and commits', async ({ page }) => {
    await mockBoard(page);
    await openBoard(page);
    const options = await page.getByLabel('Status of [high] Unwrap in start — possible panic')
      .locator('option').allTextContents();
    expect(options).toContain('Closed');
    expect(options).toContain('Rejected');
    expect(options).not.toContain('Done');
  });
});

test.describe('what a card shows', () => {
  test('a done card names the commits that fixed it', async ({ page }) => {
    await mockBoard(page);
    await openBoard(page);
    await page.getByRole('button', { name: /Show 1 done/ }).click();

    const ev = page.getByTestId('evidence-t_done');
    await expect(ev).toContainText('fixed by');
    await expect(ev).toContainText('a1b2c3d4');
    await expect(ev).toContainText('1 file');
  });

  test('a closed card says why it stopped applying', async ({ page }) => {
    await mockBoard(page);
    await openBoard(page);
    await page.getByRole('button', { name: /Show 1 closed/ }).click();
    await expect(page.getByTestId('closed-why-t_closed'))
      .toContainText('the collector stopped reporting its finding');
  });

  test('done and closed are separate columns, so neither is counted as the other', async ({ page }) => {
    await mockBoard(page);
    await openBoard(page);
    await expect(page.getByRole('button', { name: /Show 1 done/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Show 1 closed/ })).toBeVisible();
  });
});

test.describe('excluding a project', () => {
  test('THE POINT: the toggle sends the project to the never-file list', async ({ page }) => {
    let put: any = null;
    await mockBoard(page, { onPolicyPut: (b) => { put = b; } });
    await openBoard(page);

    // The per-project tiles live behind Settings; that is where the projects are
    // already listed with their counts, so it is where the toggle belongs.
    await openAutoSettings(page);
    await page.getByTestId('exclude-git:h/o/example-app').click();

    await expect.poll(() => put).not.toBeNull();
    expect(put.excludedProjects).toEqual(['git:h/o/example-app']);
  });

  test('an already-excluded project offers to come back, and keeps the others', async ({ page }) => {
    let put: any = null;
    await mockBoard(page, {
      onPolicyPut: (b) => { put = b; },
      policy: { excludedProjects: ['git:h/o/example-app', 'git:h/o/other'] },
    });
    await openBoard(page);

    await openAutoSettings(page);
    const toggle = page.getByTestId('exclude-git:h/o/example-app');
    await expect(toggle).toContainText('excluded');
    await toggle.click();

    await expect.poll(() => put).not.toBeNull();
    // The OTHER exclusion survives — replacing the list would have dropped it.
    expect(put.excludedProjects).toEqual(['git:h/o/other']);
  });
});
