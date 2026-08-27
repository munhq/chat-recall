/**
 * The one sync client (thin collector): walk local sessions AND every other
 * memory source, computing EVERYTHING live from the raw session files —
 * reading NOTHING from the local SQLite store. Redact secrets (ALWAYS —
 * `force:true`, never gated on the index-time toggle), optionally hash
 * project paths, and push to the server's `/api/sync`
 * (packages/server/src/routes/sync.ts). Credentials live in a 0600 file,
 * never in settings.json.
 *
 * Thin-collector contract: the collector owns NO derived state. It reads the
 * raw transcripts (which it must read anyway to ship them) and derives
 * telemetry, project ids, KG triples, diffs, outcomes, commits and markers on
 * the spot. The server is the source of truth for everything stateful
 * (tombstones, summaries, secret findings/rules/dismissals) — the collector
 * neither reads nor writes those locally.
 *
 * What ships (all live-computed from the session files):
 *   conversations — per-turn redacted session transcripts + live telemetry meta
 *   items/links   — every non-session source type (plan, task, claude_md,
 *                   history, paste, diary, skill, mcp, command, agent,
 *                   hook, plugin) with redacted chunks + relationships
 *   derived       — compute rows (diff/outcome/commits/markers) computed live
 *                   + outcome-badge row             (toggle: upload.sessionMeta)
 *   kg            — knowledge-graph entities/triples extracted live from the
 *                   redacted text                   (toggle: upload.sessionMeta)
 *
 * What does NOT ship, by design: the full-conversation JSON blob
 * (content_cache) and embeddings. The server reconstructs the conversation
 * view from the per-turn chunks. Tombstones, AI summaries, and secret
 * findings/dismissals/custom-rules are NOT shipped by the collector — the
 * server owns them.
 */
import { join, dirname, basename } from 'node:path';
import { envCredentials } from '@chat-recall/engine/core/credentials-env.js';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { redactSecrets, scanTextForFindings, installServerRulePack, serverRulePackVersion } from '@chat-recall/engine/core/secret-redactor.js';
import { discoverSessionSources, installSourceExclusions, sourceId } from '@chat-recall/engine/core/source-discovery.js';
import { discoverHomes } from '@chat-recall/engine/core/home-discovery.js';
import { homeDecision, approveHome, declineHome, grandfatherLegacyHomes } from '@chat-recall/engine/core/home-approval.js';
import { scanFileForSecrets, scanDirForSecrets, scanTenantRules, isSecretScannerAvailable, type ScanFinding, type DirScanFinding } from '@chat-recall/engine/core/secret-scanner.js';
import { isInternalToolPrompt } from '@chat-recall/engine/core/internal-prompts.js';
import { dropFuzzyFindings } from '@chat-recall/engine/core/secret-precision.js';
import { loadSettings, saveSettings, isProjectSyncable } from '@chat-recall/engine/core/settings.js';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { listAvailableBackends } from '@chat-recall/engine/core/tool-backend.js';
import { extractTurnsAny, replaySessionAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { parseTranscript, trimTranscriptForSync, TRANSCRIPT_VERSION, gzipContainer, mapContainerText, buildRawContainer, containerSrcHash, parseTranscriptFromContainer, updateShadow, type RawContainer } from '@chat-recall/engine/transcript/index.js';
import { parseClaudeTranscriptText } from '@chat-recall/engine/transcript/claude.js';
import { parseGeminiTranscriptText } from '@chat-recall/engine/transcript/gemini.js';
import { parseCodexTranscriptText } from '@chat-recall/engine/transcript/codex.js';
import { getBackendForId, getBackend, type SessionRef } from '@chat-recall/engine/core/tool-backend.js';
import { computeOutcome } from '@chat-recall/engine/core/session-outcome.js';
import { fileURLToPath } from 'node:url';

let ownVersion = '0.0.0';
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  ownVersion = (JSON.parse(readFileSync(join(dir, '../package.json'), 'utf-8')) as { version?: string }).version || ownVersion;
} catch {
  try {
    // @ts-ignore
    if (typeof __CLI_VERSION__ === 'string') ownVersion = __CLI_VERSION__;
  } catch {}
}
import { markPrompt, summarizeMarkers } from '@chat-recall/engine/core/session-sentiment.js';
import { parseSessionFile, readCwdFromJsonl } from '@chat-recall/engine/parsers/session.js';
import { resolveProjectId } from '@chat-recall/engine/core/project-resolver.js';
import { projectPathIncludes } from '@chat-recall/engine/core/project-path-match.js';
import { extractEntities } from '@chat-recall/engine/core/entity-extractor.js';
import { buildSourceRegistry } from '@chat-recall/engine/parsers/all-sources.js';
import { getSyncedRows, markSynced, getLedgerData, persistLedgerData,
  fieldNeedsScan, markFieldCoverage, fieldNeedsFullPass, markFieldFullPassDone,
  syncMode, markFullResync, loadItemVersions, saveItemVersions, flushLedger, pruneLedgerTargets, type SyncedRow } from './sync-ledger.js';
import { extractorVersionForTool, extractorVersionForId, extractorVersionForItem, toolOfId, EXTRACTOR_VERSION } from '@chat-recall/engine/core/extractor-version.js';
import { SYNC_FIELDS } from '@chat-recall/engine/core/sync-fields.js';
import { acquireIndexLock } from '@chat-recall/engine/core/index-lock.js';
import { fetchWithTimeout } from './http.js';
import { gzipSync } from 'zlib';
import { redactDeep } from './redact-deep.js';
import { collectDerivedRows } from './derived.js';
import { scanPool } from './scan-pool.js';
import { isPrivateHost, transportRisk, assertTransportSafe } from './transport-safety.js';
import { breakerState, breakerNotice, noteTargetSuccess, noteTargetFailure } from './target-breaker.js';
import { setTelemetryEligible } from './telemetry-consent.js';
import { record, flush } from './telemetry.js';

/**
 * The server rule pack as it arrived, kept for the scan workers.
 *
 * Workers run in their own isolate with their own copy of the redactor, so they
 * need the patterns as data. The installed form is compiled RegExp objects,
 * which cannot cross a postMessage.
 */
/**
 * Walk progress for the next upload to carry.
 *
 * Module-scope because the producer (the walk) and the consumer (the batch
 * poster) are far apart, and threading it through every batcher signature to
 * deliver a cosmetic field would be worse than a single slot.
 */
/**
 * Reduce an error message to a bounded CLASS.
 *
 * Telemetry must never carry a raw error string: server errors quote paths,
 * payload fragments and occasionally tokens. An enum is enough to answer "what
 * is breaking for customers", and cannot leak.
 */
function classifyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('429')) return 'rate_limited';
  if (m.includes('402')) return 'payment_required';
  if (m.includes('401') || m.includes('403') || m.includes('token')) return 'auth';
  if (m.includes('timed out') || m.includes('etimedout')) return 'timeout';
  if (m.includes('econnrefused')) return 'refused';
  if (m.includes('enotfound') || m.includes('dns')) return 'dns';
  if (m.includes('fetch failed') || m.includes('econnreset')) return 'network';
  if (m.includes('plain http') || m.includes('https')) return 'insecure_transport';
  if (/5\d\d/.test(m)) return 'server_error';
  return 'other';
}

let walkProgressForUpload: { done: number; total: number; complete: boolean } | null = null;

let lastServerPackSpec: { version: string; rules: Array<{ name: string; regex: string; flags?: string; redact?: boolean; source?: 'tenant' | 'pack' }> } | null = null;
import { reportWalkProgress, readCollectorHealth, updateCollectorHealth } from '@chat-recall/engine/core/collector-health.js';
import { withSessionReadCache , withSessionScanScope } from '@chat-recall/engine/core/live-session-scan.js';
import '@chat-recall/engine/core/backends/index.js'; // register the tool backends

// Lives under the data dir so CHAT_RECALL_DATA_DIR isolates credentials the
// same way it isolates the index (tests, multi-profile setups).
const credPath = () => join(getDataDir(), 'credentials.json');

export interface Credentials { serverUrl: string; token: string; }

/**
 * Multi-target: logging in ADDS a server (or updates its token). Every
 * sync pushes to ALL targets; the per-server ledger keeps coverage
 * independent. File shape is {targets:[...]} with the legacy single-object
 * form still readable.
 */
export function saveCredentials(c: Credentials): void {
  // REFUSE AT THE DOOR. Every login path funnels through here, so this is the
  // one place that can stop a cleartext target being persisted at all — better
  // than warning at sync time, by which point the user believes they are set up.
  assertTransportSafe(c.serverUrl);
  mkdirSync(dirname(credPath()), { recursive: true });
  const targets = loadAllCredentials().filter((t) => t.serverUrl !== c.serverUrl);
  // Newest login FIRST: single-target consumers (loadCredentials → targets[0],
  // i.e. sync + every MCP read) follow the most recent `chat-recall login`.
  // Appending here once meant a fresh SaaS login silently kept syncing to a
  // stale localhost self-host target that happened to sit at position 0.
  targets.unshift(c);
  writeFileSync(credPath(), JSON.stringify({ targets }, null, 2));
  try { chmodSync(credPath(), 0o600); } catch { /* windows */ }
  try {
    const s = loadSettings();
    s.sync.enabled = true;
    s.sync.endpoint = targets.map((t) => t.serverUrl).join(',');
    saveSettings(s);
  } catch { /* settings unwritable — manual `chat-recall sync` still works */ }
}

export function loadAllCredentials(): Credentials[] {
  // A container, a CI job or a headless daemon has no credentials.json. When
  // the environment carries an explicit token it IS the login — see
  // credentials-env.ts for why the file is not consulted in that case.
  const fromEnv = envCredentials();
  if (fromEnv) return [{ serverUrl: fromEnv.serverUrl, token: fromEnv.token }];

  try {
    const parsed = JSON.parse(readFileSync(credPath(), 'utf-8'));
    // token may be '' for a no-auth local self-host server (AUTH_PROVIDER=none) —
    // such a target is valid and pushes without an Authorization header.
    if (Array.isArray(parsed?.targets)) return parsed.targets.filter((t: any) => t?.serverUrl).map((t: any) => ({ serverUrl: t.serverUrl, token: t.token || '' }));
    if (parsed?.serverUrl) return [{ serverUrl: parsed.serverUrl, token: parsed.token || '' }]; // legacy single
  } catch { /* none */ }
  return [];
}

interface TenantSecurityConfig {
  tenantRules: Array<{ name: string; regex: string }>;
  verifySecrets: boolean;
  /** Content hash of the server's rule pack, or null when none was served. */
  rulePackVersion: string | null;
}

// In-memory cache for tenant security configuration. Fetched at the start of
// each `sync` call, but for the watch daemon we refresh only every 5 minutes
// so repeated incremental syncs don't hammer the server.
const _securityConfigCache = new Map<string, { fetchedAt: number; config: TenantSecurityConfig }>();
const SECURITY_CONFIG_TTL_MS = 5 * 60 * 1000;

async function fetchTenantSecurityConfig(cred: Credentials): Promise<TenantSecurityConfig> {
  const base = cred.serverUrl.replace(/\/+$/, '');
  const cached = _securityConfigCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < SECURITY_CONFIG_TTL_MS) return cached.config;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cred.token) headers.authorization = `Bearer ${cred.token}`;

  try {
    const [rulesRes, settingsRes] = await Promise.all([
      fetchWithTimeout(`${base}/api/secrets/rules`, { headers }),
      fetchWithTimeout(`${base}/api/teams/security-config`, { headers }).catch(() => null),
    ]);

    let tenantRules: Array<{ name: string; regex: string }> = [];
    let rulePackVersion: string | null = null;
    if (rulesRes.ok) {
      const body = await rulesRes.json().catch(() => ({})) as {
        version?: string;
        rules?: Array<{ name: string; regex: string; enabled?: boolean; redact?: boolean }>;
        pack?: {
          version?: string;
          revision?: string;
          rules?: Array<{ name: string; regex: string; flags?: string; source?: 'tenant' | 'pack' }>;
        };
      };
      const enabled = (body.rules || []).filter((r) => r.enabled !== false);
      tenantRules = enabled;

      // The REDACTION set. Prefer the server's `pack` — it carries chat-recall's
      // curated builtin rules as well as this tenant's `redact` ones, which is
      // what lets coverage improve for every customer from a server deploy
      // instead of a CLI release on each device. Fall back to deriving it from
      // the tenant rules when talking to a server that predates `pack`.
      //
      // installServerRulePack is add-only (it can never weaken the compiled-in
      // builtins) and drops individual rules that fail its safety checks; we log
      // those, because a silently ignored rule reads as coverage the operator
      // does not actually have.
      const packSpec = body.pack?.rules
        ? { version: body.pack.version, rules: body.pack.rules.map((r) => ({ name: r.name, regex: r.regex, flags: r.flags, redact: true, source: r.source })) }
        : { version: body.version, rules: enabled.filter((r) => r.redact === true).map((r) => ({ name: r.name, regex: r.regex, redact: true, source: 'tenant' as const })) };

      // Keep the SPEC, not just the compiled rules: a worker needs the raw
      // patterns to install them in its own isolate, and the compiled form
      // holds RegExp objects that do not survive a postMessage.
      lastServerPackSpec = { version: packSpec.version || '', rules: packSpec.rules };
      const pack = installServerRulePack(packSpec);
      rulePackVersion = serverRulePackVersion();
      for (const r of pack.rejected) {
        console.error(`[sync] server redaction rule "${r.name}" ignored: ${r.reason}`);
      }
      if (pack.accepted > 0) {
        const rev = body.pack?.revision ? `, rev ${body.pack.revision}` : '';
        console.error(`[sync] ${pack.accepted} server redaction rule(s) active (pack ${rulePackVersion}${rev})`);
      }
    }

    // Default verification ON. The server endpoint may not exist yet (older
    // servers), so we fail open to "verified enabled" — this is the product default.
    let verifySecrets = true;
    if (settingsRes?.ok) {
      const body = await settingsRes.json().catch(() => ({})) as { verifySecrets?: boolean; telemetry?: boolean };
      if (typeof body.verifySecrets === 'boolean') verifySecrets = body.verifySecrets;
      // Learned HERE because this request happens on every sync. Reading it from
      // the /api/sync response meant a fully-synced machine — which uploads
      // nothing, so gets no response — could never learn its own eligibility.
      if (typeof body.telemetry === 'boolean') {
        setTelemetryEligible(base, body.telemetry);
        try {
          const prior = readCollectorHealth()?.telemetryEligible ?? {};
          updateCollectorHealth({
            telemetryEligible: { ...prior, [base]: { allowed: body.telemetry, at: Date.now() } },
          });
        } catch { /* cosmetic — never fail a sync over it */ }
      }
    }

    const config: TenantSecurityConfig = { tenantRules, verifySecrets, rulePackVersion };
    _securityConfigCache.set(base, { fetchedAt: Date.now(), config });
    return config;
  } catch {
    // If the server is unreachable or the endpoints don't exist, fall back to
    // no tenant rules and verification enabled. This keeps the collector
    // working during transient outages and with older server images.
    return { tenantRules: [], verifySecrets: true, rulePackVersion: null };
  }
}

export function _resetTenantSecurityConfigCache(): void {
  _securityConfigCache.clear();
}

// ── Tenant sync config (server-side exclusions) ────────────────────────
// The dashboard edits exclusions once; every device pulls them here at the
// start of each sync and UNIONS them with local settings. Union is the
// fail-safe direction: the server can add exclusions for all devices but can
// never re-enable something a machine excluded locally.
//
// THIS USED TO FAIL OPEN. Any non-2xx or network error returned an EMPTY rule
// set, so a five-second blip made every dashboard exclusion silently not apply
// for that sync — and the sync then uploaded the projects those rules exist to
// hold back. Nothing logged it; the rules still showed in the dashboard.
//
// The distinction that fixes it without breaking older servers:
//
//   404          → this server has no such endpoint. Empty IS the right answer,
//                  and it is cached as a real answer.
//   anything else → we do not know the rules. Reuse the last set we successfully
//                  fetched (persisted to disk, so a fresh CLI process has it),
//                  and if we have never fetched one, REFUSE the sync rather than
//                  upload under rules we cannot see.
//
// Refusing is recoverable — the user re-runs — while uploading is not.
interface TenantSyncConfig { excludeTools: string[]; excludeProjects: string[]; excludeSources: string[]; approveSources: string[] }
const _syncConfigCache = new Map<string, { fetchedAt: number; config: TenantSyncConfig }>();

const EMPTY_SYNC_CONFIG: TenantSyncConfig = { excludeTools: [], excludeProjects: [], excludeSources: [], approveSources: [] };

/** Where the last successfully fetched rule set is kept, per server. A CLI
 *  invocation is a new process, so an in-memory cache alone would leave the
 *  common case (one `chat-recall sync` per tick) with nothing to fall back to. */
function syncConfigCachePath(): string {
  return join(getDataDir(), 'sync-config-cache.json');
}

type PersistedSyncConfigs = Record<string, { fetchedAt: number; config: TenantSyncConfig }>;

function readPersistedSyncConfigs(): PersistedSyncConfigs {
  try {
    return JSON.parse(readFileSync(syncConfigCachePath(), 'utf-8')) as PersistedSyncConfigs;
  } catch {
    return {};
  }
}

function persistSyncConfig(base: string, config: TenantSyncConfig): void {
  try {
    const all = readPersistedSyncConfigs();
    all[base] = { fetchedAt: Date.now(), config };
    mkdirSync(dirname(syncConfigCachePath()), { recursive: true });
    writeFileSync(syncConfigCachePath(), JSON.stringify(all, null, 2));
  } catch {
    // A cache we cannot write is a degraded fallback, not a failed sync. The
    // in-memory copy still serves this process.
  }
}

async function fetchTenantSyncConfig(cred: Credentials): Promise<TenantSyncConfig> {
  const base = cred.serverUrl.replace(/\/+$/, '');
  const cached = _syncConfigCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < SECURITY_CONFIG_TTL_MS) return cached.config;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cred.token) headers.authorization = `Bearer ${cred.token}`;
  try {
    // Report what this machine has BEFORE reading the selection back, so a
    // freshly-discovered source shows up in the dashboard on the first sync
    // rather than the second. Paths travel in this direction only.
    try {
      const sources = discoverSessionSources();
      if (sources.length > 0) {
        await fetchWithTimeout(`${base}/api/sync-config/sources`, {
          method: 'POST', headers,
          body: JSON.stringify({ device: deviceLabel(), sources }),
        }).catch(() => null);
      }
    } catch { /* reporting is advisory — never block a sync on it */ }

    const res = await fetchWithTimeout(`${base}/api/sync-config`, { headers });
    if (res.status === 404) {
      // No endpoint on this server — a real answer, not an outage.
      _syncConfigCache.set(base, { fetchedAt: Date.now(), config: EMPTY_SYNC_CONFIG });
      return EMPTY_SYNC_CONFIG;
    }
    if (!res.ok) return lastKnownSyncConfig(base, `HTTP ${res.status}`);
    const body = await res.json().catch(() => ({})) as Partial<TenantSyncConfig>;
    const config: TenantSyncConfig = {
      excludeTools: Array.isArray(body.excludeTools) ? body.excludeTools.filter((t): t is string => typeof t === 'string') : [],
      excludeProjects: Array.isArray(body.excludeProjects) ? body.excludeProjects.filter((p): p is string => typeof p === 'string') : [],
      // Ids only — installSourceExclusions drops anything else, so a server
      // sending a path cannot make this collector read it.
      excludeSources: Array.isArray(body.excludeSources) ? body.excludeSources.filter((x): x is string => typeof x === 'string') : [],
      approveSources: Array.isArray(body.approveSources) ? body.approveSources.filter((x): x is string => typeof x === 'string') : [],
    };
    const applied = installSourceExclusions(config.excludeSources);
    if (applied.excluded > 0) {
      console.error(`[sync] ${applied.excluded} transcript source(s) excluded by tenant config`);
    }

    // Decisions made in the dashboard become LOCAL decisions here. The server
    // sends ids, never paths: we approve/decline only a home this machine itself
    // discovered, so the dashboard can answer the question but can never
    // introduce a folder for us to read.
    try {
      const byId = new Map(
        discoverHomes({ includeRunning: false }).map((h) => [sourceId(h.path), h.path]),
      );
      let decided = 0;
      for (const id of config.approveSources) {
        const path = byId.get(id);
        if (path && homeDecision(path) === 'pending') { approveHome(path); decided++; }
      }
      for (const id of config.excludeSources) {
        const path = byId.get(id);
        const d = path ? homeDecision(path) : null;
        if (path && d !== 'declined' && d !== 'primary') { declineHome(path); decided++; }
      }
      if (decided > 0) console.error(`[sync] applied ${decided} folder decision(s) from the dashboard`);
    } catch { /* advisory — a failure must not stop the sync */ }

    _syncConfigCache.set(base, { fetchedAt: Date.now(), config });
    persistSyncConfig(base, config);
    return config;
  } catch (err) {
    // DO NOT RE-WRAP OUR OWN REFUSAL. `lastKnownSyncConfig` is called inside
    // this try (the !res.ok branch) and throws when there is nothing to fall
    // back on — so this catch caught that throw and fed the whole sentence back
    // in as the `reason`, printing it nested inside itself:
    //   "Cannot read the sync rules from X (Cannot read the sync rules from X
    //    (HTTP 502), and this machine has never…), and this machine has never…"
    if (isSyncRulesRefusal(err)) throw err;
    return lastKnownSyncConfig(base, err instanceof Error ? err.message : 'request failed');
  }
}

/** Test seam. The function itself is internal — one caller, inside the sync —
 *  but the three failure outcomes it now distinguishes are exactly what has to
 *  be pinned, and reaching them through a full sync would need a server. */
export const _fetchTenantSyncConfigForTests = fetchTenantSyncConfig;

/**
 * The last rule set we successfully fetched for this server, or a refusal.
 *
 * Called only when the fetch failed in a way that is NOT "this server has no
 * such endpoint". Reuse is stale but honest; an empty set is a lie that uploads
 * data. With nothing to reuse we throw, which aborts this sync and leaves the
 * ledger untouched, so the next run retries from the same place.
 */
function lastKnownSyncConfig(base: string, reason: string): TenantSyncConfig {
  const remembered = _syncConfigCache.get(base) ?? readPersistedSyncConfigs()[base];
  if (remembered) {
    console.error(`[sync] could not read server-side sync rules (${reason}) — applying the last known set from ${new Date(remembered.fetchedAt).toISOString()}`);
    return remembered.config;
  }
  const refusal = new Error(
    `Cannot read the server-side sync rules from ${base} (${reason}), and this machine has never `
    + 'successfully read them. Refusing to sync: uploading without knowing your exclusions could '
    + 'ship a project you told the dashboard to hold back. Fix the server or retry.',
  );
  (refusal as { [SYNC_RULES_REFUSAL]?: true })[SYNC_RULES_REFUSAL] = true;
  throw refusal;
}

/** Marks the refusal above as ours, so the caller's catch can rethrow it
 *  untouched instead of describing it a second time. A symbol rather than a
 *  message match: the text is user-facing and will be reworded. */
const SYNC_RULES_REFUSAL = Symbol.for('chat-recall.syncRulesRefusal');

function isSyncRulesRefusal(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<symbol, unknown>)[SYNC_RULES_REFUSAL] === true;
}

/** Stable-ish machine label for the dashboard's per-device grouping. */
function deviceLabel(): string {
  try { return hostname(); } catch { return 'unknown'; }
}

export function _resetTenantSyncConfigCache(): void {
  _syncConfigCache.clear();
}

/** Legacy single-target accessor — first target. */
/** The ACTIVE target = most recent login (saveCredentials unshifts). */
export function loadCredentials(): Credentials | null {
  return loadAllCredentials()[0] ?? null;
}

export function removeCredentials(serverUrl: string): boolean {
  const targets = loadAllCredentials();
  const kept = targets.filter((t) => t.serverUrl !== serverUrl);
  if (kept.length === targets.length) return false;
  writeFileSync(credPath(), JSON.stringify({ targets: kept }, null, 2));
  return true;
}

/** Tokenize an absolute project path so the server can group by project
 *  without learning the developer's filesystem layout. */
const hashPath = (p: string): string => (p ? 'p_' + createHash('sha256').update(p).digest('hex').slice(0, 12) : '');

export interface SyncResult {
  uploaded: number;
  skipped: number;
  redactions: number;
  items: number;
  links: number;
  findings: number;
  derived: number;
  kgEntities: number;
  kgTriples: number;
  /** Sessions secret-scanned this run. */
  scanned: number;
  /** Total wall-clock ms spent scanning this run. */
  scanMs: number;
}

/** compute_cache kinds shipped to the server. Must stay in step with the
 *  kinds the server's conversation routes read (heavyCacheGet keys). */
const COMPUTE_KINDS = ['diff', 'outcome', 'commits', 'markers'] as const;

/** Per-row ceiling for derived payloads — matches the local heavy-cache L2
 *  ceiling (metadata-cache.ts) so we never ship a row the server-side
 *  SQLite edition couldn't store anyway. */
const MAX_DERIVED_ROW_BYTES = 2 * 1024 * 1024;

/**
 * Local/LAN sync targets need no WAN-style pacing — you own the box and there
 * is no shared-tenant or rate-limiter to be polite to, so they get a higher
 * in-flight cap and zero inter-batch sleep. Remote/SaaS hosts stay gentler.
 */
/**
 * "You own this box", for upload pacing.
 *
 * One definition, shared with the transport gate — these were two copies of the
 * same private-address list, and the moment they disagree either politeness or
 * SECURITY is wrong. transport-safety.ts owns the list.
 */
const isLocalHost = isPrivateHost;

export async function syncSessions(opts: { sinceMs?: number; cleartextPaths?: boolean; limit?: number; throttleMs?: number; prune?: boolean; useLedger?: boolean; walk?: 'full' | 'changed' } = {}): Promise<SyncResult> {
  const targets = loadAllCredentials();
  if (targets.length === 0) throw new Error('Not logged in — run `chat-recall login <server-url> --token <token>`');
  // Once per walk: forget servers we no longer sync to, so their rows stop
  // riding along in every write of this single-file ledger.
  try { pruneLedgerTargets(targets.map((t) => t.serverUrl)); } catch { /* never block a sync on housekeeping */ }

  let agg: SyncResult | null = null;
  const errors: string[] = [];
  const skippedTargets: string[] = [];
  for (const cred of targets) {
    // CIRCUIT BREAKER. Targets are walked in SEQUENCE, so a dead one does not
    // just fail — it delays every ship to the healthy targets behind it, and
    // delays the walk's completion, which the ledger, the health file and the
    // progress report all wait on. A LAN box that is off should cost one log
    // line, not a full retry storm per session, every walk, forever.
    const verdict = breakerState(cred.serverUrl);
    if (verdict.open) {
      const notice = breakerNotice(cred.serverUrl, verdict);
      if (notice) console.error(`[sync] ${notice}`);
      skippedTargets.push(cred.serverUrl);
      continue;
    }
    try {
      const r = await syncToTarget(cred, opts);
      noteTargetSuccess(cred.serverUrl);
      agg = agg ? {
        uploaded: agg.uploaded + r.uploaded, skipped: agg.skipped + r.skipped, redactions: agg.redactions + r.redactions,
        items: agg.items + r.items, links: agg.links + r.links, findings: agg.findings + r.findings,
        derived: agg.derived + r.derived, kgEntities: agg.kgEntities + r.kgEntities, kgTriples: agg.kgTriples + r.kgTriples,
        scanned: Math.max(agg.scanned, r.scanned), scanMs: Math.max(agg.scanMs, r.scanMs),
      } : r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${cred.serverUrl}: ${msg}`);
      // Report the NEXT attempt in the same breath as the failure, so the log
      // says what will happen rather than leaving the user to infer it.
      const next = noteTargetFailure(cred.serverUrl, msg);
      const notice = breakerNotice(cred.serverUrl, next);
      if (notice) console.error(`[sync] ${notice}`);
      // The error CLASS, never the message: a server error string can quote a
      // path or a payload, and this channel must not carry either.
      record({
        kind: next.open ? 'breaker_trip' : 'target_failure',
        failures: next.failures,
        retryInMs: next.retryInMs,
        errorClass: classifyError(msg),
        local: isLocalHost(cred.serverUrl) ? 1 : 0,
      });
    }
  }
  // A walk that shipped nothing because every target is in cooldown is NOT a
  // success, and must not be reported as one — the caller marks target health
  // from this, and "0 pushed, no error" would read as a healthy quiet walk.
  if (!agg && skippedTargets.length > 0 && errors.length === 0) {
    throw new Error(
      `every sync target is in failure cooldown: ${skippedTargets.join(', ')}. `
      + 'They will be retried automatically; run `chat-recall doctor` for the last error.',
    );
  }
  // Ledger writes are coalesced during the walk (see persist() in sync-ledger).
  // This is the durability point: everything acked above reaches disk before we
  // report success, so a crash after this cannot re-ship what the server has.
  // In the finally, because a partial walk's acks are still worth keeping.
  flushLedger();

  // OPERATIONAL TELEMETRY, gated on consent + plan (telemetry-consent.ts). These
  // are the numbers that were previously only ever measured on one developer
  // machine, which is why "how long is a first sync for a 5,000-session
  // customer?" had no answer. Numbers only — the payload cannot carry a path,
  // project or session id, structurally.
  if (agg) {
    record({
      kind: 'sync_walk',
      targets: targets.length,
      skippedTargets: skippedTargets.length,
      failedTargets: errors.length,
      uploaded: agg.uploaded,
      skipped: agg.skipped,
      redactions: agg.redactions,
      scanned: agg.scanned,
      scanMs: Math.round(agg.scanMs),
      rssPeakMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  }
  // After the walk: the connection is warm and the numbers are final. Never
  // awaited into the caller's error path — telemetry must not fail a sync.
  void flush().catch(() => {});
  if (!agg) throw new Error(`sync failed for all targets:\n  ${errors.join('\n  ')}`);
  if (errors.length > 0) console.error(`[sync] ${errors.length} target(s) failed (others succeeded):\n  ${errors.join('\n  ')}`);
  return agg;
}

export interface ReconcileResult { sessions: number; scanned: number; pushed: number; absent: number; perTarget: Record<string, { pushed: number; absent: number }> }

/** POST one derived-field batch, retrying the ingest gate's 429 (honoring
 *  Retry-After) and transient 5xx. */
async function postFieldBatch(base: string, token: string, rows: Array<{ session_id: string; field: string; value: string | null }>): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(`${base}/api/sync`, { method: 'POST', headers, body: JSON.stringify({ fields: rows }) }, 60_000);
    if (res.ok) return;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) throw new Error(`${base}: fields batch HTTP ${res.status} ${await res.text().catch(() => '')}`);
    const ra = Number(res.headers.get('retry-after')) || 0;
    await sleep(ra > 0 ? ra * 1000 : [500, 1500, 4000, 8000, 15000][Math.min(attempt, 4)]);
  }
}

/**
 * Reconcile every DERIVED FIELD (engine core/sync-fields.ts) for one target,
 * pushing ONLY missing/stale fields — never the conversation.
 *
 * Per field: a one-time FULL pass (all sessions) runs when the field's version
 * bumped or a re-scan was forced; otherwise only `convRefs` (the new/changed
 * sessions this sync already listed) are checked. A session is (re)scanned only
 * when the coverage ledger says the field is missing/stale — an absent-but-
 * current field is skipped (the no-retry guarantee). Present values ship via the
 * fields[] batch and are ledger-stamped after the server acks; absent results
 * are stamped locally (nothing to ship) so they're never re-scanned.
 */
async function reconcileFieldsForTarget(
  cred: Credentials,
  fullRefs: () => SessionRef[],
  opts: { convRefs?: SessionRef[]; force?: boolean } = {},
): Promise<{ pushed: number; absent: number; scanned: number }> {
  const base = cred.serverUrl.replace(/\/+$/, '');
  const ledger = getSyncedRows(base);
  let pushed = 0, absent = 0, scanned = 0;

  for (const field of SYNC_FIELDS) {
    const needFull = !!opts.force || fieldNeedsFullPass(base, field);
    const candidates = needFull ? fullRefs() : (opts.convRefs ?? fullRefs());
    const send: Array<{ session_id: string; field: string; value: string | null }> = [];
    const mtimeById = new Map<string, number>();
    const absentIds: string[] = [];

    for (const ref of candidates) {
      if (!fieldNeedsScan(ledger.get(ref.prefixedId), field, ref.mtime, opts.force)) continue;
      scanned++;
      mtimeById.set(ref.prefixedId, ref.mtime);
      const raw = field.scan(ref);
      const value = raw && raw.trim()
        ? redactSecrets(raw.trim(), { force: true, count: { redactions: 0 } }).slice(0, 200)
        : null;
      if (value !== null) send.push({ session_id: ref.prefixedId, field: field.name, value });
      else absentIds.push(ref.prefixedId);
    }

    // Present values: ship in chunks, stamp coverage only after each ack so an
    // interrupted run resumes cleanly.
    for (let i = 0; i < send.length; i += 200) {
      const chunk = send.slice(i, i + 200);
      await postFieldBatch(base, cred.token, chunk);
      markFieldCoverage(base, field, chunk.map((r) => ({ id: r.session_id, present: true, mtime: mtimeById.get(r.session_id) ?? 0 })));
      pushed += chunk.length;
    }
    // Absent: nothing to ship; stamp locally so they're never re-scanned.
    if (absentIds.length) {
      markFieldCoverage(base, field, absentIds.map((id) => ({ id, present: false, mtime: mtimeById.get(id) ?? 0 })));
      absent += absentIds.length;
    }

    // Full pass completed without throwing → record so it isn't repeated until
    // the field version bumps or a re-scan is forced again.
    if (needFull) markFieldFullPassDone(base, field);
  }
  return { pushed, absent, scanned };
}

/**
 * Manual entrypoint (CLI `reconcile`): reconcile derived fields for ALL targets.
 * Normal `sync` already runs reconciliation each pass; this is the explicit
 * on-demand backfill / forced re-scan (also what a UI "re-scan this field"
 * action drives, via forceFieldRescan + a sync).
 */
export async function reconcileFields(opts: { force?: boolean } = {}): Promise<ReconcileResult> {
  const targets = loadAllCredentials();
  if (targets.length === 0) throw new Error('Not logged in — run `chat-recall login <server-url> --token <token>`');
  let cached: SessionRef[] | null = null;
  const fullRefs = () => (cached ??= listAvailableBackends().flatMap((b) => { try { return b.listSessions({}); } catch { return []; } }));

  let pushed = 0, absent = 0, scanned = 0;
  const perTarget: Record<string, { pushed: number; absent: number }> = {};
  for (const cred of targets) {
    const r = await reconcileFieldsForTarget(cred, fullRefs, { force: opts.force });
    pushed += r.pushed; absent += r.absent; scanned += r.scanned;
    perTarget[cred.serverUrl.replace(/\/+$/, '')] = { pushed: r.pushed, absent: r.absent };
  }
  return { sessions: fullRefs().length, scanned, pushed, absent, perTarget };
}

/**
 * Reap batch-scan temp dirs leaked by a previous run.
 *
 * The scan below deletes its dir in a `finally` — which a SIGKILL or the OOM
 * killer skips entirely, and this loop is exactly the one that has OOM-killed
 * the daemon before. Each leaked dir holds one file per session: one of them
 * was found at 3.4GB / 309k files, and together with other cruft it filled a
 * 31GB tmpfs, at which point *everything* on the box that needed /tmp broke.
 *
 * So: before starting a scan, delete our own stale dirs. 6h is far longer than
 * any real scan, so an in-flight dir from a concurrent process is never at risk.
 */
export function reapStaleScanDirs(dir: string = tmpdir(), maxAgeMs = 6 * 3600_000, now = Date.now()): number {
  let reaped = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith('cr-batchscan-')) continue;
    const p = join(dir, name);
    try {
      if (now - statSync(p).mtimeMs < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      reaped++;
    } catch { /* raced with its owner, or not ours to remove */ }
  }
  return reaped;
}

/**
 * Run the optional external detectors (gitleaks/trufflehog) over many sessions
 * with a BOUNDED amount of pre-redaction text on disk at any one time.
 *
 * The detectors take a path, so their input has to be materialized — and that
 * input is raw session text, i.e. real credentials in cleartext. Writing all of
 * it at once is what left 3.4GB / 309k such files in /tmp when the daemon was
 * OOM-killed mid-scan (the `finally` never ran). So we fill a temp dir up to
 * `maxBytes`, scan it, delete it, and repeat: worst-case exposure — and
 * worst-case leak if this process is killed — is one slice, not the whole walk.
 *
 * Cost of slicing is 2 detector spawns per extra slice, still far below the
 * 2·N of per-session scanning.
 *
 * `text()` returning null (unexportable session) is skipped silently: it just
 * gets no external findings, the builtin scan still covers it.
 * `scan` is injectable so tests don't need the binaries installed.
 */
export function batchScanExternal(
  items: Array<{ id: string; text: () => string | null }>,
  opts: {
    verifyOnly?: boolean;
    maxBytes?: number;
    scan?: (dir: string, o: { verifyOnly?: boolean }) => DirScanFinding[];
  } = {},
): { findings: Map<string, ScanFinding[]>; scanned: number; slices: number; scanMs: number } {
  const maxBytes = opts.maxBytes ?? BATCH_SCAN_MAX_BYTES;
  const scan = opts.scan ?? scanDirForSecrets;
  const findings = new Map<string, ScanFinding[]>();
  let scanned = 0, slices = 0, scanMs = 0;
  if (items.length === 0) return { findings, scanned, slices, scanMs };

  reapStaleScanDirs();
  let scanDir = mkdtempSync(join(tmpdir(), 'cr-batchscan-'));
  let safeToId = new Map<string, string>();
  let bytesInDir = 0;

  /** Scan what's currently materialized, record findings, then delete the dir. */
  const flushSlice = (): void => {
    if (safeToId.size > 0) {
      const t0 = performance.now();
      for (const f of scan(scanDir, { verifyOnly: opts.verifyOnly })) {
        const id = safeToId.get(basename(f.file).replace(/\.txt$/, ''));
        if (!id) continue;
        const list = findings.get(id) ?? [];
        list.push({ detector: f.detector, rule: f.rule, line: f.line, preview: f.preview, verified: f.verified });
        findings.set(id, list);
      }
      scanMs += performance.now() - t0;
      scanned += safeToId.size;
      slices++;
    }
    try { rmSync(scanDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    safeToId = new Map();
    bytesInDir = 0;
  };

  try {
    for (const item of items) {
      try {
        const raw = item.text();
        if (raw === null) continue;
        const safe = item.id.replace(/[^A-Za-z0-9_-]/g, '');
        safeToId.set(safe, item.id);
        writeFileSync(join(scanDir, `${safe}.txt`), raw);
        bytesInDir += Buffer.byteLength(raw);
      } catch { /* unexportable session — no external findings for it */ }
      // Bound on bytes ACTUALLY written, not an estimate. A single session
      // larger than the cap still gets scanned — alone, in its own slice.
      if (bytesInDir >= maxBytes) {
        flushSlice();
        scanDir = mkdtempSync(join(tmpdir(), 'cr-batchscan-'));
      }
    }
    flushSlice();
  } finally {
    // flushSlice removed the final dir already (force:true makes this a no-op);
    // this is what cleans up when the loop above threw.
    try { rmSync(scanDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { findings, scanned, slices, scanMs };
}

/**
 * Server API version check, cached per target for an hour.
 *
 * Only SUCCESS is cached. A server that is down, or too old, is re-checked on
 * the next tick — caching a failure would turn a thirty-second outage into an
 * hour of refusing to sync.
 */
const CAPS_TTL_MS = 60 * 60_000;
const capsOk = new Map<string, number>();   // serverUrl -> epoch ms verified
/** Ingest concurrency the server says it will accept, per serverUrl. */
const advertisedIngestConc = new Map<string, number>();
/** Servers that accept a gzipped request body. */
const advertisedGzipBody = new Set<string>();

export function _resetCapsCacheForTests(): void {
  capsOk.clear(); advertisedIngestConc.clear(); advertisedGzipBody.clear();
}

/**
 * Learn the tenant-scoped ingest allowance from an authenticated response.
 *
 * `verifyServerApi` sets the same map from /api/capabilities, which is pre-auth
 * and therefore can only report the CLASS ceiling. This overrides it with the
 * number that actually applies to this tenant.
 */
export function setServerIngestConcurrency(serverUrl: string, n: number): void {
  advertisedIngestConc.set(serverUrl.replace(/\/$/, ''), n);
}

/** Does this server accept `Content-Encoding: gzip` on a request body? */
export function serverAcceptsGzipBody(serverUrl: string): boolean {
  return advertisedGzipBody.has(serverUrl.replace(/\/$/, ''));
}

/**
 * How many uploads may be in flight at once, according to the SERVER.
 *
 * Returns null when the server does not advertise it (older image) — the caller
 * then keeps its own default.
 */
export function serverIngestConcurrency(serverUrl: string): number | null {
  return advertisedIngestConc.get(serverUrl.replace(/\/$/, '')) ?? null;
}

/**
 * Is this a chat-recall server new enough to sync to?
 *
 * THE BUG THIS LINE HELD FOR MONTHS, and the one a user hit on macOS:
 *
 *     fetchWithTimeout(`${base}/api/capabilities`).then((r) => r.json())
 *
 * No `r.ok`, no content-type check, one hop from the response to JSON.parse. A
 * host that had stopped serving chat-recall answered Traefik's `404 page not
 * found` in text/plain; JSON.parse read `404` as a number, choked on the space,
 * and every sync on that machine failed with
 *
 *     Unexpected non-whitespace character after JSON at position 4
 *
 * — a message that names no host, no status and no fix, for a problem whose fix
 * is one `chat-recall login <new-url>`. `doctor` had classified this correctly
 * since server-probe.ts was written; sync just never used it. It does now: ONE
 * probe, and the `limits` this function needs come off the same document rather
 * than a second unclassified request.
 */
async function verifyServerApi(serverUrl: string, minApi: number): Promise<boolean> {
  const base = serverUrl.replace(/\/$/, '');
  const seen = capsOk.get(base);
  if (seen !== undefined && Date.now() - seen < CAPS_TTL_MS) return true;
  const { probeServer, probeAdvice } = await import('./server-probe.js');
  // Our own fetch, so the CLI-version and OS headers still reach the server's
  // device heartbeat; probeServer supplies the timeout signal.
  const probe = await probeServer(base, {
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) =>
      fetchWithTimeout(String(url), init ?? {})) as typeof fetch,
  });
  if (probe.kind !== 'ok') throw new Error(probeAdvice(probe, base));
  const caps = probe.raw as {
    apiVersion?: number;
    limits?: { ingestConcurrencyPerTenant?: number; acceptsGzipBody?: boolean };
  };
  if ((caps.apiVersion ?? 0) < minApi) {
    throw new Error(`server too old: apiVersion ${caps.apiVersion ?? 'none'} < required ${minApi} — update the server image before syncing`);
  }
  // Learn the server's in-flight budget instead of assuming one. The old
  // hardcoded 4 was exactly twice the server's per-tenant cap of 2, so every
  // walk manufactured its own 429 storm — 3,526 of them in one measured log.
  // A number the server owns can be tuned without shipping a CLI release.
  const adv = caps.limits?.ingestConcurrencyPerTenant;
  if (typeof adv === 'number' && Number.isFinite(adv) && adv >= 1) {
    advertisedIngestConc.set(base, Math.floor(adv));
  }
  if (caps.limits?.acceptsGzipBody === true) advertisedGzipBody.add(base);
  else advertisedGzipBody.delete(base);
  capsOk.set(base, Date.now());
  return true;
}

type SyncToTargetOpts = { sinceMs?: number; cleartextPaths?: boolean; limit?: number; throttleMs?: number; prune?: boolean; useLedger?: boolean; walk?: 'full' | 'changed' };

/**
 * One walk = one scan scope.
 *
 * Locating a session used to probe every project directory in every profile
 * home, PER SESSION — and the walk asks twice per session
 * (`spansMultipleSources`, then `fileSize`). Measured on a 15,724-session
 * corpus: 62.8 seconds of filesystem syscalls to discover that 2 sessions had
 * changed. With the scope open the directories are listed once instead: 196 ms.
 *
 * The scope is the honest place for the cache. A walk snapshots its session
 * list up front, so within it "where does this session live" genuinely cannot
 * change; outside it every lookup still reads the filesystem.
 */
async function syncToTarget(cred: Credentials, opts: SyncToTargetOpts = {}): Promise<SyncResult> {
  return withSessionScanScope(() => syncToTargetInScope(cred, opts));
}

async function syncToTargetInScope(cred: Credentials, opts: SyncToTargetOpts = {}): Promise<SyncResult> {
  // Checked again here, not only at login: credentials.json is a plain file a
  // user can edit, an env var can supply a target that never saw the login gate
  // (see credentials-env.ts), and a target saved by an older version predates
  // the check entirely. The upload path is the last place to say no.
  const risk = transportRisk(cred.serverUrl);
  if (risk) throw new Error(risk);
  const sync = loadSettings().sync;
  // Exclusions = local settings ∪ server-side tenant config (dashboard-edited).
  const serverCfg = await fetchTenantSyncConfig(cred);
  const excludeTools = new Set([...(sync?.excludeTools ?? []), ...serverCfg.excludeTools]);
  const excludeProjects = [...(sync?.excludeProjects ?? []), ...serverCfg.excludeProjects];
  // Upload category toggles (settings.sync.upload, all default true).
  // Redaction of shipped text always runs regardless of toggles.
  const upload = {
    raw: sync?.upload?.raw !== false,
    sessionMeta: sync?.upload?.sessionMeta !== false,
    findings: sync?.upload?.findings !== false,
  };
  // Cleartext paths: explicit flag wins, else the persistent setting
  // (sync.pathsCleartext — what the watch daemon uses).
  const cleartext = opts.cleartextPaths ?? sync?.pathsCleartext === true;
  const mapPath = (p: string): string => (cleartext ? p : hashPath(p));
  // projectPathIncludes, not String.includes. `listSessions()` decodes the
  // project path from Claude Code's directory name, which replaced every
  // separator with '-' and cannot be inverted — so an `exclude project
  // ~/code/chat-recall` rule was compared against `/home/user/code/chat/recall`
  // and never matched. The project kept syncing with the rule sitting there
  // looking applied. See engine/core/project-path-match.ts.
  const excluded = (projectPath: string): boolean =>
    excludeProjects.some((x) => projectPathIncludes(projectPath, x));
  // Opt-in selective sync (settings.sync.syncMode='only'): ship ONLY allowlisted
  // projects. Allowlist = local ∪ tenant config; matched on the resolved project
  // id (what the dashboard picker lists) or a path substring. 'all'/unset ships
  // every non-excluded project (unchanged default).
  const syncOnly = new Set<string>([...(sync?.syncOnlyProjects ?? []), ...((serverCfg as { syncOnlyProjects?: string[] }).syncOnlyProjects ?? [])]);
  const includedProject = (projectPath: string): boolean => {
    if ((sync?.syncMode ?? 'all') !== 'only') return true; // fast path: no resolve
    const r = resolveProjectId(projectPath);
    return isProjectSyncable(r.source === 'ignored' ? '' : r.id, projectPath, { syncMode: 'only', syncOnly });
  };

  // Ledger mode walks ALL sessions (the ledger does the skipping — that's
  // what lets a previously-failed session retry no matter how old it is).
  // Watermark mode keeps the cheap bounded walk for explicit --since runs.
  // Version handshake: refuse loudly instead of silently degrading. An old
  // server ignores payload fields it doesn't know — which looks like
  // success and produces gutted data (lived experience, June 2026).
const MIN_SERVER_API = 2;
{
  // Cached for an hour per target. This ran on EVERY sync — every file-change
  // debounce, every heartbeat, per target — to re-learn a number that changes
  // only when the server is redeployed. The check itself stays: refusing to
  // sync blind is the point, and an old server silently ignoring payload fields
  // is how gutted data shipped in June 2026. Only the frequency changes.
  //
  // A FAILURE IS NEVER CACHED. An unreachable server must be retried on the
  // next tick, not written off for an hour.
  const ok = await verifyServerApi(cred.serverUrl, MIN_SERVER_API);
  if (!ok) throw new Error(`cannot verify server version — refusing to sync blind`);
}

// Fetch tenant-specific secret-scan configuration from the server. Rules are
// configured in the dashboard and must be applied to raw session text on the
// client (the server never sees unredacted secrets). Verification live-checks
// matched keys with their issuers (e.g. AWS, GitHub) — on by default, but a
// tenant admin can disable it.
const { tenantRules, verifySecrets } = await fetchTenantSecurityConfig(cred);

// Walk scope. 'full' (default) lists EVERY session — the ledger does the
// skipping, which is what lets an old failed session retry forever. 'changed'
// bounds the LISTING to recently-touched sessions (mtime window with overlap):
// the watch daemon's per-file-change ticks use it so a burst of keystrokes
// costs a walk over ~a handful of refs, not 30k+. Failed/old sessions still
// converge via the daemon's 15-min heartbeat + startup ticks, which stay
// 'full'. The ledger still drives skip/append/full per ref in BOTH modes.
const CHANGED_WALK_OVERLAP_MS = 15 * 60_000;
const changedWalk = opts.walk === 'changed';
const listSinceMs = changedWalk
  ? Math.max(0, (opts.sinceMs ?? 0) - CHANGED_WALK_OVERLAP_MS)
  : (opts.useLedger ? undefined : opts.sinceMs);
const refs = listAvailableBackends().flatMap((b) => {
    try { return b.listSessions({ sinceMs: listSinceMs }); } catch { return []; }
  });

  // ── Upload plumbing, created up-front so the walks below can stream.
  // Byte-aware batching: cap each POST at ~4MB of serialized payload (and a
  // per-field item cap) so transcript-heavy runs can't blow the server's
  // body limit. A single row larger than the cap still ships alone.
  //
  // Streaming matters: a 5k-session backfill with diff payloads would be
  // gigabytes if accumulated before upload. Each batcher flushes as soon as
  // its window fills, so memory stays bounded at ~one batch per category.
  //
  // Backpressure, not a blind sleep. Server-side ingest does real work per row
  // (chunking, classification, FTS/vector inserts); an UNBOUNDED backfill
  // browned out a node on 2026-06-11. The protection that matters is bounding
  // how many batches hit the server AT ONCE — so we cap in-flight uploads (the
  // cap is the rate limit) and let the server push back with 429/Retry-After,
  // sleeping only when it actually tells us to. Local/LAN targets need none of
  // this politeness (you own the box) → higher cap, zero pacing. An explicit
  // --throttle (opts.throttleMs>0) forces the old serial+sleep mode for a
  // known-fragile server.
  const MAX_BATCH_BYTES = 4 * 1024 * 1024;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const explicitThrottle = typeof opts.throttleMs === 'number' && opts.throttleMs > 0;
  const throttleMs = explicitThrottle ? (opts.throttleMs as number) : 0;
  // In-flight budget: the server's advertised per-tenant ingest concurrency when
  // it publishes one, else the historical default. Never exceed what the server
  // will accept — an extra in-flight batch does not go faster, it comes back
  // 429 and then sleeps out its Retry-After.
  //
  // A local target is yours: no politeness needed, and no advertised cap to
  // respect beyond its own.
  const LOCAL_INFLIGHT = 6;
  const REMOTE_INFLIGHT_FALLBACK = 4;
  const advertised = serverIngestConcurrency(cred.serverUrl);
  const maxInflight = explicitThrottle
    ? 1
    : isLocalHost(cred.serverUrl)
      ? Math.max(LOCAL_INFLIGHT, advertised ?? 0)
      : (advertised ?? REMOTE_INFLIGHT_FALLBACK);
  // Per-attempt upload timeout. WITHOUT this, a half-open/slow connection makes
  // `fetch` hang FOREVER (Node fetch has no default timeout) — observed as a
  // sync stuck for 20-40min at idle CPU with zero progress. With it, a hung
  // upload aborts, surfaces as an error, and goes through the retry path below.
  const UPLOAD_TIMEOUT_MS = Number(process.env.CHAT_RECALL_UPLOAD_TIMEOUT_MS) || 90_000;
  // Single POST with retry. Retryable: network/abort errors, HTTP 429 (obeying
  // Retry-After — the server's own rate signal), and 5xx. Non-429 4xx (bad
  // token, oversized body) is fatal: retrying can't fix it.
  // COMPRESS THE BODY. Nothing compressed it before — every sync shipped raw
  // JSON. Measured over five real sessions, 11.47 MB of envelope became 6.69 MB:
  // 42% off the wire for one header and one gzipSync.
  //
  // Why gzip and not a binary/multipart redesign. The payload is ~64% `raw_b64`
  // — a gzipped transcript, base64'd into JSON, which inflates it ~33%. Sending
  // those bytes binary alongside a compressed metadata part measures 6.66 MB:
  // the SAME bytes as just gzipping the whole thing, because gzip recovers most
  // of what base64 wasted. Binary buys CPU (115 ms vs 318 ms), not bandwidth,
  // and costs a new wire format on both sides. Brotli reaches 6.07 MB — another
  // 5% — and is where to go if bandwidth ever matters more than simplicity.
  //
  // Gated on the server advertising it: body-parser inflates transparently and
  // its size limit still applies to the DECOMPRESSED body, so the 32 MB ceiling
  // on /api/sync is unchanged.
  const gzipBody = serverAcceptsGzipBody(cred.serverUrl);
  const post = async (body: Record<string, unknown>): Promise<void> => {
    // SERIALISE INTO A BUFFER AND KEEP ONLY THAT. Retries hold the payload for
    // up to four attempts × a 90s timeout, so anything still referenced here is
    // resident for minutes. The JSON string is scoped to this block so it is
    // collectable the moment the Buffer exists — previously both the string and
    // (with gzip on) the compressed copy stayed reachable for the whole retry
    // chain, i.e. ~2.3× the payload held for as long as the server was slow.
    const payload: Buffer = (() => {
      // Ride the progress report along on whatever batch is already going out.
      // The UI had only an AGE to show ("25m behind"), which during a first sync
      // is indistinguishable from broken. No extra request, no new endpoint —
      // the server stashes it and serves it on the status the UI already polls.
      const withProgress = walkProgressForUpload
        ? { ...body, progress: walkProgressForUpload }
        : body;
      const json = JSON.stringify(withProgress);
      const raw = Buffer.from(json, 'utf8');
      return gzipBody ? gzipSync(raw, { level: 6 }) : raw;
    })();
    const RETRY_DELAYS_MS = [2000, 8000, 30000];
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`upload timed out after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/api/sync`, {
          method: 'POST',
          // No token ⇒ no auth header: a no-auth local server (AUTH_PROVIDER=none)
          // accepts it as the single 'default' tenant.
          headers: {
            'content-type': 'application/json',
            ...(gzipBody ? { 'content-encoding': 'gzip' } : {}),
            ...(cred.token ? { authorization: `Bearer ${cred.token}` } : {}),
          },
          body: payload,
          signal: ac.signal,
        });
        if (res.ok) {
          const body = await res.json().catch(() => ({})) as {
            cli?: { version: string; sha256: string } | null;
            telemetry?: boolean;
            limits?: { ingestConcurrencyPerTenant?: number };
          };
          // The server owns the plan answer; the user's opt-out is checked
          // separately and wins over it.
          if (typeof body.telemetry === 'boolean') {
            setTelemetryEligible(base, body.telemetry);
            // Persisted so `doctor` — a separate process that never syncs — can
            // tell the user the truth about what leaves their machine.
            try {
              const prior = readCollectorHealth()?.telemetryEligible ?? {};
              updateCollectorHealth({
                telemetryEligible: { ...prior, [base]: { allowed: body.telemetry, at: Date.now() } },
              });
            } catch { /* cosmetic — never fail a sync over it */ }
          }
          // The AUTHENTICATED per-tenant allowance beats the pre-auth class
          // ceiling from /api/capabilities: only this response knows the plan,
          // and the gate scales the ceiling down per tenant. Learning it here is
          // what stops a free tenant asking for 6 slots it will never get.
          const adv = body.limits?.ingestConcurrencyPerTenant;
          if (typeof adv === 'number' && Number.isFinite(adv) && adv >= 1) {
            setServerIngestConcurrency(base, Math.floor(adv));
          }
          if (body.cli && body.cli.version) {
            const { planAutoUpdate, runAutoUpdate } = await import('./auto-update.js');
            const authHeaders: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};
            const plan = planAutoUpdate(base, { cli: body.cli }, ownVersion, process.env.CHAT_RECALL_AUTO_UPDATE);
            if (plan.update) {
              void runAutoUpdate(base, authHeaders, ownVersion).catch(() => {});
            }
          }
          break;
        }
        const retryable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        // Auth rejection is a standing condition, not a glitch: the device
        // token was revoked or the tenant is gone. Every future sync will fail
        // the same way until the human reconnects — say exactly that.
        if (res.status === 401 || res.status === 403) {
          throw new Error(`server rejected this machine's device token (HTTP ${res.status} — revoked?). Reconnect with: chat-recall login ${base}`);
        }
        // 402 is a standing plan condition, not a glitch: a meter (monthly
        // quota / storage cap) or a missing email confirmation. The server's
        // payload carries the one actionable sentence — print IT, not the raw
        // HTTP line, and never retry: the answer is the same until the meter
        // resets or the human acts.
        if (res.status === 402) {
          let detail = text;
          try {
            const body = JSON.parse(text) as { error?: string; detail?: string; upgradeUrl?: string; resetsAt?: number };
            detail = body.error ?? text;
            // `detail` carries the part that stops this reading as breakage —
            // what still works, and the one command that restores the rest.
            if (body.detail) detail += `\n  ${body.detail}`;
            if (body.resetsAt) detail += ` (resets ${new Date(body.resetsAt).toISOString().slice(0, 10)})`;
            if (body.upgradeUrl) detail += `\n  ${body.upgradeUrl}`;
          } catch { /* non-JSON 402 — print as-is */ }
          throw new Error(`sync paused by the server: ${detail}`);
        }
        if (!retryable) throw new Error(`sync failed: HTTP ${res.status} ${text}`);
        if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`sync failed after ${attempt + 1} attempts: HTTP ${res.status} ${text}`);
        // 429: obey Retry-After (seconds) when the server sends it; else fall
        // back to the backoff schedule. This puts the pacing decision where it
        // belongs — on the server that knows its own load.
        const retryAfterS = Number(res.headers.get('retry-after'));
        const waitMs = res.status === 429 && retryAfterS > 0 ? retryAfterS * 1000 : RETRY_DELAYS_MS[attempt];
        console.error(`[sync] HTTP ${res.status} from ${base} — backing off ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      } catch (err) {
        const fatal = err instanceof Error && /HTTP 4\d\d|sync failed after/.test(err.message);
        if (fatal || attempt >= RETRY_DELAYS_MS.length) throw err;
        console.error(`[sync] upload attempt ${attempt + 1} failed (${err instanceof Error ? err.message : err}) — retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      } finally {
        clearTimeout(timer);
      }
    }
    if (throttleMs > 0) await sleep(throttleMs);
  };

  // Bounded-concurrency pool. Up to `maxInflight` POSTs run at once; awaiting a
  // free slot in `submit` is what paces the producer (natural backpressure).
  // A POST that fails after its own retries is captured into `poolError` and
  // re-thrown at the next slot-wait / drain, so a fatal error still aborts the
  // whole sync (matching the old serial behaviour).
  const inflight = new Set<Promise<void>>();
  let poolError: unknown = null;
  // BOUND THE BYTES, not only the request count. `maxInflight` alone permits
  // maxInflight × the largest batch resident at once, and a batch is capped at
  // 4 MB only for the row categories that go through a batcher — a single
  // oversized conversation ships ALONE and can be far larger. Counting requests
  // said "4 in flight" whether that was 4 KB or 40 MB.
  //
  // An item bigger than the whole budget still ships, alone, once the pipe is
  // empty: refusing it would silently drop a session, and waiting forever would
  // deadlock the walk.
  const MAX_INFLIGHT_BYTES = (Number(process.env.CHAT_RECALL_MAX_INFLIGHT_MB) || 32) * 1024 * 1024;
  let inflightBytes = 0;
  const submit = async (body: Record<string, unknown>, after: () => void, bytesHint = 0): Promise<void> => {
    while (
      inflight.size > 0
      && (inflight.size >= maxInflight || inflightBytes + bytesHint > MAX_INFLIGHT_BYTES)
    ) {
      await Promise.race(inflight);
    }
    if (poolError) throw poolError;
    inflightBytes += bytesHint;
    let task: Promise<void>;
    task = (async () => { await post(body); after(); })()
      .catch((e) => { poolError = poolError ?? e; })
      .finally(() => { inflight.delete(task); inflightBytes -= bytesHint; });
    inflight.add(task);
  };
  const drainInflight = async (): Promise<void> => {
    await Promise.allSettled(inflight);
    if (poolError) throw poolError;
  };
  // Track every local session id we see this sync. After the walk, any
  // session id recorded in the per-server ledger but missing locally is a
  // deletion → ship a tombstone so the server removes it. This only covers
  // sessions this device previously synced; deletions on other devices are
  // handled by their own collectors.
  const localSessionIds = new Set<string>();

  // session_id → content hash for the FULL conversations shipped this run, so
  // the convBatch ack can stamp the ledger `h` alongside {m,o,s}. A later tick
  // that re-classifies the session as FULL on an mtime-only change then matches
  // this hash and skips the rebuild entirely.
  const shippedHash = new Map<string, string>();

  // `flatten`: each add() is a GROUP of rows that must land in the same
  // POST (e.g. one session's findings — the server replaces a session's
  // findings wholesale, so splitting a session across two batches would
  // lose the first half).
  const makeBatcher = (field: string, maxItems: number, flatten = false, onFlush?: (rows: any[]) => void) => {
    let batch: any[] = [];
    let batchBytes = 0;
    return {
      sent: 0,
      async add(row: any): Promise<void> {
        // BYTES, not UTF-16 code units. `.length` on the serialised string
        // undercounts exactly the content that blows the budget: any non-ASCII
        // character is 2–4 bytes on the wire but 1–2 units here, so a batch of
        // emoji-heavy or CJK transcript could be ~3× the 4 MB cap it was
        // measured against and get rejected by the server's body limit.
        const size = Buffer.byteLength(JSON.stringify(row));
        if (batch.length > 0 && (batchBytes + size > MAX_BATCH_BYTES || batch.length >= maxItems)) await this.drain();
        batch.push(row);
        batchBytes += size;
      },
      async drain(): Promise<void> {
        if (batch.length === 0) return;
        const rows = flatten ? batch.flat() : batch;
        const bytes = batchBytes;
        batch = [];
        batchBytes = 0;
        // Hand off to the concurrency pool; `sent`/onFlush (e.g. markSynced)
        // fire only after the server acks THIS batch, same as before. The byte
        // total is already known here, so the pool can bound memory by size
        // instead of guessing from the request count.
        await submit({ [field]: rows }, () => { this.sent += rows.length; onFlush?.(rows); }, bytes);
      },
    };
  };
  const base = cred.serverUrl.replace(/\/$/, '');
  const ledger = opts.useLedger ? getSyncedRows(base) : null;
  const convBatch = makeBatcher('conversations', 25, false, (rows) => {
    // Server acked this batch — record exactly these sessions at exactly
    // the mtimes that were shipped. Failures never reach here, so an
    // unsynced session stays unsynced and retries next tick.
    //
    // For append-only backends, also stamp the byte cursor (o=size, s=size) so
    // the next tick can APPEND from here instead of re-doing a FULL sync. We
    // read the CURRENT file size (not the size at ship time) — the file may
    // have grown between ship and ack, but that's fine: the next tick's gate
    // sees size > ack.s and APPENDs the new tail. If it shrank (rotation), the
    // gate falls back to FULL.
    try {
      markSynced(base, rows.map((r: any) => {
        // Record the SAME offset the conv shipped to the server (conv.from_offset
        // = build-time file size), NOT a freshly-stat'd size — otherwise an
        // actively-growing file's ledger offset would differ from the server's
        // stored `o`, and every subsequent append would miss the continuity
        // check and fall back to FULL. Consistency here is what lets the active
        // session actually append.
        const off = typeof r.from_offset === 'number' ? r.from_offset : 0;
        const hash = shippedHash.get(r.session_id);
        // acked: the server accepted the batch containing this conversation, so
        // the cursor is a real delivery receipt.
        return off > 0
          ? { id: r.session_id, mtime: r.mtime, offset: off, size: off, hash, acked: true }
          : { id: r.session_id, mtime: r.mtime, hash };
      }));
    }
    catch { /* ledger is local bookkeeping — never fail an upload over it */ }
  });

  // ── Append batcher (tail-only sync) ──────────────────────────────
  // See docs/SYNC-INCREMENTAL.md. Append conversations ship with append:true;
  // the server appends chunks + merges the envelope. The server may respond
  // with full_resync_needed:[ids] when it has no prior envelope for a session
  // (data loss, first sync) — those sessions are NOT marked synced, so the
  // next tick re-classifies them as FULL (offset 0 or absent → full).
  //
  // Append payloads are small (tail only), so we batch up to 50 per POST and
  // inspect the response body for the full_resync_needed list. This path does
  // NOT go through the shared `post`/`submit` pool — it needs the response
  // body, which the shared path discards.
  const appendResults = { uploaded: 0, fullResyncNeeded: new Set<string>() };
  const postAppend = async (convs: Array<Record<string, unknown>>): Promise<void> => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cred.token) headers.authorization = `Bearer ${cred.token}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`upload timed out after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/api/sync`, {
        method: 'POST', headers,
        body: JSON.stringify({ conversations: convs }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`append sync failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
      const body = await res.json().catch(() => ({})) as { full_resync_needed?: string[], cli?: { version: string; sha256: string } | null };
      if (body.cli && body.cli.version) {
        const { planAutoUpdate, runAutoUpdate } = await import('./auto-update.js');
        const authHeaders: Record<string, string> = cred.token ? { authorization: `Bearer ${cred.token}` } : {};
        const plan = planAutoUpdate(base, { cli: body.cli }, ownVersion, process.env.CHAT_RECALL_AUTO_UPDATE);
        if (plan.update) {
          void runAutoUpdate(base, authHeaders, ownVersion).catch(() => {});
        }
      }
      const fullNeeded = new Set(body.full_resync_needed ?? []);
      // Mark synced ONLY the sessions the server accepted as appends. Sessions
      // the server asked to full-resync stay unmarked → next tick = FULL.
      const acked = convs.filter((c) => !fullNeeded.has(c.session_id as string));
      if (acked.length > 0) {
        try {
          markSynced(base, acked.map((c) => ({
            id: c.session_id as string,
            mtime: c.mtime as number,
            offset: c.from_offset as number,
            size: c.from_offset as number, // size = new offset (file grew to here)
            acked: true,                   // server merged this tail
          })));
        } catch { /* ledger — never fail an upload over it */ }
      }
      appendResults.uploaded += acked.length;
      for (const id of fullNeeded) appendResults.fullResyncNeeded.add(id);
    } finally {
      clearTimeout(timer);
    }
  };
  let appendBatch: Array<Record<string, unknown>> = [];
  const APPEND_BATCH_SIZE = 50;
  const appendFlush = async (): Promise<void> => {
    if (appendBatch.length === 0) return;
    const batch = appendBatch;
    appendBatch = [];
    await postAppend(batch);
  };
  const appendAdd = async (conv: Record<string, unknown>): Promise<void> => {
    appendBatch.push(conv);
    if (appendBatch.length >= APPEND_BATCH_SIZE) await appendFlush();
  };
  const itemsBatch = makeBatcher('items', 100);
  const linksBatch = makeBatcher('links', 2000);
  const derivedBatch = makeBatcher('derived', 50);
  const kgEntityBatch = makeBatcher('kg_entities', 2000);
  const kgTripleBatch = makeBatcher('kg_triples', 1000);
  // Secret findings ship per-session as a GROUP (flatten=true) — the server
  // replaces a session's findings wholesale, so they must land in one POST.
  const findingsBatch = makeBatcher('findings', 200, true);
  // External detectors (gitleaks/trufflehog) are OPT-IN and default OFF:
  // isSecretScannerAvailable() returns false unless CHAT_RECALL_EXTERNAL_SCANNERS
  // is set AND a binary is on PATH. Resolved once (each check spawns `which`).
  // CHAT_RECALL_SCAN_SECRETS=0 opts out even when enabled (e.g. to keep a huge
  // backfill fast); upload.findings=false disables shipping too.
  // NOTE: this flag gates ONLY the external binaries. Builtin regex findings
  // and tenant rules run for every user further down (buildConversationSync),
  // and redaction of everything shipped is unconditional.
  const scanSecrets = isSecretScannerAvailable() && upload.findings && process.env.CHAT_RECALL_SCAN_SECRETS !== '0';
  const verifySecretsScan = verifySecrets;

  let skipped = 0, redactions = 0, walked = 0;

  // ── Live KG accumulator. Triples are extracted on the spot from each item's
  //    redacted text (no local knowledge-graph DB is read). Dedupe by
  //    subject|predicate|object|valid_from; entity types come from `is_a`
  //    triples seen in the same pass, defaulting to 'unknown' otherwise.
  //
  // TRIPLES SHIP IMMEDIATELY. They used to pile into an array that was drained
  // only after the ENTIRE walk — on this developer's box that is 15,700
  // sessions, so the array grew for the whole run and every row stayed live and
  // reachable. A full Mark-Compact freed 0 MB at 1602 MB before the daemon
  // aborted, which is the signature of retention, not of transient copies:
  // nothing transient survives a mark-compact. Handing each triple to the
  // batcher as it is produced bounds the resident set to one 4 MB window.
  //
  // Two small structures still span the walk, and both are bounded by DISTINCT
  // entity count rather than by session count:
  //   kgSeen        — dedup. Stores a 16-hex digest, because the old key
  //                   repeated all three long strings in a fourth string.
  //   kgEntityNames — the names to emit entities for at the end. This is the
  //                   only reason the row array was ever kept; a Set of names
  //                   it already references costs a pointer, not a row.
  const kgSeen = new Set<string>();
  const kgEntityType = new Map<string, string>();
  const kgEntityNames = new Set<string>();
  const kgKey = (subject: string, predicate: string, object: string, validFrom: string): string =>
    createHash('sha1').update(`${subject}|${predicate}|${object}|${validFrom}`).digest('hex').slice(0, 16);
  const accumulateKg = async (triples: ReturnType<typeof extractEntities>, sourceSession: string | null): Promise<void> => {
    for (const t of triples) {
      const key = kgKey(t.subject, t.predicate, t.object, t.validFrom ?? '');
      if (kgSeen.has(key)) continue;
      kgSeen.add(key);
      if (t.predicate === 'is_a' && !kgEntityType.has(t.subject)) kgEntityType.set(t.subject, t.object);
      kgEntityNames.add(t.subject);
      kgEntityNames.add(t.object);
      const count = { redactions: 0 };
      await kgTripleBatch.add(redactDeep({
        subject: t.subject, predicate: t.predicate, object: t.object,
        valid_from: t.validFrom ?? null, valid_to: null,
        confidence: t.confidence ?? 1.0, source_session: sourceSession,
      }, count));
      redactions += count.redactions;
    }
  };
  let scanMs = 0, scanned = 0; // secret-scan metrics

  const slice = refs.slice(0, opts.limit ?? refs.length);

  // CHAT_RECALL_SYNC_TRACE=1: phase + progress markers with heap usage, to
  // stderr. This is how the 2026-07-03 walk OOM was localized — keep it.
  const trace = process.env.CHAT_RECALL_SYNC_TRACE === '1'
    ? (msg: string) => { const m = process.memoryUsage(); console.error(`[sync-trace] ${msg} · heap=${(m.heapUsed / 1048576).toFixed(0)}MB rss=${(m.rss / 1048576).toFixed(0)}MB`); }
    : null;
  trace?.(`walk start: ${slice.length} ref(s) → ${base}`);

  // ── Derived-field reconciliation (native title, …) — runs FIRST, BEFORE the
  // heavy conversation walk, so it's never blocked by per-session git/replay
  // compute (titles flow even when the conversation phase is slow). Pushes only
  // {session_id, field, value}, never a conversation. Cheap pass over the
  // sessions this sync listed; a one-time full pass per field when its version
  // bumped or a re-scan was forced. Best-effort — a reconcile failure must not
  // fail the conversation sync.
  if (upload.sessionMeta) {
    try {
      await reconcileFieldsForTarget(
        cred,
        () => listAvailableBackends().flatMap((b) => { try { return b.listSessions({}); } catch { return []; } }),
        { convRefs: slice },
      );
    } catch (e) {
      console.error(`[sync] field reconcile (${base}): ${e instanceof Error ? e.message : e}`);
    }
  }
  trace?.('field reconcile done');

  // Shared gate: classify each session's sync mode for this tick. Used by
  // both the batch pre-scan and the upload loop so they stay in lockstep.
  // See docs/SYNC-INCREMENTAL.md for the skip/append/full decision.
  const backendFor = (ref: SessionRef) => getBackendForId(ref.prefixedId);
  const modeOf = (ref: SessionRef): 'skip' | 'append' | 'full' => {
    if (excludeTools.has(ref.toolId as any)) return 'skip';
    if (excluded(ref.projectPath)) return 'skip';
    if (!includedProject(ref.projectPath)) return 'skip';
    if (!ledger) return ref.mtime >= (opts.sinceMs ?? 0) ? 'full' : 'skip';
    const ack = ledger.get(ref.prefixedId);
    const backend = backendFor(ref);
    // A session that exists in more than one home cannot be tail-appended: the
    // size is the SUM across copies while a byte offset addresses one file, so
    // an append would ship bytes that do not match the recorded offset. Force
    // FULL, which ships the unioned container and is correct either way.
    const split = !!backend?.spansMultipleSources?.(ref.prefixedId);
    const isAO = !!backend?.isAppendOnly?.() && !split;
    const size = isAO ? (backend?.fileSize?.(ref.prefixedId) ?? 0) : 0;
    return syncMode(ack, ref.mtime, size, extractorVersionForTool(ref.toolId), isAO);
  };
  const willBuild = (ref: SessionRef): boolean => modeOf(ref) !== 'skip';

  // ── Batch secret scan (optional external detectors) ────────────────
  // Only runs when CHAT_RECALL_EXTERNAL_SCANNERS=1 and gitleaks/trufflehog are
  // on PATH — `scanSecrets` above already folds that gate in, so by default
  // nothing here executes and no raw text is ever written to disk.
  //
  // gitleaks/trufflehog are directory-capable and report each finding's file.
  // Materialize to-be-FULL-synced sessions' raw text into a temp dir (filename
  // = sanitized session id), scan the dir ONCE per detector, then map findings
  // back to sessions by filename. That replaces 2·N cold process spawns (the
  // dominant per-session cost) with 2 per SLICE. null ⇒ no batch ran (scanning
  // off) and buildConversationSync falls back to its per-session path.
  //
  // SLICED, not one big dir: this text is PRE-redaction — real credentials in
  // cleartext on the customer's disk — and cleanup lives in a `finally` that a
  // SIGKILL/OOM skips (that is how 3.4GB / 309k files were left behind in
  // /tmp). Bounding the dir to BATCH_SCAN_MAX_BYTES bounds the worst-case
  // exposure and the worst-case leak to that many bytes, at a cost of 2 extra
  // spawns per additional slice.
  //
  // APPEND sessions are excluded — they skip external detectors (the head was
  // already scanned; the tail uses builtin regex only; the FULL re-sync when
  // the session closes covers the whole file).
  let externalFindings: Map<string, ScanFinding[]> | null = null;
  if (scanSecrets) {
    externalFindings = new Map();
    // Oversized sessions are excluded: exportRawSession would materialize the
    // whole file (hundreds of MB — this loop is what OOM-killed the daemon).
    // Their bounded tail still gets the builtin scan in buildConversationSync.
    const toScan = slice.filter((ref) => modeOf(ref) === 'full' && sessionFileBytes(ref) <= FULL_BUILD_MAX_BYTES);
    trace?.(`batch secret scan start: ${toScan.length} session(s), ≤${(BATCH_SCAN_MAX_BYTES / 1048576).toFixed(0)}MB per slice`);
    const batch = batchScanExternal(
      toScan.map((ref) => ({
        id: ref.prefixedId,
        text: () => {
          const backend = getBackendForId(ref.prefixedId) ?? getBackend('claude');
          const exp = backend.exportRawSession(ref.prefixedId);
          const container = exp ? buildRawContainer(exp) : null;
          return container ? container.files.map((f) => f.text).join('\n') : null;
        },
      })),
      { verifyOnly: verifySecretsScan },
    );
    externalFindings = batch.findings;
    scanned = batch.scanned;
    scanMs = batch.scanMs;
    trace?.(`batch secret scan done: ${scanned} session(s) in ${batch.slices} slice(s)`);
  }

  trace?.('conversation walk start');
  // Say that a walk STARTED, before anything is done. A first sync on a large
  // corpus runs for a long time, and "0 of 15,724" is the difference between a
  // user waiting and a user assuming it is broken.
  const walkStartedAt = Date.now();
  reportWalkProgress({ done: 0, total: slice.length, startedAt: walkStartedAt, complete: false });
  walkProgressForUpload = { done: 0, total: slice.length, complete: false };
  let traceN = 0;
  // ── KEEP THE EVENT LOOP ALIVE ───────────────────────────────────────────
  //
  // THIS IS WHY THE COLLECTOR LOOKED DEAD. Every `await` in this loop resolves
  // as a MICROTASK, and Node drains the entire microtask queue before it
  // advances to the timer phase. So a backlog of sessions — each one followed by
  // a multi-second synchronous secret scan — runs as ONE unbroken chain, and for
  // its whole duration nothing else in the process happens:
  //
  //   · the 60-second heartbeat never fires, so the log goes silent
  //   · collector-health.json freezes, so every reader says "not running"
  //   · SIGCHLD is not serviced, so a finished codeindex child sits <defunct>
  //   · SIGTERM is not serviced, so systemd waits 90s and then SIGKILLs
  //
  // Measured: 12 sessions, 388 MB, 24.2 seconds of walking, ZERO of 24 expected
  // heartbeats. With `setImmediate` between sessions — the check phase runs
  // AFTER the timer phase — the same work fired 11. The daemon was never hung;
  // it simply never yielded, and "never yields for nine minutes" is
  // indistinguishable from dead to everything watching it.
  //
  // Once per session, unconditionally. A first version gated this behind a
  // 50 ms budget to avoid "wasting" loop turns on the ~15,700 refs that skip in
  // microseconds — then measured it: 15,727 unconditional yields cost 37.9 ms
  // total, 2.4 µs each, against a walk that takes over a minute. The budget
  // bought nothing and cost an arbitrary constant plus a clock read in the hot
  // path, so it is gone. One yield per iteration is deterministic and needs no
  // tuning.
  //
  // NOT THE WHOLE ANSWER, and worth being clear about: this makes the process
  // RESPONSIVE while it works, it does not make the work faster. The scan is
  // pure, CPU-bound and uses one of this machine's twelve cores. Moving it to
  // worker_threads is the real fix — it would keep the main thread completely
  // free AND parallelise across cores. That is a much larger change; yielding is
  // the correct minimal one, and it is what turns "the collector is dead" back
  // into "the collector is busy".
  let considered = 0;
  for (const ref of slice) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    // PROGRESS COUNTS SESSIONS CONSIDERED, not sessions shipped.
    //
    // Reporting `walked` (the shipped count) looked right and was useless: on an
    // already-synced corpus the ledger skips ~15,700 of 15,727 sessions, so the
    // report sat at "0 of 15,727 (0%)" for the whole walk and then vanished.
    // What a waiting user needs to know is how much of the corpus has been
    // LOOKED AT, which is this counter and matches the denominator.
    considered++;
    // complete is `considered === slice.length`, not a constant false.
    //
    // The post-loop report below sets complete:true, but it lands after the last
    // upload has gone out, so it only ships on the NEXT post — and a walk with
    // nothing new to upload never makes one. The server was therefore left
    // holding done === total with complete:false forever, and the UI read that
    // as "syncing 99%" until something else happened to sync.
    const walkDone = considered >= slice.length;
    reportWalkProgress({ done: considered, total: slice.length, startedAt: walkStartedAt, complete: walkDone });
    walkProgressForUpload = { done: considered, total: slice.length, complete: walkDone };
    if (trace && ++traceN % 500 === 0) trace(`walk ${traceN}/${slice.length} · at ${ref.prefixedId}`);
    localSessionIds.add(ref.prefixedId);
    const mode = modeOf(ref);
    if (mode === 'skip') { skipped++; continue; }
    trace?.(`build (${mode}) ${ref.prefixedId} · ${(sessionFileBytes(ref) / 1048576).toFixed(1)}MB`);

    // ── APPEND: tail-only ship (no raw_b64, no telemetry, no derived) ──
    // `promotedForFindings` flips true when the tail carried a secret finding:
    // the server replaces findings wholesale per session, so a tail-only ship
    // would WIPE the head's findings. Instead of hiding the tail's secret until
    // some far-future FULL re-sync, we fall through to the FULL path NOW (which
    // re-scans head+tail and ships the complete set). Rare event — a secret
    // pasted into a long-lived, still-appending session.
    let promotedForFindings = false;
    if (mode === 'append' && ledger) {
      const ack = ledger.get(ref.prefixedId)!;
      try {
        const tail = await buildConversationTail(ref, ack.o ?? 0, { mapPath, tenantRules });
        if (tail && tail.findings.length > 0) {
          promotedForFindings = true;   // fall through to FULL (do NOT continue)
        } else if (tail) {
          redactions += tail.redactions;
          await appendAdd(tail.conv);
          walked++;
          if (walked % 250 === 0) console.error(`[sync] ${walked}/${slice.length} sessions…`);
          continue;
        } else {
          // Nothing new to ship (tail empty/unparseable). Stamp the MTIME only.
          //
          // This used to re-stamp the cursor at the local fileSize() to stop the
          // gate retrying every tick. That was a delivery receipt for bytes the
          // server never received: once fileSize() started summing profile homes,
          // the cursor jumped to the union size and the session was sealed as
          // complete with a third of its records missing (7adc748c: 2004 of
          // 2698). mtime alone gives the same anti-thrash — syncMode SKIPs an
          // unchanged file on mtime — while leaving the cursor where the server
          // actually is, so the next growth re-attempts from the true offset.
          try { markSynced(base, [{ id: ref.prefixedId, mtime: ref.mtime }]); }
          catch { /* ledger — best-effort */ }
          skipped++;
          continue;
        }
      } catch (err) {
        console.error(`[sync] append tail failed for ${ref.prefixedId} (will retry as full next tick): ${err instanceof Error ? err.message : err}`);
        // Don't mark synced → next tick re-classifies. If the tail failed, a
        // FULL sync is the safe fallback (the gate sees an unchanged cursor).
        skipped++;
        continue;
      }
    }

    // ── FULL: the existing whole-conversation path ──
    // Canonical envelope (live): parse the transcript NOW with THE parser —
    // no local content cache is read or warmed. What ships is exactly what
    // the local dashboard would render for the same file.
    const mtime = Math.floor(ref.mtime) || 0;
    // Hand this session its slice of the batch-scan results (when scanning is
    // on). `?? []` means "batch ran, found nothing here" — distinct from the
    // `undefined` that triggers the per-session fallback inside the builder.
    // A session promoted from append (secret in the tail) wasn't in the batch
    // scan set — pass undefined so buildConversationSync runs the per-session
    // external detector over the whole file, yielding the COMPLETE finding set.
    const precomputedExternal = promotedForFindings
      ? undefined
      : (externalFindings ? (externalFindings.get(ref.prefixedId) ?? []) : undefined);
    // Only trust the ledger's content hash for the skip-gate when the row is at
    // the current extractor version — a version bump must force a real re-derive
    // even if the transcript bytes are unchanged.
    const ackRow = ledger?.get(ref.prefixedId);
    const priorContentHash = ackRow && ackRow.v >= extractorVersionForId(ref.prefixedId) ? ackRow.h : undefined;
    const built = await buildConversationSync(ref, mtime, { mapPath, includeRaw: upload.raw, includeMeta: upload.sessionMeta, scanSecrets, verifySecrets: verifySecretsScan, tenantRules, precomputedExternal, priorContentHash });
    if (built && 'unchanged' in built) {
      // Content byte-identical to the last FULL sync to this target (mtime bumped
      // / resume rewrite / OpenCode summary bump). Nothing to re-ship, re-extract
      // or git-replay. Re-stamp the ledger exactly as a real FULL ack would —
      // mtime, the (unchanged) hash, and the current byte cursor — so the NEXT
      // tick reaches a true SKIP and doesn't even re-export. Byte-identical
      // content ⇒ identical size, so the cursor we write equals the one already
      // there for append-only backends; for OpenCode fileSize() is absent (0).
      if (ledger) {
        try {
          // Content is byte-identical to the last FULL sync, so the server
          // already holds these bytes — that makes this a legitimate ack. But
          // only up to the cursor it already had: if the local size now EXCEEDS
          // it (e.g. fileSize() sums a second profile home that was never
          // shipped), advancing would again receipt undelivered bytes.
          const off = getBackendForId(ref.prefixedId)?.fileSize?.(ref.rawId) ?? 0;
          const priorCursor = ackRow?.s ?? 0;
          const safeToAck = off > 0 && off <= priorCursor;
          markSynced(base, [safeToAck
            ? { id: ref.prefixedId, mtime: ref.mtime, offset: off, size: off, hash: built.srcHash, acked: true }
            : { id: ref.prefixedId, mtime: ref.mtime, hash: built.srcHash }]);
        }
        catch { /* ledger is local bookkeeping — never fail a sync over it */ }
      }
      skipped++;
      continue;
    }
    if (!built) {
      // Nothing worth shipping for THIS content — empty, unparseable, or one
      // of chat-recall's own internal LLM invocations (roughly half of all
      // "sessions" on a busy machine). Every null verdict is a pure function
      // of file content, so ack it at this mtime: without the ack these
      // sessions re-classify as FULL on every full walk, forever — observed
      // as ~5k sessions re-exported and re-secret-scanned per 15-min
      // heartbeat (4GB+ heap peak, 12-minute walks, heap-OOM crash loops).
      // A real content change bumps mtime and re-evaluates.
      if (ledger) {
        try { markSynced(base, [{ id: ref.prefixedId, mtime: ref.mtime }]); }
        catch { /* ledger is local bookkeeping — never fail a sync over it */ }
      }
      skipped++;
      continue;
    }
    redactions += built.redactions;

    // Remember the content hash so the convBatch ack stamps ledger `h` (enables
    // the mtime-only skip on a later tick). Undefined for the oversized-tail path.
    if (built.srcHash) shippedHash.set(ref.prefixedId, built.srcHash);
    await convBatch.add(built.conv);
    // Ship this session's secret findings as one group (server replaces wholesale).
    if (built.findings.length > 0) await findingsBatch.add(built.findings);

    // Knowledge graph: extract triples live from the redacted conversation
    // text (no local KG DB is read). Accumulated + deduped, flushed at the end.
    if (upload.sessionMeta) {
      await accumulateKg(extractEntities(built.kgText, { projectPath: built.projectPath, sourceType: 'session', sessionId: ref.prefixedId, validFrom: ref.mtime ? new Date(ref.mtime).toISOString().slice(0, 10) : undefined }), ref.prefixedId);
    }

    // Derived data — the CLI has the FS/git/transcript, the server doesn't.
    // Always computed live (diff/outcome/commits/markers + badge row); no
    // local compute/outcome cache is read or warmed. Oversized transcripts are
    // excluded: replay/outcome re-read the WHOLE file (readEvents), and a
    // 353MB session with 100MB+ single JSON lines OOMed the walk right after
    // its (bounded) conversation shipped.
    if (upload.sessionMeta && sessionFileBytes(ref) <= FULL_BUILD_MAX_BYTES) {
      try {
        const count = { redactions: 0 };
        // OFF THE MAIN THREAD. This is the heaviest work in the walk: replay,
        // outcome and turns each read the whole transcript and shell out to git,
        // measured at ~5 seconds per session against 78ms for the secret scan.
        // It was the entire remaining tail of a walk — 15,500 sessions skip in
        // seconds, then the couple of hundred that need rebuilding take minutes,
        // all of it on the thread that has to answer signals.
        //
        // Only an id crosses the boundary; the worker reads the transcript
        // itself. Null means the pool could not take it, and the inline path —
        // the code that shipped before this — runs instead.
        const offloaded = await scanPool().runDerived({
          prefixedId: ref.prefixedId, toolId: ref.toolId, mtime,
          maxRowBytes: MAX_DERIVED_ROW_BYTES,
          pack: lastServerPackSpec && scanPool().needsPack(lastServerPackSpec.version)
            ? { version: lastServerPackSpec.version, rules: lastServerPackSpec.rules }
            : undefined,
          packVersion: lastServerPackSpec?.version ?? '',
        });
        if (offloaded?.rows) {
          redactions += offloaded.redactions;
          await derivedBatch.add(offloaded.rows);
        } else {
          await derivedBatch.add(collectDerivedRows(ref, mtime, count, MAX_DERIVED_ROW_BYTES));
          redactions += count.redactions;
        }
      } catch (err) {
        // Derived is best-effort — the conversation still shipped — but it must
        // NOT be silent: a derived failure means this session shows empty
        // diffs/Activity on the server, and a SILENT swallow here is exactly why
        // a stale-data regression went unnoticed for days. Log it so it's
        // visible and diagnosable.
        console.error(`[sync] derived compute failed for ${ref.prefixedId} (diffs/Activity will be empty for it): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Fork lineage link (collected at index time too; shipping here keeps
    // sync self-sufficient for sessions the indexer hasn't visited).
    try {
      const { detectForkPredecessor } = await import('@chat-recall/engine/transcript/raw.js');
      if (ref.fullPath) {
        const predecessor = detectForkPredecessor(ref.fullPath);
        if (predecessor) {
          await linksBatch.add({
            source_type: 'session', source_id: ref.prefixedId,
            target_type: 'session', target_id: predecessor,
            link_type: 'forked_from', confidence: 1.0,
          });
        }
      }
    } catch { /* best-effort */ }

    walked++;
    if (walked % 250 === 0) console.error(`[sync] ${walked}/${slice.length} sessions…`);
  }

  // ── Non-session sources: plan/task/claude_md/history/paste/diary/skill/
  //    mcp/command/agent/hook/plugin. Same registry the indexer uses, so
  //    sync coverage tracks index coverage automatically. Session-type
  //    sources are skipped — sessions ship as conversations above.
  //    (excludeTools is session-only: source plugins don't carry a tool id.)
  // Per-tool item-extractor versions (see sync-ledger). A tool whose recorded
  // version is below its current version re-ships ALL its items ONCE (mtime
  // gate bypassed), so an attribution/extraction fix self-heals — same idea as
  // sessions, at the tool level. Unrecorded tools seed at EXTRACTOR_VERSION
  // (base), so only tools bumped ABOVE base (e.g. agy) re-ship on first run —
  // not a blanket re-ship of every item.
  const itemVersions = loadItemVersions(base);
  const seenTools = new Set<string>();
  const seenItemKeys = new Map<string, number>();
  const registry = buildSourceRegistry();
  for (const sourceType of registry.getRegisteredTypes()) {
    if (sourceType === 'session') continue;
    for (const source of registry.getAll(sourceType)) {
      let discovered: AsyncGenerator<any>;
      try { discovered = source.discover(); } catch { continue; }
      try {
        for await (const item of discovered) {
          const itemTool = toolOfId(item.id);
          seenTools.add(itemTool);
          // Keyed by tool AND source type: a payload change to skills must not
          // re-walk that tool's plans and tasks, and must not touch sessions at
          // all (they use a different ledger and a different version).
          const itemKey = `${itemTool}:${item.sourceType}`;
          seenItemKeys.set(itemKey, extractorVersionForItem(item.id, item.sourceType));
          const versionStale = (itemVersions[itemKey] ?? EXTRACTOR_VERSION) < extractorVersionForItem(item.id, item.sourceType);
          if ((item.mtime || 0) < (opts.sinceMs ?? 0) && !versionStale) continue;
          if (excluded(item.projectPath || '')) continue;
          if (!includedProject(item.projectPath || '')) continue;
          const count = { redactions: 0 };
          let chunks: any[] = [];
          try { chunks = await source.parse(item); } catch { /* unparseable item still ships metadata */ }
          // Project id resolved live on THIS machine (git/FS available); the
          // server stores it verbatim. `ignored:` rules mean "no project".
          const resolved = resolveProjectId(item.projectPath || '');
          const projectId = resolved.source === 'ignored' ? '' : resolved.id;
          const redactedChunks = chunks
            .filter((c) => c.text?.trim())
            .map((c) => ({
              text: redactSecrets(c.text, { force: true, count }),
              chunk_type: c.chunkType || '',
              // Chunk titles are derived from message text and so can carry a
              // secret exactly like the body can. This was the one field on the
              // upload path that shipped raw.
              title: redactSecrets(c.title || '', { force: true, count }),
            }));
          await itemsBatch.add({
            id: item.id,
            source_type: item.sourceType,
            project_id: projectId || undefined,
            title: redactSecrets(item.title || '', { force: true, count }),
            project_path: mapPath(item.projectPath || ''),
            content_preview: redactSecrets(item.contentPreview || '', { force: true, count }),
            mtime: Math.floor(item.mtime) || 0,
            extra: item.extra ? redactDeep(item.extra, count) : undefined,
            chunks: redactedChunks,
          });
          // KG: extract triples live from this item's redacted chunk text.
          if (upload.sessionMeta && redactedChunks.length > 0) {
            await accumulateKg(
              extractEntities(redactedChunks.map((c) => c.text).join('\n'), { projectPath: item.projectPath || '', sourceType: item.sourceType, validFrom: item.mtime ? new Date(Number(item.mtime)).toISOString().slice(0, 10) : undefined }),
              null,
            );
          }
          try {
            for (const l of await source.extractLinks(item)) {
              await linksBatch.add({
                source_type: l.sourceType, source_id: l.sourceId,
                target_type: l.targetType, target_id: l.targetId,
                link_type: l.linkType, confidence: l.confidence,
              });
            }
          } catch { /* links are best-effort */ }
          redactions += count.redactions;
        }
      } catch (err) {
        // One broken source must not kill the sync — but a SYSTEMATICALLY failing
        // source (bad discover/parse) would otherwise silently ship zero items
        // for its type forever, with no signal. Log it (once per source per run).
        console.error(`[sync] source '${sourceType}' failed mid-walk (its items may be incomplete this run): ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Knowledge graph (live). Triples were extracted on the spot from each
  //    session/item's redacted text during the walks above — so what ships is
  //    exactly the facts derivable from the sessions in THIS sync (which is
  //    also the incremental-correct set: no manual-fact replay, no local KG
  //    DB). Entities are derived from the triple subjects/objects, typed from
  //    any `is_a` triple seen in the same pass.
  // Triples already shipped inside accumulateKg (see above). Entities cannot:
  // a name's type comes from an `is_a` triple that may appear in any later
  // session, so the type is only known once the walk is over. The names are
  // held as a Set, bounded by distinct entities rather than by session count.
  if (upload.sessionMeta && kgEntityNames.size > 0) {
    for (const name of kgEntityNames) {
      const count = { redactions: 0 };
      await kgEntityBatch.add(redactDeep({ name, type: kgEntityType.get(name) ?? 'unknown', properties: {} }, count));
      redactions += count.redactions;
    }
  }

  // ── Drain every batcher (the walks above flushed full windows already;
  // this ships the tails). The append batch flushes BEFORE the inflight
  // barrier so its full_resync_needed set is populated before we process it.
  await appendFlush();
  // Server said full_resync_needed for these append sessions (no prior
  // envelope on the server). Wipe their ledger rows so the next tick
  // classifies them as FULL (never-synced) instead of retrying append or
  // skipping — which would leave the server without the data forever.
  for (const id of appendResults.fullResyncNeeded) {
    try { markFullResync(base, id); } catch { /* ledger — best-effort */ }
  }
  await convBatch.drain();
  await itemsBatch.drain();
  await linksBatch.drain();
  await derivedBatch.drain();
  await kgEntityBatch.drain();
  await kgTripleBatch.drain();
  await findingsBatch.drain();
  // Barrier: wait for every pooled upload to land (and surface any fatal
  // error) before tombstones/prune, which must run strictly after all data.
  await drainInflight();

  // Items shipped successfully → record each seen tool's current item-extractor
  // version, so a version-triggered re-ship (e.g. the agy attribution fix)
  // happens exactly ONCE per bump instead of every sync. Best-effort.
  if (seenTools.size > 0) {
    try {
      const rec: Record<string, number> = {};
      for (const t of seenTools) rec[t] = extractorVersionForTool(t);
      // Stamp the per-(tool, source) keys too, so a source-payload bump
      // re-ships exactly once rather than on every sync afterwards.
      for (const [k, v] of seenItemKeys) rec[k] = v;
      saveItemVersions(base, rec);
    } catch { /* local bookkeeping — best-effort */ }
  }

  // ── Tombstones for sessions this device previously synced but that no
  //    longer exist locally (deleted transcript file, cleared cache, etc).
  //    We only tombstone sessions we have a ledger record for — never data
  //    from other devices. STRICTLY full-walk only: a changed-scope walk
  //    lists only recent sessions, so "in ledger but not walked" means
  //    "old and unchanged", NOT "deleted" — tombstoning there would wipe
  //    every quiet session from the server.
  if (ledger && !changedWalk) {
    const tombstones: Array<{ session_id: string; deleted_at: number }> = [];
    for (const [sessionId] of ledger) {
      if (!localSessionIds.has(sessionId)) {
        tombstones.push({ session_id: sessionId, deleted_at: Date.now() });
      }
    }
    if (tombstones.length > 0) {
      await post({ tombstones });
      // Remove tombstoned ids from the ledger so we don't keep shipping them.
      const data = getLedgerData(base);
      for (const t of tombstones) delete data[t.session_id];
      persistLedgerData(base, data);
    }
  }

  if (opts.prune) await post({ prune_empty_sessions: true });

  // The walk finished. Marking it complete is what stops every later reader
  // showing a frozen "8,400 of 15,724" forever — and it is also how a reader
  // tells a finished walk from a daemon that died mid-walk, which is the state
  // an in-progress value left behind means.
  reportWalkProgress({ done: slice.length, total: slice.length, startedAt: walkStartedAt, complete: true });
  walkProgressForUpload = { done: slice.length, total: slice.length, complete: true };

  return {
    uploaded: convBatch.sent + appendResults.uploaded, skipped, redactions,
    items: itemsBatch.sent, links: linksBatch.sent, findings: findingsBatch.sent, derived: derivedBatch.sent,
    kgEntities: kgEntityBatch.sent, kgTriples: kgTripleBatch.sent,
    scanned, scanMs: Math.round(scanMs),
  };
}

/**
 * Build the live per-session conversation payload — the THIN-COLLECTOR core.
 * Reads ONLY the raw transcript (via `parseTranscript` + `parseSessionFile`),
 * never the local store. Returns the conversation row exactly as the server
 * ingest expects it, plus the redacted plain text (for live KG extraction)
 * and the redaction count. Returns null when there's nothing worth shipping.
 *
 * Exported so the payload can be exercised in tests with no server and no
 * pre-populated index (see sync-client.test.ts).
 */
export interface BuiltConversation {
  conv: Record<string, unknown>;
  /** Redacted conversation text — feed to `extractEntities` for the KG. */
  kgText: string;
  /** Real project path resolved from the transcript cwd (for KG context). */
  projectPath: string;
  redactions: number;
  /** Masked secret findings from the raw session (built-in regex always, plus
   *  gitleaks/trufflehog/tenant rules when installed), shipped to the server's secret_findings. */
  findings: Array<{ session_id: string; detector: string; rule: string; line: number; preview: string; verified_at?: string | null }>;
  /** Wall-clock ms spent scanning this session (0 if nothing to scan). */
  scanMs: number;
  /** Content fingerprint of the transcript this payload was built from
   *  (containerSrcHash of the raw export). The walk stamps it into the ledger so
   *  a later mtime-only bump with identical content can skip the whole rebuild.
   *  Undefined for the oversized-tail path (no full container is materialized). */
  srcHash?: string;
}

/** buildConversationSync's early-out when the caller passed a priorContentHash
 *  that matches the freshly-exported content: nothing changed since the last
 *  FULL sync, so the caller just re-stamps the ledger mtime and skips. */
export interface UnchangedConversation { unchanged: true; srcHash: string; }

/** Transcript bytes beyond which a FULL sync must not materialize the whole
 *  file. The FULL pipeline copies the transcript ~5× (parse, trim+redact,
 *  raw export, raw-text join, redacted container) — a 350MB session transiently
 *  needs >1.5GB of heap, which OOM-killed the watch daemon in a restart loop
 *  (ledger never acked → same file retried on every startup tick, forever). */
export const FULL_BUILD_MAX_BYTES =
  Math.max(8, parseInt(process.env.CHAT_RECALL_FULL_BUILD_MAX_MB || '64', 10)) * 1024 * 1024;
/** How much of an oversized transcript's tail still ships (newest content). */
const FULL_BUILD_TAIL_BYTES = 16 * 1024 * 1024;

/** Ceiling on PRE-REDACTION session text materialized on disk at any one moment
 *  by the optional external-detector batch scan. The batch dir is flushed and
 *  deleted every time it crosses this, so a SIGKILL/OOM mid-scan can strand at
 *  most this many bytes of cleartext (the incident stranded 3.4GB), and the
 *  window in which they exist is proportionally short. Raising it buys fewer
 *  detector spawns; lowering it buys a smaller blast radius. */
export const BATCH_SCAN_MAX_BYTES =
  Math.max(1, parseInt(process.env.CHAT_RECALL_BATCHSCAN_MAX_MB || '64', 10)) * 1024 * 1024;

/** Bytes an append-only session occupies on disk (0 for non-AO backends). */
export function sessionFileBytes(ref: SessionRef): number {
  const backend = getBackendForId(ref.prefixedId);
  if (!backend?.isAppendOnly?.()) return 0;
  return backend.fileSize?.(ref.prefixedId) ?? 0;
}

export async function buildConversationSync(
  ref: SessionRef,
  mtime: number,
  opts: { mapPath?: (p: string) => string; includeRaw?: boolean; includeMeta?: boolean; scanSecrets?: boolean; verifySecrets?: boolean; tenantRules?: Array<{ name: string; regex: string }>;
    /** Batch-scan results for THIS session (gitleaks/trufflehog already run
     *  over a directory). When provided, skip the per-session subprocess scan
     *  and use these instead — built-in regex + tenant rules still run inline. */
    precomputedExternal?: ScanFinding[];
    /** The content hash this target last FULL-synced (ledger `h`). When the
     *  freshly-exported transcript hashes equal to it, the whole build is
     *  redundant — we bail immediately with { unchanged, srcHash } so the caller
     *  just advances the ledger mtime. Only pass it when the ledger row is at the
     *  current extractor version (else a re-derive is genuinely owed). */
    priorContentHash?: string } = {},
): Promise<BuiltConversation | UnchangedConversation | null> {
  const mapPath = opts.mapPath ?? ((p: string) => p);
  let includeRaw = opts.includeRaw !== false;
  let includeMeta = opts.includeMeta !== false;
  let srcHash: string | undefined;

  // Oversized-transcript guard: ship the newest FULL_BUILD_TAIL_BYTES as this
  // session's FULL sync instead of materializing the whole file. The envelope
  // is marked truncated, raw/meta (whole-file reads) are dropped, and
  // from_offset = file size — so the ledger advances and every later tick is
  // a normal bounded APPEND. Truncation only loses the transcript's OLD head.
  const fileBytes = sessionFileBytes(ref);
  const oversized = fileBytes > FULL_BUILD_MAX_BYTES;
  let tailText = '';
  let tailOffsetEnd = 0;

  // Parse the transcript live — this is the single canonical parse; the
  // envelope and the redacted text both come from it. When the shadow path
  // runs (normal-size sessions) it also yields the fullest raw container, which
  // the secret scan + raw archive below reuse instead of re-exporting.
  let transcript: { messages: any[]; subagents: any[] } | null = null;
  let fullestContainer: RawContainer | null = null;
  if (oversized) {
    const backend = getBackendForId(ref.prefixedId);
    if (!backend?.readFromOffset) return null;
    try {
      const tail = await backend.readFromOffset(ref.prefixedId, fileBytes - FULL_BUILD_TAIL_BYTES);
      tailText = tail.text;
      tailOffsetEnd = tail.newOffset;
      const messages = parseTailMessages(ref.toolId, tailText);
      if (messages.length > 0) transcript = { messages, subagents: [] };
    } catch { /* unreadable tail */ }
    includeRaw = false;   // exportRawSession would read the whole file
    includeMeta = false;  // parseSessionFile would read the whole file
    // NB: oversized sessions are NOT shadowed — a full export would OOM the
    // walk (the very reason for the tail path). A session truncated FROM
    // oversized down to normal falls back to a fresh 'created' shadow; the
    // recovery command backfills its pre-truncation history from the archive.
  } else {
    // Export the raw transcript ONCE, fold it into the shadow archive, and
    // parse the FULLEST-known state. If an upstream tool truncated the file in
    // place (e.g. a Claude Code 2.1.20x `--resume` rewrite), the shadow still
    // holds the lost history, and the merged container — not the shrunken disk
    // file — is what we parse and ship. The server therefore never sees a
    // shrink, and every viewer tab keeps its full history.
    try {
      const backend = getBackendForId(ref.prefixedId) ?? getBackend('claude');
      const exp = backend.exportRawSession(ref.prefixedId);
      // Content-identity gate: hash the raw export (mtime-independent) BEFORE the
      // shadow merge / parse / redact / KG / git-replay. If it equals what this
      // target last FULL-synced, nothing downstream can differ — bail now. This
      // is what stops a resume-truncated or mtime-touched session from being
      // fully rebuilt on every tick (the export/read still happens — it's how we
      // know — but everything expensive after it is skipped).
      // Build the container ONCE. The hash is needed before the shadow is
      // touched (a content match short-circuits the whole session), and
      // updateShadow used to build a second identical copy from the same
      // export — a wasted copy of every byte on a 47 MB transcript.
      let built: RawContainer | undefined;
      if (exp) {
        try {
          built = buildRawContainer(exp);
          srcHash = containerSrcHash(built);
        } catch { built = undefined; srcHash = undefined; }
        if (srcHash && opts.priorContentHash && srcHash === opts.priorContentHash) {
          return { unchanged: true, srcHash };
        }
        // THE SIZE GUARD, MEASURED ON WHAT WE ACTUALLY HAVE.
        //
        // `oversized` above is decided from sessionFileBytes(), which returns 0
        // for any backend that is not append-only — OpenCode implements neither
        // fileSize() nor isAppendOnly(), because its sessions live in SQLite and
        // have no file at all. So for those the ceiling never fired and a huge
        // session took the FULL path: replay and computeOutcome each re-read the
        // whole thing, and a 353 MB session with 100 MB JSON lines OOMed the walk.
        //
        // The export has already happened by here, and it is bounded by the
        // session's real size. What this protects is everything AFTER it — the
        // scan, the redact, the git replay, the derived compute — which is where
        // the memory actually went. Measuring the container closes the guard for
        // every backend, including any whose fileSize() under-reports.
        const containerBytes = built
          ? built.files.reduce((n, f) => n + Buffer.byteLength(f.text), 0)
          : 0;
        if (containerBytes > FULL_BUILD_MAX_BYTES) {
          console.error(`[sync] ${ref.prefixedId} is ${(containerBytes / 1048576).toFixed(0)}MB `
            + `(over the ${(FULL_BUILD_MAX_BYTES / 1048576).toFixed(0)}MB ceiling) — shipping without `
            + 'the raw archive and derived data to keep the walk in memory');
          // Size and tool only. Knowing that customers hit this, and how big
          // their sessions get, is how the ceiling gets set from evidence rather
          // than from one developer's corpus.
          record({ kind: 'oversized_session', mb: Math.round(containerBytes / 1048576), tool: ref.toolId });
          includeRaw = false;
          includeMeta = false;
        }
      }
      const shadow = updateShadow(ref.rawId, exp, built);
      if (shadow.container) {
        fullestContainer = shadow.container;
        if (shadow.status === 'rewrite-merged' && shadow.recovered > 0) {
          console.error(`[sync] shadow recovered ${shadow.recovered} record(s) for ${ref.prefixedId} after an upstream rewrite/truncation`);
        }
        const t = parseTranscriptFromContainer(shadow.container);
        if (t.messages.length > 0 || t.subagents.length > 0) transcript = { messages: t.messages, subagents: t.subagents };
      }
    } catch { /* shadow/export failed — fall back to the live parse below */ }
    if (!transcript) {
      try {
        const t = await parseTranscript(ref.prefixedId);
        if (t && (t.messages.length > 0 || t.subagents.length > 0)) transcript = t;
      } catch { /* unparseable */ }
    }
  }
  if (!transcript) return null;

  const textMessages = transcript.messages.filter((m) => m.role !== 'summary' && m.content?.trim());
  if (textMessages.length === 0 && !transcript.messages.some((m) => m.toolCalls?.length)) return null;

  // Skip chat-recall's OWN LLM invocations that the AI CLI logged as sessions —
  // summary generation and health-check pings. On this machine ~half of all
  // "sessions" were these internal calls; indexing them buries the real
  // conversation list. Anchored to the first user message so a real chat that
  // merely quotes the prompt is not dropped.
  const firstUser = textMessages.find((m) => m.role === 'user');
  if (isInternalToolPrompt(firstUser?.content)) return null;

  // Trim payload bodies (tool inputs/results, thinking — raw replay never
  // ships), then redact every string. Counts are preserved exactly.
  const count = { redactions: 0 };
  const envelope = redactDeep(
    { v: TRANSCRIPT_VERSION, ...trimTranscriptForSync(transcript) },
    count,
  ) as { v: number; messages: any[]; subagents: any[] };

  // Live telemetry: parse the raw session file with THE metadata parser
  // (tokens/cost/models/tools/duration/branch/files). Replaces the former
  // local-store `extra_json` read. The metadata parser is Claude-JSONL shaped;
  // for other tools the fields it can't read stay at their zero defaults,
  // which is the same behaviour as an un-indexed session.
  let projectPath = ref.projectPath;
  const meta: Record<string, unknown> = { messageCount: textMessages.length };
  // Flag tail-only FULL syncs so the UI can badge partial history.
  if (oversized) meta.truncated = true;
  // Single-prompt invocations (batch/bot runs) carry a flag so the UI can
  // badge them and lists can de-emphasize them.
  if (textMessages.filter((m) => m.role === 'user').length <= 1) meta.oneShot = true;
  // Real project path: the cwd read live from inside the transcript wins over
  // the decoded dir name (`chat-recall` → `chat/recall` mangling).
  try {
    const cwd = ref.fullPath ? readCwdFromJsonl(ref.fullPath) : '';
    if (cwd) projectPath = cwd;
  } catch { /* fall back to ref.projectPath */ }
  const resolved = resolveProjectId(projectPath);
  const projectId = resolved.source === 'ignored' ? '' : resolved.id;
  if (includeMeta && ref.fullPath) {
    try {
      const parsed = await parseSessionFile(ref.fullPath);
      const m = parsed.metadata;
      const live: Record<string, unknown> = {
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens, cacheCreationTokens: m.cacheCreationTokens,
        peakContextTokens: m.peakContextTokens, costUsd: m.costUsd, durationMs: m.durationMs,
        modelsUsed: m.modelsUsed, toolsUsed: m.toolsUsed, gitBranch: m.gitBranch,
        // filesModified drives the analytics Patterns panels (Hot Files,
        // Redundancy). Without it those panels are permanently empty on the
        // server — the field simply wasn't in the synced metadata before.
        filesModified: m.filesModified,
      };
      for (const [k, v] of Object.entries(live)) {
        if (v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue; // empty models/tools = un-parseable for this tool
        meta[k] = v;
      }
    } catch { /* telemetry is best-effort — the conversation still ships */ }
  }

  // Materialize the raw session ONCE — uniform across ALL vendors: Claude/
  // Gemini/Codex file bytes AND the OpenCode row-dump are all UTF-8 text in the
  // container. Reused for BOTH the secret scan (pre-redaction) and the raw_b64
  // archive. (Scanning ref.fullPath was wrong for OpenCode — that's the DB.)
  // Oversized sessions never materialize the container — the builtin regex
  // scan runs over the bounded tail instead (same coverage the APPEND path
  // gives a growing session's new bytes).
  // Reuse the shadow's fullest container (already exported + merged above) so
  // the secret scan and raw archive cover the RECOVERED full history, not the
  // truncated disk file. Only re-export when the shadow path didn't produce one.
  let container: RawContainer | null = fullestContainer;
  if (!container && !oversized) {
    try {
      const backend = getBackendForId(ref.prefixedId) ?? getBackend('claude');
      const exp = backend.exportRawSession(ref.prefixedId);
      container = exp ? buildRawContainer(exp) : null;
    } catch { /* export unavailable — conversation still ships */ }
  }

  // Secret SCAN on the materialized raw text (where secrets actually are,
  // pre-redaction). MASKED findings (last-4) ship to the server's secret_findings.
  //   1. BUILT-IN regex engine (same rules as the redactor) — EVERY user, zero
  //      deps. This is what gives vanilla SaaS users real secret detection.
  //   2. gitleaks/trufflehog — OPTIONAL deeper engines, only when installed.
  //   3. TENANT rules configured in the dashboard — fetched from the server and
  //      applied to the raw text on the client so unredacted secrets stay local.
  const findings: BuiltConversation['findings'] = [];
  let scanMs = 0;
  // OFF THE MAIN THREAD. Scan + redact + gzip + base64 are ~98% of the CPU this
  // function burns (measured: 31.2 s over 200 MB of real sessions) and all four
  // touch the same text, so one worker task carries the text in and returns only
  // small results — findings, a redaction count and the compressed archive. The
  // 30 MB string never comes back, which is what keeps the transfer at 1.8% of
  // the work moved.
  //
  // Null means "not offloaded" for any reason at all (pool disabled, no worker
  // bundle, worker died, task threw). Every use below falls back to the inline
  // code that shipped before this existed.
  let offloaded: Awaited<ReturnType<ReturnType<typeof scanPool>['run']>> = null;
  if (container) {
    const pool = scanPool();
    if (pool.enabled) {
      const packVersion = lastServerPackSpec?.version ?? '';
      const sendPack = lastServerPackSpec !== null && pool.needsPack(packVersion);
      offloaded = await pool.run({
        files: container.files.map((f) => ({ name: f.name, text: f.text })),
        container: { v: 1, tool: container.tool, mtime: container.mtime, srcHash: container.srcHash },
        includeRaw,
        maxRawBytes: 8 * 1024 * 1024,
        pack: sendPack && lastServerPackSpec
          ? { version: packVersion, rules: lastServerPackSpec.rules }
          : undefined,
        packVersion,
      });
      if (offloaded && sendPack) pool.markPackSent(packVersion);
    }
  }
  if (container) {
    const t0 = performance.now();
    const rawText = container.files.map((f) => f.text).join('\n');
    try {
      const builtin = offloaded ? offloaded.findings : scanTextForFindings(rawText);
      for (const f of builtin) {
        findings.push({ session_id: ref.prefixedId, detector: 'builtin', rule: f.rule, line: f.line, preview: f.preview });
      }
    } catch { /* best-effort */ }
    if (opts.precomputedExternal) {
      // Batch path: gitleaks/trufflehog already ran once over a directory of
      // all sessions; this session's slice is handed in. No per-session spawn.
      // Tenant rules are cheap in-memory regex, so still run them here.
      for (const f of opts.precomputedExternal) {
        const verifiedAt = f.verified ? new Date().toISOString() : null;
        findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview, verified_at: verifiedAt });
      }
      if (opts.tenantRules && opts.tenantRules.length > 0) {
        try { for (const f of scanTenantRules(rawText, opts.tenantRules)) findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview }); }
        catch { /* best-effort */ }
      }
    } else if (opts.scanSecrets) {
      // Per-session fallback (no batch map supplied — e.g. unit tests, callers
      // outside the sync loop). gitleaks/trufflehog take a path: write once.
      let tmp: string | null = null;
      try {
        tmp = join(tmpdir(), `cr-scan-${ref.prefixedId.replace(/[^A-Za-z0-9_-]/g, '')}-${mtime}.txt`);
        writeFileSync(tmp, rawText);
        for (const f of scanFileForSecrets(tmp, { verifyOnly: opts.verifySecrets, tenantRules: opts.tenantRules })) {
          const verifiedAt = f.verified ? new Date().toISOString() : null;
          findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview, verified_at: verifiedAt });
        }
      } catch { /* detector error — never block the sync */ }
      finally { if (tmp) { try { unlinkSync(tmp); } catch { /* already gone */ } } }
    } else if (opts.tenantRules && opts.tenantRules.length > 0) {
      // Tenant rules run even when gitleaks/trufflehog are absent — they are
      // pure regex and complement the built-in scanner.
      try {
        for (const f of scanTenantRules(rawText, opts.tenantRules)) {
          findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview });
        }
      } catch { /* best-effort */ }
    }
    scanMs = performance.now() - t0;
  }
  // Oversized sessions: builtin regex (+ tenant rules) over the bounded tail —
  // the container path above never ran for them.
  if (oversized && tailText) {
    const t0 = performance.now();
    try {
      for (const f of scanTextForFindings(tailText)) {
        findings.push({ session_id: ref.prefixedId, detector: 'builtin', rule: f.rule, line: f.line, preview: f.preview });
      }
      if (opts.tenantRules && opts.tenantRules.length > 0) {
        for (const f of scanTenantRules(tailText, opts.tenantRules)) {
          findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview });
        }
      }
    } catch { /* best-effort */ }
    scanMs = performance.now() - t0;
  }

  // High-precision default: drop fuzzy/low-precision detector findings
  // (generic-api-key, Box, URI, …) before shipping so the Security view isn't
  // buried in false positives. Opt back in with CHAT_RECALL_INCLUDE_FUZZY=1.
  const keptFindings = dropFuzzyFindings(findings, (f) => ({ detector: f.detector, rule: f.rule }));
  findings.length = 0;
  findings.push(...keptFindings);

  // Raw archive: redact the SAME container so secrets never reach the server.
  let raw_b64: string | undefined;
  let raw_size: number | undefined;
  if (includeRaw && container) {
    if (offloaded) {
      // The worker already redacted, gzipped and encoded it. An absent rawB64
      // means the archive exceeded the 8 MB ceiling — the same decision the
      // inline path makes, taken in the worker so the bytes never travel.
      count.redactions += offloaded.redactions;
      raw_b64 = offloaded.rawB64;
      raw_size = offloaded.rawSize;
    } else {
      try {
        const count2 = { redactions: 0 };
        const redacted = mapContainerText(container, (t) => redactSecrets(t, { force: true, count: count2 }));
        count.redactions += count2.redactions;
        const { gz, size } = gzipContainer(redacted);
        if (gz.length <= 8 * 1024 * 1024) { raw_b64 = gz.toString('base64'); raw_size = size; }
      } catch { /* raw is additive — conversation still ships */ }
    }
  }

  const envTexts = envelope.messages.filter((m) => m.content?.trim());
  const redactedText = envTexts.map((m) => m.content).join('\n');

  // Native tool title (Claude ai-title, OpenCode session.title) is NOT shipped
  // here — it's a derived field reconciled separately (sync-fields.ts), so a
  // title change never drags the conversation back through sync.

  return {
    conv: {
      session_id: ref.prefixedId,
      tool: ref.toolId,
      project_path: mapPath(projectPath),
      // Resolved on THIS machine (git/FS available) — the server stores it
      // verbatim; it cannot resolve paths it can't see.
      project_id: projectId || undefined,
      redacted_text: redactedText,
      envelope,
      raw_b64,
      raw_size,
      first_prompt: (envTexts.find((m) => m.role === 'user')?.content as string | undefined)?.slice(0, 200),
      // Byte offset this FULL sync is synced THROUGH (file size at build time,
      // or the end of the bounded tail for an oversized session). The server
      // stores it as the envelope's `o`; the ledger records the SAME value
      // (convBatch onFlush uses this, not a recomputed size) so the next
      // append's base_offset matches exactly — no spurious continuity misses on
      // an actively-growing session. undefined for non-append-only backends.
      from_offset: oversized ? tailOffsetEnd : getBackendForId(ref.prefixedId)?.fileSize?.(ref.rawId),
      meta,
      mtime,
    },
    kgText: redactedText,
    projectPath,
    redactions: count.redactions,
    findings,
    scanMs,
    srcHash,
  };
}

/**
 * Parse raw JSONL tail text into canonical messages for one tool. The tail is
 * the bytes after the last shipped offset — complete JSONL lines only (the
 * backend's readFromOffset snaps to the last newline). Returns [] when the
 * tail has no usable messages (blank, all-summary, internal-tool prompt).
 */
function parseTailMessages(tool: string, text: string): any[] {
  if (!text || !text.trim()) return [];
  if (tool === 'claude') return parseClaudeTranscriptText(text);
  if (tool === 'gemini') return parseGeminiTranscriptText(text);
  if (tool === 'codex') return parseCodexTranscriptText(text);
  return [];
}

/**
 * Build the tail-only conversation payload for an APPEND sync (see
 * docs/SYNC-INCREMENTAL.md). Reads ONLY the new bytes from `fromOffset` via
 * the backend's `readFromOffset`, parses them into messages, and ships a
 * minimal append envelope — no raw_b64, no telemetry meta, no title/
 * first_prompt (all head-derived; the server keeps its prior values), no
 * derived (deferred to the FULL re-sync when the session goes quiet).
 *
 * Returns null when the tail is empty / unparseable / all-internal — the
 * caller treats that as "nothing to ship this tick" and leaves the ledger
 * cursor unchanged.
 */
export async function buildConversationTail(
  ref: SessionRef,
  fromOffset: number,
  opts: { mapPath?: (p: string) => string; tenantRules?: Array<{ name: string; regex: string }> } = {},
): Promise<{ conv: Record<string, unknown>; redactions: number; newOffset: number; findings: BuiltConversation['findings'] } | null> {
  const backend = getBackendForId(ref.prefixedId);
  if (!backend?.readFromOffset) return null;
  const mapPath = opts.mapPath ?? ((p: string) => p);

  const { text: tailText, newOffset } = await backend.readFromOffset(ref.prefixedId, fromOffset);
  if (!tailText.trim()) return null;

  const messages = parseTailMessages(ref.toolId, tailText);
  if (messages.length === 0) return null;

  const textMessages = messages.filter((m) => m.role !== 'summary' && m.content?.trim());
  if (textMessages.length === 0 && !messages.some((m) => m.toolCalls?.length)) return null;

  // Skip chat-recall's OWN internal prompts in the tail (same gate as the
  // full builder). A tail that is ONLY an internal prompt ships nothing.
  const firstUser = textMessages.find((m) => m.role === 'user');
  if (isInternalToolPrompt(firstUser?.content)) return null;

  // Trim + redact the tail envelope only (not the whole transcript).
  const count = { redactions: 0 };
  const envelope = redactDeep(
    { v: TRANSCRIPT_VERSION, ...trimTranscriptForSync({ messages, subagents: [] }) },
    count,
  ) as { v: number; messages: any[]; subagents: any[] };

  const envTexts = envelope.messages.filter((m) => m.content?.trim());
  const redactedText = envTexts.map((m) => m.content).join('\n');

  // Secret scan on the tail text only (builtin regex + tenant rules — cheap,
  // in-memory). External detectors skip append ticks; the FULL re-sync covers
  // the whole file when the session closes.
  const findings: BuiltConversation['findings'] = [];
  try {
    for (const f of scanTextForFindings(tailText)) {
      findings.push({ session_id: ref.prefixedId, detector: 'builtin', rule: f.rule, line: f.line, preview: f.preview });
    }
  } catch { /* best-effort */ }
  if (opts.tenantRules && opts.tenantRules.length > 0) {
    try { for (const f of scanTenantRules(tailText, opts.tenantRules)) findings.push({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview }); }
    catch { /* best-effort */ }
  }
  const keptFindings = dropFuzzyFindings(findings, (f) => ({ detector: f.detector, rule: f.rule }));
  findings.length = 0;
  findings.push(...keptFindings);

  // No title / first_prompt / meta / raw_b64 — all head-derived or whole-file.
  // The server's append path updates ONLY mtime + appends chunks + merges the
  // envelope; it keeps its prior title/preview/extra/raw_b64 untouched.
  return {
    conv: {
      session_id: ref.prefixedId,
      tool: ref.toolId,
      project_path: mapPath(ref.projectPath),
      append: true,
      base_offset: fromOffset, // where this tail STARTS — server validates it
                               // equals its stored synced-through offset.
      from_offset: newOffset,  // where it ends → new synced-through offset.
      redacted_text: redactedText,
      envelope,
      mtime: Math.floor(ref.mtime) || 0,
    },
    redactions: count.redactions,
    newOffset,
    findings,
  };
}

/**
 * Per-session derived payload: the four compute kinds the server's deep-dive
 * routes read (diff/outcome/commits/markers) + the outcome-badge row. ALWAYS
 * computed live from the transcript/git (no local compute/outcome cache is
 * read or warmed — thin collector). Everything is deep-redacted — diffs carry
 * file content.
 */
/**
 * Incremental sync for the watch daemon and parameterless `chat-recall sync`:
 * push only sessions modified after `settings.sync.lastSyncAt`, then advance
 * the watermark. The watermark is captured BEFORE the walk so sessions that
 * change mid-sync are re-pushed next time instead of being skipped forever.
 *
 * Returns null when sync isn't configured (no credentials) — callers treat
 * that as "feature off", not an error.
 */
/** Why an incremental sync tick did no work. Distinct outcomes because the
 *  right reaction differs: 'lock-held' is routine writer election (be quiet),
 *  'no-credentials'/'paused' are user-actionable. Historically all three were
 *  a bare `null` and every skip logged as "not logged in" — thousands of
 *  misleading lines in the watch log. */
export interface SyncSkip { skipped: 'no-credentials' | 'paused' | 'lock-held' }

export function isSyncSkip(r: SyncResult | SyncSkip): r is SyncSkip {
  return typeof (r as SyncSkip).skipped === 'string';
}

export async function syncIncremental(opts: { scope?: 'full' | 'changed' } = {}): Promise<SyncResult | SyncSkip> {
  const cred = loadCredentials();
  if (!cred) return { skipped: 'no-credentials' };
  let settings = loadSettings();
  // Master switch (settings.sync.enabled) — `chat-recall login` flips it on;
  // the user can turn background sync off without logging out. Legacy logins
  // (credentials.json written before login set the flag) have enabled=false
  // AND no endpoint recorded: treat that as consent (the only way to get
  // credentials is an explicit login) and migrate the settings once. An
  // endpoint WITH enabled=false means the user deliberately paused — respect it.
  if (!settings.sync.enabled) {
    if (settings.sync.endpoint) return { skipped: 'paused' }; // user paused
    settings.sync.enabled = true;
    settings.sync.endpoint = cred.serverUrl;
    saveSettings(settings);
    settings = loadSettings();
  }
  // SINGLE WRITER — see docs/SYNC.md. Every background sync (MCP ticks across
  // sessions, any file-watcher, manual incremental) serializes on ONE
  // cross-platform lock (O_EXCL lockfile; Linux/macOS/Windows). One writer of
  // the sync ledger at a time, ever. Can't get the lock ⇒ another writer is
  // mid-sync ⇒ skip this tick. Nothing is lost (the per-session ledger +
  // watermark make ticks idempotent; the next tick picks up the rest).
  const lock = acquireIndexLock({ kind: 'sync-incremental', staleAfterMs: 10 * 60_000 });
  if (!lock) return { skipped: 'lock-held' };
  try {
    const startedAt = Date.now();
    // Per-session ledger replaces the global watermark for sessions: a FULL
    // walk lists ALL sessions and the ledger skips acked ones — so a session
    // that failed once retries forever until it lands. scope:'changed'
    // (file-change ticks from the watch daemon) bounds the listing to the
    // recent-mtime window instead — a keystroke-burst tick walks a handful of
    // refs, not 30k+ — while heartbeat/startup ticks stay 'full' so the
    // retry-forever property holds. The watermark also bounds the
    // non-session items walk in both scopes.
    const result = await syncSessions({ useLedger: true, sinceMs: settings.sync.lastSyncAt, walk: opts.scope ?? 'full' });
    // Re-load before saving so we don't clobber settings written mid-sync.
    const fresh = loadSettings();
    fresh.sync.lastSyncAt = startedAt;
    saveSettings(fresh);
    return result;
  } finally {
    lock.release();
  }
}
