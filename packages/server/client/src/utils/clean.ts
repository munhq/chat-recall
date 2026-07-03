/**
 * Strip status banners that clients like Claude Code occasionally
 * prepend to user messages (MCP health warnings, context-low
 * notices, transient API errors). These aren't part of the user's
 * actual prompt and shouldn't leak into summaries or previews.
 *
 * Mirrors the server-side stripper in src/parsers/chunker.ts.
 */
const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];

export function stripInjectedBanners(text: string): string {
  if (!text) return text;
  let result = text;
  for (const re of INJECTED_BANNERS) result = result.replace(re, ' ');
  // Collapse whitespace that the stripped banner may have left behind,
  // but keep paragraph breaks intact.
  result = result.replace(/[ \t]{2,}/g, ' ');
  return result.trim();
}

/**
 * THE canonical "summary → one-line title" cleaner. AI summaries are
 * structured markdown ("**Request:** - The user wanted …"); a title wants
 * the substance of that first point with no markdown artifacts. Every
 * surface that shows a summary as a row title must go through this —
 * there were previously two divergent copies (list + viewer) and three
 * call sites rendering the raw markdown.
 */
export function summaryTitle(rawSummary: string | null | undefined, maxLength = 200): string {
  if (!rawSummary) return '';
  const summary = stripInjectedBanners(rawSummary);
  // Prefer the "**Request:**" clause — it states what the session was for.
  const requestMatch = summary.match(/\*\*Request:?\*\*:?\s*[-*]?\s*([^\n]+)/i);
  let line = requestMatch?.[1] ?? summary.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  line = line
    .replace(/^#+\s*/, '')                       // markdown heading marker
    .replace(/^\*\*[^*]+\*\*:?\s*[-*]?\s*/, '')  // leading "**Label:**" prefix
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // bold
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, '$1') // italics (not intra-word)
    .replace(/`([^`]+)`/g, '$1')                 // inline code
    .replace(/^[-*•]\s+/, '')                    // list bullet
    .replace(/\s+/g, ' ')
    .trim();
  // Placeholder strings are worse than nothing — they push real content out.
  if (!line) return '';
  if (/^no (first prompt|summary)( available)?$/i.test(line)) return '';
  if (/^session [0-9a-f]{4,}/i.test(line)) return '';
  return line.length <= maxLength ? line : line.substring(0, maxLength) + '…';
}
