/**
 * The chat-recall data directory, with no other import.
 *
 * paths.ts re-exports this. The message hook runs on every prompt and tool
 * call, so it reads its credentials through this module and does not load the
 * logger that paths.ts needs for its migration.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root data directory. Respects $CHAT_RECALL_DATA_DIR; defaults to ~/.chat-recall. */
export function getDataDir(): string {
  const override = process.env.CHAT_RECALL_DATA_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.chat-recall');
}
