/**
 * Whether the transcript on this machine holds messages the server does not.
 *
 * recall_show reads the server. When the sync of a session is behind, its
 * newest messages are missing from every window, and an agent that does not
 * know that concludes they never happened. One session was synced to 20:18
 * while its transcript ran to 07:52 the next morning; the agent then read the
 * whole raw file to find the rest.
 *
 * Messages are compared by timestamp. Line numbers change when a compacted
 * session is stitched, and message counts change between parser versions,
 * but a message's timestamp is the same on both sides.
 */
import { getBackendForId } from '../core/tool-backend.js';
import { parseTranscript } from '../transcript/index.js';

export interface LocalTranscript {
  /** mtime of the local transcript in epoch ms, or null when this machine does not have it. */
  mtime(): number | null;
  /** The local transcript's messages. Called only when the file changed after the server's newest message. */
  messages(): Promise<Array<{ timestamp?: string }> | null>;
}

/** The newest message timestamp in epoch ms, or 0 when none has one. */
export function newestTimestamp(messages: Array<{ timestamp?: string }>): number {
  let newest = 0;
  for (const m of messages) {
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/**
 * How many local messages are newer than the server's newest message. 0 when
 * the server is current, null when there is nothing to compare: the session is
 * not on this machine, or the server's messages carry no timestamps.
 */
export async function unsyncedLocalMessages(
  serverMessages: Array<{ timestamp?: string }>,
  local: LocalTranscript,
): Promise<number | null> {
  const serverNewest = newestTimestamp(serverMessages);
  if (!serverNewest) return null;
  const mtime = local.mtime();
  if (mtime === null) return null;
  // Claude Code writes a message and its timestamp together, so a file last
  // written before the server's newest message cannot hold a newer one.
  if (mtime <= serverNewest) return 0;
  const messages = await local.messages();
  if (!messages) return null;
  let newer = 0;
  for (const m of messages) {
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (Number.isFinite(t) && t > serverNewest) newer++;
  }
  return newer;
}

/** The transcript of `sessionId` on this machine, through its tool's backend. */
export function localTranscript(sessionId: string): LocalTranscript {
  return {
    mtime() {
      try {
        const backend = getBackendForId(sessionId);
        const loc = backend?.findSession(backend.toRawId(sessionId));
        return loc ? loc.mtime : null;
      } catch {
        return null;
      }
    },
    async messages() {
      try {
        return (await parseTranscript(sessionId))?.messages ?? null;
      } catch {
        return null;
      }
    },
  };
}
