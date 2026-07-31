/**
 * Secret-finding endpoints. Reads from the `secret_findings` table
 * populated by the secret scanner. Findings carry only redacted
 * previews — the raw secret is NEVER stored or returned, so these
 * endpoints are safe to surface across tenant boundaries.
 *
 *   GET /api/secrets/summary
 *     Per-detector totals + top rules. Drives the Security view.
 *
 *   GET /api/secrets/sessions
 *     One row per session with finding counts by detector.
 *     Use `?min=2` to require at least N detectors agreeing (signal vs noise).
 *
 *   GET /api/secrets/session/:id
 *     Full findings for one session, grouped by detector.
 *     Used by the per-conversation Security tab.
 *
 * Storage goes through the async StorageDriver (sqlite | postgres) — every
 * handler is async and awaits a freshly-created store.
 */

import express from 'express';
import { createHash } from 'node:crypto';
import { createStore } from '../imports.js';
import { enqueueTasksFile } from '../util/tasks-file-intent.js';
import { classifySecret, secretSeverityRank, type SecretSeverity } from '@chat-recall/engine/core/secret-classify.js';
import {
  dismissalToTaskStatus, taskStatusToDismissal, isSecretTaskStatus, type SecretTaskStatus,
} from '@chat-recall/engine/core/secret-task-status.js';
import { validateRedactionRule } from '@chat-recall/engine/core/secret-redactor.js';

const router = express.Router();

/* ── SECURITY_TASKS.md generation ─────────────────────────────────
 *
 * Per-project, persistent, status-tracked checklist of every distinct
 * credential that leaked from this repo into an AI session. Mirrors the
 * CODE_TASKS.md mechanism: the server renders the file and enqueues a
 * `write_tasks_file` sync-intent that the user's local drain writes into
 * the repo — no CLI change needed for generation.
 *
 * Two-way + verifiable (server is source of truth):
 *   - Status lives in `secret_dismissals` (keyed by masked preview, survives
 *     re-sync). The file mirrors it.
 *   - Each task carries a stable machine id in an HTML comment so the CLI can
 *     read the user's/AI's checkmarks back and sync them into dismissals.
 *   - The id is a hash of the masked preview (never the raw secret), so it is
 *     stable across regenerations and safe to write to disk.
 */

/** Stable, non-secret task id derived from the masked preview. */
function secretTaskId(preview: string): string {
  return 'sec_' + createHash('sha256').update(preview).digest('hex').slice(0, 12);
}

/** Server-side twin of the client's shortId — strips tool prefixes. */
function shortSessionId(id: string): string {
  return id.replace(/^(opencode_|gemini_|codex_|agy_)/, '').slice(0, 8);
}

interface DistinctSecret {
  preview: string;
  rules: Array<{ detector: string; rule: string }>;
  detectors: string[];
  sessions: Array<{ sessionId: string; project: string; lines: number[] }>;
  sessionCount: number;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  verified: boolean | null;
}
type Dismissal = { status: string; reason: string | null; dismissed_at: number };

/** Classify a distinct secret by its most-severe rule (matches the dashboard). */
function classifyDistinct(s: DistinctSecret) {
  let top = classifySecret('', s.rules[0]?.rule || '');
  for (const r of s.rules) {
    const t = classifySecret(r.detector, r.rule);
    if (secretSeverityRank(t.severity) < secretSeverityRank(top.severity)) top = t;
  }
  return top;
}

/**
 * Select the distinct secrets that leaked from `projectPath`, scoped to that
 * repo's own sessions, sorted the way the dashboard sorts Action Required.
 * `noise`-tier matches are excluded from the checklist body (counted instead).
 */
function selectProjectSecrets(all: DistinctSecret[], projectPath: string) {
  const scoped: Array<DistinctSecret & { type: ReturnType<typeof classifyDistinct> }> = [];
  let noiseOmitted = 0;
  for (const s of all) {
    const here = s.sessions.filter((x) => x.project === projectPath);
    if (!here.length) continue;
    const type = classifyDistinct(s);
    if (type.severity === 'noise') { noiseOmitted++; continue; }
    scoped.push({ ...s, sessions: here, sessionCount: here.length, type });
  }
  scoped.sort((a, b) =>
    Number(b.verified === true) - Number(a.verified === true) ||
    secretSeverityRank(a.type.severity) - secretSeverityRank(b.type.severity) ||
    b.detectors.length - a.detectors.length ||
    b.sessionCount - a.sessionCount ||
    b.occurrences - a.occurrences,
  );
  return { scoped, noiseOmitted };
}

const SEVERITY_BADGE: Record<SecretSeverity, string> = {
  critical: '🔴 CRITICAL', high: '🟠 HIGH', medium: '🟡 MEDIUM', noise: '⚪ NOISE',
};

/**
 * Per-secret status for the file. Returns the machine token (for the anchor),
 * the checkbox state, a human display, and whether there's a CONTRADICTION —
 * a secret the user marked `rotated` that the scanner still reports live.
 */
function statusFor(s: DistinctSecret, dismissal: Dismissal | undefined): {
  token: SecretTaskStatus; checked: boolean; display: string; contradiction: boolean;
} {
  const token = dismissalToTaskStatus(dismissal?.status);
  if (token === 'open') {
    return { token, checked: false, display: s.verified === true ? '🔴 OPEN — verified live' : '🔴 open', contradiction: false };
  }
  if (token === 'rotated') {
    const contradiction = s.verified === true; // claimed rotated but scanner still verifies it live
    return {
      token, checked: true, contradiction,
      display: contradiction ? '⚠️ marked ROTATED but scanner still reports LIVE — re-check' : '✅ rotated',
    };
  }
  if (token === 'not-a-secret') return { token, checked: true, display: '⚪ not a secret', contradiction: false };
  return { token, checked: true, display: '⚪ dismissed', contradiction: false };
}

function buildSecurityTasksMd(
  projectPath: string,
  scoped: Array<DistinctSecret & { type: ReturnType<typeof classifyDistinct> }>,
  dismissals: Map<string, Dismissal>,
  noiseOmitted: number,
): string {
  const projName = projectPath.split('/').filter(Boolean).pop() || projectPath;
  const open = scoped.filter((s) => !dismissals.has(s.preview)).length;
  const head =
    `# SECURITY_TASKS.md — ${projName}\n\n` +
    `> Generated by chat-recall. Each item below is a **distinct credential** that leaked from this repo into an AI session. ` +
    `**${open} open**, ${scoped.length - open} handled` +
    (noiseOmitted ? ` (+${noiseOmitted} noise-tier matches omitted)` : '') + `.\n>\n` +
    `> **Do NOT paste raw secrets here.** Only the masked tail is shown — that is the identifier chat-recall tracks.\n>\n` +
    `> **To resolve a task:** rotate the key on its issuer, then change its \`status:\` from \`open\` to one of ` +
    `\`rotated\` · \`not-a-secret\` · \`dismissed\`, and tick the box. Set it back to \`open\` to reopen. ` +
    `Your edits sync to the dashboard on the next \`chat-recall sync\`; chat-recall re-scans on every sync, so a rotated key ` +
    `that stops reappearing is confirmed resolved, and one flagged \`rotated\` that the scanner still sees live is called out below.\n>\n` +
    `> The \`<!-- cr-secret … -->\` markers are machine anchors — **leave them intact.**\n\n`;

  if (!scoped.length) {
    return head + `_No critical/high/medium credentials outstanding for this repo. ✅_\n`;
  }

  const body = scoped.map((s, i) => {
    const st = statusFor(s, dismissals.get(s.preview));
    const id = secretTaskId(s.preview);
    const detectors = s.detectors.join(' · ') + (s.detectors.length >= 2 ? ` (${s.detectors.length} agree)` : '');
    const locations = s.sessions
      .map((x) => `\`${shortSessionId(x.sessionId)}\` ${x.lines.length === 1 ? `L${x.lines[0]}` : `${x.lines.length} lines (L${x.lines.slice(0, 6).join(', L')}${x.lines.length > 6 ? '…' : ''})`}`)
      .join(' · ');
    const rotate = s.type.rotateUrl ? `[${s.type.rotateUrl}](${s.type.rotateUrl})` : 'on the issuing service\'s console';
    // The anchor line is the ONLY machine-parsed line: checkbox + `status: <token>`
    // + the id/original-status comment. The CLI reads it back verbatim.
    const instruction = st.token === 'open'
      ? 'rotate on the issuer, then set the status above and tick this box'
      : 'resolved — set status back to `open` to reopen';
    return (
      `## ${i + 1}. ${s.type.glyph} ${s.type.label} — \`${s.preview}\`\n\n` +
      `- **Severity / status:** ${SEVERITY_BADGE[s.type.severity]} · ${st.display}\n` +
      (st.contradiction ? `- **⚠️ Verification conflict:** you marked this rotated, but the scanner still reports it **live**. Confirm the key is actually revoked.\n` : '') +
      `- **Impact:** ${s.type.impact}\n` +
      `- **Detectors:** ${detectors}\n` +
      `- **Rotate:** ${rotate}\n` +
      `- **Leaked in this repo:** ${locations}\n\n` +
      `- [${st.checked ? 'x' : ' '}] status: \`${st.token}\` — ${instruction} <!-- cr-secret id=${id} was=${st.token} -->\n`
    );
  }).join('\n');

  return head + body + '\n';
}

router.get('/summary', async (_req, res) => {
  const store = await createStore();
  try {
    const base = await store.secretFindingsSummary();
    const distinct = await store.secretFindingsByDistinctSecret();
    const dismissals = await store.getSecretDismissals();
    const total = distinct.reduce((n, s) => n + s.occurrences, 0);
    const verified = distinct.filter(s => s.verified === true).length;
    const actionRequired = distinct.filter(s => !dismissals.has(s.preview)).length;
    res.json({ ...base, total, verified, actionRequired, distinct: distinct.length });
  } finally { await store.close(); }
});

router.get('/by-rule', async (_req, res) => {
  const store = await createStore();
  try {
    res.json({ rules: await store.secretFindingsByRule() });
  } finally { await store.close(); }
});

// Per-repo rollup: which projects leaked the most, and how many are live.
router.get('/by-project', async (_req, res) => {
  const store = await createStore();
  try {
    res.json({ projects: await store.secretFindingsByProject() });
  } finally { await store.close(); }
});

// Daily trend (distinct secrets + verified-live) over ?days=N (default 30).
router.get('/trend', async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days as string) || 30, 365));
  const store = await createStore();
  try {
    res.json({ days, trend: await store.secretFindingsTrend(days) });
  } finally { await store.close(); }
});

router.get('/distinct', async (req, res) => {
  // ?include_dismissed=true to show items the user already actioned;
  // default hides them so the Action Required list stays focused on
  // unresolved leaks.
  const includeDismissed = req.query.include_dismissed === 'true';
  const store = await createStore();
  try {
    const all = await store.secretFindingsByDistinctSecret();
    const dismissals = await store.getSecretDismissals();
    const enriched = all.map(s => ({
      ...s,
      dismissal: dismissals.get(s.preview) || null,
    }));
    const filtered = includeDismissed ? enriched : enriched.filter(s => !s.dismissal);
    res.json({ secrets: filtered, dismissedCount: enriched.length - filtered.length });
  } finally { await store.close(); }
});

// Mark a finding as rotated / false_positive / dismissed.
router.post('/dismiss', express.json(), async (req, res) => {
  const { preview, status, reason } = req.body as { preview?: string; status?: string; reason?: string };
  if (!preview || typeof preview !== 'string') {
    return res.status(400).json({ error: 'preview required' });
  }
  if (!['rotated', 'false_positive', 'dismissed'].includes(status || '')) {
    return res.status(400).json({ error: 'status must be rotated|false_positive|dismissed' });
  }
  const store = await createStore();
  try {
    await store.setSecretDismissal(preview, status as 'rotated' | 'false_positive' | 'dismissed', reason);
    res.json({ ok: true });
  } finally { await store.close(); }
});

// Reverse a dismissal — bring the finding back into the Action list.
router.post('/undismiss', express.json(), async (req, res) => {
  const { preview } = req.body as { preview?: string };
  if (!preview) return res.status(400).json({ error: 'preview required' });
  const store = await createStore();
  try {
    await store.clearSecretDismissal(preview);
    res.json({ ok: true });
  } finally { await store.close(); }
});

/**
 * On-demand server re-scan of ALREADY-STORED (redacted) text with today's
 * rules. Anything it finds got past the redactor on some device, which means it
 * is in our database in cleartext — so it is recorded as a server-owned finding
 * and alerted on. Runs on a daily sweep too (see server.ts); this endpoint is
 * for "check my tenant now", e.g. right after shipping better rules.
 *
 * Body: { since_hours?: number, limit?: number }
 */
router.post('/rescan', express.json(), async (req, res) => {
  const tenant = (req as any).tenant || process.env.CHAT_RECALL_TENANT || 'default';
  const sinceHours = Number(req.body?.since_hours);
  const limit = Number(req.body?.limit);
  const store = await createStore();
  try {
    const { rescanTenant } = await import('../services/secret-rescan.js');
    const r = await rescanTenant(store, tenant, {
      sinceMs: Number.isFinite(sinceHours) && sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : 0,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 2000,
    });
    res.json(r);
  } finally { await store.close(); }
});

/* ── Tenant-configurable rules CRUD ──────────────────────────── */

/**
 * The rule pack the collector pulls at the start of every sync.
 *
 * `version` is a content hash of the enabled rules: the client logs it, and it
 * makes "which rules was this device actually running?" answerable after the
 * fact. It changes whenever a rule's name/pattern/redact flag changes, so a
 * client can also use it to skip re-installing an unchanged pack.
 *
 * Rules are CONFIGURED here and EXECUTED on the client — the server never sees
 * unredacted text, so it could not apply them itself even if it wanted to.
 */
router.get('/rules', async (_req, res) => {
  const store = await createStore();
  try {
    const rules = await store.listSecretRules();
    const material = rules
      .filter((r) => r.enabled)
      .map((r) => `${r.name} ${r.regex} ${r.redact ? 1 : 0}`)
      .sort()
      .join('');
    const version = rules.length === 0
      ? 'empty'
      : createHash('sha256').update(material).digest('hex').slice(0, 12);
    res.json({ rules, version });
  } finally { await store.close(); }
});

router.post('/rules', express.json(), async (req, res) => {
  const { id, name, regex, severity, description, enabled, redact } = req.body || {};
  if (!name || !regex || !severity) {
    return res.status(400).json({ error: 'name, regex, severity required' });
  }
  if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
    return res.status(400).json({ error: 'severity must be one of critical|high|medium|low' });
  }
  // Validate the regex compiles BEFORE we persist it — a broken
  // pattern would silently break every future scan.
  try { new RegExp(regex); }
  catch (e) { return res.status(400).json({ error: 'invalid regex: ' + (e as Error).message }); }

  // A `redact` rule runs against every string leaving the user's machine, so it
  // must clear the collector's safety checks here rather than being dropped
  // client-side (which would look like coverage that isn't there).
  if (redact === true) {
    const v = validateRedactionRule({ name, regex });
    if (!v.ok) return res.status(400).json({ error: `not safe to redact with: ${v.reason}` });
  }

  const store = await createStore();
  try {
    const r = await store.upsertSecretRule({ id, name, regex, severity, description, enabled, redact });
    res.json(r);
  } finally { await store.close(); }
});

router.delete('/rules/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be a number' });
  const store = await createStore();
  try {
    await store.deleteSecretRule(id);
    res.json({ ok: true });
  } finally { await store.close(); }
});

/**
 * Test-sandbox: post a sample text + (optional) regex-overrides to
 * see what would match, without persisting anything. Used by the
 * Settings UI's live-preview field. Catches backwards regexes
 * before they go into production scans.
 */
router.post('/rules/test', express.json(), (req, res) => {
  const { sample, regex } = req.body || {};
  if (typeof sample !== 'string' || typeof regex !== 'string') {
    return res.status(400).json({ error: 'sample and regex required' });
  }
  try {
    const re = new RegExp(regex, 'g');
    const matches = [...sample.matchAll(re)].slice(0, 20).map(m => ({
      match: m[0].length > 80 ? m[0].slice(0, 76) + '…' : m[0],
      index: m.index,
    }));
    res.json({ count: matches.length, matches });
  } catch (e) {
    res.status(400).json({ error: 'invalid regex: ' + (e as Error).message });
  }
});

router.get('/sessions', async (req, res) => {
  const min = Math.max(1, Number(req.query.min) || 1);
  const store = await createStore();
  try {
    // One row per (session, detector). Pivot client-side; the SQL stays
    // boring and adapts to whatever set of detectors we end up running.
    const rows = await store.secretFindingsBySession();

    const bySession = new Map<string, {
      sessionId: string; project: string; title: string; mtime: number;
      detectors: Record<string, number>; total: number; agreement: number;
    }>();
    for (const r of rows) {
      let entry = bySession.get(r.session_id);
      if (!entry) {
        entry = {
          sessionId: r.session_id,
          project: r.project_path || '',
          title: r.title || '',
          mtime: r.mtime || 0,
          detectors: {},
          total: 0,
          agreement: 0,
        };
        bySession.set(r.session_id, entry);
      }
      entry.detectors[r.detector] = r.n;
      entry.total += r.n;
      entry.agreement = Object.keys(entry.detectors).length;
    }
    const filtered = [...bySession.values()]
      .filter(s => s.agreement >= min)
      .sort((a, b) => b.agreement - a.agreement || b.total - a.total);
    res.json({ sessions: filtered, count: filtered.length });
  } finally { await store.close(); }
});

router.get('/session/:id', async (req, res) => {
  const { id } = req.params;
  const store = await createStore();
  try {
    const findings = await store.secretFindingsForSession(id);
    // Memoize cross-session counts per unique preview so we don't
    // run the same query N times for repeated findings on the same key.
    const xCount = new Map<string, number>();
    const enriched: Array<typeof findings[number] & { crossSessionCount: number }> = [];
    for (const f of findings) {
      let cross = xCount.get(f.preview);
      if (cross === undefined) {
        cross = await store.secretCrossSessionCount(f.preview, id);
        xCount.set(f.preview, cross);
      }
      enriched.push({ ...f, crossSessionCount: cross });
    }
    const byDetector: Record<string, typeof enriched> = {};
    for (const f of enriched) (byDetector[f.detector] ||= []).push(f);
    res.json({ sessionId: id, total: enriched.length, byDetector });
  } finally { await store.close(); }
});

// POST /api/secrets/tasks/write — { project }
// Materialise SECURITY_TASKS.md in the repo via the local drain (same rail as
// CODE_TASKS.md), so the user can point Claude Code at it: "rotate the secrets
// in SECURITY_TASKS.md and tick them off".
router.post('/tasks/write', express.json(), async (req, res) => {
  const project = typeof req.body?.project === 'string' ? req.body.project.trim() : '';
  if (!project) return res.status(400).json({ error: 'project (filesystem path) is required' });
  const store = await createStore();
  try {
    const all = (await store.secretFindingsByDistinctSecret()) as DistinctSecret[];
    const dismissals = (await store.getSecretDismissals()) as Map<string, Dismissal>;
    const { scoped, noiseOmitted } = selectProjectSecrets(all, project);
    if (!scoped.length) {
      return res.json({ ok: true, queued: false, message: 'No outstanding critical/high/medium secrets for this repo — nothing to write.' });
    }
    const content = buildSecurityTasksMd(project, scoped, dismissals, noiseOmitted);
    const intentId = await enqueueTasksFile(store, {
      rootPath: project, filename: 'SECURITY_TASKS.md', content, createdBy: 'security-tasks',
    });
    const open = scoped.filter((s) => !dismissals.has(s.preview)).length;
    res.json({
      ok: true, queued: true, intentId, filename: 'SECURITY_TASKS.md', count: scoped.length, open,
      message: 'Queued — your local agent writes SECURITY_TASKS.md to the repo (≤45s). Then tell your AI: "Rotate the secrets in SECURITY_TASKS.md and tick each one off."',
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  } finally { await store.close(); }
});

// GET /api/secrets/tasks/tracked — filesystem project paths that have
// actionable (non-noise) secrets. The CLI checks each for a SECURITY_TASKS.md
// to read back. Returns real paths only (drops '' and '/').
router.get('/tasks/tracked', async (_req, res) => {
  const store = await createStore();
  try {
    const all = (await store.secretFindingsByDistinctSecret()) as DistinctSecret[];
    const paths = new Set<string>();
    for (const s of all) {
      if (classifyDistinct(s).severity === 'noise') continue;
      for (const x of s.sessions) {
        if (x.project && x.project !== '/' && x.project.startsWith('/')) paths.add(x.project);
      }
    }
    res.json({ projects: [...paths].sort() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  } finally { await store.close(); }
});

// POST /api/secrets/tasks/status — { project, items: [{id, status}] }
// The file→server half of the two-way sync. The CLI parses SECURITY_TASKS.md
// and posts each task's id + status token; we recompute id→preview for that
// project and write `secret_dismissals` (server is the source of truth).
// Idempotent; unknown/invalid ids are reported, never applied.
router.post('/tasks/status', express.json(), async (req, res) => {
  const project = typeof req.body?.project === 'string' ? req.body.project.trim() : '';
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!project) return res.status(400).json({ error: 'project (filesystem path) is required' });
  if (!items) return res.status(400).json({ error: 'items[] is required' });
  const store = await createStore();
  try {
    const all = (await store.secretFindingsByDistinctSecret()) as DistinctSecret[];
    const { scoped } = selectProjectSecrets(all, project);
    // id → preview for this project's secrets (id is a hash of the preview).
    const idToPreview = new Map<string, string>();
    for (const s of scoped) idToPreview.set(secretTaskId(s.preview), s.preview);

    let applied = 0, cleared = 0; const unknown: string[] = []; let invalid = 0;
    for (const it of items) {
      const id = typeof it?.id === 'string' ? it.id : '';
      const status = it?.status;
      if (!id || !isSecretTaskStatus(status)) { invalid++; continue; }
      const preview = idToPreview.get(id);
      if (!preview) { unknown.push(id); continue; }
      const dismissal = taskStatusToDismissal(status as SecretTaskStatus);
      if (dismissal === null) { await store.clearSecretDismissal(preview); cleared++; }
      else { await store.setSecretDismissal(preview, dismissal, 'via SECURITY_TASKS.md'); applied++; }
    }
    res.json({ ok: true, project, applied, cleared, unknown, unknownCount: unknown.length, invalid });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'failed' });
  } finally { await store.close(); }
});

export default router;
