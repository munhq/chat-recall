import { describe, test, expect } from 'vitest';
import { extractEntities } from './entity-extractor.js';

describe('extractEntities', () => {
  test('returns no triples for empty text', () => {
    expect(extractEntities('')).toEqual([]);
  });

  test('extracts a project→tool "uses" fact (no glossary is_a triple)', () => {
    const ts = extractEntities('we use postgres for transactional storage', { projectPath: '/code/myapp' });
    // Glossary "postgres is_a database" triples are no longer emitted (noise);
    // the user-specific dependency fact is what we keep.
    expect(ts.find(t => t.predicate === 'uses' && t.object.toLowerCase() === 'postgres')).toBeDefined();
    expect(ts.find(t => t.predicate === 'is_a' && t.object === 'database')).toBeUndefined();
  });

  test('links tool to project when projectPath is provided', () => {
    const ts = extractEntities('we use docker for dev', { projectPath: '/code/myapp' });
    const usesLink = ts.find(t => t.predicate === 'uses' && t.subject.toLowerCase() === 'myapp');
    expect(usesLink).toBeDefined();
  });

  test('deduplicates identical triples', () => {
    const ts = extractEntities('postgres postgres postgres');
    const isAs = ts.filter(t => t.subject.toLowerCase().includes('postgres') && t.predicate === 'is_a');
    expect(isAs.length).toBeLessThanOrEqual(1);
  });

  test('confidence is bounded to (0, 1]', () => {
    const ts = extractEntities('we use redis and docker', { projectPath: '/p/myapp' });
    for (const t of ts) {
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
    }
  });

  test('decision filter drops verbs/stopwords as objects', () => {
    // These trigger phrases used to produce junk triples like
    // "chose -> so" and "rejected -> paying". Should now be filtered.
    const ts = extractEntities(
      'we chose so to keep it simple and rejected paying for the upgrade',
      { projectPath: '/p/x' },
    );
    expect(ts.find(t => t.predicate === 'chose' && t.object.toLowerCase() === 'so')).toBeUndefined();
    expect(ts.find(t => t.predicate === 'rejected' && t.object.toLowerCase() === 'paying')).toBeUndefined();
  });

  test('decision filter keeps known tools as objects', () => {
    const ts = extractEntities('we chose postgres for storage', { projectPath: '/p/myapp' });
    const dec = ts.find(t => t.predicate === 'chose' && t.object.toLowerCase() === 'postgres');
    expect(dec).toBeDefined();
  });

  test('decision filter keeps proper nouns as objects', () => {
    const ts = extractEntities('switched to React from Vue', { projectPath: '/p/myapp' });
    const dec = ts.find(t => t.predicate === 'chose' && t.object === 'React');
    expect(dec).toBeDefined();
  });

  test('decision filter drops bare gerunds', () => {
    const ts = extractEntities('we chose summarizing over reading', { projectPath: '/p/x' });
    expect(ts.find(t => t.predicate === 'chose' && t.object.toLowerCase() === 'summarizing')).toBeUndefined();
  });
});

describe('precision — prose words are not technologies (anti-noise regression)', () => {
  test('"let me go check" does not mint a go language triple', () => {
    const ts = extractEntities('Let me go check what happened and move the file over.', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.subject === 'go')).toBeUndefined();
    expect(ts.find(t => t.subject === 'move')).toBeUndefined();
  });

  test('"written in go" DOES mint the go dependency', () => {
    const ts = extractEntities('The collector is written in go for speed.', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.predicate === 'uses' && t.object === 'go')).toBeDefined();
  });

  test('a single passing mention does not become a project dependency', () => {
    const ts = extractEntities('Someone mentioned redis at the meetup.', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.predicate === 'uses' && t.object === 'redis')).toBeUndefined();
    // And no glossary "redis is_a database" triple is emitted either.
    expect(ts.find(t => t.subject === 'redis' && t.predicate === 'is_a')).toBeUndefined();
  });

  test('claude/gemini never become tool entities (they are in every transcript)', () => {
    const ts = extractEntities('claude wrote this and gemini reviewed it, using claude again.', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.subject === 'claude' || t.object === 'claude')).toBeUndefined();
    expect(ts.find(t => t.subject === 'gemini' || t.object === 'gemini')).toBeUndefined();
  });

  test('npm scopes are not people', () => {
    const ts = extractEntities('Import it from @playwright/test and @chat-recall/engine.');
    expect(ts.find(t => t.predicate === 'is_a' && t.object === 'person')).toBeUndefined();
  });

  test('decorators / JSDoc tags are not people (@param, @app.route, @Component)', () => {
    const ts = extractEntities('@param foo the input. @app.route("/x"). @Component({}) @override', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.predicate === 'is_a' && t.object === 'person')).toBeUndefined();
  });

  test('"I\'m <state>" is not a person (I\'m Sorry / I am Working)', () => {
    for (const s of ["I'm Sorry about that", 'I am Working on it', "I'm Done", "I'm Trying now"]) {
      const ts = extractEntities(s, { projectPath: '/code/myapp' });
      expect(ts.find(t => t.predicate === 'is_a' && t.object === 'person'), s).toBeUndefined();
    }
  });

  test('symmetric "X over Y" needs real tools — no "Monday over Tuesday" garbage', () => {
    const junk = extractEntities('I prefer Monday over Tuesday for releases.', { projectPath: '/code/myapp' });
    expect(junk.find(t => t.predicate === 'chosen_over')).toBeUndefined();
    const real = extractEntities('We went with postgres over mongodb.', { projectPath: '/code/myapp' });
    expect(real.find(t => t.predicate === 'chosen_over' && t.subject === 'postgres')).toBeDefined();
  });

  test('tool aliases are canonicalized (postgresql → postgres)', () => {
    const ts = extractEntities('The app uses postgresql heavily; postgresql everywhere.', { projectPath: '/code/myapp' });
    expect(ts.find(t => t.predicate === 'uses' && t.object === 'postgres')).toBeDefined();
    expect(ts.find(t => t.predicate === 'uses' && t.object === 'postgresql')).toBeUndefined();
  });
});
