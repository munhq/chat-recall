/**
 * Status banners that Claude Code and related clients prepend to user
 * messages — MCP failures, low-context notices, API errors.
 *
 * They are not part of the user's intent, so they must not reach a summary, a
 * preview or a search hit. The session parser strips them from every recorded
 * prompt; the summary generator strips them again from text it sends onward.
 */

const INJECTED_BANNERS: RegExp[] = [
  /MCP issues detected\. ?Run \/mcp list for status\.?/g,
  /Context low[^\n]*Run \/compact[^\n]*/g,
  /API Error:[^\n]{0,120}/g,
];

export function stripInjectedBanners(text: string): string {
  let result = text;
  for (const re of INJECTED_BANNERS) result = result.replace(re, ' ');
  return result;
}
