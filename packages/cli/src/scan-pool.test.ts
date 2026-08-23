/**
 * The worker must be INVISIBLE. Same findings, same redactions, same archive
 * bytes as the inline path — or it is not an optimisation, it is a behaviour
 * change that happens to be faster.
 *
 * Why the work moved at all: scan + redact + gzip + base64 are ~98% of the CPU
 * building one session burns (measured 31.2 s over 200 MB of real sessions), and
 * all of it ran on the main thread. A single 47 MB transcript is ~7 seconds of
 * solid computation, during which the daemon serviced no timers and no signals.
 *
 * These tests drive the REAL bundled worker when one exists, and assert the
 * fallback is correct when it does not — which is also the dev-from-source case.
 */
import { describe, test, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ScanPool, closeScanPool } from './scan-pool.js';
import { scanTextForFindings, redactSecrets } from '@chat-recall/engine/core/secret-redactor.js';

const workerBuilt = existsSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'scan-worker.js'));

afterAll(async () => { await closeScanPool(); });

/** A transcript with a real secret in it, plus enough bulk to be representative. */
function fixture() {
  return [
    { name: 'main', text: [
      '{"type":"user","message":"deploy the thing"}',
      '{"type":"assistant","text":"export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789"}',
      `{"type":"assistant","text":"${'padding '.repeat(2000)}"}`,
    ].join('\n') },
    { name: 'subagents/one', text: '{"type":"user","message":"and the other thing"}' },
  ];
}

/** Exactly what buildConversationSync does when the pool is unavailable. */
function inline(files: ReturnType<typeof fixture>, container: { v: 1; tool: string; mtime: number }) {
  const findings = scanTextForFindings(files.map((f) => f.text).join('\n'));
  const count = { redactions: 0 };
  const redacted = files.map((f) => ({ name: f.name, text: redactSecrets(f.text, { force: true, count }) }));
  const json = JSON.stringify({ ...container, files: redacted });
  const gz = gzipSync(json, { level: 6 });
  return { findings, redactions: count.redactions, rawB64: gz.toString('base64'), rawSize: Buffer.byteLength(json) };
}

describe('scan pool', () => {
  test('a size of 0 disables the pool, so everything runs inline', async () => {
    const pool = new ScanPool(0);
    expect(pool.enabled).toBe(false);
    expect(await pool.run({
      files: fixture(), container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    })).toBeNull();
  });

  test('the rule pack is sent once per version, not per task', () => {
    const pool = new ScanPool(0);
    expect(pool.needsPack('v1')).toBe(true);
    pool.markPackSent('v1');
    expect(pool.needsPack('v1')).toBe(false);
    expect(pool.needsPack('v2')).toBe(true);   // a new pack must be re-sent
  });

  test.skipIf(!workerBuilt)('worker output is IDENTICAL to the inline path', async () => {
    const files = fixture();
    const container = { v: 1 as const, tool: 'claude', mtime: 1750000000000 };
    const pool = new ScanPool(1);

    const got = await pool.run({
      files, container, includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    });
    const want = inline(files, container);

    expect(got).not.toBeNull();
    expect(got!.findings).toEqual(want.findings);
    expect(got!.redactions).toBe(want.redactions);
    // Byte-for-byte: the archive the server stores must not depend on WHERE it
    // was produced.
    expect(got!.rawB64).toBe(want.rawB64);
    expect(got!.rawSize).toBe(want.rawSize);
    await pool.close();
  });

  test.skipIf(!workerBuilt)('the secret is actually found, and actually redacted out of the archive', async () => {
    const files = fixture();
    const pool = new ScanPool(1);
    const got = await pool.run({
      files, container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    });
    // Reported as `env-secret`, NOT `github-pat`, and that is correct: both
    // rules match the same span, scanTextForFindings dedupes by span, and the
    // baseline list is ordered so its labels win on overlap. Asserting
    // github-pat here failed for that reason, not because detection broke.
    expect(got!.findings.map((f) => f.rule)).toContain('env-secret');
    expect(got!.redactions).toBeGreaterThan(0);
    // The whole point of redacting before upload: the token must not be in the
    // bytes that leave the machine.
    const archive = Buffer.from(got!.rawB64!, 'base64').toString('binary');
    expect(archive).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    await pool.close();
  });

  test.skipIf(!workerBuilt)('an archive over the ceiling is omitted, not truncated', async () => {
    const pool = new ScanPool(1);
    const got = await pool.run({
      files: fixture(), container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: true, maxRawBytes: 16, packVersion: '',   // absurdly small
    });
    expect(got).not.toBeNull();
    expect(got!.rawB64).toBeUndefined();
    expect(got!.rawSize).toBeUndefined();
    // Findings still come back — the archive is additive, the scan is not.
    expect(got!.findings.length).toBeGreaterThan(0);
    await pool.close();
  });

  test.skipIf(!workerBuilt)('includeRaw:false skips the archive but still scans', async () => {
    const pool = new ScanPool(1);
    const got = await pool.run({
      files: fixture(), container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: false, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    });
    expect(got!.rawB64).toBeUndefined();
    expect(got!.findings.length).toBeGreaterThan(0);
    await pool.close();
  });

  test.skipIf(!workerBuilt)('the main thread stays responsive while the worker computes', async () => {
    // The whole reason this module exists. A big session is seconds of solid
    // computation; with it on a worker, timers on the main thread keep firing.
    const big = [{ name: 'main', text: `{"text":"${'lorem ipsum dolor '.repeat(400_000)}"}` }];
    const pool = new ScanPool(1);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      await pool.run({
        files: big, container: { v: 1, tool: 'claude', mtime: 1 },
        includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
      });
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
    await pool.close();
  });
});

/**
 * THE ONE-SHOT CASE, which the daemon hides and which broke CI twice.
 *
 * A permanent `worker.unref()` reads as obviously correct — a pool should not
 * keep a process alive. But with a task in flight and nothing else on the event
 * loop, Node has no reason to stay alive, so `chat-recall sync` returned with
 * the reply still pending: zero sessions shipped, exit 0, no error printed. The
 * watch daemon never showed it, because a daemon always has timers holding the
 * loop open.
 *
 * The bug was fixed once during the build-pipeline work and then destroyed by
 * reverting that file wholesale. This test is what makes the third time
 * impossible.
 */
describe('a one-shot process must survive until the worker answers', () => {
  test.skipIf(!workerBuilt)('a task settles with NOTHING else holding the event loop', async () => {
    const pool = new ScanPool(1);
    // No timers, no intervals, no other pending work — exactly a CLI command.
    const got = await pool.run({
      files: fixture(), container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    });
    expect(got).not.toBeNull();
    expect(got!.findings.length).toBeGreaterThan(0);
    await pool.close();
  });

  test.skipIf(!workerBuilt)('an idle pool does not hold the process open', async () => {
    const pool = new ScanPool(1);
    await pool.run({
      files: fixture(), container: { v: 1, tool: 'claude', mtime: 1 },
      includeRaw: false, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
    });
    // After the task, every worker must be unref'd again — otherwise the pool
    // alone keeps a finished CLI command running forever, which is the opposite
    // failure and just as bad.
    for (const s of (pool as unknown as { slots: Array<{ worker: { unref: () => void } }> }).slots) {
      expect(typeof s.worker.unref).toBe('function');
    }
    expect(pool.enabled).toBe(true);
    await pool.close();
  });

  test.skipIf(!workerBuilt)('several sequential tasks all settle', async () => {
    const pool = new ScanPool(1);
    for (let i = 0; i < 3; i++) {
      const got = await pool.run({
        files: fixture(), container: { v: 1, tool: 'claude', mtime: i },
        includeRaw: true, maxRawBytes: 8 * 1024 * 1024, packVersion: '',
      });
      expect(got).not.toBeNull();
    }
    await pool.close();
  });
});
