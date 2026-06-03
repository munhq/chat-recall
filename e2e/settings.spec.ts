/**
 * Settings dialog — opens from TopBar, reads /api/settings, PUTs structured updates.
 *
 * The new UI uses radio cards per provider (not a single select), with
 * provider-specific form fields swapping in based on selection. We mock the
 * /api/settings endpoint so the test doesn't depend on real disk state.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const STATUS_FIXTURE = {
  totalChunks: 0,
  totalSessions: 0,
  indexPath: '/tmp/fake',
  projects: {},
};

const SETTINGS_FIXTURE = {
  settings: {
    v: 1,
    embedding: { provider: 'ollama', ollamaHost: 'http://localhost:11434', ollamaModel: 'nomic-embed-text' },
    // Active summary provider is the "cli" row pinned to the gemini preset.
    // The UI exposes each (provider=cli, preset) pair as a single selectable row
    // via testid `summary-choice-cli:<preset>`.
    summary:   { provider: 'cli', cliPreset: 'gemini', cliCommand: 'gemini -p " "', cliTimeoutMs: 120_000 },
  },
  presets: {
    embeddingProviders: ['none', 'ollama', 'nvidia', 'gemini', 'openai', 'openai-compat'],
    summaryProviders:   ['none', 'cli', 'ollama', 'claude'],
    summaryCliPresets:  ['opencode', 'kilocode', 'gemini', 'claude-cli', 'llm', 'aichat'],
    summaryCliPresetCommands: {
      opencode:    'opencode -p " "',
      kilocode:    'kilo -p " "',
      gemini:      'gemini -p " "',
      'claude-cli':'claude -p " "',
      llm:         'llm " "',
      aichat:      'aichat " "',
    },
    embeddingHints: {
      ollama:          { label: 'Ollama (local, free)', requires: 'Ollama running locally' },
      gemini:          { label: 'Google Gemini (hosted)', requires: 'GEMINI_API_KEY' },
      openai:          { label: 'OpenAI (hosted)', requires: 'OPENAI_API_KEY' },
      nvidia:          { label: 'Nvidia NIM (free hosted)', requires: 'NVIDIA_API_KEY' },
      'openai-compat': { label: 'Custom OpenAI-compatible endpoint', requires: 'A base URL + model name.' },
      none:            { label: 'None — keyword search only (FTS5)', requires: 'Nothing.' },
    },
    summaryHints: {
      'cli':    { label: 'Local CLI', requires: 'Detect or pick an installed AI CLI' },
      'ollama': { label: 'Ollama (local)', requires: 'Ollama + a chat model' },
      'claude': { label: 'Claude API (HTTP)', requires: 'ANTHROPIC_API_KEY' },
      'none':   { label: 'None — first prompt fallback', requires: 'Nothing.' },
    },
  },
  status: {
    ollama: { reachable: true, models: ['nomic-embed-text:latest'] },
    // CLI presets all marked detected so they render in the visible "Detected
    // on this machine" group instead of the collapsed install-required group.
    cliDetected: {
      opencode: true, kilocode: true, gemini: true, 'claude-cli': true, llm: true, aichat: true,
    },
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
      // Echo back the merged settings so the client can refresh its state.
      const merged = {
        v: 1,
        embedding: { ...SETTINGS_FIXTURE.settings.embedding, ...(body.embedding ?? {}) },
        summary:   { ...SETTINGS_FIXTURE.settings.summary,   ...(body.summary ?? {}) },
      };
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, settings: merged, restartHint: 'CLI/MCP picks up on next start.' }),
      });
    }
    return r.fulfill({ status: 405, body: 'method not allowed' });
  });
}

test.describe('Settings dialog', () => {
  test('opens from the TopBar Settings button and shows current provider selection', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');

    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');
    await expect(dialog).toBeVisible();

    // The fixture has embedding=ollama, summary=cli/gemini — both should
    // be marked selected via data-selected on the wrapping label.
    await expect(dialog.locator('[data-testid="embedding-choice-ollama"]')).toHaveAttribute('data-selected', 'true');
    await expect(dialog.locator('[data-testid="summary-choice-cli:gemini"]')).toHaveAttribute('data-selected', 'true');
  });

  test('switching the embedding provider swaps in provider-specific fields', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');

    // Click the OpenAI choice. Use the underlying input so React picks up onChange.
    await dialog.locator('[data-testid="embedding-choice-openai"] input[type="radio"]').click();

    // The form swap happens after the radio change. The OpenAI key textbox
    // should now exist and the Ollama host field should be gone. Both
    // strings appear in provider-hint copy too, so we scope to the actual
    // <input> via its accessible name (label association).
    await expect(dialog.getByRole('textbox', { name: 'OPENAI_API_KEY' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Ollama host' })).toHaveCount(0);
  });

  test('save sends a structured embedding+summary payload to PUT /api/settings', async ({ page }) => {
    let received: any = null;
    await mockApi(page, (body) => { received = body; });

    await page.goto('/');
    await page.waitForSelector('[data-testid="project-all"]');
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-dialog');

    // Each (provider, cliPreset) pair is its own selectable row. Picking
    // "cli:opencode" applies provider=cli + cliPreset=opencode in one click.
    await dialog.locator('[data-testid="summary-choice-cli:opencode"] input[type="radio"]').click();

    await page.getByTestId('settings-save').click();

    await expect.poll(() => received?.summary?.provider).toBe('cli');
    await expect.poll(() => received?.summary?.cliPreset).toBe('opencode');
    // Embedding section was untouched but should still round-trip the current value.
    await expect.poll(() => received?.embedding?.provider).toBe('ollama');
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
