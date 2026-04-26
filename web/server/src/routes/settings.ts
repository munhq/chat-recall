/**
 * Settings routes — read and write the project `.env` (allowlisted keys only).
 *
 * Changes land on disk immediately; the backend / MCP processes still need
 * a restart to pick them up because dotenv loads on boot.
 */

import express from 'express';
import { join, resolve } from 'path';
import { readEnvFile, writeEnvFile } from '../utils/env-file.js';

const router = express.Router();

// The .env lives at the repo root, two levels up from web/server/.
const ENV_PATH = resolve(join(process.cwd(), '..', '..', '.env'));

/**
 * Keys the UI is allowed to read/write. Everything else stays in .env untouched.
 */
const ALLOWED_KEYS = [
  // Summary provider
  'SUMMARY_PROVIDER',
  'SUMMARY_CLI_PRESET',
  'SUMMARY_CLI_CMD',
  'SUMMARY_CLI_TIMEOUT_MS',
  'GEMINI_MODEL',
  // Embedding provider
  'EMBEDDING_PROVIDER',
  'OLLAMA_HOST',
  'OLLAMA_SUMMARY_MODEL',
  // Paths
  'CLAUDE_DIR',
] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];

const VALIDATORS: Partial<Record<AllowedKey, (v: string) => boolean>> = {
  SUMMARY_PROVIDER: (v) => ['cli', 'gemini-cli', 'ollama', 'claude'].includes(v),
  SUMMARY_CLI_PRESET: (v) =>
    ['', 'opencode', 'kilo', 'kilocode', 'gemini', 'claude-cli', 'llm', 'aichat'].includes(v),
  SUMMARY_CLI_TIMEOUT_MS: (v) => /^\d+$/.test(v) && parseInt(v, 10) > 0,
  EMBEDDING_PROVIDER: (v) => ['ollama', 'gemini'].includes(v),
};

// GET /api/settings
router.get('/', (_req, res) => {
  try {
    const file = readEnvFile(ENV_PATH);
    const picked: Record<string, string> = {};
    for (const key of ALLOWED_KEYS) {
      // Prefer the file contents; fall back to process env (useful when
      // the backend is started with systemd Environment= directives).
      const val = file.values[key] ?? process.env[key] ?? '';
      picked[key] = val;
    }
    res.json({
      envPath: ENV_PATH,
      settings: picked,
      presets: {
        summaryCliPresets: [
          'opencode', 'kilo', 'kilocode', 'gemini', 'claude-cli', 'llm', 'aichat',
        ],
        summaryProviders: ['cli', 'gemini-cli', 'ollama', 'claude'],
        embeddingProviders: ['ollama', 'gemini'],
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings   body: { settings: Record<string,string> }
router.put('/', (req, res) => {
  try {
    const incoming = (req.body?.settings ?? {}) as Record<string, unknown>;
    const updates: Record<string, string | undefined> = {};
    const rejected: string[] = [];

    for (const key of ALLOWED_KEYS) {
      if (!(key in incoming)) continue;
      const raw = incoming[key];
      // Allow explicit empty string to clear/unset.
      if (raw === undefined || raw === null) {
        updates[key] = undefined;
        continue;
      }
      if (typeof raw !== 'string') {
        rejected.push(`${key}: must be string`);
        continue;
      }
      const validator = VALIDATORS[key];
      if (validator && raw !== '' && !validator(raw)) {
        rejected.push(`${key}: invalid value "${raw}"`);
        continue;
      }
      updates[key] = raw === '' ? undefined : raw;
    }

    if (rejected.length > 0) {
      return res.status(400).json({ error: 'validation failed', rejected });
    }

    writeEnvFile(ENV_PATH, updates);

    res.json({
      ok: true,
      envPath: ENV_PATH,
      updated: Object.keys(updates),
      restartHint:
        'Restart chat-recall-api (and MCP clients) to pick up changes: ' +
        '`systemctl --user restart chat-recall-api`',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
