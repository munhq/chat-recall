/**
 * code-collector — the TS port of codeindex's dashboard.py.
 *
 * Drives the local `codeindex` Zig binary over MCP stdio (the binary has no CLI
 * analyze flag), runs the analyses, then enriches with git churn, AI-authorship,
 * and complexity — and synthesises a ranked, actionable plan. Emits the four
 * persisted shapes (project / findings / hotspots / actions) ready to sync.
 *
 * Runs LOCALLY (needs the repo's files + git history on disk), like the toolkit
 * sync executor. The server only stores + renders what this produces.
 */

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

import { resolveProjectId } from '../project-resolver.js';
import { checkCodeindexStatus, installCodeindex } from '../companions.js';
import { redactSecrets } from '../secret-redactor.js';
import {
  FINDING_WHY, secFix,
  securityPrompt, literalPrompt, clonePrompt, duplicationPrompt, deadCodePrompt, hotspotPrompt, couplingPrompt, cyclePrompt,
  unwrapPrompt, coveragePrompt, architecturePrompt,
  crossrefPrompt, typeDriftPrompt, schemaPrompt, migrationPrompt, manifestPrompt,
} from './prompts.js';
import type {
  CodeProjectInput, CodeFindingInput, CodeHotspotInput, CodeActionInput,
  CodeSeverity, CodeMapNode, CodeMapEdge, CodeBlastRadius,
} from '../../types/code-intel.js';

const ANALYSES = [
  'health', 'security', 'duplication', 'clones', 'literal_scan', 'coupling', 'cycles', 'dead_code',
  // deeper analyzers with per-item findings:
  'unwrap_audit', 'test_coverage', 'architecture',
  // count-only analyzers (folded into project stats, no per-item detail emitted):
  'crossref', 'type_drift', 'db_schema', 'migration_parity', 'manifest_compliance',
] as const;
const GENERATED = ['generated/', '.pb.go', '.gen.', '_pb2.py', '/gen/', '.g.dart', '/node_modules/', '/vendor/', '.lock'];
const CF_RE = /\b(if|for|while|switch|case|catch|elif|when|loop|&&|\|\||\?)\b|\?/g;
const DEPTH = 2;

export interface CollectResult {
  project: CodeProjectInput;
  findings: CodeFindingInput[];
  hotspots: CodeHotspotInput[];
  actions: CodeActionInput[];
}

export interface CollectOpts {
  workspace: string;
  /** Defaults to the codeindex binary resolved via companions.ts. */
  binPath?: string;
  /** Auto-install the binary if missing (default true). */
  autoInstall?: boolean;
  /** Device id recorded on the project row. */
  deviceId?: string | null;
  /** Progress logger. */
  log?: (msg: string) => void;
}

/** Resolve the codeindex binary, installing it if asked + possible. */
export async function resolveCodeindexBin(autoInstall = true): Promise<string> {
  let st = checkCodeindexStatus();
  if (!st.installed && autoInstall) st = await installCodeindex();
  if (!st.installed || !st.path) {
    throw new Error(
      st.unsupportedReason
        ? `codeindex not available: ${st.unsupportedReason}`
        : 'codeindex binary not found. Run `chat-recall companions install` or build it from source.',
    );
  }
  return st.path;
}

/** Drive the codeindex MCP server: write all calls, close stdin, collect replies by id. */
function runMcp(binPath: string, workspace: string, calls: any[], timeoutMs = 180_000): Promise<Map<number, string>> {
  return new Promise((resolve, reject) => {
    const p = spawn(binPath, ['--mcp', '--workspace', workspace], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('codeindex MCP timed out')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      const res = new Map<number, string>();
      for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let m: any;
        try { m = JSON.parse(s); } catch { continue; }
        const text = m?.result?.content?.[0]?.text;
        if (m?.id != null && typeof text === 'string') res.set(Number(m.id), text);
      }
      resolve(res);
    });
    p.stdin.write(calls.map((c) => JSON.stringify(c) + '\n').join(''));
    p.stdin.end();
  });
}

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function parseJson<T>(map: Map<number, string>, id: number, fallback: T): T {
  const t = map.get(id);
  if (!t) return fallback;
  try { return JSON.parse(t) as T; } catch { return fallback; }
}

function isGenerated(rel: string): boolean { return GENERATED.some((g) => rel.includes(g)); }

export async function collectCode(opts: CollectOpts): Promise<CollectResult> {
  const ws = opts.workspace.replace(/\/+$/, '');
  const log = opts.log ?? (() => {});
  const bin = opts.binPath ?? (await resolveCodeindexBin(opts.autoInstall ?? true));
  const projectId = resolveProjectId(ws).id || `path:${ws}`;
  const wsPrefix = ws + '/';
  const rel = (p: string) => {
    let r = p.startsWith(wsPrefix) ? p.slice(wsPrefix.length) : p;
    if (r.startsWith('./')) r = r.slice(2);
    return r;
  };

  // ── Pass 1: index + status + tree + analyses ────────────────────────────
  log(`indexing ${ws} + analyses …`);
  const base = await runMcp(bin, ws, [
    call(1, 'index_workspace', { path: ws }),
    call(2, 'status'),
    call(3, 'get_tree'),
    ...ANALYSES.map((a, i) => call(10 + i, 'analyze', { analysis: a })),
  ]);
  const st = parseJson<any>(base, 2, {});
  const tree = parseJson<any[]>(base, 3, []);
  const A: Record<string, any> = {};
  ANALYSES.forEach((a, i) => { A[a] = parseJson<any>(base, 10 + i, {}); });
  const {
    health, security: sec, duplication: dup, clones, literal_scan: lit, coupling: coup, cycles: cyc, dead_code: dead,
    unwrap_audit: unwrap, test_coverage: coverage, architecture: arch,
    crossref, type_drift: typeDrift, db_schema: dbSchema, migration_parity: migParity, manifest_compliance: manifest,
  } = A as any;

  if (tree.length === 0) {
    throw new Error('codeindex returned no files — is this a code workspace? (it refuses $HOME and /)');
  }

  // ── Pass 2: git churn + AI-authorship + complexity ──────────────────────
  log('git churn + AI-authorship + complexity …');
  const churn = new Map<string, number>();
  try {
    const stdout = execSync(`git -C "${ws}" log --format= --name-only`, { encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const ln of stdout.split('\n')) { const f = ln.trim(); if (f) churn.set(f, (churn.get(f) ?? 0) + 1); }
  } catch { /* not a git repo */ }

  const aiFiles = new Set<string>();
  let aiCommits = 0, totalCommits = 0;
  try {
    const log2 = execSync(`git -C "${ws}" log --format=%H%x00%B%x00END%x00`, { encoding: 'utf8', timeout: 120_000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const AI_RE = /co-authored-by: claude|generated with.*claude|🤖|noreply@anthropic|codex|gpt-|cursor/i;
    for (const block of log2.split('\x00END\x00')) {
      if (!block.includes('\x00')) continue;
      const [h, body] = [block.slice(0, block.indexOf('\x00')).trim(), block.slice(block.indexOf('\x00') + 1)];
      if (!h) continue;
      totalCommits++;
      if (AI_RE.test(body)) {
        aiCommits++;
        try {
          const files = execSync(`git -C "${ws}" show --format= --name-only ${h}`, { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
          for (const f of files.split('\n')) { if (f.trim()) aiFiles.add(f.trim()); }
        } catch { /* ignore */ }
      }
    }
  } catch { /* not a git repo */ }

  const complexity = (r: string): number => {
    try {
      const txt = readFileSync(join(ws, r), 'utf8');
      if (txt.length > 2_000_000) return 1;       // skip pathological files
      const m = txt.match(CF_RE);
      return 1 + (m ? m.length : 0);
    } catch { return 1; }
  };

  // ── Dependency graph (package-level nodes + edges) ──────────────────────
  log('dependency graph …');
  const files: string[] = tree.map((n) => n.path);
  const pkg = (path: string): string => {
    const parts = rel(path).split('/');
    return parts.length > DEPTH ? parts.slice(0, DEPTH).join('/') : (rel(path).split('/').slice(0, -1).join('/') || rel(path));
  };
  const symByPkg = new Map<string, number>();
  const langFiles = new Map<string, number>();
  const langSymbols = new Map<string, number>();
  const pkgFiles: Record<string, string[]> = {};
  const fileMeta: Record<string, { symbols: number; lang: string }> = {};
  for (const n of tree) {
    const r = rel(n.path); const p = pkg(n.path); const lang = n.language ?? '?';
    symByPkg.set(p, (symByPkg.get(p) ?? 0) + (n.symbols ?? 0));
    langFiles.set(lang, (langFiles.get(lang) ?? 0) + 1);
    langSymbols.set(lang, (langSymbols.get(lang) ?? 0) + (n.symbols ?? 0));
    (pkgFiles[p] ??= []).push(r);
    fileMeta[r] = { symbols: n.symbols ?? 0, lang: n.language ?? '' };
  }
  const imp = await runMcp(bin, ws, [
    call(1, 'index_workspace', { path: ws }),
    ...files.map((f, i) => call(1000 + i, 'get_imports', { path: f })),
  ]);
  const pkgEdges = new Map<string, number>();
  const fileEdges: CodeMapEdge[] = [];   // file-level edges for drill-down
  for (let i = 0; i < files.length; i++) {
    const t = imp.get(1000 + i);
    if (!t || t.includes('No imports')) continue;
    const sr = rel(files[i]); const sp = pkg(files[i]);
    for (const ln of t.split('\n')) {
      const tgt = ln.trim(); if (!tgt) continue;
      if (fileEdges.length < 4000) fileEdges.push({ from: sr, to: rel(tgt) });
      const dp = pkg(tgt);
      if (dp !== sp) { const k = `${sp} ${dp}`; pkgEdges.set(k, (pkgEdges.get(k) ?? 0) + 1); }
    }
  }

  // ── Findings (the per-row drawer feed) ──────────────────────────────────
  const findings: CodeFindingInput[] = [];
  // Literal scan is heuristic (substring/regex), so it never outranks a real
  // security rule: secret_suspect is medium at most, the rest low/info.
  const sevFromLiteral = (cat: string): CodeSeverity =>
    cat === 'secret_suspect' ? 'medium' : cat === 'todo_marker' ? 'info' : 'low';

  for (const f of (sec?.findings ?? []).slice(0, 300)) {
    const file = rel(f.file);
    findings.push({
      category: 'security', severity: (f.severity ?? 'medium') as CodeSeverity, file, line: f.line ?? null,
      rule: f.rule ?? 'security', title: f.rule ?? 'Security finding', snippet: f.line_text ?? '',
      why: FINDING_WHY.security, agentPrompt: securityPrompt(f.rule ?? 'security', f.severity ?? 'medium', file, f.line ?? null),
    });
  }
  for (const f of (lit?.findings ?? []).slice(0, 150)) {
    const file = rel(f.file); const cat = f.category ?? 'literal';
    findings.push({
      category: 'literal', severity: sevFromLiteral(cat), file, line: f.line ?? null,
      rule: cat, title: `${cat} literal`, snippet: (f.snippet ?? '').slice(0, 120),
      why: FINDING_WHY.literal, agentPrompt: literalPrompt(cat, file, f.line ?? null, (f.snippet ?? '').slice(0, 80)),
    });
  }
  for (const g of (clones?.groups ?? []).slice(0, 40)) {
    const fns = (g.functions ?? []).filter((x: any) => x && typeof x === 'object');
    const names = [...new Set(fns.map((x: any) => x.name))] as string[];
    const fileList = fns.map((x: any) => rel(x.file)).slice(0, 6);
    const heavy = (g.lines ?? 0) * (g.count ?? 0) >= 150;
    findings.push({
      category: 'clone', severity: heavy ? 'high' : 'medium', file: fileList[0] ?? '', line: fns[0]?.line ?? null,
      rule: 'copy_paste', title: `${names.join(', ')} ×${g.count}`, snippet: `${g.lines} lines, ${g.count} copies`,
      why: FINDING_WHY.clone, agentPrompt: clonePrompt(names, g.lines ?? 0, g.count ?? 0, fileList),
    });
  }
  for (const c of (dup?.clusters ?? []).slice(0, 40)) {
    // file = the reinvented symbol name: a meaningful locator AND the
    // discriminator that keeps each cluster's deterministic id unique.
    findings.push({
      category: 'duplication', severity: 'low', file: c.name ?? '', line: null, rule: 'reinvention',
      title: `${c.name} reimplemented ×${c.count}`, snippet: `${c.kind}, ${c.count} files`,
      why: FINDING_WHY.duplication, agentPrompt: duplicationPrompt(c.name, c.kind ?? '', c.count ?? 0),
    });
  }
  for (const s of (dead?.symbols ?? []).slice(0, 120)) {
    const file = rel(s.file);
    findings.push({
      category: 'dead_code', severity: 'low', file, line: s.line ?? null, rule: 'dead_symbol',
      title: s.name, snippet: s.reason ? `${s.kind ?? 'symbol'} · ${s.reason}` : (s.kind ?? ''), why: FINDING_WHY.dead_code,
      agentPrompt: deadCodePrompt(s.name, s.kind ?? 'symbol', file, s.line ?? null),
    });
  }
  for (const m of (coup?.god_modules ?? []).slice(0, 15)) {
    const file = rel(m.file);
    findings.push({
      category: 'coupling', severity: 'medium', file, line: null, rule: 'god_module',
      title: `God module ${basename(file)}`, snippet: `fan-in ${m.fan_in}, fan-out ${m.fan_out}`,
      why: FINDING_WHY.coupling, agentPrompt: couplingPrompt(file, m.fan_in ?? 0, m.fan_out ?? 0, Math.round((m.instability ?? 0) * 100) / 100),
    });
  }
  for (const c of (cyc?.cycles ?? []).slice(0, 25)) {
    const chain = (c.files ?? []).map(rel);
    findings.push({
      category: 'cycle', severity: 'medium', file: chain[0] ?? '', line: null, rule: 'circular_dependency',
      title: `Circular dependency (${chain.length} files)`, snippet: chain.slice(0, 4).join(' → '),
      why: FINDING_WHY.cycle, agentPrompt: cyclePrompt(chain.slice(0, 6)),
    });
  }

  for (const f of (unwrap?.findings ?? []).slice(0, 150)) {
    const file = rel(f.file);
    findings.push({
      category: 'unwrap', severity: (f.severity ?? 'low') as CodeSeverity, file, line: f.line ?? null,
      rule: f.kind ?? 'unwrap', title: f.scope ? `${f.kind ?? 'unwrap'} in ${f.scope} — possible panic` : `${f.kind ?? 'unwrap'} — possible panic`, snippet: f.line_text ?? '',
      why: FINDING_WHY.unwrap, agentPrompt: unwrapPrompt(f.kind ?? 'unwrap', file, f.line ?? null),
    });
  }
  // test_coverage: only flag real code modules with poor coverage. A file with
  // too few symbols (README, .gitignore, configs) has nothing to test — skip it.
  for (const m of (coverage?.modules ?? [])) {
    const lvl = String(m.coverage ?? '').toLowerCase();
    if (lvl !== 'none' && lvl !== 'low') continue;
    if ((m.total_symbols ?? 0) < 3) continue;
    const file = rel(m.file);
    findings.push({
      category: 'coverage', severity: lvl === 'none' ? 'low' : 'info', file, line: null,
      rule: `coverage_${lvl}`, title: `Low test coverage (${m.test_symbols ?? 0}/${m.total_symbols ?? 0})`,
      snippet: `${m.test_symbols ?? 0}/${m.total_symbols ?? 0} symbols tested`,
      why: FINDING_WHY.coverage, agentPrompt: coveragePrompt(file, m.total_symbols ?? 0, m.test_symbols ?? 0),
    });
  }
  for (const v of (arch?.details ?? []).slice(0, 60)) {
    const from = rel(v.from); const to = rel(v.to);
    findings.push({
      category: 'architecture', severity: 'medium', file: from, line: null, rule: 'layer_violation',
      title: `${v.from_layer}→${v.to_layer} layer violation`, snippet: v.description ? `${from} → ${to} — ${v.description}` : `${from} → ${to}`,
      why: FINDING_WHY.architecture, agentPrompt: architecturePrompt(from, to, v.from_layer ?? '?', v.to_layer ?? '?'),
    });
  }

  // ── Recovered analyzers (were count-only) → real per-item findings ───────
  // crossref: frontend calls with no route (broken) + routes with no caller (dead)
  for (const r of (crossref?.frontend_only_calls ?? []).slice(0, 80)) {
    const file = rel(r.file); const target = r.url ?? '';
    findings.push({
      category: 'crossref', severity: 'medium', file, line: r.line ?? null, rule: 'frontend_only',
      title: `${r.method ?? 'CALL'} ${target} — no backend route`, snippet: `${r.method ?? ''} ${target}`.trim(),
      why: FINDING_WHY.crossref, agentPrompt: crossrefPrompt('frontend_only', r.method ?? 'CALL', target, file, r.line ?? null),
    });
  }
  for (const r of (crossref?.backend_only_routes ?? []).slice(0, 80)) {
    const file = rel(r.file); const target = r.path ?? '';
    findings.push({
      category: 'crossref', severity: 'low', file, line: r.line ?? null, rule: 'backend_only',
      title: `${r.method ?? 'ROUTE'} ${target} — no caller`, snippet: `${r.method ?? ''} ${target}`.trim(),
      why: FINDING_WHY.crossref, agentPrompt: crossrefPrompt('backend_only', r.method ?? 'ROUTE', target, file, r.line ?? null),
    });
  }
  // type_drift: same type disagrees across languages
  for (const m of (typeDrift?.mismatch_details ?? []).slice(0, 80)) {
    const a = `${m.lang_a}:${m.type_a}`; const b = `${m.lang_b}:${m.type_b}`;
    findings.push({
      category: 'type_drift', severity: 'medium', file: m.type_name ?? '', line: null, rule: 'type_mismatch',
      title: `${m.type_name}.${m.field}: ${m.type_a} vs ${m.type_b}`, snippet: `${a}  ≠  ${b}`,
      why: FINDING_WHY.type_drift, agentPrompt: typeDriftPrompt(m.type_name ?? '', m.field ?? '', a, b),
    });
  }
  for (const m of (typeDrift?.missing_field_details ?? []).slice(0, 80)) {
    findings.push({
      category: 'type_drift', severity: 'low', file: m.type_name ?? '', line: null, rule: 'missing_field',
      title: `${m.type_name}.${m.field} missing in ${m.missing_from}`, snippet: `present in ${m.present_in}, missing from ${m.missing_from}`,
      why: FINDING_WHY.type_drift, agentPrompt: typeDriftPrompt(m.type_name ?? '', m.field ?? '', m.present_in ?? '', m.missing_from ?? ''),
    });
  }
  // db_schema: code ↔ migration parity
  const schemaSev = (t: string): CodeSeverity => t === 'missing_migration' ? 'high' : t === 'column_mismatch' ? 'medium' : 'low';
  for (const iss of (dbSchema?.issue_details ?? []).slice(0, 80)) {
    const file = rel(iss.file);
    findings.push({
      category: 'schema', severity: schemaSev(iss.issue_type ?? ''), file, line: iss.line ?? null, rule: iss.issue_type ?? 'schema_issue',
      title: `${iss.table}: ${iss.issue_type}`, snippet: iss.description ?? '',
      why: FINDING_WHY.schema, agentPrompt: schemaPrompt(iss.table ?? '', iss.issue_type ?? '', iss.description ?? '', file, iss.line ?? null),
    });
  }
  // migration_parity: broken migration sequence
  for (const iss of (migParity?.issue_details ?? []).slice(0, 80)) {
    const file = rel(iss.file);
    findings.push({
      category: 'migration', severity: 'medium', file, line: null, rule: iss.issue_type ?? 'migration_issue',
      title: `Migration ${iss.issue_type}`, snippet: iss.description ?? '',
      why: FINDING_WHY.migration, agentPrompt: migrationPrompt(iss.issue_type ?? '', iss.description ?? '', file),
    });
  }
  // manifest_compliance: leaked creds / suspicious deps / missing fields
  const manifestSev = (t: string): CodeSeverity => t === 'credential_in_manifest' ? 'critical' : t === 'suspicious_dependency' ? 'high' : t === 'version_mismatch' ? 'medium' : 'low';
  for (const v of (manifest?.violation_details ?? []).slice(0, 80)) {
    const file = rel(v.file);
    findings.push({
      category: 'manifest', severity: manifestSev(v.violation_type ?? ''), file, line: v.line ?? null, rule: v.violation_type ?? 'manifest_violation',
      title: `${v.violation_type} in ${basename(file)}`, snippet: v.description ?? '',
      why: FINDING_WHY.manifest, agentPrompt: manifestPrompt(v.violation_type ?? '', file, v.line ?? null, v.description ?? ''),
    });
  }

  // ── Hotspots: churn × complexity, generated excluded ────────────────────
  const godSet = new Set((coup?.god_modules ?? []).map((m: any) => rel(m.file)));
  const cloneSet = new Set<string>();
  for (const g of clones?.groups ?? []) for (const x of g.functions ?? []) if (x && typeof x === 'object') cloneSet.add(rel(x.file));
  const secByFile = new Map<string, number>();
  for (const f of sec?.findings ?? []) { const r = rel(f.file); secByFile.set(r, (secByFile.get(r) ?? 0) + 1); }

  const suggest = (r: string, ch: number, cx: number): string => {
    if (isGenerated(r)) return 'Generated — exclude from review; fix the generator/template instead.';
    const s: string[] = [];
    if (godSet.has(r)) s.push('God module: high fan-in AND fan-out — split responsibilities into smaller units.');
    if (secByFile.get(r)) s.push(`${secByFile.get(r)} security finding(s) here — remediate (see Security).`);
    if (cloneSet.has(r)) s.push('Contains duplicated blocks — extract a shared helper.');
    if (ch >= 20 && cx >= 40) s.push('Churned + complex — add regression tests and refactor into smaller functions before the next change.');
    else if (ch >= 20) s.push('Frequently changed — ensure strong test coverage here.');
    if (aiFiles.has(r)) s.push('AI-authored & high-risk — review carefully.');
    return s.join(' ') || 'High churn × complexity — prioritise review/tests.';
  };

  const hotspotsAll: CodeHotspotInput[] = [];
  for (const n of tree) {
    const r = rel(n.path); const ch = churn.get(r) ?? 0;
    if (ch === 0 || isGenerated(r)) continue;
    const cx = complexity(r);
    if (cx <= 2) continue;
    hotspotsAll.push({ file: r, churn: ch, complexity: cx, score: ch * cx, aiAuthored: aiFiles.has(r), lines: n.lines ?? 0, suggestion: suggest(r, ch, cx) });
  }
  hotspotsAll.sort((a, b) => b.score - a.score);
  const hotspots: CodeHotspotInput[] = hotspotsAll.slice(0, 30);

  // ── Blast radius (plan_change) for the top hotspots — "what breaks if I touch this" ──
  log('blast radius (plan_change) for top hotspots …');
  const blast: Record<string, CodeBlastRadius> = {};
  const blastTargets = hotspots.slice(0, 12).map((h) => h.file);
  if (blastTargets.length) {
    try {
      const pc = await runMcp(bin, ws, [
        call(1, 'index_workspace', { path: ws }),
        ...blastTargets.map((f, i) => call(2000 + i, 'plan_change', { file: f, format: 'json' })),
      ]);
      blastTargets.forEach((f, i) => {
        const j = parseJson<any>(pc, 2000 + i, null);
        if (j && typeof j === 'object' && typeof j.fan_in === 'number') {
          blast[f] = {
            fileRole: j.file_role ?? 'regular', fanIn: j.fan_in ?? 0, fanOut: j.fan_out ?? 0,
            direct: j.direct ?? 0, transitive: j.transitive ?? 0, maxDepth: j.max_depth ?? 0,
            directFiles: Array.isArray(j.direct_files) ? j.direct_files.map(rel).slice(0, 20) : undefined,
          };
        }
      });
    } catch { /* blast radius is best-effort enrichment */ }
  }

  // ── Synthesis: the ranked, actionable plan ──────────────────────────────
  log('synthesising action plan …');
  const actions: CodeActionInput[] = [];
  const pushAction = (pri: number, category: string, title: string, fix: string, loc: Array<{ file: string; line?: number | null }>, agentPrompt: string) =>
    actions.push({ pri, category, title, fix, loc, agentPrompt });

  // 1. security grouped by rule
  const byRule = new Map<string, Array<{ file: string; line: number | null; sev: string }>>();
  for (const f of sec?.findings ?? []) {
    const arr = byRule.get(f.rule) ?? []; arr.push({ file: rel(f.file), line: f.line ?? null, sev: f.severity }); byRule.set(f.rule, arr);
  }
  for (const [rule, hits] of byRule) {
    const sev = hits.some((h) => h.sev === 'critical') ? 'critical' : hits.some((h) => h.sev === 'high') ? 'high' : 'medium';
    const pri = sev === 'critical' ? 0 : sev === 'high' ? 1 : 2;
    pushAction(pri, 'security', `${rule} — ${hits.length} occurrence(s)`, secFix(rule),
      hits.slice(0, 4).map((h) => ({ file: h.file, line: h.line })),
      securityPrompt(rule, sev, hits[0].file, hits[0].line));
  }
  // 2. copy-paste clones
  for (const g of clones?.groups ?? []) {
    if ((g.count ?? 0) >= 3 || (g.lines ?? 0) >= 12) {
      const fns = (g.functions ?? []).filter((x: any) => x && typeof x === 'object');
      const names = [...new Set(fns.map((x: any) => x.name))] as string[];
      const locs = fns.map((x: any) => rel(x.file)).slice(0, 5);
      pushAction((g.lines ?? 0) * (g.count ?? 0) >= 150 ? 1 : 2, 'duplication',
        `${names.join(', ')} copy-pasted ${g.count}× (${g.lines} lines each)`,
        'Extract one shared implementation and replace the copies.',
        locs.map((f: string) => ({ file: f })), clonePrompt(names, g.lines ?? 0, g.count ?? 0, locs));
    }
  }
  // 3. reinvented utilities
  for (const c of (dup?.clusters ?? []).slice(0, 12)) {
    if ((c.count ?? 0) >= 5) pushAction(2, 'reuse', `${c.name} (${c.kind}) reimplemented in ${c.count} files`,
      'Consolidate into a single shared utility/module.', [], duplicationPrompt(c.name, c.kind ?? '', c.count));
  }
  // 4. god modules
  for (const m of (coup?.god_modules ?? []).slice(0, 5)) {
    const file = rel(m.file);
    pushAction(2, 'modularity', `God module ${file} (fan-in ${m.fan_in}, fan-out ${m.fan_out})`,
      'Split into cohesive sub-modules; introduce interfaces to cut fan-out.', [{ file }],
      couplingPrompt(file, m.fan_in ?? 0, m.fan_out ?? 0, Math.round((m.instability ?? 0) * 100) / 100));
  }
  // 5. cycles
  for (const c of (cyc?.cycles ?? []).slice(0, 5)) {
    const chain = (c.files ?? []).map(rel);
    pushAction(2, 'architecture', `Circular dependency (${chain.length} files)`,
      'Break the cycle: extract the shared type/interface into a separate module.',
      chain.slice(0, 4).map((f: string) => ({ file: f })), cyclePrompt(chain.slice(0, 6)));
  }
  // 6. hotspots
  for (const h of hotspotsAll.slice(0, 5)) {
    pushAction(2, 'stability', `Hotspot ${h.file} (${h.churn}× changes, complexity ${h.complexity})`,
      'Add regression tests and refactor into smaller functions before the next change.',
      [{ file: h.file }], hotspotPrompt(h.file, h.churn, h.complexity, h.suggestion));
  }
  // 7. dead code (batch)
  if ((dead?.symbols ?? []).length) {
    const names = (dead.symbols as any[]).slice(0, 6).map((s) => s.name);
    pushAction(3, 'cleanup', `${dead.dead_count ?? dead.symbols.length} unreferenced symbols`,
      'Remove if truly unused (verify no reflection / FFI / external API first).', [],
      `Review & remove dead symbols (e.g. ${names.join(', ')}). For each, run codeindex find_callers to confirm it is unreferenced before deleting.`);
  }
  actions.sort((a, b) => a.pri - b.pri);

  // ── Health + map blob + project row ─────────────────────────────────────
  // findings-by-severity (all categories) for the hero counts …
  const sevCount = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const f of findings) if (f.severity in sevCount) sevCount[f.severity]++;
  // … but the SCORE is driven by real security rules + structural debt, with
  // only a small, capped penalty for low-confidence quality noise (literals,
  // dead code, reinvention) so a repo full of TODOs doesn't read as "0 health".
  const secSev = { critical: 0, high: 0, medium: 0 } as Record<string, number>;
  for (const f of sec?.findings ?? []) if (f.severity in secSev) secSev[f.severity]++;
  const qualityNoise = findings.filter((f) => f.category === 'literal' || f.category === 'dead_code' || f.category === 'duplication').length;
  const aiAuthoredFiles = tree.filter((n) => aiFiles.has(rel(n.path))).length;
  const score = Math.round(Math.max(0, Math.min(100,
    100 - secSev.critical * 14 - secSev.high * 6 - secSev.medium * 2
        - (cyc?.cycles?.length ?? 0) * 4 - (coup?.god_modules?.length ?? 0) * 3
        - Math.min(qualityNoise, 60) * 0.1)));

  const nodes: CodeMapNode[] = [...symByPkg.entries()].map(([p, sym]) => ({ file: p, pkg: p, symbols: sym, lines: 0 }));
  const edges: CodeMapEdge[] = [...pkgEdges.entries()].filter(([, w]) => w >= 2).map(([k]) => { const [from, to] = k.split(' '); return { from, to }; });

  const metric = (m: any) => ({ file: rel(m.file), fanIn: m.fan_in ?? 0, fanOut: m.fan_out ?? 0, instability: Math.round((m.instability ?? 0) * 100) / 100 });

  const project: CodeProjectInput = {
    projectId, rootPath: ws, fileCount: st.files ?? tree.length, symbolCount: st.symbols ?? 0,
    langs: Object.fromEntries(langFiles),
    health: {
      score, findings: findings.length, critical: sevCount.critical, high: sevCount.high,
      medium: sevCount.medium, low: sevCount.low, hotspots: hotspots.length,
      aiAuthoredPct: tree.length ? Math.round((aiAuthoredFiles / tree.length) * 1000) / 1000 : 0,
      aiCommits, totalCommits, savingsPct: Number(st.savings_pct ?? 0),
      // count-only analyzers — folded here so the data ships even without per-item detail.
      stats: {
        god_modules: health?.god_modules ?? (coup?.god_modules?.length ?? 0),
        circular_deps: health?.circular_deps ?? (cyc?.cycles?.length ?? 0),
        panic_sites: health?.panic_sites ?? (unwrap?.findings?.length ?? 0),
        dead_symbols: health?.dead_symbols ?? (dead?.symbols?.length ?? 0),
        duplicate_names: health?.duplicate_names ?? (dup?.clusters?.length ?? 0),
        clone_groups: health?.clone_groups ?? (clones?.groups?.length ?? 0),
        literal_urls: lit?.urls ?? 0, literal_ips: lit?.ips ?? 0, literal_localhosts: lit?.localhosts ?? 0,
        literal_secrets: lit?.secrets ?? 0, literal_magic_ports: lit?.magic_ports ?? 0,
        literal_todos: lit?.todos ?? 0, literal_abs_paths: lit?.abs_paths ?? 0,
        crossref_frontend_only: crossref?.frontend_only ?? 0,
        crossref_backend_only: crossref?.backend_only ?? 0,
        type_mismatches: typeDrift?.mismatches ?? 0,
        type_missing_fields: typeDrift?.missing_fields ?? 0,
        db_schema_issues: dbSchema?.issues ?? 0,
        migration_issues: migParity?.issues ?? 0,
        manifest_violations: manifest?.violations ?? 0,
      },
    },
    map: {
      nodes, edges,
      buckets: {
        god_modules: (coup?.god_modules ?? []).map((m: any) => rel(m.file)),
        stable_cores: (coup?.stable_cores ?? []).map((m: any) => rel(m.file)),
        unstable_drivers: (coup?.unstable_drivers ?? []).map((m: any) => rel(m.file)),
        islands: (coup?.islands_sample ?? coup?.islands ?? []).map((m: any) => rel(m.file)),
        cycles: (cyc?.cycles ?? []).slice(0, 25).map((c: any) => (c.files ?? []).map(rel)),
      },
      coupling: {
        god_modules: (coup?.god_modules ?? []).map(metric),
        stable_cores: (coup?.stable_cores ?? []).map(metric),
        unstable_drivers: (coup?.unstable_drivers ?? []).map(metric),
        islands: (coup?.islands_sample ?? coup?.islands ?? []).map((m: any) => ({ file: rel(m.file), fanIn: 0, fanOut: 0, instability: 0 })),
      },
      pkgFiles, fileEdges, fileMeta, langSymbols: Object.fromEntries(langSymbols), blast,
    },
    label: undefined,
    indexedBy: opts.deviceId ?? null,
    lastIndexedAt: Date.now(),
  };

  // Redact at the production boundary: a literal `secret_suspect` finding's
  // snippet (and the prompt that embeds it) can carry a real secret. Everything
  // shipped off this machine must be masked, exactly like the session sync path.
  for (const f of findings) {
    if (f.snippet) f.snippet = redactSecrets(f.snippet, { force: true });
    if (f.agentPrompt) f.agentPrompt = redactSecrets(f.agentPrompt, { force: true });
  }

  log(`done — ${findings.length} findings, ${hotspots.length} hotspots, ${actions.length} actions (health ${score})`);
  void health;  // codeindex's own health rollup is available but we compute our own score
  return { project, findings, hotspots, actions };
}
