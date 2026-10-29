/**
 * The one server that recall reads from and writes to.
 *
 * The MCP tools and the message hook both resolve it here. They must agree: a
 * message the MCP tool sends to one server is received by a hook that polls
 * that same server, or by nobody.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envCredentials } from './credentials-env.js';
import { getDataDir } from './data-dir.js';

export function recallTarget(): { base: string; token: string } | null {
  // A container has no credentials file and cannot run a login, so an explicit
  // CHAT_RECALL_TOKEN outranks the disk. This is what lets Glama and the Docker
  // MCP catalog run this server at all.
  const fromEnv = envCredentials();
  if (fromEnv) return { base: fromEnv.serverUrl, token: fromEnv.token };

  try {
    const raw = readFileSync(join(getDataDir(), 'credentials.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      targets?: Array<{ serverUrl?: string; token?: string }>;
      primary?: string;
      serverUrl?: string; token?: string;
    };
    // Multi-target format ({targets:[...]}). Recall READS from one server, and
    // the default is the REMOTE (SaaS) one. A localhost/dev login must never
    // hijack recall — that pointed reads at an empty dev instance while the
    // real data lived on the cloud. Resolution order:
    //   1. CHAT_RECALL_SERVER env  — explicit override
    //   2. configured `primary`    — set by init/login/`chat-recall use`
    //   3. the first remote (non-localhost) target  — SaaS by default
    //   4. the first target        — pure self-host (localhost is the only login)
    if (Array.isArray(parsed.targets) && parsed.targets.length) {
      const valid = parsed.targets.filter((t) => t?.serverUrl);
      if (!valid.length) return null;
      const norm = (u: string) => u.replace(/\/+$/, '');
      const isLocal = (u: string) => /\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/.test(u);
      const byUrl = (u?: string) => u ? valid.find((t) => norm(t.serverUrl!) === norm(u)) : undefined;
      const remotes = valid.filter((t) => !isLocal(t.serverUrl!));
      const pick =
        byUrl(process.env.CHAT_RECALL_SERVER) ??
        byUrl(parsed.primary) ??
        remotes[0] ??
        valid[0];
      return pick?.serverUrl ? { base: norm(pick.serverUrl), token: pick.token || '' } : null;
    }
    // Legacy single-target format. Empty token is valid (tokenless self-host).
    if (parsed.serverUrl) return { base: parsed.serverUrl.replace(/\/+$/, ''), token: parsed.token || '' };
    return null;
  } catch { return null; }
}
