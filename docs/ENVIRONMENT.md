# Environment variables

Every knob is optional — chat-recall runs with sane defaults. This is the single
reference for the `CHAT_RECALL_*` variables (grep the source for the authoritative
behavior; defaults below are current at time of writing).

## Collector / sync (the `chat-recall` CLI + `chat-recall-watch` daemon)

| Variable | Default | What it does |
|---|---|---|
| `CHAT_RECALL_UPLOAD_TIMEOUT_MS` | `90000` | Per-request abort timeout for conversation uploads. |
| `CHAT_RECALL_FULL_BUILD_MAX_MB` | `64` | Transcripts larger than this aren't fully materialized on a FULL sync — only the newest tail ships (prevents OOM on huge sessions). |
| `CHAT_RECALL_TAIL_APPEND` | on | Set `0` to disable incremental tail-append and force FULL syncs (emergency off-switch for the offset-continuity path). |
| `CHAT_RECALL_EXTERNAL_SCANNERS` | **off** | Set `1` to enable the external secret detectors (gitleaks/trufflehog). Off by default: they are third-party subprocesses that need pre-redaction text materialized on disk, and coverage would vary per device. Built-in regex redaction + findings and tenant rules run for everyone regardless. |
| `CHAT_RECALL_SCAN_SECRETS` | on | Set `0` to skip the external secret scanners even when they're enabled above (e.g. to keep a huge backfill fast). |
| `CHAT_RECALL_BATCHSCAN_MAX_MB` | `64` | Cap on pre-redaction text the external-detector batch scan keeps on disk at once. The batch dir is scanned and deleted each time it crosses this, bounding what a SIGKILL/OOM can strand in `/tmp`. |
| `CHAT_RECALL_INCLUDE_FUZZY` | off | Set `1` to keep low-precision detector findings (generic-api-key, URI, …) instead of dropping them. |
| `CHAT_RECALL_SYNC_TRACE` | off | Set `1` to print per-phase progress + heap/RSS to stderr — how walk OOMs get localized. |
| `CHAT_RECALL_REDACT_INDEX` | — | Index-time redaction toggle (sync-path redaction is always on regardless). |
| `CHAT_RECALL_AUTO_UPDATE` | on (self-host) | Controls the daemon's checksum-pinned same-origin self-update. |
| `CHAT_RECALL_OIDC_ISSUER` | — | Fallback OIDC issuer for `chat-recall login` SSO when the server doesn't advertise one and `--issuer` isn't passed. |

### Auto code-intelligence (collector)

| Variable | Default | What it does |
|---|---|---|
| `CHAT_RECALL_CODE_INDEX` | on | Set `0` to disable automatic codeindex discovery/indexing. |
| `CHAT_RECALL_CODE_INDEX_MINUTES` | `180` | How often the code-index pass runs. |
| `CHAT_RECALL_CODE_INDEX_MAX` | `50` | Max workspaces indexed per pass. |
| `CHAT_RECALL_CODE_INDEX_DAYS` | `120` | Recent-activity window for discovering workspaces. |
| `CHAT_RECALL_WITH_CODEINDEX` | — | Force-download the codeindex companion during `init`. |

## Path overrides

Point the collector at non-standard tool locations (useful for fixtures/tests):

| Variable | Overrides |
|---|---|
| `CHAT_RECALL_CLAUDE_HOME` | `~/.claude` |
| `CHAT_RECALL_GEMINI_HOME` | `~/.gemini` |
| `CHAT_RECALL_CODEX_HOME` | `~/.codex` |
| `CHAT_RECALL_AGY_HOME` | the agy tool home |
| `CHAT_RECALL_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` (full file path) |
| `CHAT_RECALL_DATA_DIR` | `~/.chat-recall` (ledger, shadow archive, credentials) |

## Server / storage (self-host)

Set on the **server** container, not the CLI. See the quick-start header of
`docker-compose.yml` for the canonical set.

| Variable | What it does |
|---|---|
| `CHAT_RECALL_STORAGE` | `postgres` (product) — required; the server fails closed rather than guessing a backend. (`sqlite` exists for unit tests only, not a user-facing mode.) |
| `CHAT_RECALL_DATABASE_URL` / `..._URL_RO` | Postgres connection string(s) for bring-your-own-Postgres. |
| `OIDC_ISSUER` | The server's OIDC issuer — advertised to CLIs via `/api/capabilities` for SSO login. |
| `ADMIN_KEY`, `AUTH_PROVIDER` | Admin key and auth mode (`none` for a single-tenant local box). |

Other server-internal flags (`CHAT_RECALL_EDITION`, `_ROLE`, `_SERVER_MODE`,
`_TENANT`, `_FEATURE_*`, `_VECTOR_PARTITIONS`, `_TELEMETRY`) tune SaaS/edition
behavior; consult the server source before setting them.
