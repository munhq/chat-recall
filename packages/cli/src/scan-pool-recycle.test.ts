/**
 * A worker gives its memory back to the operating system only when it ends.
 *
 * Measured on 2026-11-13 on the watch unit: the process held 471 MB of
 * anonymous memory with the pool on, 293 MB with `CHAT_RECALL_SCAN_WORKERS=0`,
 * while a heap snapshot of the main isolate held 56 MB of objects in total. So
 * the pool retires a worker after its task.
 *
 * These tests hold that behaviour still, including the part that is easy to
 * break: a fresh worker has no rule pack, so `needsPack` must answer true again
 * after a recycle. A worker that scans with no rules finds nothing, and nobody
 * sees an error.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScanPool } from './scan-pool.js';

// A worker with no work in it: it echoes the id and answers with an empty
// result, so a test measures the pool's lifecycle and not a scan.
const dir = mkdtempSync(join(tmpdir(), 'scan-pool-recycle-'));
const fake = join(dir, 'worker.cjs');
writeFileSync(fake, `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (task) => {
  parentPort.postMessage({ id: task.id, findings: [], redactions: 0, rows: null });
});
`);

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const task = { sessionId: 'session-a', text: 'a session' } as never;

describe('ScanPool — a worker retires after its task', () => {
  it('starts a fresh worker for the next task and asks for the rule pack again', async () => {
    const pool = new ScanPool(1, fake);

    // The first worker, and the pack it has not seen yet.
    expect(pool.needsPack('rules-1')).toBe(true);
    pool.markPackSent('rules-1');
    expect(pool.needsPack('rules-1')).toBe(false);
    expect(pool.workerGeneration).toBe(1);

    const first = await pool.run(task);
    expect(first).not.toBeNull();
    expect(first?.findings).toEqual([]);

    // The worker that answered is gone, so the next task needs a new one with
    // the rules in it. This is the assertion that protects a silent failure.
    expect(pool.needsPack('rules-1')).toBe(true);
    expect(pool.workerGeneration).toBe(2);

    pool.markPackSent('rules-1');
    expect(pool.needsPack('rules-1')).toBe(false);
    const second = await pool.run(task);
    expect(second).not.toBeNull();
    expect(second?.findings).toEqual([]);
    expect(pool.workerGeneration).toBe(2);

    await pool.close();
  });

  it('answers a task with the pool switched off by running it inline', async () => {
    const pool = new ScanPool(0, fake);
    // `0` workers means the caller does the work: a null answer is the contract.
    await expect(pool.run(task)).resolves.toBeNull();
  });
});
