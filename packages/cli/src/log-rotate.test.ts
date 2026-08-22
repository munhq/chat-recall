/**
 * The one property that matters: rotation must not take the log away.
 *
 * The shipped bug renamed the file. Every writer already held the fd — the
 * supervisor opens the log before the daemon's first line — so after a rename
 * the output followed the inode into `watch.log.1`, the path everything tails
 * ceased to exist, and the "rotated" file grew unbounded. The daemon then wedged
 * for eight hours with nothing in the place anyone looks.
 *
 * These tests drive the real function through a real fd, because the only way to
 * catch that class of defect is to keep writing through the rotation and then
 * read the path back.
 */
import { describe, test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, openSync, writeSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLogIfLarge, LOG_MAX_BYTES } from './log-rotate.js';

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cr-logrotate-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('rotateLogIfLarge', () => {
  test('a small log is left alone', () => {
    withTmp((dir) => {
      const log = join(dir, 'watch.log');
      writeFileSync(log, 'one line\n');
      expect(rotateLogIfLarge(log, 1024)).toEqual({ rotated: false, sizeBefore: 0 });
      expect(readFileSync(log, 'utf8')).toBe('one line\n');
    });
  });

  test('an oversized log is copied aside and emptied — and the PATH survives', () => {
    withTmp((dir) => {
      const log = join(dir, 'watch.log');
      writeFileSync(log, 'x'.repeat(2048));
      const r = rotateLogIfLarge(log, 1024);
      expect(r.rotated).toBe(true);
      expect(r.sizeBefore).toBe(2048);
      expect(statSync(log).size).toBe(0);                      // still there, emptied
      expect(readFileSync(`${log}.1`, 'utf8').length).toBe(2048);  // history kept
    });
  });

  // THE REGRESSION. A rename left the supervisor's fd pointing at the renamed
  // inode, so every subsequent line vanished from the path and the rotated file
  // kept growing. An append-mode fd must survive rotation and land at offset 0.
  test('an already-open append fd keeps writing INTO the live path, not the archive', () => {
    withTmp((dir) => {
      const log = join(dir, 'watch.log');
      writeFileSync(log, 'y'.repeat(2048));
      // Exactly how a supervisor holds it: opened before rotation, append mode.
      const fd = openSync(log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
      try {
        rotateLogIfLarge(log, 1024);
        writeSync(fd, 'after rotation\n');
      } finally { closeSync(fd); }

      expect(readFileSync(log, 'utf8')).toBe('after rotation\n');
      expect(readFileSync(`${log}.1`, 'utf8')).toBe('y'.repeat(2048));
    });
  });

  test('a second rotation overwrites the previous generation rather than failing', () => {
    withTmp((dir) => {
      const log = join(dir, 'watch.log');
      writeFileSync(log, 'a'.repeat(2048));
      rotateLogIfLarge(log, 1024);
      writeFileSync(log, 'b'.repeat(2048));
      expect(rotateLogIfLarge(log, 1024).rotated).toBe(true);
      expect(readFileSync(`${log}.1`, 'utf8')).toBe('b'.repeat(2048));
    });
  });

  test('a missing log is not an error — the daemon must still start', () => {
    withTmp((dir) => {
      expect(rotateLogIfLarge(join(dir, 'nope.log'), 1024)).toEqual({ rotated: false, sizeBefore: 0 });
    });
  });

  test('the shipped ceiling bounds the log at two 32 MB generations', () => {
    expect(LOG_MAX_BYTES).toBe(32 * 1024 * 1024);
  });
});
