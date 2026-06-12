/**
 * The one sync client: walk local sessions AND every other memory source,
 * redact secrets (ALWAYS — `force:true`, never gated on the index-time
 * toggle), optionally hash project paths, and push to the server's
 * `/api/sync` (packages/server/src/routes/sync.ts). Credentials live in a
 * 0600 file, never in settings.json.
 *
 * What ships (the local index stays the source of truth):
 *   conversations — per-turn redacted session transcripts + telemetry meta
 *   items/links   — every non-session source type (plan, task, claude_md,
 *                   history, paste, diary, skill, mcp, command, agent,
 *                   hook, plugin) with redacted chunks + relationships
 *   findings      — secret-scanner findings        (toggle: upload.findings)
 *   derived       — compute_cache rows (diff/outcome/commits/markers) +
 *                   outcome-badge rows             (toggle: upload.sessionMeta)
 *   kg            — knowledge-graph entities/triples (toggle: upload.sessionMeta)
 *   dismissals    — secret dismissals              (toggle: upload.dismissals)
 *   custom_rules  — custom secret rules            (toggle: upload.customRules)
 *
 * What does NOT ship, by design: the full-conversation JSON blob
 * (content_cache) and embeddings. The server reconstructs the conversation
 * view from the per-turn chunks.
 */
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';
import { loadSettings, saveSettings } from '@chat-recall/engine/core/settings.js';
import { getDataDir } from '@chat-recall/engine/core/paths.js';
import { listAvailableBackends } from '@chat-recall/engine/core/tool-backend.js';
import { extractTurnsAny, replaySessionAny } from '@chat-recall/engine/core/session-multi-tool.js';
import { computeOutcome } from '@chat-recall/engine/core/session-outcome.js';
import { markPrompt, summarizeMarkers } from '@chat-recall/engine/core/session-sentiment.js';
import { createStore, type StorageDriver } from '@chat-recall/engine/core/store/index.js';
import { createMetadataCache, createOutcomeCache } from '@chat-recall/engine/core/store/caches.js';
import { createKnowledgeGraph } from '@chat-recall/engine/core/store/knowledge-graph.js';
import { buildSourceRegistry } from '@chat-recall/engine/parsers/all-sources.js';
import '@chat-recall/engine/core/backends/index.js'; // register the tool backends

// Local store handle for telemetry lookups during a sync walk. Opened once,
// closed by the caller's process exit (CLI) / kept by the daemon.
let _localStore: Promise<StorageDriver> | null = null;
function localStore(): Promise<StorageDriver> {
  if (!_localStore) _localStore = createStore();
  return _localStore;
}

// Lives under the data dir so CHAT_RECALL_DATA_DIR isolates credentials the
// same way it isolates the index (tests, multi-profile setups).
const credPath = () => join(getDataDir(), 'credentials.json');

export interface Credentials { serverUrl: string; token: string; }

export function saveCredentials(c: Credentials): void {
  mkdirSync(dirname(credPath()), { recursive: true });
  writeFileSync(credPath(), JSON.stringify(c, null, 2));
  try { chmodSync(credPath(), 0o600); } catch { /* windows */ }
  // Logging in IS the sync opt-in: enable background sync and record the
  // endpoint so the watch daemon starts pushing without further setup.
  try {
    const s = loadSettings();
    s.sync.enabled = true;
    s.sync.endpoint = c.serverUrl;
    saveSettings(s);
  } catch { /* settings unwritable — manual `chat-recall sync` still works */ }
}
export function loadCredentials(): Credentials | null {
  try { return JSON.parse(readFileSync(credPath(), 'utf-8')) as Credentials; } catch { return null; }
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
}

/** compute_cache kinds shipped to the server. Must stay in step with the
 *  kinds the server's conversation routes read (heavyCacheGet keys). */
const COMPUTE_KINDS = ['diff', 'outcome', 'commits', 'markers'] as const;

/** Per-row ceiling for derived payloads — matches the local heavy-cache L2
 *  ceiling (metadata-cache.ts) so we never ship a row the server-side
 *  SQLite edition couldn't store anyway. */
const MAX_DERIVED_ROW_BYTES = 2 * 1024 * 1024;

export async function syncSessions(opts: { sinceMs?: number; cleartextPaths?: boolean; limit?: number; throttleMs?: number } = {}): Promise<SyncResult> {
  const cred = loadCredentials();
  if (!cred) throw new Error('Not logged in — run `chat-recall login <server-url> --token <token>`');
  const sync = loadSettings().sync;
  const excludeTools = new Set(sync?.excludeTools ?? []);
  const excludeProjects = sync?.excludeProjects ?? [];
  // Upload category toggles (settings.sync.upload, all default true).
  const upload = {
    findings: sync?.upload?.findings !== false,
    sessionMeta: sync?.upload?.sessionMeta !== false,
    dismissals: sync?.upload?.dismissals !== false,
    customRules: sync?.upload?.customRules !== false,
  };
  // Cleartext paths: explicit flag wins, else the persistent setting
  // (sync.pathsCleartext — what the watch daemon uses).
  const cleartext = opts.cleartextPaths ?? sync?.pathsCleartext === true;
  const mapPath = (p: string): string => (cleartext ? p : hashPath(p));
  const excluded = (projectPath: string): boolean =>
    excludeProjects.some((x) => x && projectPath.includes(x));

  const refs = listAvailableBackends().flatMap((b) => {
    try { return b.listSessions({ sinceMs: opts.sinceMs }); } catch { return []; }
  });

  const store = await localStore();
  const metaCache = await createMetadataCache();
  const outcomeCache = await createOutcomeCache();

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
  const base = cred.serverUrl.replace(/\/$/, '');
  const MAX_BATCH_BYTES = 4 * 1024 * 1024;
  const throttleMs = opts.throttleMs ?? 1000;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Retries: a multi-hour backfill must survive a transient connection
  // reset or a 5xx — one blip at batch 200/210 must not throw away the
  // whole run. 4xx (bad token, oversized body) stays fatal: retrying
  // can't fix it.
  const post = async (body: Record<string, unknown>): Promise<void> => {
    const payload = JSON.stringify(body);
    const RETRY_DELAYS_MS = [2000, 8000, 30000];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${base}/api/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cred.token}` },
          body: payload,
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
      }
    }
    if (throttleMs > 0) await sleep(throttleMs);
  };
  // `flatten`: each add() is a GROUP of rows that must land in the same
  // POST (e.g. one session's findings — the server replaces a session's
  // findings wholesale, so splitting a session across two batches would
  // lose the first half).
  const makeBatcher = (field: string, maxItems: number, flatten = false) => {
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
      },
    };
  };
  const convBatch = makeBatcher('conversations', 25);
  const itemsBatch = makeBatcher('items', 100);
  const linksBatch = makeBatcher('links', 2000);
  const findingsBatch = makeBatcher('findings', 200, true); // 200 session-groups per POST
  const derivedBatch = makeBatcher('derived', 50);
  const kgEntityBatch = makeBatcher('kg_entities', 2000);
  const kgTripleBatch = makeBatcher('kg_triples', 1000);

  let skipped = 0, redactions = 0, walked = 0;
  const syncedSessionIds = new Set<string>();
  for (const ref of refs.slice(0, opts.limit ?? refs.length)) {
    if (excludeTools.has(ref.toolId as any)) { skipped++; continue; }
    if (excluded(ref.projectPath)) { skipped++; continue; }
    let turns;
    try { turns = extractTurnsAny(ref.prefixedId, { maxTurns: 5000 }); } catch { skipped++; continue; }
    if (!turns.found) { skipped++; continue; }

    // Structured per-turn payload (each turn redacted independently).
    // Text turns become FTS chunks + the conversation view; tool turns
    // (calls + result snippets, NOT raw outputs) ride along so the synced
    // conversation has the same mass as the local one — a tool-heavy
    // session is 90% tool activity and looked gutted without them.
    // `redacted_text` stays for the legacy sync server.
    const count = { redactions: 0 };
    const structured: Array<Record<string, unknown>> = [];
    let textTurns = 0;
    for (const t of turns.turns) {
      if ((t.kind === 'user' || t.kind === 'assistant_text') && t.text) {
        textTurns++;
        structured.push({
          role: t.kind === 'user' ? 'user' : 'assistant',
          text: redactSecrets(t.text, { force: true, count }),
          ts: t.ts || undefined,
        });
      } else if (t.kind === 'tool_use') {
        structured.push({
          role: 'tool_use',
          tool_name: t.toolName || 'tool',
          tool_use_id: t.toolUseId || undefined,
          text: redactSecrets((t.command || t.toolInputSummary || '').slice(0, 2000), { force: true, count }),
          ts: t.ts || undefined,
        });
      } else if (t.kind === 'tool_result') {
        structured.push({
          role: 'tool_result',
          tool_use_id: t.toolUseId || undefined,
          text: redactSecrets((t.resultSummary || '').slice(0, 2000), { force: true, count }),
          is_error: t.resultIsError || undefined,
          ts: t.ts || undefined,
        });
      }
    }
    if (textTurns === 0) { skipped++; continue; }
    redactions += count.redactions;
    const mtime = Math.floor(ref.mtime) || 0;
    syncedSessionIds.add(ref.prefixedId);

    // Local index row: real project path + telemetry. The backend's
    // ref.projectPath is decoded from the encoded dir name (every '-'
    // becomes '/', so `chat-recall` → `chat/recall`); memory_metadata
    // stores the real cwd read from inside the transcript — prefer it.
    const textOnly = structured.filter((t) => t.role === 'user' || t.role === 'assistant');
    let projectPath = ref.projectPath;
    let meta: Record<string, unknown> = { messageCount: textTurns };
    // Single-prompt invocations (batch/bot runs — e.g. thousands of one-shot
    // Gemini CLI calls) sync like everything else but carry a flag so the
    // UI can badge them and lists can de-emphasize them.
    if (textOnly.filter((t) => t.role === 'user').length <= 1) meta.oneShot = true;
    try {
      const row = await store.getItem(ref.prefixedId, 'session');
      if (row?.project_path) projectPath = row.project_path;
      if (upload.sessionMeta && row?.extra_json) {
        const extra = JSON.parse(row.extra_json);
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens',
                         'peakContextTokens', 'costUsd', 'durationMs', 'modelsUsed', 'toolsUsed',
                         'messageCount', 'gitBranch'] as const) {
          if (extra[k] !== undefined) meta[k] = extra[k];
        }
      }
    } catch { /* row is best-effort */ }

    await convBatch.add({
      session_id: ref.prefixedId,
      tool: ref.toolId,
      project_path: mapPath(projectPath),
      redacted_text: textOnly.map((t) => t.text).join('\n'),
      turns: structured,
      first_prompt: (textOnly.find((t) => t.role === 'user')?.text as string | undefined)?.slice(0, 200),
      meta,
      mtime,
    });

    // Secret findings — already redacted previews (the scanner stores
    // previews, never raw secrets). Replace-wholesale server-side.
    if (upload.findings) {
      try {
        const rows = (await store.secretFindingsForSession(ref.prefixedId))
          .map((f) => ({ session_id: ref.prefixedId, detector: f.detector, rule: f.rule, line: f.line, preview: f.preview }));
        // One add() per session — the whole group lands in one POST.
        if (rows.length > 0) await findingsBatch.add(rows);
      } catch { /* findings are best-effort */ }
    }

    // Derived data — the CLI has the FS/git/transcript, the server doesn't.
    // Ship cached compute rows; compute the missing ones here so the hosted
    // dashboard is complete (diff/outcome/commits/markers + badge row).
    if (upload.sessionMeta) {
      try {
        await derivedBatch.add(await collectDerived(ref, mtime, turns, metaCache, outcomeCache, count));
        redactions += count.redactions;
      } catch { /* derived is best-effort — the conversation itself shipped */ }
    }

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
          await itemsBatch.add({
            id: item.id,
            source_type: item.sourceType,
            title: redactSecrets(item.title || '', { force: true, count }),
            project_path: mapPath(item.projectPath || ''),
            content_preview: redactSecrets(item.contentPreview || '', { force: true, count }),
            mtime: Math.floor(item.mtime) || 0,
            extra: item.extra ? redactDeep(item.extra, count) : undefined,
            chunks: chunks
              .filter((c) => c.text?.trim())
              .map((c) => ({
                text: redactSecrets(c.text, { force: true, count }),
                chunk_type: c.chunkType || '',
                title: c.title || '',
              })),
          });
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

  // ── Knowledge graph. Full export on a full sync; on incremental syncs
  //    only triples sourced from the sessions in this walk (manual
  //    `recall_kg_add` facts ride along on the next full sync).
  if (upload.sessionMeta) {
    try {
      const kg = await createKnowledgeGraph();
      const fullExport = !opts.sinceMs;
      const entities = await kg.listEntities(1_000_000);
      const seenTriples = new Set<string>();
      const wantedEntities = new Set<string>();
      for (const e of entities) {
        for (const t of await kg.queryEntity(e.name, undefined, 'outgoing')) {
          if (!fullExport && !(t.source_session && syncedSessionIds.has(t.source_session))) continue;
          const key = `${t.subject}|${t.predicate}|${t.object}|${t.valid_from ?? ''}`;
          if (seenTriples.has(key)) continue;
          seenTriples.add(key);
          const count = { redactions: 0 };
          await kgTripleBatch.add(redactDeep({
            subject: t.subject, predicate: t.predicate, object: t.object,
            valid_from: t.valid_from ?? null, valid_to: t.valid_to ?? null,
            confidence: t.confidence ?? 1.0, source_session: t.source_session ?? null,
          }, count));
          wantedEntities.add(t.subject); wantedEntities.add(t.object);
          redactions += count.redactions;
        }
      }
      for (const e of entities) {
        if (!fullExport && !wantedEntities.has(e.name)) continue;
        const count = { redactions: 0 };
        await kgEntityBatch.add(redactDeep({ name: e.name, type: e.type, properties: e.properties ?? {} }, count));
        redactions += count.redactions;
      }
      await kg.close();
    } catch { /* KG is best-effort */ }
  }

  // ── Dismissals + custom rules: small tables, shipped whole (idempotent
  //    upserts server-side).
  const dismissals: any[] = [];
  const customRules: any[] = [];
  if (upload.dismissals) {
    try {
      for (const [preview, d] of await store.getSecretDismissals()) {
        dismissals.push({ preview, status: d.status, reason: d.reason ?? null });
      }
    } catch { /* best-effort */ }
  }
  if (upload.customRules) {
    try {
      for (const r of await store.listSecretRules()) {
        customRules.push({ name: r.name, regex: r.regex, severity: r.severity, description: r.description ?? null, enabled: !!r.enabled });
      }
    } catch { /* best-effort */ }
  }

  // ── Drain every batcher (the walks above flushed full windows already;
  // this ships the tails) + the small whole-table payloads.
  await convBatch.drain();
  await itemsBatch.drain();
  await linksBatch.drain();
  await findingsBatch.drain();
  await derivedBatch.drain();
  await kgEntityBatch.drain();
  await kgTripleBatch.drain();
  if (dismissals.length > 0 || customRules.length > 0) {
    await post({ dismissals, custom_rules: customRules });
  }

  await metaCache.close();
  await outcomeCache.close();

  return {
    uploaded: convBatch.sent, skipped, redactions,
    items: itemsBatch.sent, links: linksBatch.sent, findings: findingsBatch.sent, derived: derivedBatch.sent,
    kgEntities: kgEntityBatch.sent, kgTriples: kgTripleBatch.sent,
  };
}

/**
 * Per-session derived payload: the four compute_cache kinds the server's
 * deep-dive routes read (diff/outcome/commits/markers) + the outcome-badge
 * row. Cached rows ship as-is; missing/stale ones are computed here and
 * written back to the local cache (so the local dashboard warms too).
 * Everything is deep-redacted — diffs carry file content.
 */
async function collectDerived(
  ref: { prefixedId: string; toolId: string; mtime: number },
  mtime: number,
  turns: { turns: any[]; startMs: number; endMs: number },
  metaCache: Awaited<ReturnType<typeof createMetadataCache>>,
  outcomeCache: Awaited<ReturnType<typeof createOutcomeCache>>,
  count: { redactions: number },
): Promise<{ session_id: string; mtime: number; compute: Array<{ kind: string; mtime: number; data: unknown }>; outcome_row: unknown | null }> {
  const id = ref.prefixedId;
  const compute: Array<{ kind: string; mtime: number; data: unknown }> = [];
  let fullOutcome: ReturnType<typeof computeOutcome> | null = null;

  for (const kind of COMPUTE_KINDS) {
    let data = await metaCache.getCompute<unknown>(id, kind, mtime);
    if (data === null) {
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
          const prompts = turns.turns
            .filter((t) => t.kind === 'user' && t.text)
            .map((t) => ({ line: t.line, ts: t.ts, tsIso: t.tsIso, ...markPrompt(t.text) }));
          data = { sessionId: id, prompts, summary: summarizeMarkers(prompts) };
        }
      } catch { data = null; }
      if (data !== null) {
        try { await metaCache.setCompute(id, kind, mtime, data); } catch { /* local warm is best-effort */ }
      }
    }
    if (data === null) continue;
    const redacted = redactDeep(data, count);
    if (JSON.stringify(redacted).length > MAX_DERIVED_ROW_BYTES) continue;
    compute.push({ kind, mtime, data: redacted });
  }

  // Outcome-badge row (session_outcome_cache) — what the list badges read.
  let outcomeRow = await outcomeCache.get(id);
  if (!outcomeRow && fullOutcome?.found) {
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
    try { await outcomeCache.put(outcomeRow); } catch { /* local warm is best-effort */ }
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
  const sinceMs = settings.sync.lastSyncAt;
  const result = await syncSessions({ sinceMs });
  // Re-load before saving so we don't clobber settings written mid-sync.
  const fresh = loadSettings();
  fresh.sync.lastSyncAt = startedAt;
  saveSettings(fresh);
  return result;
}
