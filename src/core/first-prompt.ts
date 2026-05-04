/**
 * Fast extractor for the first human-typed prompt in a Claude Code session.
 *
 * Streams the .jsonl line-by-line and stops at the first qualifying user
 * message — orders of magnitude cheaper than `parseSessionFile`, which does
 * the full pass over every turn. Used by `getRecentSessions` to avoid
 * showing "(no prompt captured)" when sessions-index.json isn't present.
 */

import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

const BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];

function stripBanners(s: string): string {
  let out = s;
  for (const re of BANNERS) out = out.replace(re, ' ');
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Read a Claude Code session .jsonl and return the first real user prompt.
 *
 * Skips: system reminders, sidechain task injections, tool-result envelopes,
 * messages shorter than 10 chars after banner stripping. Returns '' if none
 * found within `maxLines` (default 500 — first prompt is usually in the first
 * few lines, but some sessions begin with system_init / hook events).
 */
export function extractFirstUserPrompt(
  filePath: string,
  options: { maxLines?: number; maxLength?: number } = {}
): Promise<string> {
  const maxLines = options.maxLines ?? 500;
  const maxLength = options.maxLength ?? 1000;

  return new Promise((resolve) => {
    if (!existsSync(filePath)) {
      resolve('');
      return;
    }

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    let lineNo = 0;
    let resolved = false;
    const finish = (val: string) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(val);
    };

    rl.on('line', (raw) => {
      lineNo++;
      if (lineNo > maxLines) {
        finish('');
        return;
      }
      if (!raw.trim()) return;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }
      if (obj.type !== 'user') return;

      // Sidechain prompts are agent-injected, not human-typed.
      if (obj.isSidechain === true) return;

      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) return;

      const content = message.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (
            block && typeof block === 'object' &&
            (block as Record<string, unknown>).type === 'text' &&
            typeof (block as Record<string, unknown>).text === 'string'
          ) {
            parts.push((block as Record<string, unknown>).text as string);
          }
        }
        text = parts.join('\n');
      }

      if (!text) return;
      if (text.includes('<system-reminder>')) return;
      // Tool-result envelopes appear as user messages with content blocks of
      // type 'tool_result' — already filtered above, but the synthetic
      // "[Request interrupted by user]" placeholder is plain text, drop it.
      if (text.trim() === '[Request interrupted by user]') return;

      const cleaned = stripBanners(text);
      if (cleaned.length < 10) return;

      finish(cleaned.slice(0, maxLength));
    });

    rl.on('close', () => finish(''));
    rl.on('error', () => finish(''));
  });
}

/**
 * Synchronous variant — reads the whole file into memory but stops parsing
 * once the first prompt is found. Use when you can't await (legacy callers).
 */
export function extractFirstUserPromptSync(
  filePath: string,
  options: { maxLines?: number; maxLength?: number } = {}
): string {
  const maxLines = options.maxLines ?? 500;
  const maxLength = options.maxLength ?? 1000;

  if (!existsSync(filePath)) return '';

  let raw: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    raw = require('fs').readFileSync(filePath, 'utf-8') as string;
  } catch {
    return '';
  }

  const lines = raw.split('\n');
  const upTo = Math.min(lines.length, maxLines);

  for (let i = 0; i < upTo; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== 'user') continue;
    if (obj.isSidechain === true) continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const content = message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (
          block && typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
      text = parts.join('\n');
    }

    if (!text) continue;
    if (text.includes('<system-reminder>')) continue;
    if (text.trim() === '[Request interrupted by user]') continue;

    const cleaned = stripBanners(text);
    if (cleaned.length < 10) continue;

    return cleaned.slice(0, maxLength);
  }

  return '';
}
