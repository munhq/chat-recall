/**
 * Agent-prompt + remediation generation — the actionability IP.
 *
 * Ported from codeindex's dashboard.py (SEC_FIX, action synthesis) and
 * dashboard_template.html (WHY, P()). Lives server-side/in-engine on purpose:
 * the OSS binary emits raw findings; turning them into "why it matters" + a
 * ready agent prompt that references codeindex MCP tools (so the agent verifies
 * before editing) is the paid product's value, not the commodity analyzer's.
 *
 * Every prompt is concrete (file:line, the duplicated set, the fix) and tells
 * the agent which codeindex tool to run first — never generic "review this".
 */

import type { CodeFindingCategory } from '../../types/code-intel.js';

/** One-line "why it matters" per finding category (shown in the drawer). */
export const FINDING_WHY: Record<CodeFindingCategory, string> = {
  security: 'Leaked credential or unsafe pattern — exploitable. Remediate now; rotate if a secret.',
  literal: 'Hardcoded endpoint/secret breaks across environments and can leak.',
  clone: 'Duplicated logic drifts out of sync — a fix in one copy leaves the others buggy.',
  duplication: 'The same thing reimplemented many times — consolidate to one source of truth.',
  dead_code: 'Unused code is maintenance drag and review noise.',
  coupling: 'Over-coupled module: hard to change safely and concentrates risk.',
  cycle: 'Circular dependency blocks modular build/test and signals tangled design.',
  unwrap: 'Unchecked unwrap/panic on an error path — a crash waiting for the wrong input.',
  coverage: 'Code with few or no tests — changes here ship unverified.',
  architecture: 'Layering violation — a lower layer reaching into a higher one tangles the design.',
  crossref: 'Frontend/backend wiring gap — a call with no route (or a route nobody calls) is a broken or dead API.',
  type_drift: 'The same type disagrees across languages — a serialization/contract mismatch waiting to corrupt data.',
  schema: 'Code and migrations disagree about the schema — a table/column drift that fails at runtime.',
  migration: 'Migration sequence is broken (gap/duplicate/out-of-order) — deploys may apply the wrong state.',
  manifest: 'Manifest problem — a leaked credential, suspicious/unused dependency, or missing required field.',
};

/** Per-rule remediation for security findings (from codeindex's rule set). */
export const SEC_FIX: Record<string, string> = {
  hardcoded_secret_assignment: 'Move the secret to env/secret-manager and ROTATE the exposed credential.',
  private_key_block: 'Remove the committed private key; rotate it and load from a vault.',
  aws_access_key: 'Revoke this AWS key immediately and move to IAM roles / secrets.',
  stripe_live_key: 'Revoke the live Stripe key and load from env.',
  github_token: 'Revoke the token and use a secrets store.',
  solidity_tx_origin_auth: 'Replace tx.origin auth with msg.sender (phishing-safe).',
  solidity_delegatecall: 'Audit the delegatecall target — ensure it is trusted and immutable.',
  solidity_low_level_call: "Check the call's return value; prefer a checked/safe wrapper.",
  solidity_timestamp_dependence: "Don't rely on block.timestamp for critical logic.",
  solidity_weak_randomness: 'Use a secure randomness source (e.g. a VRF), not blockhash.',
  command_injection: 'Never pass untrusted input to exec/system; use safe APIs.',
  eval_usage: 'Avoid eval on dynamic input.',
};

export function secFix(rule: string): string {
  return SEC_FIX[rule] ?? 'Review and remediate.';
}

// ── Per-finding agent prompts (the P() port). Each references a codeindex tool.

export function securityPrompt(rule: string, severity: string, file: string, line: number | null): string {
  return `Fix a ${severity} security finding (${rule}) at ${file}:${line ?? '?'}. Open the file, explain the concrete risk, and show the minimal diff. ${secFix(rule)}`;
}

export function literalPrompt(cat: string, file: string, line: number | null, snippet: string): string {
  return `Hardcoded ${cat} at ${file}:${line ?? '?'}: \`${snippet}\`. Move it to configuration/secret management and replace the literal. Show the diff.`;
}

export function clonePrompt(names: string[], lines: number, count: number, files: string[]): string {
  return `These function(s) ${names.join(', ')} (${lines} lines) are copy-pasted ${count}× across:\n${files.map((f) => '  - ' + f).join('\n')}\nUse codeindex find_callers / get_imported_by to confirm every usage, extract ONE shared implementation, and replace all call sites. Show the new function and the edits.`;
}

export function duplicationPrompt(name: string, kind: string, count: number): string {
  return `\`${name}\` (${kind}) is reimplemented in ${count} files. Find all definitions (codeindex find_symbol "${name}"), consolidate into one shared utility, and update imports. Show the diff.`;
}

export function deadCodePrompt(name: string, kind: string, file: string, line: number | null): string {
  return `Verify whether ${name} (${kind}) at ${file}:${line ?? '?'} is truly unused — check reflection, FFI, dynamic dispatch and exported API (codeindex find_callers "${name}"). If unused, remove it and any now-dead references.`;
}

export function hotspotPrompt(file: string, churn: number, cx: number, suggestion: string): string {
  return `${file} is a hotspot — changed ${churn}× with complexity ${cx}. ${suggestion}\nRun codeindex get_change_impact on it first, add tests for its critical paths, then propose targeted refactors to reduce complexity. Show a plan + the first diff.`;
}

export function couplingPrompt(file: string, fanIn: number, fanOut: number, instability: number): string {
  return `${file} has fan-in ${fanIn}, fan-out ${fanOut} (instability ${instability}). Use codeindex get_imports/get_imported_by to map its dependencies, then propose how to split it into cohesive units and which dependencies to invert behind interfaces.`;
}

export function cyclePrompt(chain: string[]): string {
  return `Break this circular dependency:\n  ${chain.join(' → ')} → ${chain[0]}\nIdentify the shared type/interface to extract into a new module and show the change.`;
}

export function unwrapPrompt(kind: string, file: string, line: number | null): string {
  return `Unchecked ${kind} at ${file}:${line ?? '?'} can panic. Replace it with proper error handling (propagate with ? / Result, or a checked fallback). Use codeindex get_change_impact first, then show the diff.`;
}

export function coveragePrompt(file: string, totalSymbols: number, testSymbols: number): string {
  return `${file} has ${testSymbols}/${totalSymbols} symbols covered by tests. Identify its critical paths (codeindex get_outline) and add focused tests before the next change. Show the new tests.`;
}

export function architecturePrompt(from: string, to: string, fromLayer: string, toLayer: string): string {
  return `Layer violation: ${from} (${fromLayer}) imports ${to} (${toLayer}). Invert the dependency behind an interface, or move the shared piece to a lower layer. Use codeindex get_imports/get_imported_by to map the blast radius, then show the change.`;
}

export function crossrefPrompt(kind: 'frontend_only' | 'backend_only', method: string, target: string, file: string, line: number | null): string {
  return kind === 'frontend_only'
    ? `Frontend calls \`${method} ${target}\` (${file}:${line ?? '?'}) but no backend route matches it. Either the endpoint is missing/renamed or the call is wrong. Find the intended route (codeindex search "${target}"), then fix the call or implement the route. Show the diff.`
    : `Backend route \`${method} ${target}\` (${file}:${line ?? '?'}) has no frontend caller. Confirm it is truly unused (codeindex find_word "${target}") — if dead, remove it; if it's a public API, document why it's kept.`;
}

export function typeDriftPrompt(typeName: string, field: string, a: string, b: string): string {
  return `Type \`${typeName}\` field \`${field}\` disagrees across languages: ${a} vs ${b}. Pick the source of truth, align both sides, and add a shared contract/test so they can't drift again. Show the diff.`;
}

export function schemaPrompt(table: string, issueType: string, description: string, file: string, line: number | null): string {
  return `Schema drift on \`${table}\` (${issueType}) at ${file}:${line ?? '?'}: ${description}. Reconcile the code model and the migrations — add the missing migration or model, or fix the mismatched column. Show the migration + model change.`;
}

export function migrationPrompt(issueType: string, description: string, file: string): string {
  return `Migration problem (${issueType}) in ${file}: ${description}. Renumber/merge/reorder the migrations so the sequence is contiguous and deterministic. Show the corrected migration set.`;
}

export function manifestPrompt(violationType: string, file: string, line: number | null, description: string): string {
  if (violationType === 'credential_in_manifest') {
    return `A credential appears in the manifest ${file}:${line ?? '?'}: ${description}. Remove it, ROTATE the exposed secret, and load it from env/secret-manager instead. Show the diff.`;
  }
  return `Manifest issue (${violationType}) in ${file}:${line ?? '?'}: ${description}. Fix the manifest — pin/remove the dependency or add the required field. Show the diff.`;
}
