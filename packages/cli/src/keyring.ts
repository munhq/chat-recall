/**
 * OS keyring access for the vault passphrase — the only way the unattended
 * daemon can decrypt cross-device artifacts without a secret sitting on disk.
 *
 * No new dependency: we shell out to the platform's own tool, exactly as this
 * codebase already does for services (systemctl / launchctl / schtasks in
 * service-installer.ts). A native addon (keytar, @napi-rs/keyring) would trip
 * the bundle's native-free guard and reintroduce prebuilt-binary pain to a
 * package deliberately built without any.
 *
 *   macOS    `security`     built in
 *   Linux    `secret-tool`  needs libsecret-tools (the gap — see probe())
 *   Windows  PowerShell + DPAPI, encrypting under the user's own key
 *
 * SECRETS NEVER GO IN ARGV. /proc/<pid>/cmdline is world-readable on Linux and
 * `ps` shows arguments to every local user, so a passphrase passed as a flag
 * would leak to any process on the box for the lifetime of the call. Every
 * backend below writes the secret to the child's STDIN instead:
 *   - secret-tool store          reads the secret from stdin by design
 *   - security -i                reads *commands* from stdin (batch mode)
 *   - powershell -Command -      reads the script from stdin
 *
 * There is deliberately NO plaintext fallback. A machine with no keyring does
 * not get cross-device artifacts, and is told exactly how to fix that — a
 * silent downgrade to a file on disk would quietly defeat the entire point.
 */
import { execFileSync } from 'node:child_process';

const SERVICE = 'chat-recall';
const ACCOUNT = 'vault-passphrase';

export type KeyringBackendId = 'macos-keychain' | 'libsecret' | 'windows-dpapi' | 'none';

export interface KeyringProbe {
  backend: KeyringBackendId;
  available: boolean;
  /** Actionable one-liner when unavailable — shown verbatim to the user. */
  hint?: string;
}

/** Injectable process runner (tests pass a fake; nothing else should). */
export interface Runner {
  /** Run `file args…`, optionally writing `input` to stdin. Returns stdout. */
  run(file: string, args: string[], input?: string): string;
  platform: NodeJS.Platform;
}

const realRunner: Runner = {
  run(file, args, input) {
    return execFileSync(file, args, {
      input,
      encoding: 'utf-8',
      stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
  },
  platform: process.platform,
};

/** Which backend this platform uses, and whether it's actually usable here. */
export function probeKeyring(r: Runner = realRunner): KeyringProbe {
  if (r.platform === 'darwin') {
    // `security` ships with macOS; if it's missing the install is broken.
    try { r.run('security', ['help']); return { backend: 'macos-keychain', available: true }; }
    catch { return { backend: 'macos-keychain', available: false, hint: '`security` not found — is this really macOS?' }; }
  }
  if (r.platform === 'win32') {
    try { r.run('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']); return { backend: 'windows-dpapi', available: true }; }
    catch { return { backend: 'windows-dpapi', available: false, hint: 'PowerShell not found — required for DPAPI-protected storage.' }; }
  }
  if (r.platform === 'linux') {
    try { r.run('secret-tool', ['--version']); return { backend: 'libsecret', available: true }; }
    catch {
      return {
        backend: 'libsecret',
        available: false,
        // The common case is a running keyring daemon with the CLI absent —
        // observed on a desktop with gnome-keyring-daemon up and no secret-tool.
        hint: 'No keyring access: install libsecret-tools (Debian/Ubuntu: `sudo apt install libsecret-tools`, '
          + 'Fedora: `sudo dnf install libsecret`). Headless machines have no keyring at all — '
          + 'cross-device artifacts will not apply there.',
      };
    }
  }
  return { backend: 'none', available: false, hint: `No keyring backend for platform ${r.platform}.` };
}

/** Thrown when the keyring is unusable. Callers surface .message as-is. */
export class KeyringUnavailableError extends Error {}

function requireBackend(r: Runner): KeyringBackendId {
  const p = probeKeyring(r);
  if (!p.available) throw new KeyringUnavailableError(p.hint || 'No OS keyring available on this machine.');
  return p.backend;
}

/**
 * Windows has no credential store we can READ from the shell (cmdkey stores
 * but cannot retrieve), so we use DPAPI: the ciphertext is decryptable only by
 * this user on this machine, which is the same trust boundary as a keyring
 * entry. Stored in the user profile, not in our data dir, to keep it out of
 * anything that gets synced or archived.
 */
const WIN_BLOB = '$env:USERPROFILE\\.chat-recall-vault.dpapi';

export function keyringSet(secret: string, r: Runner = realRunner): void {
  const backend = requireBackend(r);
  if (backend === 'macos-keychain') {
    // Batch mode: the command line (with -w and the secret) goes over stdin,
    // so it never appears in argv. -U updates an existing item in place.
    r.run('security', ['-i'], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -w ${shQuote(secret)}\n`);
    return;
  }
  if (backend === 'libsecret') {
    r.run('secret-tool', ['store', '--label=chat-recall vault passphrase', 'service', SERVICE, 'account', ACCOUNT], secret);
    return;
  }
  // windows-dpapi — script on stdin; the secret is interpolated into the
  // script text, which is piped, never argv.
  r.run('powershell', ['-NoProfile', '-Command', '-'],
    `$s = ${psQuote(secret)}\n`
    + `ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -Path ${WIN_BLOB} -Encoding ascii\n`);
}

/** The stored passphrase, or null when absent. Throws only if unusable. */
export function keyringGet(r: Runner = realRunner): string | null {
  const backend = requireBackend(r);
  try {
    if (backend === 'macos-keychain') {
      return r.run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']).replace(/\n$/, '') || null;
    }
    if (backend === 'libsecret') {
      // secret-tool prints the secret with NO trailing newline; empty = absent.
      return r.run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]) || null;
    }
    const out = r.run('powershell', ['-NoProfile', '-Command', '-'],
      `if (!(Test-Path ${WIN_BLOB})) { exit 1 }\n`
      + `$sec = Get-Content ${WIN_BLOB} | ConvertTo-SecureString\n`
      + `[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))\n`);
    return out.replace(/\r?\n$/, '') || null;
  } catch {
    // Every backend exits non-zero for "no such entry"; that is not an error.
    return null;
  }
}

/** Remove the stored passphrase. True if something was removed. */
export function keyringDelete(r: Runner = realRunner): boolean {
  const backend = requireBackend(r);
  try {
    if (backend === 'macos-keychain') {
      r.run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
      return true;
    }
    if (backend === 'libsecret') {
      r.run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
      return true;
    }
    r.run('powershell', ['-NoProfile', '-Command', '-'], `Remove-Item -Force -ErrorAction Stop ${WIN_BLOB}\n`);
    return true;
  } catch {
    return false;
  }
}

/* ── quoting ──────────────────────────────────────────────────────── */

/** Single-quote for the `security -i` command line (POSIX-ish tokenizer). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote for PowerShell, where '' is the escaped quote. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
