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

export interface Capabilities {
  mode: 'local' | 'server';
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
