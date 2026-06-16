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
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { redactSecrets, scanTextForFindings } from '@chat-recall/engine/core/secret-redactor.js';
import { scanFileForSecrets, scanTenantRules, isSecretScannerAvailable } from '@chat-recall/engine/core/secret-scanner.js';
import { isInternalToolPrompt } from '@chat-recall/engine/core/internal-prompts.js';
import { dropFuzzyFindings } from '@chat-recall/engine/core/secret-precision.js';
import { loadSettings, saveSettings } from '@chat-recall/engine/core/settings.js';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { listAvailableBackends } from '@chat-recall/engine/core/tool-backend.js';
import { extractTurnsAny, replaySessionAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { parseTranscript, trimTranscriptForSync, TRANSCRIPT_VERSION, gzipContainer, mapContainerText, buildRawContainer } from '@chat-recall/engine/transcript/index.js';
import { getBackendForId, getBackend, type SessionRef } from '@chat-recall/engine/core/tool-backend.js';
import { computeOutcome } from '@chat-recall/engine/core/session-outcome.js';
import { markPrompt, summarizeMarkers } from '@chat-recall/engine/core/session-sentiment.js';
import { parseSessionFile, readCwdFromJsonl } from '@chat-recall/engine/parsers/session.js';
import { resolveProjectId } from '@chat-recall/engine/core/project-resolver.js';
import { extractEntities } from '@chat-recall/engine/core/entity-extractor.js';
import { buildSourceRegistry } from '@chat-recall/engine/parsers/all-sources.js';
import { getSyncedMtimes, markSynced, getLedgerData, persistLedgerData } from './sync-ledger.js';
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
  mkdirSync(dirname(credPath()), { recursive: true });
  const targets = loadAllCredentials().filter((t) => t.serverUrl !== c.serverUrl);
  targets.push(c);
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
      fetch(`${base}/api/secrets/rules`, { headers }),
      fetch(`${base}/api/teams/security-config`, { headers }).catch(() => null),
    ]);

    let tenantRules: Array<{ name: string; regex: string }> = [];
    if (rulesRes.ok) {
      const body = await rulesRes.json().catch(() => ({})) as { rules?: Array<{ name: string; regex: string; enabled?: boolean }> };
      tenantRules = (body.rules || []).filter((r) => r.enabled !== false);
    }

    // Default verification ON. The server endpoint may not exist yet (older
    // servers), so we fail open to "verified enabled" — this is the product default.
    let verifySecrets = true;
    if (settingsRes?.ok) {
      const body = await settingsRes.json().catch(() => ({})) as { verifySecrets?: boolean };
      if (typeof body.verifySecrets === 'boolean') verifySecrets = body.verifySecrets;
    }

    const config: TenantSecurityConfig = { tenantRules, verifySecrets };
    _securityConfigCache.set(base, { fetchedAt: Date.now(), config });
    return config;
  } catch {
    // If the server is unreachable or the endpoints don't exist, fall back to
    // no tenant rules and verification enabled. This keeps the collector
    // working during transient outages and with older server images.
    return { tenantRules: [], verifySecrets: true };
  }
}

export function _resetTenantSecurityConfigCache(): void {
  _securityConfigCache.clear();
}

/** Legacy single-target accessor — first target. */
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

/** Redact every string anywhere inside a JSON-serializable value. Used for
 *  derived payloads (diffs carry file content; outcomes carry prompt text)
 *  where field-by-field redaction would be fragile. */
function redactDeep<T>(v: T, count: { redactions: number }): T {
  if (typeof v === 'string') return redactSecrets(v, { force: true, count }) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, count)) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(val, count);
    return o as unknown as T;
  }
  return v;
}

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

export async function syncSessions(opts: { sinceMs?: number; cleartextPaths?: boolean; limit?: number; throttleMs?: number; prune?: boolean; useLedger?: boolean } = {}): Promise<SyncResult> {
  const targets = loadAllCredentials();
  if (targets.length === 0) throw new Error('Not logged in — run `chat-recall login <server-url> --token <token>`');
  let agg: SyncResult | null = null;
  const errors: string[] = [];
  for (const cred of targets) {
    try {
      const r = await syncToTarget(cred, opts);
      agg = agg ? {
        uploaded: agg.uploaded + r.uploaded, skipped: agg.skipped + r.skipped, redactions: agg.redactions + r.redactions,
        items: agg.items + r.items, links: agg.links + r.links, findings: agg.findings + r.findings,
        derived: agg.derived + r.derived, kgEntities: agg.kgEntities + r.kgEntities, kgTriples: agg.kgTriples + r.kgTriples,
        scanned: Math.max(agg.scanned, r.scanned), scanMs: Math.max(agg.scanMs, r.scanMs),
      } : r;
    } catch (e) {
      errors.push(`${cred.serverUrl}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!agg) throw new Error(`sync failed for all targets:\n  ${errors.join('\n  ')}`);
  if (errors.length > 0) console.error(`[sync] ${errors.length} target(s) failed (others succeeded):\n  ${errors.join('\n  ')}`);
  return agg;
}

async function syncToTarget(cred: Credentials, opts: { sinceMs?: number; cleartextPaths?: boolean; limit?: number; throttleMs?: number; prune?: boolean; useLedger?: boolean } = {}): Promise<SyncResult> {
  const sync = loadSettings().sync;
  const excludeTools = new Set(sync?.excludeTools ?? []);
  const excludeProjects = sync?.excludeProjects ?? [];
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
  const excluded = (projectPath: string): boolean =>
    excludeProjects.some((x) => x && projectPath.includes(x));

  // Ledger mode walks ALL sessions (the ledger does the skipping — that's
  // what lets a previously-failed session retry no matter how old it is).
  // Watermark mode keeps the cheap bounded walk for explicit --since runs.
  // Version handshake: refuse loudly instead of silently degrading. An old
  // server ignores payload fields it doesn't know — which looks like
  // success and produces gutted data (lived experience, June 2026).
const MIN_SERVER_API = 2;
try {
  const caps = await fetch(`${cred.serverUrl.replace(/\/$/, '')}/api/capabilities`).then((r) => r.json()) as { apiVersion?: number };
  if ((caps.apiVersion ?? 0) < MIN_SERVER_API) {
    throw new Error(`server too old: apiVersion ${caps.apiVersion ?? 'none'} < required ${MIN_SERVER_API} — update the server image before syncing`);
  }
} catch (e) {
  if (e instanceof Error && e.message.startsWith('server too old')) throw e;
  throw new Error(`cannot verify server version (${e instanceof Error ? e.message : e}) — refusing to sync blind`);
}

// Fetch tenant-specific secret-scan configuration from the server. Rules are
// configured in the dashboard and must be applied to raw session text on the
// client (the server never sees unredacted secrets). Verification live-checks
// matched keys with their issuers (e.g. AWS, GitHub) — on by default, but a
// tenant admin can disable it.
const { tenantRules, verifySecrets } = await fetchTenantSecurityConfig(cred);

const refs = listAvailableBackends().flatMap((b) => {
    try { return b.listSessions({ sinceMs: opts.useLedger ? undefined : opts.sinceMs }); } catch { return []; }
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
  // Throttle: server-side ingest does real work per row (chunking,
  // classification, FTS inserts) — an unthrottled 10k-session backfill can
  // brown out a small server/database (it took down a node on 2026-06-11).
  // Default 1s between batches; bulk callers pass more.
  const MAX_BATCH_BYTES = 4 * 1024 * 1024;
  const throttleMs = opts.throttleMs ?? 1000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Retries: a multi-hour backfill must survive a transient connection
  // reset or a 5xx — one blip at batch 200/210 must not throw away the
  // whole run. 4xx (bad token, oversized body) stays fatal: retrying
  // can't fix it.
  // Per-attempt upload timeout. WITHOUT this, a half-open/slow connection makes
  // `fetch` hang FOREVER (Node fetch has no default timeout) — observed as a
  // sync stuck for 20-40min at idle CPU with zero progress. With it, a hung
  // upload aborts, surfaces as an error, and goes through the retry path below.
  const UPLOAD_TIMEOUT_MS = Number(process.env.CHAT_RECALL_UPLOAD_TIMEOUT_MS) || 90_000;
  const post = async (body: Record<string, unknown>): Promise<void> => {
    const payload = JSON.stringify(body);
    const RETRY_DELAYS_MS = [2000, 8000, 30000];
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error(`upload timed out after ${UPLOAD_TIMEOUT_MS}ms`)), UPLOAD_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/api/sync`, {
          method: 'POST',
          // No token ⇒ no auth header: a no-auth local server (AUTH_PROVIDER=none)
          // accepts it as the single 'default' tenant.
          headers: cred.token
            ? { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` }
            : { 'content-type': 'application/json' },
          body: payload,
          signal: ac.signal,
        });
        if (res.ok) break;
        const text = await res.text().catch(() => '');
        if (res.status < 500) throw new Error(`sync failed: HTTP ${res.status} ${text}`);
        if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`sync failed after ${attempt + 1} attempts: HTTP ${res.status} ${text}`);
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
  // Track every local session id we see this sync. After the walk, any
  // session id recorded in the per-server ledger but missing locally is a
  // deletion → ship a tombstone so the server removes it. This only covers
  // sessions this device previously synced; deletions on other devices are
  // handled by their own collectors.
  const localSessionIds = new Set<string>();

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
        const size = JSON.stringify(row).length;
        if (batch.length > 0 && (batchBytes + size > MAX_BATCH_BYTES || batch.length >= maxItems)) await this.drain();
        batch.push(row);
        batchBytes += size;
      },
      async drain(): Promise<void> {
        if (batch.length === 0) return;
        const rows = flatten ? batch.flat() : batch;
        batch = [];
        batchBytes = 0;
        await post({ [field]: rows });
        this.sent += rows.length;
        onFlush?.(rows);
      },
    };
  };
  const base = cred.serverUrl.replace(/\/$/, '');
  const ledger = opts.useLedger ? getSyncedMtimes(base) : null;
  const convBatch = makeBatcher('conversations', 25, false, (rows) => {
    // Server acked this batch — record exactly these sessions at exactly
    // the mtimes that were shipped. Failures never reach here, so an
    // unsynced session stays unsynced and retries next tick.
    try { markSynced(base, rows.map((r: any) => ({ id: r.session_id, mtime: r.mtime }))); }
    catch { /* ledger is local bookkeeping — never fail an upload over it */ }
  });
  const itemsBatch = makeBatcher('items', 100);
  const linksBatch = makeBatcher('links', 2000);
  const derivedBatch = makeBatcher('derived', 50);
  const kgEntityBatch = makeBatcher('kg_entities', 2000);
  const kgTripleBatch = makeBatcher('kg_triples', 1000);
  // Secret findings ship per-session as a GROUP (flatten=true) — the server
  // replaces a session's findings wholesale, so they must land in one POST.
  const findingsBatch = makeBatcher('findings', 200, true);
  // Scanning lights up automatically when a detector binary (gitleaks/
  // trufflehog) is on PATH. Resolved once (each check spawns `which`).
  // CHAT_RECALL_SCAN_SECRETS=0 opts out (e.g. to keep a huge backfill fast).
  // upload.findings=false also disables secret scanning/shipping.
  const scanSecrets = isSecretScannerAvailable() && upload.findings && process.env.CHAT_RECALL_SCAN_SECRETS !== '0';
  const verifySecretsScan = verifySecrets;

  // ── Live KG accumulator. Triples are extracted on the spot from each
  //    item's redacted text (no local knowledge-graph DB is read). Dedupe by
  //    subject|predicate|object|valid_from; entity types come from `is_a`
  //    triples seen in the same pass, defaulting to 'unknown' otherwise.
  const kgSeen = new Set<string>();
  const kgEntityType = new Map<string, string>();
  const kgRows: Array<{ subject: string; predicate: string; object: string; valid_from: string | null; valid_to: string | null; confidence: number; source_session: string | null }> = [];
  const accumulateKg = (triples: ReturnType<typeof extractEntities>, sourceSession: string | null): void => {
    for (const t of triples) {
      const key = `${t.subject}|${t.predicate}|${t.object}|${t.validFrom ?? ''}`;
      if (kgSeen.has(key)) continue;
      kgSeen.add(key);
      if (t.predicate === 'is_a' && !kgEntityType.has(t.subject)) kgEntityType.set(t.subject, t.object);
      kgRows.push({
        subject: t.subject, predicate: t.predicate, object: t.object,
        valid_from: t.validFrom ?? null, valid_to: null,
        confidence: t.confidence ?? 1.0, source_session: sourceSession,
      });
    }
  };

  let skipped = 0, redactions = 0, walked = 0;
  let scanMs = 0, scanned = 0; // secret-scan metrics
  for (const ref of refs.slice(0, opts.limit ?? refs.length)) {
    localSessionIds.add(ref.prefixedId);
    if (excludeTools.has(ref.toolId as any)) { skipped++; continue; }
    if (excluded(ref.projectPath)) { skipped++; continue; }
    // Ledger mode: this exact session at this exact version already acked
    // by this server → nothing to do. Anything not covered (new, changed,
    // or previously failed) flows through.
    if (ledger && (ledger.get(ref.prefixedId) ?? -1) >= Math.floor(ref.mtime)) { skipped++; continue; }
    // Canonical envelope (live): parse the transcript NOW with THE parser —
    // no local content cache is read or warmed. What ships is exactly what
    // the local dashboard would render for the same file.
    const mtime = Math.floor(ref.mtime) || 0;
    const built = await buildConversationSync(ref, mtime, { mapPath, includeRaw: upload.raw, includeMeta: upload.sessionMeta, scanSecrets, verifySecrets: verifySecretsScan, tenantRules });
    if (!built) { skipped++; continue; }
    redactions += built.redactions;

    await convBatch.add(built.conv);
    // Ship this session's secret findings as one group (server replaces wholesale).
    if (built.findings.length > 0) await findingsBatch.add(built.findings);
    if (built.scanMs > 0) { scanMs += built.scanMs; scanned++; }

    // Knowledge graph: extract triples live from the redacted conversation
    // text (no local KG DB is read). Accumulated + deduped, flushed at the end.
    if (upload.sessionMeta) {
      accumulateKg(extractEntities(built.kgText, { projectPath: built.projectPath, sourceType: 'session', sessionId: ref.prefixedId }), ref.prefixedId);
    }

    // Derived data — the CLI has the FS/git/transcript, the server doesn't.
    // Always computed live (diff/outcome/commits/markers + badge row); no
    // local compute/outcome cache is read or warmed.
    if (upload.sessionMeta) {
      try {
        const count = { redactions: 0 };
        await derivedBatch.add(collectDerived(ref, mtime, count));
        redactions += count.redactions;
      } catch { /* derived is best-effort — the conversation itself shipped */ }
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
    if (walked % 250 === 0) console.error(`[sync] ${walked} sessions processed…`);
  }

  // ── Non-session sources: plan/task/claude_md/history/paste/diary/skill/
  //    mcp/command/agent/hook/plugin. Same registry the indexer uses, so
  //    sync coverage tracks index coverage automatically. Session-type
  //    sources are skipped — sessions ship as conversations above.
  //    (excludeTools is session-only: source plugins don't carry a tool id.)
  const registry = buildSourceRegistry();
  for (const sourceType of registry.getRegisteredTypes()) {
    if (sourceType === 'session') continue;
    for (const source of registry.getAll(sourceType)) {
      let discovered: AsyncGenerator<any>;
      try { discovered = source.discover(); } catch { continue; }
      try {
        for await (const item of discovered) {
          if ((item.mtime || 0) < (opts.sinceMs ?? 0)) continue;
          if (excluded(item.projectPath || '')) continue;
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
              title: c.title || '',
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
            accumulateKg(
              extractEntities(redactedChunks.map((c) => c.text).join('\n'), { projectPath: item.projectPath || '', sourceType: item.sourceType }),
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
      } catch { /* one broken source must not kill the sync */ }
    }
  }

  // ── Knowledge graph (live). Triples were extracted on the spot from each
  //    session/item's redacted text during the walks above — so what ships is
  //    exactly the facts derivable from the sessions in THIS sync (which is
  //    also the incremental-correct set: no manual-fact replay, no local KG
  //    DB). Entities are derived from the triple subjects/objects, typed from
  //    any `is_a` triple seen in the same pass.
  if (upload.sessionMeta && kgRows.length > 0) {
    const entityNames = new Set<string>();
    for (const t of kgRows) {
      const count = { redactions: 0 };
      await kgTripleBatch.add(redactDeep(t, count));
      redactions += count.redactions;
      entityNames.add(t.subject);
      entityNames.add(t.object);
    }
    for (const name of entityNames) {
      const count = { redactions: 0 };
      await kgEntityBatch.add(redactDeep({ name, type: kgEntityType.get(name) ?? 'unknown', properties: {} }, count));
      redactions += count.redactions;
    }
  }

  // ── Drain every batcher (the walks above flushed full windows already;
  // this ships the tails).
  await convBatch.drain();
  await itemsBatch.drain();
  await linksBatch.drain();
  await derivedBatch.drain();
  await kgEntityBatch.drain();
  await kgTripleBatch.drain();
  await findingsBatch.drain();

  // ── Tombstones for sessions this device previously synced but that no
  //    longer exist locally (deleted transcript file, cleared cache, etc).
  //    We only tombstone sessions we have a ledger record for — never data
  //    from other devices.
  if (ledger) {
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

  return {
    uploaded: convBatch.sent, skipped, redactions,
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
}

export async function buildConversationSync(
  ref: SessionRef,
  mtime: number,
  opts: { mapPath?: (p: string) => string; includeRaw?: boolean; includeMeta?: boolean; scanSecrets?: boolean; verifySecrets?: boolean; tenantRules?: Array<{ name: string; regex: string }> } = {},
): Promise<BuiltConversation | null> {
  const mapPath = opts.mapPath ?? ((p: string) => p);
  const includeRaw = opts.includeRaw !== false;
  const includeMeta = opts.includeMeta !== false;

  // Parse the transcript live — this is the single canonical parse; the
  // envelope and the redacted text both come from it.
  let transcript: { messages: any[]; subagents: any[] } | null = null;
  try {
    const t = await parseTranscript(ref.prefixedId);
    if (t && (t.messages.length > 0 || t.subagents.length > 0)) transcript = t;
  } catch { /* unparseable */ }
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
  let container: ReturnType<typeof buildRawContainer> | null = null;
  try {
    const backend = getBackendForId(ref.prefixedId) ?? getBackend('claude');
    const exp = backend.exportRawSession(ref.prefixedId);
    container = exp ? buildRawContainer(exp) : null;
  } catch { /* export unavailable — conversation still ships */ }

  // Secret SCAN on the materialized raw text (where secrets actually are,
  // pre-redaction). MASKED findings (last-4) ship to the server's secret_findings.
  //   1. BUILT-IN regex engine (same rules as the redactor) — EVERY user, zero
  //      deps. This is what gives vanilla SaaS users real secret detection.
  //   2. gitleaks/trufflehog — OPTIONAL deeper engines, only when installed.
  //   3. TENANT rules configured in the dashboard — fetched from the server and
  //      applied to the raw text on the client so unredacted secrets stay local.
  const findings: BuiltConversation['findings'] = [];
  let scanMs = 0;
  if (container) {
    const t0 = performance.now();
    const rawText = container.files.map((f) => f.text).join('\n');
    try {
      for (const f of scanTextForFindings(rawText)) {
        findings.push({ session_id: ref.prefixedId, detector: 'builtin', rule: f.rule, line: f.line, preview: f.preview });
      }
    } catch { /* best-effort */ }
    if (opts.scanSecrets) {
      // gitleaks/trufflehog take a file path — write the materialized text once.
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
    try {
      const count2 = { redactions: 0 };
      const redacted = mapContainerText(container, (t) => redactSecrets(t, { force: true, count: count2 }));
      count.redactions += count2.redactions;
      const { gz, size } = gzipContainer(redacted);
      if (gz.length <= 8 * 1024 * 1024) { raw_b64 = gz.toString('base64'); raw_size = size; }
    } catch { /* raw is additive — conversation still ships */ }
  }

  const envTexts = envelope.messages.filter((m) => m.content?.trim());
  const redactedText = envTexts.map((m) => m.content).join('\n');
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
      meta,
      mtime,
    },
    kgText: redactedText,
    projectPath,
    redactions: count.redactions,
    findings,
    scanMs,
  };
}

/**
 * Per-session derived payload: the four compute kinds the server's deep-dive
 * routes read (diff/outcome/commits/markers) + the outcome-badge row. ALWAYS
 * computed live from the transcript/git (no local compute/outcome cache is
 * read or warmed — thin collector). Everything is deep-redacted — diffs carry
 * file content.
 */
function collectDerived(
  ref: { prefixedId: string; toolId: string; mtime: number },
  mtime: number,
  count: { redactions: number },
): { session_id: string; mtime: number; compute: Array<{ kind: string; mtime: number; data: unknown }>; outcome_row: unknown | null } {
  const id = ref.prefixedId;
  const compute: Array<{ kind: string; mtime: number; data: unknown }> = [];
  let fullOutcome: ReturnType<typeof computeOutcome> | null = null;

  for (const kind of COMPUTE_KINDS) {
    let data: unknown = null;
    try {
      if (kind === 'diff') {
        const replay = replaySessionAny(id);
        if (replay.found) data = replay;
      } else if (kind === 'outcome') {
        fullOutcome = computeOutcome(id);
        if (fullOutcome.found) data = fullOutcome;
      } else if (kind === 'commits') {
        // computeOutcome already ran git for the session window — reuse.
        if (!fullOutcome) fullOutcome = computeOutcome(id);
        if (fullOutcome.found) data = fullOutcome.commits;
      } else if (kind === 'markers') {
        // Analysis-only use of the turns extractor (R4) — markers need
        // per-prompt line/ts, not render fidelity.
        const turns = extractTurnsAny(id, { maxTurns: 50_000 });
        const prompts = turns.turns
          .filter((t) => t.kind === 'user' && t.text)
          .map((t) => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text!) }));
        data = { sessionId: id, prompts, summary: summarizeMarkers(prompts) };
      }
    } catch { data = null; }
    if (data === null) continue;
    const redacted = redactDeep(data, count);
    if (JSON.stringify(redacted).length > MAX_DERIVED_ROW_BYTES) continue;
    compute.push({ kind, mtime, data: redacted });
  }

  // Outcome-badge row (session_outcome_cache) — what the list badges read.
  // Computed live from the outcome we already ran above.
  let outcomeRow: Record<string, unknown> | null = null;
  if (fullOutcome?.found) {
    outcomeRow = {
      sessionId: id,
      tool: ref.toolId,
      status: fullOutcome.status as any,
      reason: fullOutcome.reason,
      fileMtime: mtime,
      fileSize: 0,
      contentHash: '',
      fileCount: fullOutcome.fileCount,
      linesAdded: fullOutcome.totalLinesAdded,
      linesRemoved: fullOutcome.totalLinesRemoved,
      commits: fullOutcome.commits?.totalCommits ?? 0,
      isFull: true,
      classifiedAt: Date.now(),
      lastScannedOffset: 0,
    };
  }

  return {
    session_id: id,
    mtime,
    compute,
    outcome_row: outcomeRow ? redactDeep({ ...outcomeRow, sessionId: undefined }, count) : null,
  };
}

/**
 * Incremental sync for the watch daemon and parameterless `chat-recall sync`:
 * push only sessions modified after `settings.sync.lastSyncAt`, then advance
 * the watermark. The watermark is captured BEFORE the walk so sessions that
 * change mid-sync are re-pushed next time instead of being skipped forever.
 *
 * Returns null when sync isn't configured (no credentials) — callers treat
 * that as "feature off", not an error.
 */
export async function syncIncremental(): Promise<SyncResult | null> {
  const cred = loadCredentials();
  if (!cred) return null;
  let settings = loadSettings();
  // Master switch (settings.sync.enabled) — `chat-recall login` flips it on;
  // the user can turn background sync off without logging out. Legacy logins
  // (credentials.json written before login set the flag) have enabled=false
  // AND no endpoint recorded: treat that as consent (the only way to get
  // credentials is an explicit login) and migrate the settings once. An
  // endpoint WITH enabled=false means the user deliberately paused — respect it.
  if (!settings.sync.enabled) {
    if (settings.sync.endpoint) return null; // user paused
    settings.sync.enabled = true;
    settings.sync.endpoint = cred.serverUrl;
    saveSettings(settings);
    settings = loadSettings();
  }
  const startedAt = Date.now();
  // Per-session ledger replaces the global watermark for sessions: every
  // tick walks ALL sessions and the ledger skips acked ones — so a session
  // that failed once retries forever until it lands. The watermark is kept
  // only to bound the non-session items walk.
  const result = await syncSessions({ useLedger: true, sinceMs: settings.sync.lastSyncAt });
  // Re-load before saving so we don't clobber settings written mid-sync.
  const fresh = loadSettings();
  fresh.sync.lastSyncAt = startedAt;
  saveSettings(fresh);
  return result;
}
