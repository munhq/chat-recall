/**
 * Recommendations engine — the moat.
 *
 * Turns the intersection of WHAT you build (code findings/hotspots/AI-authorship
 * /structure) and HOW you build it (failed/abandoned sessions, recurring
 * corrections — behavioral signals) into concrete, one-click-applyable changes:
 * a CLAUDE.md rule, a skill to install, a project label, a POC db reset, or a
 * focused review. Nobody else can compute these because nobody else holds both
 * halves.
 *
 * Pure + deterministic: same inputs → same recommendations (stable ids), so the
 * server can diff/store them and the UI can render apply-actions. The behavioral
 * half is optional — code-only inputs still produce useful recommendations.
 */

import { createHash } from 'crypto';
import type {
  CodeProjectInput, CodeProjectRow, CodeFindingInput, CodeFindingRow,
  CodeHotspotInput, CodeHotspotRow, CodeFindingsSummary,
} from '../../types/code-intel.js';

export type RecommendationKind = 'rule' | 'skill' | 'label' | 'reset' | 'review';

export interface RecommendationAction {
  /** What the local agent does when the user clicks Apply (wired via the intent rail). */
  type: 'append_claude_md' | 'install_skill' | 'set_label' | 'reset_db' | 'open_findings';
  payload: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  severity: 'high' | 'medium' | 'low';
  title: string;
  rationale: string;
  evidence: string[];
  action: RecommendationAction;
}

/** Optional behavioral aggregates for this project (from sessions/outcomes). */
export interface BehaviorSignal {
  failedOrAbandoned: number;
  totalSessions: number;
  /** clustered correction phrases the user repeatedly gave the AI here */
  topCorrections?: string[];
}

export interface RecommendationInput {
  project: CodeProjectInput | CodeProjectRow;
  summary: CodeFindingsSummary;
  findings: Array<CodeFindingInput | CodeFindingRow>;
  hotspots: Array<CodeHotspotInput | CodeHotspotRow>;
  behavior?: BehaviorSignal;
  /**
   * Recommendation ids already applied, so a done one stops being recommended.
   *
   * WHY THIS IS AN INPUT. buildRecommendations is pure over the CURRENT findings,
   * and an applied rule does not change them: adding "search before you write" to
   * CLAUDE.md does not delete the 47 duplication findings that motivated it. So
   * the recommendation regenerated on every load, forever, after being applied.
   *
   * Observed on this very repository: the rule sits in CLAUDE.md under the header
   * "## Rule (added by chat-recall recommendation)", its code_apply sync intent
   * is status='done', and the card still said Apply. A suggestion that cannot
   * notice it was taken teaches you to ignore the panel.
   */
  appliedRecIds?: ReadonlySet<string>;
}

const FRONTEND_LANGS = ['tsx', 'jsx', 'typescriptreact', 'javascriptreact', 'css', 'scss', 'svelte', 'vue'];

function recId(projectId: string, kind: string, key: string): string {
  return 'rec_' + createHash('sha256').update([projectId, kind, key].join('|')).digest('hex').slice(0, 16);
}

export function buildRecommendations(input: RecommendationInput): Recommendation[] {
  const { project, summary, findings, hotspots, behavior } = input;
  const pid = project.projectId;
  const recs: Recommendation[] = [];
  const bySev = summary.bySeverity || {};
  const byCat = summary.byCategory || {};

  // 1. Leaked secrets → a hard rule + rotate. Highest signal.
  const secFindings = findings.filter((f) => f.category === 'security');
  const criticalSec = secFindings.filter((f) => f.severity === 'critical');
  if (criticalSec.length > 0) {
    recs.push({
      id: recId(pid, 'rule', 'no-hardcoded-secrets'),
      kind: 'rule', severity: 'high',
      title: 'Add a "never hardcode secrets" rule + rotate the exposed ones',
      rationale: `${criticalSec.length} critical security finding(s) (e.g. hardcoded secrets) are in this codebase. A standing rule stops the AI re-introducing them.`,
      evidence: criticalSec.slice(0, 4).map((f) => `${f.rule} @ ${f.file}${f.line ? ':' + f.line : ''}`),
      action: { type: 'append_claude_md', payload: { text: 'Never hardcode secrets, API keys, or credentials. Load them from environment variables or a secret manager. If a secret is ever committed, rotate it immediately.' } },
    });
  }

  // 2. Reinvention / copy-paste → a reuse rule.
  const dupCount = (byCat.duplication || 0) + (byCat.clone || 0);
  if (dupCount >= 3) {
    recs.push({
      id: recId(pid, 'rule', 'reuse-before-write'),
      kind: 'rule', severity: 'medium',
      title: 'Add a "search before you write" reuse rule',
      rationale: `${dupCount} duplication/copy-paste finding(s) — the AI keeps reinventing utilities that already exist.`,
      evidence: findings.filter((f) => f.category === 'duplication' || f.category === 'clone').slice(0, 4).map((f) => f.title),
      action: { type: 'append_claude_md', payload: { text: 'Before writing a new helper/utility, search for an existing one (use codeindex find_symbol / find_word). Consolidate duplicates into a single shared module rather than copy-pasting.' } },
    });
  }

  // 3. AI-authored × hotspots → label engineering-grade + a test rule.
  const aiPct = project.health?.aiAuthoredPct ?? 0;
  if (aiPct >= 0.4 && hotspots.length >= 3 && project.label !== 'engineering') {
    recs.push({
      id: recId(pid, 'label', 'engineering-grade'),
      kind: 'label', severity: 'medium',
      title: 'Label this project engineering-grade (AI-authored + churny)',
      rationale: `${Math.round(aiPct * 100)}% of files are AI-authored and there are ${hotspots.length} hotspots — changes here are statistically where bugs land. An engineering-grade label raises the bar (tests + review).`,
      evidence: hotspots.slice(0, 3).map((h) => `${h.file} (churn ${h.churn}, cx ${h.complexity})`),
      action: { type: 'set_label', payload: { label: 'engineering' } },
    });
  }

  // 4a. POC → move fast: reset the db, add a "POC mode" rule (don't over-engineer).
  if (project.label === 'poc') {
    recs.push({
      id: recId(pid, 'reset', 'poc-db'),
      kind: 'reset', severity: 'low',
      title: 'POC: reset the database between iterations',
      rationale: 'This project is labelled POC — invest in iteration speed, not migrations. Reset/reseed the dev db rather than maintaining a migration history.',
      evidence: ['project label = poc'],
      action: { type: 'reset_db', payload: {} },
    });
    recs.push({
      id: recId(pid, 'rule', 'poc-mode'),
      kind: 'rule', severity: 'low',
      title: 'Add a "POC mode" rule — optimise for speed, not durability',
      rationale: 'Labelled POC. Tell the AI it can drop/reseed data, skip migration history, and prefer the fastest path over production hardening here.',
      evidence: ['project label = poc'],
      action: { type: 'append_claude_md', payload: { text: 'This is a POC / throwaway prototype. Optimise for iteration speed: it is OK to reset/reseed the database, skip migration history, and avoid premature hardening. Do not invest in production concerns (backups, zero-downtime migrations) unless asked.' } },
    });
  }

  // 4b. Production/work → protect data: NO destructive ops, reversible migrations.
  if (project.label === 'production') {
    recs.push({
      id: recId(pid, 'rule', 'production-data-safety'),
      kind: 'rule', severity: 'high',
      title: 'Protect production data — no destructive ops without backup',
      rationale: 'This project is labelled production. Schema/data changes must be reversible and data must never be lost to a careless AI edit.',
      evidence: ['project label = production'],
      action: { type: 'append_claude_md', payload: { text: 'This is a PRODUCTION project. NEVER drop or reset the database, truncate tables, or delete user data. Make all schema changes via reversible migrations (never destructive DDL on live data). Back up before any risky operation, and never remove data without explicit written approval.' } },
    });
  }

  // 4c. No label set → ask the user to classify so the right guidance kicks in.
  if (!project.label) {
    recs.push({
      id: recId(pid, 'label', 'classify-project'),
      kind: 'label', severity: 'low',
      title: 'Label this project (POC / Production / Engineering)',
      rationale: 'Set a label so the AI gets the right guardrails — a POC can reset its db and move fast; a production repo must protect data; engineering-grade raises the bar on tests + review.',
      evidence: ['no label set'],
      action: { type: 'set_label', payload: { label: 'production' } },
    });
  }

  // 5. Frontend-heavy → install the frontend-design skill.
  const langs = (project.langs || {}) as Record<string, number>;
  const totalFiles = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  const feFiles = Object.entries(langs).filter(([l]) => FRONTEND_LANGS.includes(l.toLowerCase())).reduce((a, [, n]) => a + n, 0);
  if (feFiles / totalFiles >= 0.25 && feFiles >= 5) {
    recs.push({
      id: recId(pid, 'skill', 'frontend-design'),
      kind: 'skill', severity: 'low',
      title: 'Install the frontend-design skill',
      rationale: `${Math.round((feFiles / totalFiles) * 100)}% of this codebase is frontend (${feFiles} files). The frontend-design skill helps the AI produce non-generic, production-grade UI here.`,
      evidence: [`${feFiles}/${totalFiles} frontend files`],
      action: { type: 'install_skill', payload: { skill: 'frontend-design' } },
    });
  }

  // 6. Circular dependencies → a focused review.
  const cycles = project.map?.buckets?.cycles?.length ?? 0;
  if (cycles > 0) {
    recs.push({
      id: recId(pid, 'review', 'break-cycles'),
      kind: 'review', severity: 'medium',
      title: `Break ${cycles} circular dependency chain(s)`,
      rationale: 'Circular dependencies block modular build/test and signal tangled design. Extract the shared type/interface into its own module.',
      evidence: (project.map?.buckets?.cycles ?? []).slice(0, 3).map((c) => c.join(' → ')),
      action: { type: 'open_findings', payload: { category: 'cycle' } },
    });
  }

  // 7. Behavioral: many unresolved sessions in this project → an acceptance rule.
  if (behavior && behavior.totalSessions >= 4 && behavior.failedOrAbandoned / behavior.totalSessions >= 0.3) {
    const pct = Math.round((behavior.failedOrAbandoned / behavior.totalSessions) * 100);
    recs.push({
      id: recId(pid, 'rule', 'definition-of-done'),
      kind: 'rule', severity: 'medium',
      title: 'Add a "definition of done" rule — sessions here often stall',
      rationale: `${pct}% of recent sessions in this project ended failed/abandoned. A clear "done = built + tested + verified" rule reduces dead-end loops.`,
      evidence: [`${behavior.failedOrAbandoned}/${behavior.totalSessions} sessions unresolved`, ...(behavior.topCorrections ?? []).slice(0, 2)],
      action: { type: 'append_claude_md', payload: { text: 'A task is only done when it builds, its tests pass, and the change is verified by running it — not when the code is written. State what "done" means before starting.' } },
    });
  }

  // 8. Behavioral: recurring corrections → capture them as a rule verbatim.
  if (behavior?.topCorrections && behavior.topCorrections.length >= 1 && behavior.failedOrAbandoned >= 0) {
    const top = behavior.topCorrections[0];
    if (top && top.length > 8) {
      recs.push({
        id: recId(pid, 'rule', 'recurring-correction'),
        kind: 'rule', severity: 'low',
        title: 'Capture a recurring correction as a rule',
        rationale: 'You repeatedly gave the AI the same correction in this project. Encoding it as a rule stops the repetition.',
        evidence: behavior.topCorrections.slice(0, 3),
        action: { type: 'append_claude_md', payload: { text: top } },
      });
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => order[a.severity] - order[b.severity]);
  // Drop what has already been done. Only ACTIONS THE PRODUCT PERFORMED are
  // filtered — the caller derives the set from completed sync intents, so a rule
  // whose apply failed or is still queued keeps offering itself.
  const applied = input.appliedRecIds;
  return applied?.size ? recs.filter((r) => !applied.has(r.id)) : recs;
}

/** Tenant-wide signals for account-level recommendations (the "same approach"
 *  applied to chat-recall's OWN data, not a code project). */
export interface AccountSignal {
  leakedSecrets: number;
  distinctSecretRules: string[];
  behavior?: BehaviorSignal;
}

/**
 * Account-level recommendations from chat-recall's native data: leaked secrets
 * (from the security scanner) and session behaviour (outcomes). Same shape +
 * apply rail as code recommendations, so the UI/MCP treat them identically.
 */
export function buildAccountRecommendations(sig: AccountSignal): Recommendation[] {
  const recs: Recommendation[] = [];
  const id = (kind: string, key: string) => 'rec_acct_' + createHash('sha256').update([kind, key].join('|')).digest('hex').slice(0, 16);

  if (sig.leakedSecrets > 0) {
    recs.push({
      id: id('rule', 'secrets-in-sessions'),
      kind: 'rule', severity: 'high',
      title: `Rotate ${sig.leakedSecrets} leaked secret(s) + add a no-secrets rule`,
      rationale: `chat-recall's scanner found ${sig.leakedSecrets} secret(s) (${sig.distinctSecretRules.slice(0, 4).join(', ') || 'various'}) in your sessions. Rotate them and add a standing rule so the AI never echoes secrets back.`,
      evidence: sig.distinctSecretRules.slice(0, 5),
      action: { type: 'append_claude_md', payload: { text: 'Never paste real secrets/credentials into prompts or print them in output. Reference env var names instead. If a secret was exposed in a session, rotate it.', global: true } },
    });
  }
  if (sig.behavior && sig.behavior.totalSessions >= 5 && sig.behavior.failedOrAbandoned / sig.behavior.totalSessions >= 0.3) {
    const pct = Math.round((sig.behavior.failedOrAbandoned / sig.behavior.totalSessions) * 100);
    recs.push({
      id: id('rule', 'global-definition-of-done'),
      kind: 'rule', severity: 'medium',
      title: 'Add a global "definition of done" rule',
      rationale: `${pct}% of your recent sessions ended unresolved. A standing "done = built + tested + verified" rule reduces dead-end loops across projects.`,
      evidence: [`${sig.behavior.failedOrAbandoned}/${sig.behavior.totalSessions} sessions unresolved`, ...(sig.behavior.topCorrections ?? []).slice(0, 2)],
      action: { type: 'append_claude_md', payload: { text: 'A task is only done when it builds, its tests pass, and the change is verified by running it. State what "done" means before starting.', global: true } },
    });
  }
  const ord = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => ord[a.severity] - ord[b.severity]);
  return recs;
}
