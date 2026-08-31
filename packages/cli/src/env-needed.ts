/**
 * Telling someone which secrets they still have to supply, and why.
 *
 * When `init` or `toolkit pull` rebuilds an MCP server on a new machine, it
 * writes the config but not the secrets — values never leave the machine they
 * were set on. Those servers will not start until the person sets them.
 *
 * The message this replaces was one line:
 *
 *   Set these env vars — their values were never uploaded: GITHUB_PERSONAL_ACCESS_TOKEN, XCODEBUILDMCP_ENABLED_WORKFLOWS
 *
 * It never said that anything had been INSTALLED, so the instruction arrived
 * about nothing. It flattened the per-server mapping that the caller already
 * had, so you could not tell which server would break. It did not say where to
 * put them, or what happens if you do not. And it led with a privacy
 * reassurance — answering a question nobody had asked — in the middle of an
 * instruction.
 *
 * Every one of those facts was available at the call site and thrown away by a
 * flatMap.
 */
import chalk from 'chalk';

export interface EnvNeed {
  /** The MCP server this belongs to. */
  server: string;
  vars: string[];
}

/**
 * Variables that are configuration rather than credentials.
 *
 * Presenting a feature flag under "values were never uploaded" implies it was
 * withheld to protect you, when it is simply not the kind of thing anyone
 * uploads. Conflating the two teaches people to skim the warning that matters.
 */
function isSecret(name: string): boolean {
  return /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PAT)\b/i.test(name);
}

/**
 * Servers that cannot run on this machine at all.
 *
 * Asking a Linux user to configure an Xcode tool is noise that costs trust in
 * everything printed beside it. Kept to a platform check rather than a list of
 * server names, so a new macOS-only server needs no change here.
 */
function unusableHere(server: string): string | null {
  const mac = /xcode|swift|apple|ios|macos/i.test(server);
  if (mac && process.platform !== 'darwin') return 'macOS only — nothing to do on this machine';
  return null;
}

/** Group the flat outcomes into one row per server. */
export function collectEnvNeeds(
  outcomes: Array<{ name: string; needsEnv?: string[] }>,
): EnvNeed[] {
  const byServer = new Map<string, Set<string>>();
  for (const o of outcomes) {
    if (!o.needsEnv?.length) continue;
    const set = byServer.get(o.name) ?? new Set<string>();
    for (const v of o.needsEnv) set.add(v);
    byServer.set(o.name, set);
  }
  return [...byServer.entries()]
    .map(([server, vars]) => ({ server, vars: [...vars].sort() }))
    .sort((a, b) => a.server.localeCompare(b.server));
}

/**
 * Render the whole thing: what happened, what is needed, where it goes, and
 * what breaks without it — in that order, because that is the order the
 * questions arrive in.
 */
export function renderEnvNeeds(needs: EnvNeed[], installedCount: number): string[] {
  if (!needs.length) return [];

  const lines: string[] = [];
  const plural = installedCount === 1 ? 'server' : 'servers';
  lines.push(
    chalk.yellow(`Installed ${installedCount} MCP ${plural} from your account. `)
    + chalk.yellow(`${needs.length === 1 ? 'One needs' : `${needs.length} need`} values you must set here:`),
  );
  lines.push('');

  const width = Math.max(...needs.map((n) => n.server.length));
  let anySecret = false;
  for (const n of needs) {
    const note = unusableHere(n.server);
    anySecret ||= n.vars.some(isSecret);
    const name = chalk.bold(n.server.padEnd(width));
    const vars = n.vars.join(', ');
    lines.push(`  ${name}  ${vars}${note ? chalk.dim(`   (${note})`) : ''}`);
  }

  lines.push('');
  lines.push(chalk.dim('  Add them to your shell profile, then restart your AI tool.'));
  lines.push(chalk.dim('  Until then these servers will fail to start.'));
  // The reassurance goes LAST, where it answers a question the reader now has,
  // instead of first, where it interrupted the instruction.
  if (anySecret) {
    lines.push(chalk.dim('  chat-recall never uploads secret values — only the variable names.'));
  }
  return lines;
}
