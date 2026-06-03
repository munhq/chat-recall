import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  resolveProjectId,
  resolveWorkspaceId,
  _setProjectsConfigForTests,
  parseGitRemote,
  globMatch,
} from './project-resolver.js';

let root: string;

function mk(...parts: string[]): string {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}
function gitInit(dir: string, remote?: string) {
  execSync('git init -q', { cwd: dir });
  if (remote) execSync(`git remote add origin ${remote}`, { cwd: dir });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-resolver-'));
  _setProjectsConfigForTests({});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  _setProjectsConfigForTests(null);
});

describe('parseGitRemote', () => {
  test('ssh-style', () => {
    expect(parseGitRemote('git@github.com:adi/chat-recall.git'))
      .toEqual({ host: 'github.com', owner: 'adi', repo: 'chat-recall' });
  });
  test('https-style', () => {
    expect(parseGitRemote('https://github.com/adi/chat-recall.git'))
      .toEqual({ host: 'github.com', owner: 'adi', repo: 'chat-recall' });
  });
  test('gitlab nested groups treated as owner=last-group', () => {
    expect(parseGitRemote('https://gitlab.com/group/sub/repo.git'))
      .toEqual({ host: 'gitlab.com', owner: 'group/sub', repo: 'repo' });
  });
  test('rejects garbage', () => {
    expect(parseGitRemote('not a url')).toBeNull();
  });
  test('normalises SSH host aliases for github (multi-account setup)', () => {
    // ~/.ssh/config: Host github.com-darkkraft → second GitHub account
    expect(parseGitRemote('git@github.com-darkkraft:darkkraft/chat-recall.git'))
      .toEqual({ host: 'github.com', owner: 'darkkraft', repo: 'chat-recall' });
  });
  test('normalises host aliases for other major providers', () => {
    expect(parseGitRemote('git@gitlab.com-work:team/api.git'))
      .toEqual({ host: 'gitlab.com', owner: 'team', repo: 'api' });
    expect(parseGitRemote('git@bitbucket.org-foo:bar/baz.git'))
      .toEqual({ host: 'bitbucket.org', owner: 'bar', repo: 'baz' });
  });
  test('preserves unknown self-hosted hosts (no false collapse)', () => {
    expect(parseGitRemote('git@git.internal-corp:team/api.git'))
      .toEqual({ host: 'git.internal-corp', owner: 'team', repo: 'api' });
  });
});

describe('globMatch', () => {
  test('basic star', () => {
    expect(globMatch('/a/*/c', '/a/b/c')).toBe(true);
    expect(globMatch('/a/*/c', '/a/b/d/c')).toBe(false);
  });
  test('double star', () => {
    expect(globMatch('/a/**/c', '/a/b/d/c')).toBe(true);
    expect(globMatch('/a/**/c', '/a/c')).toBe(true);
  });
  test('brace group', () => {
    expect(globMatch('/x/{a,b}/y', '/x/a/y')).toBe(true);
    expect(globMatch('/x/{a,b}/y', '/x/c/y')).toBe(false);
  });
});

describe('resolveProjectId — git', () => {
  test('git repo with remote yields git:<host>/<owner>/<repo>', () => {
    const repo = mk('myrepo');
    gitInit(repo, 'git@github.com:me/myrepo.git');
    const r = resolveProjectId(repo);
    expect(r.source).toBe('git-remote');
    expect(r.id).toBe('git:github.com/me/myrepo');
    expect(r.displayName).toBe('myrepo');
  });

  test('subdir of git repo rolls up to repo id', () => {
    const repo = mk('myrepo');
    gitInit(repo, 'https://gitlab.com/team/myrepo.git');
    const sub = mk('myrepo', 'src', 'deep', 'subdir');
    const r = resolveProjectId(sub);
    expect(r.id).toBe('git:gitlab.com/team/myrepo');
  });

  test('local-only git repo yields git-local:<hash>', () => {
    const repo = mk('local-only');
    gitInit(repo);
    const r = resolveProjectId(repo);
    expect(r.source).toBe('git-local');
    expect(r.id).toMatch(/^git-local:[0-9a-f]{12}$/);
  });
});

describe('resolveProjectId — auto-workspace', () => {
  test('parent with >=3 git children promotes to ws:<name>', () => {
    const ws = mk('acme');
    for (const name of ['a', 'b', 'c']) {
      const child = mk('acme', name);
      gitInit(child, `git@github.com:acme/${name}.git`);
    }
    // Open the workspace folder itself (no .git here)
    const r = resolveProjectId(ws);
    expect(r.source).toBe('auto-workspace');
    expect(r.id).toBe('ws:acme');
  });

  test('parent with only 2 git children does NOT promote', () => {
    const ws = mk('few');
    for (const name of ['a', 'b']) gitInit(mk('few', name));
    const r = resolveProjectId(ws);
    expect(r.source).toBe('path');
  });

  test('does not promote if parent itself is a git repo (vendored submodules)', () => {
    const outer = mk('outer');
    gitInit(outer, 'git@github.com:me/outer.git');
    for (const name of ['v1', 'v2', 'v3']) gitInit(mk('outer', name));
    // A non-git subfolder inside outer/ should resolve via outer's git, not as a workspace.
    const sub = mk('outer', 'docs');
    const r = resolveProjectId(sub);
    expect(r.id).toBe('git:github.com/me/outer');
  });
});

describe('resolveProjectId — user config', () => {
  test('user-declared root wins over git auto', () => {
    const repo = mk('thing');
    gitInit(repo, 'git@github.com:me/thing.git');
    _setProjectsConfigForTests({
      projects: [{ id: 'my-thing', name: 'My Thing', root: repo }],
    });
    const r = resolveProjectId(repo);
    expect(r.source).toBe('user');
    expect(r.id).toBe('my-thing');
    expect(r.displayName).toBe('My Thing');
  });

  test('sub-project match yields <parent>/<child>', () => {
    const parent = mk('k8s_gpu');
    mk('k8s_gpu', 'services', 'api');
    mk('k8s_gpu', 'infra', 'ansible');
    _setProjectsConfigForTests({
      projects: [{
        id: 'k8s_gpu',
        root: parent,
        children: [
          { id: 'api', name: 'API', path: 'services/api' },
          { id: 'ansible', path: 'infra/ansible' },
        ],
      }],
    });
    const apiPath = join(parent, 'services', 'api');
    const r = resolveProjectId(apiPath);
    expect(r.id).toBe('k8s_gpu/api');
    expect(r.workspaceId).toBe('k8s_gpu');
    expect(r.displayName).toBe('API');
  });

  test('path inside declared root but outside any child falls back to parent id', () => {
    const parent = mk('k8s_gpu');
    mk('k8s_gpu', 'random');
    _setProjectsConfigForTests({
      projects: [{
        id: 'k8s_gpu',
        root: parent,
        children: [{ id: 'api', path: 'services/api' }],
      }],
    });
    const r = resolveProjectId(join(parent, 'random'));
    expect(r.id).toBe('k8s_gpu');
  });

  test('longer declared root wins over shorter (more specific)', () => {
    const outer = mk('outer');
    const inner = mk('outer', 'inner');
    _setProjectsConfigForTests({
      projects: [
        { id: 'outer-id', root: outer },
        { id: 'inner-id', root: inner },
      ],
    });
    const r = resolveProjectId(inner);
    expect(r.id).toBe('inner-id');
  });

  test('ignore rule short-circuits', () => {
    const repo = mk('vendored');
    gitInit(repo, 'git@github.com:foo/bar.git');
    _setProjectsConfigForTests({ ignore: [{ match: `${root}/vendored/**` }, { match: repo }] });
    const r = resolveProjectId(join(repo, 'sub'));
    expect(r.source).toBe('ignored');
  });
});

describe('resolveProjectId — fallbacks', () => {
  test('empty input → path:', () => {
    const r = resolveProjectId('');
    expect(r.source).toBe('path');
  });

  test('non-git folder with no workspace context → path:', () => {
    const lonely = mk('alone');
    const r = resolveProjectId(lonely);
    expect(r.source).toBe('path');
    expect(r.id.startsWith('path:')).toBe(true);
  });
});

describe('resolveWorkspaceId', () => {
  function acmeWorkspace() {
    // /<root>/acme/{a,b,c} — 3 git repos promotes `acme` to a workspace.
    const names = ['repo-a', 'repo-b', 'repo-c'];
    for (const n of names) gitInit(mk('acme', n), `git@github.com:acme/${n}.git`);
    return names;
  }

  test('repo directly under workspace → ws:acme', () => {
    acmeWorkspace();
    expect(resolveWorkspaceId(join(root, 'acme', 'repo-a'))).toBe('ws:acme');
  });

  test('DEEP subdir inside a repo still resolves to ws:acme (CWD-independent)', () => {
    acmeWorkspace();
    const deep = mk('acme', 'repo-a', 'pkg', 'sub', 'dir');
    expect(resolveWorkspaceId(deep)).toBe('ws:acme');
  });

  test('every repo + subdir in the workspace agrees on the same id', () => {
    acmeWorkspace();
    const ids = [
      resolveWorkspaceId(join(root, 'acme', 'repo-a')),
      resolveWorkspaceId(mk('acme', 'repo-b', 'deep', 'path')),
      resolveWorkspaceId(join(root, 'acme', 'repo-c')),
    ];
    expect(new Set(ids)).toEqual(new Set(['ws:acme']));
  });

  test('repo with no workspace context → null', () => {
    const lone = mk('solo');
    gitInit(lone, 'git@github.com:me/solo.git');
    expect(resolveWorkspaceId(lone)).toBeNull();
  });

  test('non-absolute / empty input → null', () => {
    expect(resolveWorkspaceId('')).toBeNull();
    expect(resolveWorkspaceId('relative/path')).toBeNull();
  });
});

describe('resolveProjectId — bot worktrees', () => {
  test('git worktree under .claude-pr-bot buckets to the bot root, not the repo', () => {
    const wt = mk('.claude-pr-bot', 'worktrees', 'myrepo-447');
    gitInit(wt, 'git@github.com:me/myrepo.git');
    const r = resolveProjectId(wt);
    expect(r.source).toBe('path');
    expect(r.id).toBe(`path:${join(root, '.claude-pr-bot')}`);
    expect(r.id.includes('git:')).toBe(false);
  });

  test('all bot worktrees collapse into one bucket', () => {
    const a = mk('.claude-pr-bot', 'worktrees', 'repo-1');
    const b = mk('.claude-pr-bot', 'worktrees', 'repo-2');
    gitInit(a, 'git@github.com:me/repo.git');
    gitInit(b, 'git@github.com:me/repo.git');
    expect(resolveProjectId(a).id).toBe(resolveProjectId(b).id);
  });
});
