/**
 * The digests `recall_smart_resume` prints for the sessions BEFORE the one it
 * resumes in full.
 *
 * "Continue" rarely means one session. An evening's work spans three of them,
 * and the newest alone reports a fragment: the tail of a task whose decision
 * was taken two sessions back, or a claim whose reason is in the session before
 * it. The head dossier answers "where did I stop"; these answer "what was I
 * doing", which is the question that was actually asked.
 *
 * A bare call also takes the GLOBALLY newest sessions. When the last thing a
 * machine ran belonged to another project, the single-session answer was
 * confidently about the wrong work with nothing on screen to show it. Each
 * digest carries its own project, and `crossProjectNote` says so outright when
 * the set disagrees.
 *
 * The formatting lives here, away from the tool handler, because it is pure:
 * rows in, markdown lines out. The handler owns the fetching.
 */

/** A row as `/api/conversations/recent` returns it. */
export interface RecentRow {
  sessionId: string;
  projectPath?: string;
  modified?: string;
  firstPrompt?: string;
  summary?: string;
  tool?: string;
  userTitle?: string | null;
  toolTitle?: string | null;
}

/** The subset of `/outcome` a digest reads. */
export interface DigestOutcome {
  status: string;
  reason: string;
  fileCount: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  commits?: { totalCommits: number };
  decisions?: Array<{ text: string }>;
}

/** The subset of `/related` a digest reads. */
export interface DigestRelated {
  links?: Array<{ sourceType: string; title: string }>;
}

export interface DigestInput {
  row: RecentRow;
  outcome?: DigestOutcome | null;
  related?: DigestRelated | null;
  /** Ready-made resume command, or null when the tool has none. */
  resumeCmd?: string | null;
}

/**
 * Split a generated summary into its four sections.
 *
 * `summary-generator.ts` asks for exactly these headings, so they are a format
 * this code owns rather than a shape guessed from output: **Request:**,
 * **Plan:**, **What was done:**, **Remaining/Not done:**.
 *
 * A digest that printed the summary's opening printed the REQUEST every time,
 * because Request and Plan come first and 400 characters never reached past
 * them. The reader learned what was asked — which the title already said — and
 * never what happened. Resuming needs the last two sections.
 *
 * A summary that does not carry the headings (a shorter provider, an older
 * row) yields an empty record, and the caller falls back to the opening text.
 */
export function splitSummary(summary: string): {
  request?: string; plan?: string; done?: string; remaining?: string;
} {
  const out: { request?: string; plan?: string; done?: string; remaining?: string } = {};
  if (!summary) return out;
  const heads: Array<[keyof typeof out, RegExp]> = [
    ['request', /\*\*Request:?\*\*/i],
    ['plan', /\*\*Plan:?\*\*/i],
    ['done', /\*\*What was done:?\*\*/i],
    ['remaining', /\*\*Remaining\s*\/?\s*Not done:?\*\*/i],
  ];
  const marks: Array<{ key: keyof typeof out; start: number; end: number }> = [];
  for (const [key, re] of heads) {
    const m = re.exec(summary);
    if (m) marks.push({ key, start: m.index + m[0].length, end: m.index });
  }
  marks.sort((a, b) => a.start - b.start);
  for (let i = 0; i < marks.length; i++) {
    const stop = i + 1 < marks.length ? marks[i + 1].end : summary.length;
    const body = summary.slice(marks[i].start, stop).trim();
    if (body) out[marks[i].key] = body;
  }
  return out;
}

/**
 * True for a bullet that is only a heading: `**Infrastructure/Debugging:**`.
 *
 * The generator groups its bullets under bold labels, and at digest scale a
 * label with its group cut off is a line that says nothing. Four of them filled
 * the whole budget on a real session and reported no work at all.
 */
function isLabelOnly(text: string): boolean {
  const bare = text.replace(/\*\*/g, '').trim();
  return bare.endsWith(':');
}

/**
 * A section reduced to its bullets, flattened onto one line each.
 *
 * The generator nests bullets two deep and the nesting carries no meaning at
 * digest scale — it costs three lines to say what one says.
 */
export function bulletLines(section: string | undefined, max: number, chars = 160): string[] {
  if (!section) return [];
  const out: string[] = [];
  for (const raw of section.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('-') && !line.startsWith('*')) continue;
    const text = line.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!text || isLabelOnly(text)) continue;
    out.push(text.length > chars ? `${text.slice(0, chars)}…` : text);
    if (out.length >= max) break;
  }
  return out;
}

/** Same status→emoji mapping the head dossier and `recall_outcome` use. */
function statusEmoji(status: string): string {
  if (status === 'shipped') return '🚢';
  if (status === 'interrupted') return '⏸';
  if (status === 'abandoned') return '🪦';
  if (status === 'in_progress') return '🟡';
  return '❔';
}

/** The last path segment, which is the name a person recognises. */
export function projectName(projectPath?: string): string {
  if (!projectPath) return '';
  return projectPath.split('/').pop() || projectPath;
}

/** The title to print: what the user named it, else the tool's, else the prompt. */
export function digestTitle(row: RecentRow, max = 90): string {
  const t = row.userTitle?.trim() || row.toolTitle?.trim() || row.firstPrompt || '(no prompt)';
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * One session's digest.
 *
 * The summary is trimmed to its opening. The full text belongs to
 * `recall_summary`; a digest only has to say enough to tell whether this is the
 * session worth opening.
 */
export function formatDigest(input: DigestInput, summaryChars = 400): string[] {
  const { row, outcome, related, resumeCmd } = input;
  const lines: string[] = [];

  lines.push(`### ${digestTitle(row)}`);
  const when = (row.modified || '').slice(0, 16).replace('T', ' ');
  lines.push(
    `**Project:** ${projectName(row.projectPath) || '(unknown)'}`
    + ` · **Tool:** ${row.tool || 'claude'}`
    + (when ? ` · **Modified:** ${when}` : '')
    + ` · \`${row.sessionId}\``,
  );

  if (outcome) {
    const edits = outcome.fileCount > 0
      ? ` · ${outcome.fileCount} file(s) +${outcome.totalLinesAdded}/−${outcome.totalLinesRemoved}`
      : '';
    const commits = outcome.commits && outcome.commits.totalCommits > 0
      ? ` · ${outcome.commits.totalCommits} commit(s)`
      : '';
    lines.push(`${statusEmoji(outcome.status)} **${outcome.status}** — ${outcome.reason}${edits}${commits}`);
  }

  // The conclusion, not the request. The title above already carries what was
  // asked; what this has to answer is what came of it and what is still open.
  const sections = splitSummary(row.summary || '');
  const did = bulletLines(sections.done, 4);
  const left = bulletLines(sections.remaining, 4);

  if (did.length) {
    lines.push('**Did:**');
    for (const d of did) lines.push(`- ${d}`);
  }
  if (left.length) {
    lines.push('**Still open:**');
    for (const l of left) lines.push(`- ${l}`);
  }

  // Fall back to the opening only when the summary carries no headings — an
  // older row, or a provider that ignored the format. Some text beats none.
  if (!did.length && !left.length) {
    const gist = (row.summary || '').replace(/\s+/g, ' ').trim();
    if (gist) lines.push(gist.length > summaryChars ? `${gist.slice(0, summaryChars)}…` : gist);
  }

  // Decisions carry across sessions — a choice taken two sessions ago still
  // governs the work in front of you.
  if (outcome?.decisions?.length) {
    lines.push('**Decisions:**');
    for (const d of outcome.decisions.slice(0, 3)) lines.push(`- ${d.text.slice(0, 160)}`);
  }

  const tasks = (related?.links ?? []).filter(l => l.sourceType === 'task');
  if (tasks.length > 0) {
    lines.push('**Task lists:**');
    for (const t of tasks.slice(0, 5)) lines.push(`- ${t.title}`);
  }

  if (resumeCmd) lines.push(`**Resume:** \`${resumeCmd}\``);
  lines.push('');
  return lines;
}

/**
 * The warning that the resumed set is not one project.
 *
 * Returns null when the caller scoped the call, or when every session agrees —
 * a note on a single-project set is noise, and noise is what stops warnings
 * being read.
 */
export function crossProjectNote(
  headProject: string,
  priorRows: RecentRow[],
  hasProjectFilter: boolean,
): string | null {
  if (hasProjectFilter) return null;
  const names = new Set(
    [headProject, ...priorRows.map(r => projectName(r.projectPath))].filter(Boolean),
  );
  if (names.size < 2) return null;
  return `_These sessions span ${names.size} projects (${[...names].join(', ')}).`
    + ' Pass `project_filter` to scope the resume to one._';
}
