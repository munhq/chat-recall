/**
 * Team toolkit sync — HTTP client.
 *
 * Talks to the team-server over JSON. Resolves config from `settings.team.*`
 * and the bearer token from the env var named in `team.tokenRef` (the
 * token itself is never persisted to disk).
 *
 * The team-server endpoint contracts mirror this module; if the server
 * shape ever drifts, fix one side and update the other in lockstep —
 * compile errors here are the canary.
 */

import { loadSettings, saveSettings, type TeamSettings } from './settings.js';

export type TeamArtifactType =
  | 'skill' | 'command' | 'agent' | 'mcp' | 'plan'
  | 'hook' | 'plugin' | 'instructions';

export type TeamArtifactTool = 'claude' | 'gemini' | 'opencode' | 'codex' | 'agy' | 'cursor' | 'cross_tool';

export interface TeamArtifactMeta {
  id: string;
  type: TeamArtifactType;
  tool: TeamArtifactTool;
  name: string;
  version: number;
  authorId: string;
  sha256: string;
  pinnedTo: string | null;
  updatedAt: number;
  bytes: number;
}

export interface TeamArtifactBody extends TeamArtifactMeta {
  /** Body is base64 — markdown/JSON/binary all carried uniformly. */
  bodyB64: string;
}

export interface TeamPullResult {
  pulled: TeamArtifactBody[];
  removed: string[];   // artifact ids revoked since `since`
  serverNow: number;
}

export interface TeamMembership { teamId: string; teamName: string; role: 'owner' | 'member'; plan: string }
export interface TeamMe { user: { id: string; email: string }; memberships: TeamMembership[] }

// ── Errors ──────────────────────────────────────────────────────────

export class TeamConfigError extends Error {}
export class TeamAuthError   extends Error { constructor(msg: string, public readonly status?: number) { super(msg); } }
export class TeamHttpError   extends Error { constructor(msg: string, public readonly status: number, public readonly body?: unknown) { super(msg); } }

// ── Context ─────────────────────────────────────────────────────────

interface Ctx { serverUrl: string; token: string; handle: string; teamId?: string }

/**
 * Resolve the env-var-held bearer + the configured server URL. Throws
 * a typed error with a helpful hint if either is missing — surfaces
 * cleanly through the CLI.
 */
function context(opts: { requireTeam?: boolean } = {}): Ctx {
  const t = loadSettings().team;
  if (!t.enabled)        throw new TeamConfigError('Team sync is disabled. Enable in Settings → Team or via `chat-recall team join`.');
  if (!t.serverUrl)      throw new TeamConfigError('No team server URL set. Settings → Team → Server URL.');
  if (!t.tokenRef)       throw new TeamConfigError('No token env var configured. Settings → Team → Token env var.');
  const token = process.env[t.tokenRef];
  if (!token)            throw new TeamConfigError(`Env var ${t.tokenRef} is not set. Export your team token first.`);
  if (opts.requireTeam && !t.teamId) throw new TeamConfigError('Not joined to a team. Run `chat-recall team join <invite-token>`.');
  return { serverUrl: t.serverUrl, token, handle: t.memberHandle ?? '', teamId: t.teamId };
}

async function http<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const url = ctx.serverUrl.replace(/\/+$/, '') + path;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${ctx.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }

  if (r.status === 401 || r.status === 403) {
    const msg = (parsed as any)?.detail ?? (parsed as any)?.error ?? r.statusText;
    throw new TeamAuthError(`${r.status} ${msg}`, r.status);
  }
  if (!r.ok) {
    const msg = (parsed as any)?.error ?? r.statusText;
    throw new TeamHttpError(`${method} ${path}: ${r.status} ${msg}`, r.status, parsed);
  }
  return parsed as T;
}

// ── Public API ──────────────────────────────────────────────────────

export async function teamMe(): Promise<TeamMe> {
  return http<TeamMe>(context(), 'GET', '/api/team/me');
}

/**
 * Create a new team. Caller becomes owner. Saves teamId + memberHandle
 * locally so subsequent calls know which team to operate on.
 */
export async function teamCreate(name: string): Promise<{ id: string; name: string }> {
  const ctx = context();
  const r = await http<{ team: { id: string; name: string } }>(ctx, 'POST', '/api/team', { name });
  await persistTeamId(r.team.id);
  return r.team;
}

/** Owner-only. Returns a single-use invite token; show it to the user once. */
export async function teamInvite(emailHint?: string): Promise<{ inviteToken: string; expiresAt: string }> {
  const ctx = context({ requireTeam: true });
  return http(ctx, 'POST', `/api/team/${ctx.teamId}/invite`, { emailHint });
}

/**
 * Redeem an invite token. The bearer in `team.tokenRef` already
 * identifies the redeeming user (via Keycloak); we just attach them as
 * a member of the inviting team. Saves teamId locally on success.
 */
export async function teamJoin(inviteToken: string): Promise<{ id: string; name: string }> {
  const ctx = context();
  const r = await http<{ team: { id: string; name: string } }>(ctx, 'POST', '/api/team/join', { inviteToken });
  await persistTeamId(r.team.id);
  return r.team;
}

// ── Per-device install ledger (server-side) ─────────────────────────────────
// Was a better-sqlite3 file at ~/.chat-recall/team-installs.db — the only local
// database this feature owned, and half the reason the CLI needed a native
// module at boot. It lives in Postgres now, device-scoped.
//
// It records (artifactId, tool, type, name, sha256) and DELIBERATELY NOT the
// install path: the path is recomputed locally by installPathFor(), so no
// absolute filesystem path leaves the machine. See routes/ledgers.ts.

export interface TeamInstallRow {
  artifactId: string;
  tool: string;
  artifactType: TeamArtifactType;
  artifactName: string;
  sha256: string;
  installedAt: number;
}

/**
 * A server older than the ledger endpoints answers 404. Treat that as "no ledger
 * here" rather than an error: the CLI updates itself FROM the server, but an npm
 * install can reach a server that has not rolled yet, and `team pull` must still
 * write files on a machine whose server is a version behind. Losing the ledger
 * costs an unchanged-file rewrite, never correctness — the merge compares the
 * bytes on disk before writing.
 */
function isMissingEndpoint(err: unknown): boolean {
  return err instanceof TeamHttpError && err.status === 404;
}

/** Rows this device recorded — all of them, or just one artifact's. */
export async function teamInstallsList(artifactId?: string): Promise<TeamInstallRow[]> {
  const ctx = context();
  const qs = artifactId ? `?artifactId=${encodeURIComponent(artifactId)}` : '';
  try {
    const r = await http<{ installs: TeamInstallRow[] }>(ctx, 'GET', `/api/ledgers/team-installs${qs}`);
    return r.installs ?? [];
  } catch (err) {
    if (isMissingEndpoint(err)) return [];
    throw err;
  }
}

/** Record what this device just wrote. Batched — one call per merge, not per file. */
export async function teamInstallsRecord(installs: TeamInstallRow[]): Promise<void> {
  if (!installs.length) return;
  const ctx = context();
  try {
    await http(ctx, 'POST', '/api/ledgers/team-installs', { installs });
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
  }
}

/** Forget an artifact on this device (after its files are deleted). */
export async function teamInstallsForget(artifactId: string, tool?: string): Promise<void> {
  const ctx = context();
  try {
    await http(ctx, 'DELETE', '/api/ledgers/team-installs', { artifactId, tool });
  } catch (err) {
    if (!isMissingEndpoint(err)) throw err;
  }
}

export async function teamList(): Promise<TeamArtifactMeta[]> {
  const ctx = context({ requireTeam: true });
  const r = await http<{ artifacts: TeamArtifactMeta[] }>(ctx, 'GET', `/api/team/${ctx.teamId}/list`);
  return r.artifacts;
}

export async function teamPull(since?: number, limit?: number): Promise<TeamPullResult> {
  const ctx = context({ requireTeam: true });
  const sinceMs = since ?? loadSettings().team.lastPullAt ?? 0;
  const qs = new URLSearchParams();
  qs.set('since', String(sinceMs));
  if (limit) qs.set('limit', String(limit));
  const r = await http<TeamPullResult>(ctx, 'GET', `/api/team/${ctx.teamId}/pull?${qs.toString()}`);
  await persistLastPull(r.serverNow);
  return r;
}

export async function teamPublish(args: {
  type: TeamArtifactType;
  tool: TeamArtifactTool;
  name: string;
  body: Buffer | Uint8Array | string;  // string = utf-8 body
  pinnedTo?: string;
}): Promise<{ id: string; version: number; sha256: string; updatedAt: number }> {
  const ctx = context({ requireTeam: true });
  const buf = typeof args.body === 'string'
    ? Buffer.from(args.body, 'utf-8')
    : Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body);
  const bodyB64 = buf.toString('base64');
  const r = await http<{ artifact: { id: string; version: number; sha256: string; updated_at: string } }>(
    ctx, 'POST', `/api/team/${ctx.teamId}/publish`,
    { type: args.type, tool: args.tool, name: args.name, bodyB64, pinnedTo: args.pinnedTo },
  );
  return {
    id: r.artifact.id,
    version: r.artifact.version,
    sha256: r.artifact.sha256,
    updatedAt: new Date(r.artifact.updated_at).getTime(),
  };
}

export async function teamRevoke(artifactId: string): Promise<{ id: string; type: string; name: string }> {
  const ctx = context({ requireTeam: true });
  const r = await http<{ revoked: { id: string; type: string; name: string } }>(
    ctx, 'DELETE', `/api/team/${ctx.teamId}/artifacts/${artifactId}`,
  );
  return r.revoked;
}

/** Clears the local team config (token/server stay). Server-side leave is best-effort. */
export async function teamLeave(): Promise<void> {
  const t = loadSettings().team;
  const next: TeamSettings = { ...t, teamId: undefined, lastPullAt: undefined };
  saveSettings({ ...loadSettings(), team: next });
}

// ── Settings persistence ────────────────────────────────────────────

async function persistTeamId(teamId: string): Promise<void> {
  const s = loadSettings();
  s.team = { ...s.team, teamId };
  saveSettings(s);
}

async function persistLastPull(when: number): Promise<void> {
  const s = loadSettings();
  s.team = { ...s.team, lastPullAt: when };
  saveSettings(s);
}
