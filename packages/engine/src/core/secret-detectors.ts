/**
 * Detector names, and who owns the rows they write.
 *
 * `secret_findings` holds rows from two very different places:
 *
 *   CLIENT-owned — 'builtin' (in-process regex), 'tenant' (dashboard rules run
 *     on the client), 'gitleaks'/'trufflehog' (opt-in external binaries). These
 *     come from PRE-redaction text on the user's machine and are replaced
 *     wholesale on every sync, because the client is their source of truth.
 *
 *   SERVER-owned — SERVER_DETECTOR, written by the server's re-scan of text it
 *     ALREADY holds (i.e. post-redaction). These findings exist precisely
 *     because the client's rules missed something, so a sync from that same
 *     client must never delete them.
 *
 * One constant, imported by both drivers and the re-scan service, so the
 * ownership boundary can't drift apart across three SQL statements.
 */
export const SERVER_DETECTOR = 'server';

/** True when this detector's rows belong to the server, not the collector. */
export function isServerOwnedDetector(detector: string): boolean {
  return detector === SERVER_DETECTOR;
}
