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
