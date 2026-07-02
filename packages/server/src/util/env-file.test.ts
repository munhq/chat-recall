import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readEnvFile, writeEnvFile } from './env-file.js';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'env-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('readEnvFile', () => {
  test('parses KEY=value lines into a map', () => {
    const path = join(tmp, '.env');
    writeFileSync(path, 'A=1\nB=hello\n# comment\nC=multi word\n');
    const env = readEnvFile(path);
    expect(env.values).toEqual(expect.objectContaining({ A: '1', B: 'hello', C: 'multi word' }));
  });

  test('returns an empty file shape when path is missing', () => {
    const env = readEnvFile(join(tmp, 'nope.env'));
    expect(env.values).toEqual({});
  });

  test('strips surrounding quotes from values', () => {
    const path = join(tmp, '.env');
    writeFileSync(path, 'A="quoted"\nB=\'single\'\n');
    const env = readEnvFile(path);
    expect(env.values.A).toBe('quoted');
    expect(env.values.B).toBe('single');
  });
});

describe('writeEnvFile', () => {
  test('writes a new env file when one does not exist', () => {
    const path = join(tmp, '.env');
    writeEnvFile(path, { FOO: 'bar', BAZ: 'qux' });
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/FOO=bar/);
    expect(content).toMatch(/BAZ=qux/);
  });

  test('updates a key without disturbing comments or other keys', () => {
    const path = join(tmp, '.env');
    writeFileSync(path, '# top comment\nA=1\nB=2\n');
    writeEnvFile(path, { B: 'new' });
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/# top comment/);
    expect(content).toMatch(/A=1/);
    expect(content).toMatch(/B=new/);
  });

  test('removes a key when value is undefined', () => {
    const path = join(tmp, '.env');
    writeFileSync(path, 'A=1\nB=2\n');
    writeEnvFile(path, { A: undefined });
    const content = readFileSync(path, 'utf-8');
    expect(content).not.toMatch(/A=1/);
    expect(content).toMatch(/B=2/);
  });
});
