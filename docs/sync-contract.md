# Sync contract — client → cloud

The seam between self-hosted (free) and cloud (paid). Self-hosted runs
the full stack locally; cloud adds aggregation, alerting, retention,
and team views on top of the same finding data.

**Scanning, redaction, and raw chat content all stay on the client.**
The cloud server only sees what the client chooses to upload, which is
exactly the redacted findings + metadata listed below — never the raw
secret material, never the original session JSONL.

## Endpoint shape

```
POST /api/sync
Authorization: Bearer <jwt>      # carries tenant_id + device_id
Content-Type: application/json

Request body:
{
  "device_id":   "ulid-or-uuid",        # stable per machine
  "client_version": "0.3.1",
  "since_at":    1777999999,            # last successful sync; server returns >= this watermark
  "findings":    SecretFinding[],       # only NEW or CHANGED since since_at
  "dismissals":  Dismissal[],
  "custom_rules": SecretRule[],
  "session_meta": SessionMetaLite[]     # id, mtime, project, tool — no content
}

Response body:
{
  "ack_at":      1778000050,            # new high-water-mark for client
  "remote_dismissals": Dismissal[],     # dismissals from OTHER devices on same tenant
  "remote_rules":      SecretRule[],    # rule changes the client should pull down
  "alerts":      Alert[]                # server-evaluated thresholds the client should surface
}
```

## What's in (and what's not in) the upload

### `findings` — the only thing that smells like security data

```ts
interface SecretFinding {
  session_id:         string;   // chat-recall session id (codex_/gemini_/opencode_/agy_/cursor_ prefix; Claude has none)
  detector:           'gitleaks' | 'trufflehog' | 'secretlint' | 'tenant';
  rule:               string;   // rule id from the detector or tenant rule name
  line:               number;
  preview:            string;   // ALWAYS masked — last 4 chars + asterisks
  scanned_at:         number;   // ms epoch
  verified:           boolean | null;
}
```

**Critical invariant:** `preview` is the redacted tail (`'*'.repeat(N) + raw.slice(-4)`).
The raw secret value is never serialised on the wire. If the client wants
to upload anything beyond the redacted preview, it's a deliberate Pro-tier
opt-in (see "server-side processing" below).

### `dismissals`, `custom_rules` — bidirectional state

These sync both ways. If you mark a finding "rotated" on your laptop, your
workstation sees the same dismissal on next sync. If you add a custom rule
on the team admin's machine, every engineer's machine pulls it down.

```ts
interface Dismissal {
  preview:       string;
  status:        'rotated' | 'false_positive' | 'dismissed';
  reason:        string | null;
  dismissed_at:  number;
  dismissed_by:  string;     // user id; team views show "Alice rotated this"
}

interface SecretRule {
  id:            number;
  tenant_id:     string;
  name:          string;
  regex:         string;
  severity:      'critical' | 'high' | 'medium' | 'low';
  description:   string | null;
  enabled:       0 | 1;
  updated_at:    number;     // last-write-wins on conflict
}
```

### `session_meta` — IDs only

```ts
interface SessionMetaLite {
  id:            string;
  tool:          'claude' | 'codex' | 'gemini' | 'opencode' | 'agy' | 'cursor';
  project_path:  string;     // for grouping; not for processing
  mtime:         number;
  created_at:    number;
  /** intentionally absent: title, content_preview, first_prompt, messages */
}
```

The server uses these for one purpose: to display "session abc12345 in
project ~/code/personal/munbot was scanned at T". It cannot reconstruct
chat content from this data.

## What the cloud server CAN do with this

The aggregation layer is what justifies the SaaS price; sync is just
the transport.

- **Multi-device** — one tenant, three devices, one dashboard. Findings
  union across devices keyed by `(session_id, detector, rule, line)`.
- **Team views** — multiple users in a tenant. Admin role sees aggregate
  per-user counts; non-admins see only their own sessions.
- **Alerting** — when a finding lands with `severity=critical` AND
  `detectors_count >= 2`, fire a webhook (Slack / email / PagerDuty).
- **Retention** — server keeps findings even after the client wipes its
  local index. Audit trail outlives any one machine.
- **Verified-mode scheduler** — `verified` column on findings; cron job
  runs trufflehog `--only-verified` against the *redacted* preview shape
  on a schedule. (For verification mode that needs the raw secret, see
  Pro tier.)
- **Suggestion engine** — anonymised cross-tenant signal proposes new
  rule patterns. No raw secrets cross tenants; only structural
  fingerprints.

## What the cloud server CANNOT do (without Pro tier)

- **Read raw chat content.** The JSONLs stay local.
- **Verify a credential by calling its issuer with the raw value.**
  Verification on this tier is server-driven on the *redacted shape* —
  fine for "this rule fires N% of the time" telemetry, useless for
  "is this specific key still live."
- **Reproduce the leak in any way.** A breach of your DB exposes
  `*****QVGY` redacted previews + dismissal history + custom rule regexes.
  Not a single recoverable secret.

## Pro tier — opt-in server-side processing

Some features genuinely require raw content on the server (e.g. verified
mode that calls AWS to confirm a key works, or compliance reports that
embed transcript context). For those:

- Customer explicitly opts in: per-tenant Firecracker microVM
  (Fly.io Machines under the hood).
- Each customer = one VM = one volume. Kernel-level isolation.
- Sync uploads RAW chat content (still gzipped + TLS in transit) to that
  VM only. The shared cloud server never sees raw content.
- Pro features run inside the VM: real verification, suggestion engine
  on raw text, compliance PDF generation.

Pricing implication: Pro is materially more expensive (per-VM cost +
storage). Two-tier pricing is honest because the trust ask is
materially different.

## Migration story for existing self-hosted users

- Self-hosted user installs an updated chat-recall.
- Optionally signs up for cloud and sets `CHAT_RECALL_SYNC_TOKEN=…`.
- On first run, indexer pushes existing local findings + dismissals to
  the cloud. No data motion needed beyond that — the sync is purely
  additive on top of the existing local DB.
- Self-hosted continues to work without sync if the env var is unset.

## Server schema (minimal, sketch only)

```sql
-- mirrors the client's secret_findings, scoped by tenant + device
CREATE TABLE findings (
  tenant_id    TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  detector     TEXT NOT NULL,
  rule         TEXT NOT NULL,
  line         INTEGER NOT NULL,
  preview      TEXT NOT NULL,
  verified     INTEGER,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, session_id, detector, rule, line)
);

-- bidirectional state, last-write-wins on (tenant_id, preview)
CREATE TABLE dismissals (
  tenant_id    TEXT NOT NULL,
  preview      TEXT NOT NULL,
  status       TEXT NOT NULL,
  reason       TEXT,
  dismissed_at INTEGER NOT NULL,
  dismissed_by TEXT,
  PRIMARY KEY (tenant_id, preview)
);

CREATE TABLE rules (
  tenant_id   TEXT NOT NULL,
  id          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  regex       TEXT NOT NULL,
  severity    TEXT NOT NULL,
  description TEXT,
  enabled     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- watermarks per device for incremental sync
CREATE TABLE sync_state (
  tenant_id    TEXT NOT NULL,
  device_id    TEXT NOT NULL,
  last_ack     INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);
```

## Open questions to settle before wire-up

1. **Auth provider.** Roll our own (JWT + email/pw) or buy (WorkOS,
   Clerk, Stytch)? Recommendation: buy. SAML/SCIM in Enterprise tier
   is a hard requirement; rolling SCIM yourself is months of work.
2. **Tenancy granularity.** One tenant per user (consumer model) or
   one tenant per organisation (B2B model)? Both probably — but the
   schema needs to encode the user→tenant relationship from day one.
3. **Conflict resolution policy.** Last-write-wins on dismissals is
   safe (worst case: a stale dismissal flickers and reapplies). On
   custom rules, last-write-wins risks wiping a teammate's edits —
   needs at least an `updated_at` check + a "your rule is out of
   date" UI prompt on conflict.
4. **Encryption-at-rest.** Cloud DB encrypted with what? Cloud-provider
   default vs per-tenant KMS keys (the latter is the upmarket pitch).
