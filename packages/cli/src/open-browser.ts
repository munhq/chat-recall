/**
 * Open a URL in the user's browser, and never care much whether it worked.
 *
 * Used for sign-in, which is why the caller ALWAYS prints the URL too. An MCP
 * server or a CLI can be running over ssh, in a container, in CI, or on a
 * headless box, and in every one of those there is no browser to open. A flow
 * that depends on this succeeding is a flow that strands those users silently —
 * so this is a convenience on top of a link, never the way the link is
 * delivered.
 *
 * Detached and fully ignored: a browser launched as a child of a long-lived
 * daemon would otherwise keep a pipe open and, on some desktops, die with the
 * parent.
 */
import { spawn } from 'node:child_process';

/** Only ever hand the shell-free launchers an http(s) URL we built ourselves. */
function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

/**
 * Returns true when a launcher was started — NOT that a browser appeared. There
 * is no portable way to learn the second thing, and pretending otherwise would
 * let a caller suppress the printed URL.
 */
export function openBrowser(url: string): boolean {
  if (!isSafeUrl(url)) return false;
  // Respect the convention a headless or scripted environment uses to say "do
  // not launch anything", plus the usual CI markers.
  if (process.env.CHAT_RECALL_NO_BROWSER === '1' || process.env.CI) return false;

  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32'
      // `start` is a cmd builtin; the empty title argument is required or a URL
      // containing spaces is read as the window title.
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no launcher on this box — the URL was printed */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
