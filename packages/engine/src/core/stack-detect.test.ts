import { describe, it, expect } from 'vitest';
import { detectStack, evidenceLine, isManifest, MANIFEST_NAMES } from './stack-detect.js';
import { DECISION_AREAS } from './decision-areas.js';

/**
 * The case this whole feature exists for: a Tauri app whose store is rusqlite,
 * which the register called Postgres because nobody ever opened the manifest.
 */
const CARGO_TOML = `[package]
name = "example-app"
version = "0.1.0"

[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
serde = { version = "1", features = ["derive"] }
rusqlite = { version = "0.32", features = ["bundled", "vtab", "backup"] }
tokio = { version = "1", features = ["full"] }
r2d2_sqlite = "0.25"

[dev-dependencies]
proptest = "1"
`;

describe('detectStack', () => {
  it('reads a Cargo.toml and names the database the driver implies', () => {
    const out = detectStack([{ path: 'src-tauri/Cargo.toml', content: CARGO_TOML }]);
    const db = out.find((e) => e.area === 'database');
    expect(db).toBeDefined();
    expect(db!.value).toBe('SQLite');
    expect(db!.file).toBe('src-tauri/Cargo.toml');
    // The line the reader is sent to must be the line the dependency is on.
    expect(CARGO_TOML.split('\n')[db!.line - 1]).toContain('rusqlite');
  });

  it('collapses two drivers for one product into one piece of evidence', () => {
    const out = detectStack([{ path: 'src-tauri/Cargo.toml', content: CARGO_TOML }]);
    expect(out.filter((e) => e.area === 'database' && e.value === 'SQLite')).toHaveLength(1);
  });

  it('finds the frontend and the test runner in the same manifest', () => {
    const out = detectStack([{ path: 'src-tauri/Cargo.toml', content: CARGO_TOML }]);
    expect(out.find((e) => e.area === 'frontend')?.value).toBe('Tauri');
    expect(out.find((e) => e.area === 'testing')?.value).toBe('proptest');
  });

  it('reads package.json dependencies and devDependencies', () => {
    const content = JSON.stringify({
      name: 'example-app',
      dependencies: { express: '^4.19.0', pg: '^8.11.0', 'better-auth': '^1.6.0', lodash: '^4' },
      devDependencies: { vitest: '^3.0.0', '@playwright/test': '^1.58.0' },
    }, null, 2);
    const out = detectStack([{ path: 'package.json', content }]);
    const byArea = new Map(out.map((e) => [e.area, e.value]));
    expect(byArea.get('api')).toBe('Express');
    expect(byArea.get('database')).toBe('Postgres');
    expect(byArea.get('auth')).toBe('BetterAuth');
    expect(byArea.get('testing')).toBeDefined();
    // A utility library answers no area, so it never becomes a card.
    expect(out.some((e) => e.name === 'lodash')).toBe(false);
  });

  it('does not read a scoped fork as the package it is named after', () => {
    const content = JSON.stringify({ dependencies: { '@acme/react': '1.0.0', '@acme/pg': '1.0.0' } });
    expect(detectStack([{ path: 'package.json', content }])).toEqual([]);
  });

  it('does not mistake a package that merely contains a product name', () => {
    const content = JSON.stringify({ dependencies: { 'pg-boss': '^9.0.0', 'next-auth': '^4.0.0' } });
    const out = detectStack([{ path: 'package.json', content }]);
    // pg-boss is a job queue; next-auth is auth, not the Next.js frontend.
    expect(out.map((e) => `${e.area}:${e.value}`)).toEqual(['auth:NextAuth']);
  });

  it('reads a requirements.txt with version specifiers', () => {
    const content = '# runtime\nfastapi==0.115.0\npsycopg2-binary>=2.9\npytest~=8.0\n-r other.txt\n';
    const out = detectStack([{ path: 'requirements.txt', content }]);
    expect(out.map((e) => `${e.area}:${e.value}`).sort())
      .toEqual(['api:FastAPI', 'database:Postgres', 'testing:pytest']);
  });

  it('reads PEP 621 dependencies written as a list', () => {
    const content = '[project]\nname = "example-app"\ndependencies = [\n  "flask>=3.0",\n  "sqlalchemy>=2.0",\n]\n';
    const out = detectStack([{ path: 'pyproject.toml', content }]);
    expect(out.map((e) => e.value).sort()).toEqual(['Flask', 'SQLAlchemy']);
  });

  it('reads a go.mod require block, version suffix and all', () => {
    const content = 'module example.com/app\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgithub.com/stretchr/testify v1.9.0\n)\n';
    const out = detectStack([{ path: 'go.mod', content }]);
    expect(out.map((e) => `${e.area}:${e.value}`).sort()).toEqual(['api:Gin', 'testing:testify']);
  });

  it('reads a Gemfile', () => {
    const content = "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem 'pg'\ngem 'rspec'\n";
    const out = detectStack([{ path: 'Gemfile', content }]);
    expect(out.map((e) => e.value).sort()).toEqual(['Postgres', 'RSpec']);
  });

  it('takes evidence from every manifest in a monorepo', () => {
    const out = detectStack([
      { path: 'packages/server/package.json', content: JSON.stringify({ dependencies: { express: '4' } }) },
      { path: 'packages/client/package.json', content: JSON.stringify({ dependencies: { react: '18' } }) },
    ]);
    expect(out.map((e) => e.area).sort()).toEqual(['api', 'frontend']);
    expect(out.find((e) => e.area === 'frontend')!.file).toBe('packages/client/package.json');
  });

  it('survives a manifest that is not valid JSON', () => {
    expect(detectStack([{ path: 'package.json', content: '{ broken' }])).toEqual([]);
  });

  it('ignores a file that is not a manifest', () => {
    expect(detectStack([{ path: 'README.md', content: 'we use postgres everywhere' }])).toEqual([]);
  });

  it('returns a stable order', () => {
    const files = [{ path: 'package.json', content: JSON.stringify({ dependencies: { react: '1', express: '1', pg: '1' } }) }];
    expect(detectStack(files)).toEqual(detectStack(files));
    expect(detectStack(files).map((e) => e.area)).toEqual(['api', 'database', 'frontend']);
  });

  it('only ever reports canonical areas', () => {
    const content = JSON.stringify({ dependencies: { express: '4', pg: '8', react: '18', stripe: '22' } });
    for (const e of detectStack([{ path: 'package.json', content }])) {
      expect(DECISION_AREAS).toContain(e.area);
    }
  });
});

describe('evidenceLine', () => {
  it('names the file and the line so a reader can check it', () => {
    const [e] = detectStack([{ path: 'src-tauri/Cargo.toml', content: CARGO_TOML }])
      .filter((x) => x.value === 'SQLite');
    expect(evidenceLine(e)).toMatch(/^rusqlite in src-tauri\/Cargo\.toml:\d+$/);
  });
});

describe('isManifest', () => {
  it('recognises every name the detector reads, at any depth and any case', () => {
    for (const name of MANIFEST_NAMES) {
      expect(isManifest(name)).toBe(true);
      expect(isManifest(`packages/app/${name}`)).toBe(true);
      expect(isManifest(name.toUpperCase())).toBe(true);
    }
    expect(isManifest('package-lock.json')).toBe(false);
  });
});
