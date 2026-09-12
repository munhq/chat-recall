import { describe, test, expect } from 'vitest';
import { introducedBy, normaliseName } from './decision-guard.js';

const names = (i: Parameters<typeof introducedBy>[0]) => introducedBy(i).names.sort();

describe('installs', () => {
  test('npm, pnpm, yarn and bun all name packages positionally', () => {
    expect(names({ command: 'npm install auth0' })).toEqual(['auth0']);
    expect(names({ command: 'pnpm add keycloak-js' })).toEqual(['keycloak-js']);
    expect(names({ command: 'yarn add stripe' })).toEqual(['stripe']);
    expect(names({ command: 'bun install redis' })).toEqual(['redis']);
  });

  test('other ecosystems', () => {
    expect(names({ command: 'pip install psycopg2' })).toEqual(['psycopg2']);
    expect(names({ command: 'cargo add tokio' })).toEqual(['tokio']);
    expect(names({ command: 'go get github.com/lib/pq' })).toEqual([]);  // URL-shaped, not a bare name
    expect(names({ command: 'gem install devise' })).toEqual(['devise']);
  });

  test('flags are not packages', () => {
    expect(names({ command: 'npm install -g --save-dev auth0' })).toEqual(['auth0']);
    expect(names({ command: 'pip install --upgrade --user keycloak' })).toEqual(['keycloak']);
  });

  test('version specifiers and scopes reduce to the library name', () => {
    expect(names({ command: 'npm i keycloak-js@^3.1.0' })).toEqual(['keycloak-js']);
    expect(names({ command: 'npm i @auth0/nextjs-auth0' })).toEqual(['nextjs-auth0']);
    expect(names({ command: 'pip install "django==4.2"' })).toEqual(['django']);
    expect(names({ command: 'pip install celery[redis]' })).toEqual(['celery']);
  });

  test('several packages in one command are all caught', () => {
    expect(names({ command: 'npm install auth0 stripe redis' })).toEqual(['auth0', 'redis', 'stripe']);
  });

  test('a local tarball or path is not a decision', () => {
    expect(names({ command: 'npm install -g /tmp/cr-update/chat-recall.tgz' })).toEqual([]);
    expect(names({ command: 'npm install ./packages/engine' })).toEqual([]);
  });
});

describe('prose is never a signal', () => {
  test('THE POINT: talking about a tool does not trip the guard', () => {
    // A guard that fires on conversation is a guard people turn off, and a
    // disabled guard protects nothing.
    expect(names({ content: 'we could use Auth0 here, or maybe Keycloak' })).toEqual([]);
    expect(names({ command: 'echo "should we install auth0?"' })).toEqual([]);
  });

  test('a command that merely mentions a name does not count', () => {
    expect(names({ command: 'grep -r keycloak src/' })).toEqual([]);
    expect(names({ command: 'git log --grep auth0' })).toEqual([]);
  });
});

describe('imports', () => {
  test('the module specifier is what names the library, not the binding', () => {
    expect(names({ content: 'import Keycloak from "keycloak-js";' })).toEqual(['keycloak-js']);
    expect(names({ content: "const stripe = require('stripe');" })).toEqual(['stripe']);
  });

  test('python and rust roots', () => {
    expect(names({ content: 'from django.db import models' })).toEqual(['django']);
    expect(names({ content: 'import psycopg2' })).toEqual(['psycopg2']);
    expect(names({ content: 'use tokio::runtime;' })).toEqual(['tokio']);
  });

  test('a relative import decides nothing', () => {
    expect(names({ content: "import { thing } from './local.js';" })).toEqual([]);
    expect(names({ content: "import x from '../../util';" })).toEqual([]);
  });
});

describe('manifests', () => {
  test('a dependency added to package.json counts', () => {
    const content = '{\n  "dependencies": {\n    "keycloak-js": "^3.1.0"\n  }\n}';
    expect(names({ path: 'package.json', content })).toContain('keycloak-js');
  });

  test('requirements.txt and Cargo.toml', () => {
    expect(names({ path: 'requirements.txt', content: 'django==4.2\npsycopg2\n' }))
      .toEqual(expect.arrayContaining(['django', 'psycopg2']));
    expect(names({ path: 'Cargo.toml', content: 'tokio = "1"\n' })).toContain('tokio');
  });

  test('the same content in a file that is NOT a manifest is not scanned as one', () => {
    // Otherwise every JSON fixture in the repo looks like a dependency change.
    expect(names({ path: 'src/fixtures/sample.json', content: '{\n  "keycloak-js": "^3.1.0"\n}' }))
      .toEqual([]);
  });
});

describe('normaliseName', () => {
  test('rejects what is not a package name', () => {
    expect(normaliseName('--save-dev')).toBeNull();
    expect(normaliseName('./local')).toBeNull();
    expect(normaliseName('https://example.com/x.tgz')).toBeNull();
    expect(normaliseName('')).toBeNull();
    expect(normaliseName('a')).toBeNull();
  });

  test('is case- and quote-insensitive', () => {
    expect(normaliseName('"Keycloak-JS",')).toBe('keycloak-js');
  });
});

describe('via', () => {
  test('reports which rule matched, so the message can explain itself', () => {
    expect(introducedBy({ command: 'npm i auth0' }).via).toBe('install');
    expect(introducedBy({ content: 'import x from "auth0";' }).via).toBe('import');
    expect(introducedBy({ path: 'package.json', content: '{"auth0": "^1"}' }).via).toBe('manifest');
    expect(introducedBy({ content: 'nothing here' }).via).toBeNull();
  });

  test('an empty result is the common case and costs nothing', () => {
    expect(introducedBy({ tool: 'Read', path: 'src/index.ts' }).names).toEqual([]);
    expect(introducedBy({}).names).toEqual([]);
  });
});
