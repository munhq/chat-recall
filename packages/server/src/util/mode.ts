/**
 * Server run-mode + edition flags.
 *
 * MODE (CHAT_RECALL_SERVER_MODE):
 *   local  (default) — dev dashboard on the user's own machine. Full access
 *                      to ~/.claude etc.; FS walks, live scans, git, toolkit
 *                      writes and settings editing all allowed.
 *   server           — store-only deployment (self-host compose / SaaS).
 *                      Data arrives exclusively via /api/sync; everything
 *                      that touches the local filesystem is disabled.
 *
 * EDITION (CHAT_RECALL_EDITION): selfhost (default) | cloud. Gates the
 * paid surface (teams UI, alerting later); the BSL license rides along in
 * either case. Capabilities are reported to the client so it can hide
 * unsupported tabs instead of rendering dead panels.
 */
import type { Request, Response, NextFunction } from 'express';

export function isServerMode(): boolean {
  return (process.env.CHAT_RECALL_SERVER_MODE || 'local').toLowerCase() === 'server';
}

export function edition(): 'selfhost' | 'cloud' {
  return (process.env.CHAT_RECALL_EDITION || 'selfhost').toLowerCase() === 'cloud' ? 'cloud' : 'selfhost';
}

/**
 * Wire-contract version between sync client and server. Bump when the
 * ingest contract changes such that an old server would SILENTLY mishandle
 * a new client's payload (the failure mode this exists to kill: v6
 * envelopes ignored by a v5 server produced metadata-only ghost rows).
 *   2 — raw containers + canonical envelopes + project_id passthrough
 */
export const API_VERSION = 2;

/**
 * Generation of the recall read/write HTTP surface (KG, KV, diary, conversation
 * views, etc.) that the thin-collector MCP queries. Independent of API_VERSION
 * (the sync/ingest contract): bump when adding recall endpoints the MCP relies
 * on, so an MCP hitting an older server can say "update your server (needs
 * recall API ≥ N)" instead of surfacing a raw 404.
 *   1 — /api/kg/*, /api/kv/*, /api/diary/*, /api/memory/wake-up
 */
export const RECALL_API_VERSION = 1;

export interface Capabilities {
  mode: 'local' | 'server';
  apiVersion: number;
  /** Generation of the recall HTTP surface the thin-collector MCP consumes. */
  recallApi: number;
  edition: 'selfhost' | 'cloud';
  /** Per-feature switches the client consumes to show/hide views. */
  features: {
    conversations: boolean;
    search: boolean;
    memory: boolean;
    analytics: boolean;
    security: boolean;
    /** FS-backed extras: live edits timeline, diff/outcome/commits tabs, toolkit, settings editor, projects config. */
    activity: boolean;
    sessionDeepDive: boolean;
    toolkit: boolean;
    settings: boolean;
    projects: boolean;
    teams: boolean;
  };
}

export function capabilities(): Capabilities {
  const server = isServerMode();
  const ed = edition();
  // Security stays on in both editions for now — flipping it off for free
  // self-host is a one-line config decision, deliberately not hardcoded.
  const securityEnabled = (process.env.CHAT_RECALL_FEATURE_SECURITY ?? '1') !== '0';
  return {
    mode: server ? 'server' : 'local',
    apiVersion: API_VERSION,
    recallApi: RECALL_API_VERSION,
    edition: ed,
    features: {
      conversations: true,
      search: true,
      memory: true,
      analytics: true,
      security: securityEnabled,
      // Served from synced store rows in server mode (sync ships items for
      // every source type + derived compute rows), so these stay on. Only
      // toolkit writes and settings editing remain local-only (they mutate
      // the local filesystem).
      activity: true,
      sessionDeepDive: true,
      projects: true,
      toolkit: !server,
      settings: !server,
      // Edition hint only: "the teams feature exists in this build". This is
      // PRE-AUTH (capabilities() runs before any tenant is resolved), so it
      // CANNOT reflect whether a given tenant has paid. Per-tenant enforcement
      // lives in requireEntitlement / entitledOr402 (util/billing.ts), applied
      // to the paid write paths (team publish + invite).
      teams: ed === 'cloud',
    },
  };
}

/** Guard for FS-dependent endpoints: 501 in server mode with a clear reason. */
export function requireLocalMode(req: Request, res: Response, next: NextFunction): void {
  if (isServerMode()) {
    res.status(501).json({
      error: 'not available in server mode',
      detail: 'This endpoint reads the local filesystem; in a server deployment data arrives via /api/sync only.',
    });
    return;
  }
  next();
}
