/**
 * Write-Ahead Log (WAL) for auditing MCP write operations.
 *
 * Every write operation (index, add, delete, kg_add, etc.) is logged to
 * a JSONL file before execution. Enables:
 * - Audit trail for detecting memory poisoning
 * - Review/rollback of writes from external or untrusted sources
 * - Debugging write failures
 */

import { existsSync, mkdirSync, appendFileSync, openSync, closeSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { getWalDir } from './paths.js';

export interface WALEntry {
  timestamp: string;
  operation: string;
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
}

// Keys whose values should be redacted in WAL entries
const REDACT_KEYS = new Set([
  'content', 'text', 'content_preview', 'entry',
  'api_key', 'token', 'password', 'secret',
]);

const MAX_PREVIEW_LENGTH = 200;

export class WriteAheadLog {
  private readonly walPath: string;

  constructor(walDir?: string) {
    const dir = walDir || getWalDir();

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try { chmodSync(dir, 0o700); } catch { /* best effort */ }
    }

    this.walPath = join(dir, 'write_log.jsonl');

    // Pre-create with restricted permissions
    if (!existsSync(this.walPath)) {
      const fd = openSync(this.walPath, 'w', 0o600);
      closeSync(fd);
    }
  }

  /**
   * Log a write operation. Call BEFORE executing the operation.
   */
  log(operation: string, params: Record<string, unknown>, result?: Record<string, unknown>): void {
    const safeParams = this.redactSensitive(params);
    const safeResult = result ? this.redactSensitive(result) : undefined;

    const entry: WALEntry = {
      timestamp: new Date().toISOString(),
      operation,
      params: safeParams,
      ...(safeResult && { result: safeResult }),
    };

    try {
      appendFileSync(this.walPath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
    } catch (err) {
      // WAL write failure is non-fatal — log to stderr
      process.stderr.write(`WAL write failed: ${err}\n`);
    }
  }

  /**
   * Log with result — call AFTER the operation succeeds.
   */
  logWithResult(operation: string, params: Record<string, unknown>, result: Record<string, unknown>): void {
    this.log(operation, params, result);
  }

  private redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (REDACT_KEYS.has(key)) {
        if (typeof value === 'string') {
          safe[key] = value.length <= MAX_PREVIEW_LENGTH
            ? value
            : `[${value.length} chars] ${value.slice(0, MAX_PREVIEW_LENGTH)}...`;
        } else {
          safe[key] = '[REDACTED]';
        }
      } else {
        safe[key] = value;
      }
    }

    return safe;
  }
}

// Singleton for convenience
let _instance: WriteAheadLog | null = null;

export function getWAL(): WriteAheadLog {
  if (!_instance) {
    _instance = new WriteAheadLog();
  }
  return _instance;
}
