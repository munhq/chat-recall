/**
 * CLI release info advertised on /api/capabilities so an installed CLI can tell
 * it's older than the server it syncs to and self-update from this same origin.
 *
 * Reads the packed tarball (INSTALL_TGZ_PATH, the same file /install serves) and
 * a version stamp written next to it at image build (INSTALL_VERSION_PATH). Both
 * are computed once and cached — the tarball is immutable for an image.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TGZ = process.env.INSTALL_TGZ_PATH || '/app/install/chat-recall.tgz';
const VER = process.env.INSTALL_VERSION_PATH || '/app/install/cli-version.txt';

export interface CliRelease { version: string; sha256: string; }

let cached: CliRelease | null | undefined;

/** { version, sha256 } for the served CLI tarball, or null if unavailable. */
export function cliRelease(): CliRelease | null {
  if (cached !== undefined) return cached;
  try {
    const version = existsSync(VER) ? readFileSync(VER, 'utf8').trim() : '';
    const sha256 = existsSync(TGZ) ? createHash('sha256').update(readFileSync(TGZ)).digest('hex') : '';
    cached = version && sha256 ? { version, sha256 } : null;
  } catch {
    cached = null;
  }
  return cached;
}
