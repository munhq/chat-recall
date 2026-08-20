/**
 * PG_SCHEMA is applied as ONE multi-statement string, in written order, so an
 * `ALTER TABLE x` placed above `CREATE TABLE IF NOT EXISTS x` runs before the
 * table exists.
 *
 * On an existing database that mistake is invisible — the table is already
 * there. It only bites a FRESH one: boot dies with 42P01 `relation "x" does not
 * exist`, which means every new self-host install and the compose integration
 * job fail while production stays green. That is exactly how it shipped once
 * (`ALTER TABLE entitlements ADD COLUMN … seats`), so the ordering is asserted
 * here rather than left to review.
 */
import { describe, it, expect } from 'vitest';
import { PG_SCHEMA } from './pg-schema.js';

interface Stmt { table: string; line: number; text: string }

function scan(sql: string): { creates: Map<string, number>; alters: Stmt[] } {
  const creates = new Map<string, number>();
  const alters: Stmt[] = [];
  const lines = sql.split('\n');
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    // Ignore comment lines — a comment that names a table is not a statement.
    if (/^\s*--/.test(raw)) return;
    const c = /CREATE TABLE IF NOT EXISTS\s+([a-z_0-9]+)/i.exec(raw);
    if (c && !creates.has(c[1])) creates.set(c[1], line);
    const a = /^\s*ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_0-9]+)/i.exec(raw);
    if (a) alters.push({ table: a[1], line, text: raw.trim() });
  });
  return { creates, alters };
}

describe('PG_SCHEMA statement order', () => {
  const { creates, alters } = scan(PG_SCHEMA);

  it('parses the schema it is guarding', () => {
    expect(creates.size).toBeGreaterThan(20);
    expect(alters.length).toBeGreaterThan(10);
  });

  it('never ALTERs a table before the CREATE that makes it', () => {
    const offenders = alters
      .filter((a) => {
        const created = creates.get(a.table);
        return created !== undefined && created > a.line;
      })
      .map((a) => `L${a.line}: ${a.text}  (CREATE TABLE ${a.table} is at L${creates.get(a.table)})`);

    expect(offenders, 'these ALTERs run before their table exists — a fresh database fails to boot').toEqual([]);
  });

  it('never ALTERs a table the schema does not create', () => {
    const unknown = alters
      .filter((a) => !creates.has(a.table))
      .map((a) => `L${a.line}: ${a.text}`);

    expect(unknown, 'ALTER on a table PG_SCHEMA never creates').toEqual([]);
  });

  it('keeps the entitlements.seats column reachable on a fresh AND an existing database', () => {
    // Fresh: the CREATE carries the column. Existing: the ALTER adds it.
    const created = creates.get('entitlements');
    const alter = alters.find((a) => a.table === 'entitlements' && /seats/i.test(a.text));
    expect(created).toBeDefined();
    expect(alter).toBeDefined();
    expect(alter!.line).toBeGreaterThan(created!);
    expect(PG_SCHEMA).toMatch(/seats\s+INTEGER/i);
  });
});
