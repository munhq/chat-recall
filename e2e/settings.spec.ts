/**
 * Settings dialog — opens from TopBar, reads /api/settings, PUTs changes.
 *
 * We mock both endpoints so the test doesn't depend on the user's real
 * .env contents and doesn't mutate disk.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

const STATUS_FIXTURE = {
  totalChunks: 0,
  totalSessions: 0,
  indexPath: '/tmp/fake',
  projects: {},
};

const SETTINGS_FIXTURE = {
  envPath: '/tmp/fake/.env',
  settings: {
    SUMMARY_PROVIDER: 'gemini-cli',
    SUMMARY_CLI_PRESET: '',
    SUMMARY_CLI_CMD: '',
    SUMMARY_CLI_TIMEOUT_MS: '',
    GEMINI_MODEL: 'gemini-3-flash-preview',
    EMBEDDING_PROVIDER: 'ollama',
    OLLAMA_HOST: 'http://localhost:11434',
    OLLAMA_SUMMARY_MODEL: '',
    CLAUDE_DIR: '~/.claude',
  },
  presets: {
    summaryCliPresets: ['opencode', 'kilo', 'kilocode', 'gemini', 'claude-cli', 'llm', 'aichat'],
    summaryProviders: ['cli', 'gemini-cli', 'ollama', 'claude'],
    embeddingProviders: ['ollama', 'gemini'],
  },
};

async function mockApi(page: Page, onPut?: (body: any) => void) {
  await page.route('**/api/status', (r: Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS_FIXTURE) })
  );
  await page.route('**/api/status/stream', (r) => r.abort());
  await page.route('**/api/conversations/recent**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"sessions":[],"count":0}' })
  );
  await page.route('**/api/settings', (r: Route) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SETTINGS_FIXTURE) });
    }
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData() || '{}');
      onPut?.(body);
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          envPath: SETTINGS_FIXTURE.envPath,
          updated: Object.keys(body.settings || {}),
          restartHint: 'Restart chat-recall-api to apply.',
        }),
      });
    }
    return r.fulfill({ status: 405, body: 'method not allowed' });
  });
}

test.describe('Settings dialog', () => {
  test('opens from the TopBar Settings button and loads current settings', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');

    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();

    // Reads the fixture's provider value into the select.
    const providerSelect = dialog.locator('select').first();
    await expect(providerSelect).toHaveValue('gemini-cli');
  });

  test('switching to cli exposes preset/command/timeout fields', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');

    const providerSelect = dialog.locator('select').first();
    await providerSelect.selectOption('cli');

    // Preset select and custom-command input should appear.
    await expect(dialog.getByText('CLI preset')).toBeVisible();
    await expect(dialog.getByText('Custom CLI command (optional)')).toBeVisible();
    await expect(dialog.getByText('Timeout (ms)')).toBeVisible();
  });

  test('save sends allowlisted keys to PUT /api/settings', async ({ page }) => {
    let received: any = null;
    await mockApi(page, (body) => { received = body; });

    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');

    await dialog.locator('select').first().selectOption('cli');
    // The second select is the CLI preset.
    await dialog.locator('select').nth(1).selectOption('opencode');

    await page.getByTestId('settings-save').click();

    await expect.poll(() => received?.settings?.SUMMARY_PROVIDER).toBe('cli');
    await expect.poll(() => received?.settings?.SUMMARY_CLI_PRESET).toBe('opencode');
    // Confirm success banner rendered.
    await expect(dialog.getByText(/Saved \d+ settings?\./)).toBeVisible();
  });

  test('Escape key closes the dialog', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
  });
});
