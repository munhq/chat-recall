/**
 * Vault HTTP client + sync/restore orchestration.
 *
 * `enable(passphrase)` — derives the master key, persists salt + keyId
 *                        to settings (NOT the key, NOT the passphrase),
 *                        flips `team.vault.enabled = true`.
 *
 * `sync(passphrase)`   — walks local sources, encrypts each new/changed
 *                        file, presigns + uploads + commits a blob ref.
 *
 * `restore(passphrase)` — pulls blob refs since last sync, downloads
 *                         ciphertext, decrypts, writes to
 *                         `~/.chat-recall/imported/<tool>/<session>.jsonl`
 *                         where the local indexer picks it up.
 *
 * The passphrase is held in a process-local cache for the duration of
 * the CLI invocation only. No keyring integration in v0.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';

import { loadSettings, saveSettings } from './settings.js';
import { getDataDir } from './paths.js';
import {
  ARGON2_PROD, deriveMasterKey, encryptBlob, decryptBlob, generateSalt, keyIdFor, sha256Hex,
} from './vault-crypto.js';
import { walkVaultSources, type VaultSourceFile, type VaultTool } from './vault-source.js';

// ── Errors ──────────────────────────────────────────────────────────

export class VaultConfigError extends Error {}
export class VaultAuthError   extends Error { constructor(msg: string, public readonly status?: number) { super(msg); } }
export class VaultHttpError   extends Error { constructor(msg: string, public readonly status: number, public readonly body?: unknown) { super(msg); } }

// ── HTTP — reuses team-client's bearer + base URL via shared helper ──

interface Ctx { serverUrl: string; teamId: string; token: string }

function context(): Ctx {
  const s = loadSettings().team;
  if (!s.enabled)   throw new VaultConfigError('Team is disabled. Run `chat-recall team join` first.');
  if (!s.serverUrl) throw new VaultConfigError('No team server URL set.');
  if (!s.teamId)    throw new VaultConfigError('Not joined to a team.');
  if (!s.tokenRef)  throw new VaultConfigError('No token env var configured.');
  const token = process.env[s.tokenRef];
  if (!token)       throw new VaultConfigError(`Env var ${s.tokenRef} is not set.`);
  return { serverUrl: s.serverUrl, teamId: s.teamId, token };
}

async function api<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  const doFetch = () => fetch(ctx.serverUrl.replace(/\/+$/, '') + path, {
    method,
    headers: {
      'Authorization': `Bearer ${ctx.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let r: Response;
  try {
    r = await doFetch();
  } catch {
    // One retry on NETWORK-level failure (undici 'fetch failed'). The vault
    // KDF pauses ~5s between calls — long enough for a server/LB keep-alive
    // timeout to close the pooled socket, and the next request on that dead
    // socket dies with ECONNRESET before anything was sent. A fresh attempt
    // opens a new connection. (Response-received errors are NOT retried —
    // only the nothing-was-processed case.)
    await new Promise((res) => setTimeout(res, 250));
    r = await doFetch();
  }
  const text = await r.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (r.status === 401 || r.status === 403) throw new VaultAuthError(`${r.status} ${(parsed as any)?.detail ?? r.statusText}`, r.status);
  if (!r.ok) throw new VaultHttpError(`${method} ${path}: ${r.status} ${(parsed as any)?.error ?? r.statusText}`, r.status, parsed);
  return parsed as T;
}

// ── Local upload-state ledger (similar to team-merge.ts) ─────────────

/**
 * Upload ledger — which sessions THIS DEVICE already encrypted and shipped.
 *
 * Was a better-sqlite3 file at ~/.chat-recall/vault-uploads.db; it lives in
 * Postgres now, device-scoped (routes/ledgers.ts). Only `source_sha256` was
 * ever read, so that is all the server keeps — the old table also wrote
 * `source_path` and `source_mtime_ms`, which nothing consumed and which would
 * have shipped local paths off the machine for no benefit.
 */
interface VaultUploadRow {
  sessionId: string;
  tool: string;
  sourceSha256: string;
  cipherSha256: string;
  uploadedAt: number;
}

const uploadKey = (sessionId: string, tool: string): string => `${sessionId}\u0000${tool}`;

/** The whole ledger for this device, as key → source sha. One round trip. */
async function loadUploadLedger(ctx: Ctx): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    const r = await api<{ uploads: VaultUploadRow[] }>(ctx, 'GET', '/api/ledgers/vault-uploads');
    for (const u of r.uploads ?? []) m.set(uploadKey(u.sessionId, u.tool), u.sourceSha256);
  } catch (err) {
    // A server older than the ledger endpoints answers 404. An empty ledger is
    // SAFE — every session re-encrypts and re-uploads, which is wasteful but
    // never wrong — whereas throwing would make `vault sync` unusable against a
    // server one version behind.
    if (!(err instanceof VaultHttpError && err.status === 404)) throw err;
  }
  return m;
}

/** Record one upload. Written per session, not batched at the end: a crash
 *  mid-sync must not discard everything already encrypted and PUT. */
async function recordUpload(ctx: Ctx, row: Omit<VaultUploadRow, 'uploadedAt'>): Promise<void> {
  try {
    await api(ctx, 'POST', '/api/ledgers/vault-uploads', { uploads: [row] });
  } catch (err) {
    // Same reasoning as loadUploadLedger: the blob is already uploaded and
    // committed. Failing here would discard a successful upload over bookkeeping.
    if (!(err instanceof VaultHttpError && err.status === 404)) throw err;
  }
}

// ── Public API ──────────────────────────────────────────────────────

export interface VaultEnableResult { keyId: string; saltHex: string }

/**
 * First-time setup. Generates salt, derives master key, persists salt
 * + keyId to settings. Subsequent devices call this with the SAME
 * passphrase + the salt copied from the first device's settings — but
 * v0 ships the salt server-side (for now we ask the user to copy it).
 */
export function vaultEnable(passphrase: string, opts: { existingSaltHex?: string } = {}): VaultEnableResult {
  const salt = opts.existingSaltHex
    ? Buffer.from(opts.existingSaltHex, 'hex')
    : generateSalt();
  if (salt.length !== 32) throw new VaultConfigError('salt must be 32 bytes (64 hex chars)');
  const key = deriveMasterKey(passphrase, salt, ARGON2_PROD);
  const keyId = keyIdFor(key);
  const saltHex = Buffer.from(salt).toString('hex');

  const s = loadSettings();
  s.team = { ...s.team, vault: { ...s.team.vault, enabled: true, saltHex, keyId } };
  saveSettings(s);
  return { keyId, saltHex };
}

/** A server this device can reach, with a bearer token. Supplied by the caller
 *  (the CLI has the credentials file) so the engine stays credential-agnostic —
 *  and so this path does NOT require team config, which `context()` demands. */
export interface VaultRemote { baseUrl: string; token: string }

export interface VaultEnableRemoteResult extends VaultEnableResult {
  /** 'server' = adopted an existing workspace salt; 'local' = we published ours. */
  saltSource: 'server' | 'local';
  /** True when the server already knew a keyId and ours matches it. */
  keyIdMatches?: boolean;
}

/** Thrown when the derived key disagrees with the workspace's published keyId —
 *  i.e. this is a DIFFERENT passphrase than the one the other device used. */
export class VaultPassphraseMismatchError extends Error {}

/**
 * Enable the vault using the workspace's shared salt.
 *
 * The manual alternative was `--existing-salt <64 hex>` copied off the first
 * machine plus retyping the passphrase from memory — with a wrong passphrase
 * failing SILENTLY, producing blobs no other device could ever open. Here the
 * salt comes from the server (it is a KDF salt, not a secret), and the
 * published keyId — a fingerprint of the derived key, never the key — turns a
 * mistyped passphrase into an immediate, explicit error.
 *
 * The passphrase and the derived key never leave this process.
 */
export async function vaultEnableWithRemote(
  passphrase: string,
  remote: VaultRemote,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<VaultEnableRemoteResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = remote.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${remote.token}`, 'content-type': 'application/json' };

  let published: { saltHex: string | null; keyId: string | null } = { saltHex: null, keyId: null };
  try {
    const r = await doFetch(`${base}/api/vault/salt`, { headers });
    if (r.ok) published = (await r.json()) as typeof published;
  } catch {
    // Offline: fall through and set up locally. Publishing is retried the next
    // time enable runs; a device that never reaches the server can still work.
  }

  if (published.saltHex) {
    const result = vaultEnable(passphrase, { existingSaltHex: published.saltHex });
    if (published.keyId && published.keyId !== result.keyId) {
      throw new VaultPassphraseMismatchError(
        'That passphrase does not match the one your other device used for this workspace. '
        + 'Nothing was changed — re-run with the original passphrase, or use `vault forget` on every '
        + 'device and start over (existing encrypted history becomes unreadable).',
      );
    }
    return { ...result, saltSource: 'server', keyIdMatches: published.keyId ? true : undefined };
  }

  // Nothing published yet — this is device one. Generate, then publish so the
  // next device needs nothing but the passphrase.
  const result = vaultEnable(passphrase);
  try {
    const r = await doFetch(`${base}/api/vault/salt`, {
      method: 'POST', headers, body: JSON.stringify({ saltHex: result.saltHex, keyId: result.keyId }),
    });
    // 409 = another device published first, in the window between our GET and
    // POST. Theirs wins: redo the derivation against it rather than leaving this
    // device on an orphaned salt.
    if (r.status === 409) {
      const body = (await r.json()) as { saltHex?: string; keyId?: string | null };
      if (body.saltHex && body.saltHex !== result.saltHex) {
        const redone = vaultEnable(passphrase, { existingSaltHex: body.saltHex });
        if (body.keyId && body.keyId !== redone.keyId) {
          throw new VaultPassphraseMismatchError(
            'Another device published a vault with a different passphrase. Nothing was changed here.',
          );
        }
        return { ...redone, saltSource: 'server', keyIdMatches: body.keyId ? true : undefined };
      }
    }
  } catch (err) {
    if (err instanceof VaultPassphraseMismatchError) throw err;
    // Publishing failed (offline / old server): the vault still works on this
    // device; the next enable re-publishes.
  }
  return { ...result, saltSource: 'local' };
}

export interface VaultSyncReport {
  uploaded: Array<{ sessionId: string; tool: string; bytes: number }>;
  skipped:  Array<{ sessionId: string; tool: string; reason: 'unchanged' | 'denylisted' }>;
  failures: Array<{ sessionId: string; tool: string; error: string }>;
}

/**
 * Walk local chat sources, encrypt new/changed ones, upload, commit refs.
 *
 * Uses the upload ledger to skip files whose source mtime+sha haven't
 * changed since last upload — re-encrypting (and re-uploading) bytes
 * we've already shipped is wasted work.
 */
export async function vaultSync(passphrase: string): Promise<VaultSyncReport> {
  const ctx = context();
  const v = loadSettings().team.vault;
  if (!v.enabled) throw new VaultConfigError('Vault not enabled. Run `chat-recall vault enable` first.');
  if (!v.saltHex) throw new VaultConfigError('Vault salt missing — re-run `vault enable`.');

  const key = deriveMasterKey(passphrase, Buffer.from(v.saltHex, 'hex'), ARGON2_PROD);
  const expectedKeyId = keyIdFor(key);
  if (v.keyId && v.keyId !== expectedKeyId) {
    throw new VaultConfigError(`Wrong passphrase. Expected keyId ${v.keyId}, got ${expectedKeyId}.`);
  }

  const denyProjects = new Set(v.excludeProjects ?? []);
  const report: VaultSyncReport = { uploaded: [], skipped: [], failures: [] };
  const uploaded = await loadUploadLedger(ctx);

  for (const src of walkVaultSources()) {
    if (src.projectPath && denyProjects.has(src.projectPath)) {
      report.skipped.push({ sessionId: src.sessionId, tool: src.tool, reason: 'denylisted' });
      continue;
    }
    try {
      const plaintext = readFileSync(src.path);
      const sourceSha = sha256Hex(plaintext);
      const priorSha = uploaded.get(uploadKey(src.sessionId, src.tool));
      if (priorSha === sourceSha) {
        report.skipped.push({ sessionId: src.sessionId, tool: src.tool, reason: 'unchanged' });
        continue;
      }

      const cipher = encryptBlob(key, plaintext);
      const cipherBuf = Buffer.from(cipher);
      const cipherSha = sha256Hex(cipher);

      // 1. presign
      const pres = await api<{
        url: string; method: string; headers: Record<string, string>;
        bucket: string; objectKey: string; expiresAt: number;
      }>(ctx, 'POST', `/api/team/${ctx.teamId}/blobs/presign-upload`, {
        sessionId: src.sessionId,
        tool: src.tool,
        sha256Cipher: cipherSha,
        bytes: cipherBuf.length,
      });

      // 2. PUT bytes
      const put = await fetch(pres.url, {
        method: pres.method,
        headers: pres.headers,
        body: cipherBuf,
      });
      if (!put.ok) throw new Error(`upload PUT failed: ${put.status} ${put.statusText}`);

      // 3. commit
      await api(ctx, 'POST', `/api/team/${ctx.teamId}/blobs/commit`, {
        sessionId: src.sessionId,
        tool: src.tool,
        projectPath: src.projectPath,
        bucket: pres.bucket,
        objectKey: pres.objectKey,
        sha256Cipher: cipherSha,
        keyId: expectedKeyId,
        bytes: cipherBuf.length,
        mtimeSourceMs: src.mtimeMs,
      });

      await recordUpload(ctx, {
        sessionId: src.sessionId, tool: src.tool,
        sourceSha256: sourceSha, cipherSha256: cipherSha,
      });
      report.uploaded.push({ sessionId: src.sessionId, tool: src.tool, bytes: cipherBuf.length });
    } catch (err) {
      report.failures.push({ sessionId: src.sessionId, tool: src.tool, error: (err as Error).message });
    }
  }

  // Stamp the watermark — restore() uses this to know what's already been pulled.
  const s = loadSettings();
  s.team = { ...s.team, vault: { ...s.team.vault, lastSyncAt: Date.now() } };
  saveSettings(s);

  return report;
}

export interface VaultRestoreReport {
  restored: Array<{ sessionId: string; tool: string; path: string; bytes: number }>;
  skipped:  Array<{ sessionId: string; tool: string; reason: 'unchanged' | 'wrong-key' }>;
  failures: Array<{ sessionId: string; tool: string; error: string }>;
}

const IMPORTED_ROOT = (): string => join(getDataDir(), 'imported');

function importedPathFor(tool: VaultTool, sessionId: string): string {
  // Drop the per-tool prefix from session id so the on-disk filename is
  // just the underlying id.
  const base = sessionId
    .replace(/^gemini_/, '')
    .replace(/^codex_/, '')
    .replace(/^agy_/, '')
    .replace(/^cursor_/, '')
    .replace(/^opencode_/, '');
  return join(IMPORTED_ROOT(), tool, `${base}.jsonl`);
}

/**
 * Pull every blob ref the user can access (default: just their own; the
 * multi-device-of-one case), download ciphertext, decrypt locally, write
 * to the imported dir. The chat-recall indexer treats imported/ as a
 * native source so the search results show up automatically.
 *
 * Idempotent — re-runs skip files whose decrypted bytes already match.
 */
export async function vaultRestore(passphrase: string, opts: { since?: number } = {}): Promise<VaultRestoreReport> {
  const ctx = context();
  const v = loadSettings().team.vault;
  if (!v.enabled) throw new VaultConfigError('Vault not enabled.');
  if (!v.saltHex) throw new VaultConfigError('Vault salt missing.');

  const key = deriveMasterKey(passphrase, Buffer.from(v.saltHex, 'hex'), ARGON2_PROD);
  const expectedKeyId = keyIdFor(key);

  const since = opts.since ?? 0;  // restore everything by default (idempotent skip handles dupes)
  const list = await api<{ blobs: Array<{
    id: string; sessionId: string; tool: VaultTool; bucket: string; objectKey: string;
    sha256Cipher: string; keyId: string; bytes: number; mtimeSourceMs: number;
  }>; serverNow: number }>(ctx, 'GET', `/api/team/${ctx.teamId}/blobs?since=${since}&owner=self`);

  const report: VaultRestoreReport = { restored: [], skipped: [], failures: [] };

  for (const blob of list.blobs) {
    if (blob.keyId !== expectedKeyId) {
      // Encrypted with a different master key (different passphrase). Skip
      // rather than fail the whole run — useful when a user rotated their
      // passphrase and old blobs are still around.
      report.skipped.push({ sessionId: blob.sessionId, tool: blob.tool, reason: 'wrong-key' });
      continue;
    }
    try {
      // Local idempotency: if the imported file already matches, skip.
      const path = importedPathFor(blob.tool, blob.sessionId);
      if (existsSync(path)) {
        // We don't have the plaintext sha pre-computed; sha the local
        // file and compare to a re-decrypt cost. Simpler: skip when
        // mtime matches the source mtime we recorded — usually the
        // file is identical when both sides agree on mtime.
        const localStat = await import('fs').then(m => m.statSync(path));
        if (Math.abs(localStat.mtimeMs - blob.mtimeSourceMs) < 1) {
          report.skipped.push({ sessionId: blob.sessionId, tool: blob.tool, reason: 'unchanged' });
          continue;
        }
      }

      const dl = await api<{ url: string }>(
        ctx, 'GET', `/api/team/${ctx.teamId}/blobs/${blob.id}/presign-download`,
      );
      const r = await fetch(dl.url);
      if (!r.ok) throw new Error(`download failed: ${r.status} ${r.statusText}`);
      const cipher = Buffer.from(await r.arrayBuffer());
      if (sha256Hex(cipher) !== blob.sha256Cipher) {
        throw new Error('cipher integrity check failed');
      }
      const plaintext = decryptBlob(key, cipher);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(plaintext));
      // Preserve source mtime so future restores can short-circuit.
      const { utimesSync } = await import('fs');
      const t = blob.mtimeSourceMs / 1000;
      utimesSync(path, t, t);
      report.restored.push({ sessionId: blob.sessionId, tool: blob.tool, path, bytes: plaintext.length });
    } catch (err) {
      report.failures.push({ sessionId: blob.sessionId, tool: blob.tool, error: (err as Error).message });
    }
  }

  return report;
}

/**
 * Quick status — report enabled/disabled, salt fingerprint, last sync.
 * Doesn't require the passphrase.
 */
export function vaultStatus(): {
  enabled: boolean; saltHex?: string; keyId?: string; lastSyncAt?: number;
  syncTools: string[]; excludeProjects: string[];
} {
  const v = loadSettings().team.vault;
  return {
    enabled: v.enabled,
    saltHex: v.saltHex, keyId: v.keyId, lastSyncAt: v.lastSyncAt,
    syncTools: v.syncTools, excludeProjects: v.excludeProjects,
  };
}
