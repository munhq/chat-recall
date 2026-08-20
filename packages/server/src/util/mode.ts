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
 * paid surface (teams UI, alerting later); the Elastic License 2.0 rides along in
 * either case. Capabilities are reported to the client so it can hide
 * unsupported tabs instead of rendering dead panels.
 */
import type { Request, Response, NextFunction } from 'express';
import { queryExpansionEnabled } from '../services/query-expander.js';
import { hasFeature, licensedSeats, licenseState } from './license.js';

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
    /** LLM query expansion is active — keyword search is meaning-aware. Lets
     *  the client honestly signal "semantic-ish" search without embeddings. */
    queryExpansion: boolean;
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
    account: boolean;
    /** Code intelligence (codeindex merge): the Code dashboard + findings/hotspots/actions. */
    codeIntel: boolean;
  };
  /**
   * Self-host licence state, so the UI can explain why `features.teams` is off
   * instead of silently hiding it. null on cloud, where a subscription decides.
   * Deliberately carries no key material and no holder name.
   */
  license: {
    team: boolean;
    /** Licensed seats, null for unlimited. */
    seats: number | null;
    state: 'valid' | 'absent' | 'malformed' | 'bad_signature' | 'expired';
  } | null;
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
      queryExpansion: queryExpansionEnabled(),
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
      // Toolkit READS (browse/matrix/status) come from synced store rows, so
      // the tab renders in both modes. Its fs-mutating routes self-guard with
      // requireLocalMode; cross-tool copy on a remote server runs via the
      // local CLI agent draining /api/sync-intents. Settings editing genuinely
      // writes the local fs, so it stays local-only.
      toolkit: true,
      settings: !server,
      // "The teams feature is available in this deployment." Still PRE-AUTH, so
      // it cannot reflect whether a given TENANT has paid — per-tenant
      // enforcement stays in requireEntitlement / entitledOr402 (util/billing.ts)
      // on the paid write paths.
      //
      // It does reflect the DEPLOYMENT's team licence, which it must: this flag
      // is what App.tsx uses to render the Team surface at all, so a self-hoster
      // who bought a licence would otherwise pay and still see nothing.
      teams: ed === 'cloud' || hasFeature('team'),
      // Cloud-only account/billing surface (subscription, secret-alert webhook,
      // device tokens). Self-host has no billing, so no account view.
      account: ed === 'cloud',
      // Code intelligence: store-backed in both modes (the local CLI ships
      // collector output via /api/code/index), so the Code tab renders on the
      // hosted SaaS and self-host alike. Opt-out via CHAT_RECALL_FEATURE_CODE=0.
      codeIntel: (process.env.CHAT_RECALL_FEATURE_CODE ?? '1') !== '0',
    },
    // Why teams is off, so a self-host UI can say "available with a licence"
    // rather than hiding the feature and leaving the operator guessing whether
    // it exists. Never includes the key itself or the holder.
    license: ed === 'cloud' ? null : (() => {
      const st = licenseState();
      return { team: hasFeature('team'), seats: licensedSeats(),
               state: st.valid ? 'valid' as const : st.reason };
    })(),
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
