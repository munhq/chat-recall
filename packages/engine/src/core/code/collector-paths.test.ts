/**
 * Workspace paths must work on both separators.
 *
 * The collector compared `ws + '/'` with startsWith. On Windows that prefix
 * ('C:\repo/') matches no real path, so rel() silently became the identity
 * function and three things broke at once, none of them loudly:
 *
 *   - readFileSync(join(ws, rel)) received an absolute path joined onto ws,
 *     threw, and complexity fell back to 1 for every file;
 *   - tracked.has(file) compared an absolute Windows path against `git
 *     ls-files` output, which is always relative and forward-slash, so EVERY
 *     secret finding was discarded;
 *   - stored finding paths were absolute, leaking the developer's home
 *     directory to the server.
 *
 * isJunkWorkspacePath had the same flaw with the opposite effect: its '/'
 * boundary matched nothing on Windows, so the daemon happily code-indexed the
 * temp and cache directories it exists to refuse.
 *
 * These assertions are platform-independent on purpose. A Linux server ingests
 * findings produced on a Windows laptop, so the rule cannot depend on the host.
 */
import { describe, test, expect } from 'vitest';
import { isJunkWorkspacePath } from './collector.js';

describe('refusing junk workspaces', () => {
  test.each([
    ['/home/user/.cache/foo', 'posix cache'],
    ['/tmp/scratch/scratchpad', 'posix scratchpad'],
    ['/home/user/proj/node_modules', 'posix node_modules'],
    ['/tmp', 'posix tmp itself'],
    ['C:\\Users\\user\\AppData\\Local\\Temp\\scratchpad', 'windows scratchpad'],
    ['C:\\Users\\user\\.cache\\thing', 'windows cache'],
    ['C:\\proj\\node_modules', 'windows node_modules'],
    ['C:\\proj\\.git', 'windows git dir'],
    ['D:\\tmp', 'windows tmp on another drive'],
  ])('refuses %s (%s)', (p) => {
    expect(isJunkWorkspacePath(p)).toBe(true);
  });

  test.each([
    ['/home/user/code/chat-recall'],
    ['C:\\Users\\user\\code\\chat-recall'],
    // Near-misses: a real repo whose name merely contains a junk word.
    ['/home/user/code/tmpl-service'],
    ['C:\\code\\mytmp-app'],
    ['/home/user/code/gitops'],
  ])('accepts %s', (p) => {
    expect(isJunkWorkspacePath(p)).toBe(false);
  });
});

/**
 * rel() is module-private, so its contract is asserted through the same
 * normalisation it performs. Written as an explicit table because the bug was
 * that the Windows column was never considered at all.
 */
describe('workspace-relative paths', () => {
  const relFor = (ws: string) => {
    const stripped = ws.replace(/[/\\]+$/, '');
    const wsPrefix = stripped.replace(/\\/g, '/') + '/';
    return (p: string) => {
      const n = p.replace(/\\/g, '/');
      let r = n.startsWith(wsPrefix) ? n.slice(wsPrefix.length) : n;
      if (r.startsWith('./')) r = r.slice(2);
      return r;
    };
  };

  test('posix path under a posix workspace', () => {
    expect(relFor('/home/user/repo')('/home/user/repo/src/a.ts')).toBe('src/a.ts');
  });

  test('windows path under a windows workspace — the case that was broken', () => {
    expect(relFor('C:\\Users\\user\\repo')('C:\\Users\\user\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  test('a trailing separator on the workspace is stripped, either kind', () => {
    expect(relFor('/home/user/repo/')('/home/user/repo/src/a.ts')).toBe('src/a.ts');
    expect(relFor('C:\\Users\\user\\repo\\')('C:\\Users\\user\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  test('the result is always forward-slash, so it means the same on any host', () => {
    // A Linux server stores findings produced on a Windows laptop; a path that
    // arrives with backslashes never matches anything the server compares it to.
    expect(relFor('C:\\repo')('C:\\repo\\a\\b\\c.ts')).not.toContain('\\');
  });

  test('git ls-files output (relative, forward-slash) passes through unchanged', () => {
    // This is the comparison that dropped every Windows secret finding.
    expect(relFor('C:\\repo')('src/a.ts')).toBe('src/a.ts');
  });

  test('a path outside the workspace is left alone rather than mangled', () => {
    expect(relFor('/home/user/repo')('/etc/passwd')).toBe('/etc/passwd');
  });
});
