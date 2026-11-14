import { getBackendForId } from '@chat-recall/engine/core/tool-backend.js';
import type { SessionProbe } from './tombstone-rule.js';

/**
 * Ask the backend that owns `id` whether the source of the session exists.
 * A backend that is not available (its folder or database is not there) or that
 * throws gives `unknown`, so a missing mount never reads as a deletion.
 */
export function probeSessionSource(id: string): SessionProbe {
  const backend = getBackendForId(id);
  if (!backend || !backend.isAvailable()) return 'unknown';
  try {
    return backend.findSession(id) ? 'present' : 'missing';
  } catch {
    return 'unknown';
  }
}
