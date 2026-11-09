import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectOfFolder, repoFromRemoteUrl } from './session-project.js';

describe('repoFromRemoteUrl', () => {
  test.each([
    ['git@github.com:acme/example-app.git', 'acme/example-app'],
    ['https://github.com/acme/example-app.git', 'acme/example-app'],
    ['https://github.com/acme/example-app', 'acme/example-app'],
    ['ssh://git@git.example.com/acme/example-app.git', 'acme/example-app'],
    ['https://git.example.com/acme/example-app/', 'acme/example-app'],
  ])('%s', (url, repo) => expect(repoFromRemoteUrl(url)).toBe(repo));

  test('a local path or an empty value is no project', () => {
    expect(repoFromRemoteUrl('/srv/git/example-app.git')).toBeNull();
    expect(repoFromRemoteUrl('../example-app')).toBeNull();
    expect(repoFromRemoteUrl('')).toBeNull();
  });
});

describe('projectOfFolder', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'project-of-folder-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  test('a desk work folder names its repository from .desk/config.json', () => {
    write(join(root, 'work', '.desk', 'config.json'), JSON.stringify({ version: 1, github: 'acme/example-app', store: 'server' }));
    mkdirSync(join(root, 'work', 'src', 'deep'), { recursive: true });
    expect(projectOfFolder(join(root, 'work', 'src', 'deep'))).toBe('acme/example-app');
  });

  test('a git checkout names its repository from the origin remote', () => {
    write(join(root, 'repo', '.git', 'config'),
      '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/fork.git\n'
      + '[remote "origin"]\n\turl = git@github.com:acme/example-app.git\n');
    expect(projectOfFolder(join(root, 'repo'))).toBe('acme/example-app');
  });

  test('a checkout without a remote is named by its folder', () => {
    write(join(root, 'example-lib', '.git', 'config'), '[core]\n\tbare = false\n');
    expect(projectOfFolder(join(root, 'example-lib'))).toBe('example-lib');
  });

  test('a linked worktree reads the config of the main checkout', () => {
    const main = join(root, 'main');
    write(join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/example-app.git\n');
    mkdirSync(join(main, '.git', 'worktrees', 'task'), { recursive: true });
    write(join(root, 'task-tree', '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'task')}\n`);
    expect(projectOfFolder(join(root, 'task-tree'))).toBe('acme/example-app');
  });

  test('a folder in no repository has no project', () => {
    mkdirSync(join(root, 'plain'), { recursive: true });
    expect(projectOfFolder(join(root, 'plain'))).toBeNull();
    expect(projectOfFolder('')).toBeNull();
  });

  test('a bad .desk/config.json does not hide the git remote', () => {
    write(join(root, 'both', '.desk', 'config.json'), '{ not json');
    write(join(root, 'both', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/example-app.git\n');
    expect(projectOfFolder(join(root, 'both'))).toBe('acme/example-app');
  });
});
