/**
 * Fast extractor for the first human-typed prompt in a Claude Code session.
 *
 * Streams the .jsonl line-by-line and stops at the first qualifying user
 * message — orders of magnitude cheaper than `parseSessionFile`, which does
 * the full pass over every turn. Used by `getRecentSessions` to avoid
 * showing "(no prompt captured)" when sessions-index.json isn't present.
 */

import { createReadStream, existsSync, openSync, readSync, closeSync } from 'fs';
import { createInterface } from 'readline';
import { StringDecoder } from 'string_decoder';
import { flatString } from './flat-string.js';

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
 * Decide whether one transcript line carries the first human prompt.
 *
 * Extracted so the streaming and the bounded-read variants below cannot drift:
 * they had two copies of these six filters, and a rule fixed in one would have
 * silently not applied to the other.
 *
 * Returns the cleaned prompt, or null to keep looking.
 */
function promptFromLine(raw: string, maxLength: number): string | null {
  if (!raw.trim()) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== 'user') return null;
  // Sidechain prompts are agent-injected, not human-typed.
  if (obj.isSidechain === true) return null;

  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return null;

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

  if (!text) return null;
  if (text.includes('<system-reminder>')) return null;
  // Tool-result envelopes appear as user messages with content blocks of type
  // 'tool_result' — already filtered above, but the synthetic
  // "[Request interrupted by user]" placeholder is plain text, drop it.
  if (text.trim() === '[Request interrupted by user]') return null;

  const cleaned = stripBanners(text);
  if (cleaned.length < 10) return null;
  // flatString: the preview is cut from a message that can be megabytes, and a
  // V8 slice would keep all of it alive inside every SessionRef.
  return flatString(cleaned.slice(0, maxLength));
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
      if (lineNo > maxLines) { finish(''); return; }
      const found = promptFromLine(raw, maxLength);
      if (found !== null) finish(found);
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
  options: { maxLines?: number; maxLength?: number; maxBytes?: number } = {}
): string {
  const maxLines = options.maxLines ?? 500;
  const maxLength = options.maxLength ?? 1000;
  // Hard ceiling on how far in we are willing to look. The first human prompt is
  // in the first few lines of a well-formed transcript; a file where it is not
  // is malformed, and scanning 36 MB to prove that is not worth it.
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;

  let fd: number;
  try { fd = openSync(filePath, 'r'); } catch { return ''; }

  try {
    // READ ONLY AS FAR AS NEEDED.
    //
    // This used to be readFileSync of the entire file, and listSessions() calls
    // it once per session with no mtime filter (the ledger drives skipping, so
    // sinceMs is undefined and the cutoff is 0). On this developer's machine
    // that was 13,766 files and 4.3 GB read from disk per walk, per sync target,
    // every 15 minutes — to keep a 200-character preview and throw away the
    // rest. Measured: 33 GB of logical reads in 50 minutes of daemon uptime.
    //
    // Chunked reading stops at the first qualifying line, so the common case
    // costs one 64 KB read instead of the whole transcript.
    const CHUNK = 64 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    // A chunk boundary can fall inside a multi-byte UTF-8 sequence; the decoder
    // holds the partial bytes back until the next chunk completes them.
    const decoder = new StringDecoder('utf-8');
    let carry = '';
    let pos = 0;
    let lineNo = 0;

    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      carry += decoder.write(buf.subarray(0, n));

      const parts = carry.split('\n');
      // The last element is an incomplete line unless the chunk ended exactly on
      // a newline, in which case it is ''. Either way it carries to the next read.
      carry = parts.pop() ?? '';

      for (const line of parts) {
        if (++lineNo > maxLines) return '';
        const found = promptFromLine(line, maxLength);
        if (found !== null) return found;
      }

      if (pos >= maxBytes) return '';
    }

    // A final line with no trailing newline.
    carry += decoder.end();
    if (carry && lineNo < maxLines) {
      const found = promptFromLine(carry, maxLength);
      if (found !== null) return found;
    }
    return '';
  } finally {
    try { closeSync(fd); } catch { /* already gone */ }
  }
}
