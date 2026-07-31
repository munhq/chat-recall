# Security policy

Thanks for taking the time to look at chat-recall's security.

## Architecture in one line

chat-recall is a **CLI + a server**. The CLI (the "collector") reads the
transcripts your AI tools already write to disk, **redacts secrets locally**, and
**syncs to a server**. The server (self-hosted with Postgres via Docker Compose,
or the hosted SaaS) is the only thing that stores and searches data. There is no
embedded/offline datastore — the collector keeps only local bookkeeping.

## Threat model — what chat-recall touches

- **Reads from**: `~/.claude/`, `~/.gemini/`, `~/.local/share/opencode/`,
  `~/.codex/` (everything your AI tools already write). Transcripts are
  user-controlled input and are treated as untrusted.
- **Writes locally**: `~/.chat-recall/` — the sync ledger, the shadow archive
  (a local, gzipped copy of the fullest-seen transcript per session, so an
  upstream `--resume` truncation can't destroy history), `credentials.json`
  (mode 0600), and per-agent diaries. Also `~/.mcp.json` when registering the
  MCP server. No search index is stored locally.
- **Network**: the collector **always** talks to the server(s) you `login` to
  (a local `http://localhost` Postgres stack, or a remote server you point it
  at). It phones home to **no** default server — `chat-recall login <url>` is
  always explicit. Optional: code-intelligence + auto-update fetches from the
  same server origin you logged into.
- **Redaction is unconditional**: every string that leaves the machine is run
  through the secret redactor first (`packages/engine/src/core/secret-redactor.ts`),
  regardless of any setting. It is in-process regex with no external dependency,
  so it behaves identically on every device.
- **Detection runs where the raw text is — on your machine.** The server only
  ever receives masked previews (last-4), never raw secrets, which also means it
  cannot scan for what your client didn't catch. Tenant rules are *configured*
  server-side and *executed* client-side for exactly this reason.
- **The external detectors are opt-in and off by default.** gitleaks/trufflehog
  only run with `CHAT_RECALL_EXTERNAL_SCANNERS=1` — they are third-party
  subprocesses, they require pre-redaction text to be written to disk (bounded
  and deleted per slice, see `CHAT_RECALL_BATCHSCAN_MAX_MB`), and having them
  installed on one device but not another would make findings device-dependent.
- **Live key verification** (`--only-verified`) also stays client-side by
  construction: confirming a key is live requires the raw value, so that request
  goes from your machine to the key's own issuer, never through us.
- **Server data at rest**: conversations, chunks, and the knowledge graph live
  in Postgres, scoped per tenant. Auth is OIDC (device flow) or a per-device
  token; a self-host server may run `AUTH_PROVIDER=none` for a single-tenant
  local box.

## Reporting a vulnerability

Open a GitHub Security Advisory:
<https://github.com/darkkraft/chat-recall/security/advisories/new>

Or, if you can't use that, open a public issue clearly tagged `security:` and
we'll move it private. Do **not** disclose exploit details in a public issue
before the advisory is opened.

We aim to acknowledge within 72 hours and ship a patch within two weeks for
confirmed high/critical issues.

## What's in scope

- **A raw secret reaching the server** — the redactor is the core boundary; any
  input that slips an unmasked credential past it into a synced payload is a
  high-severity bug.
- **Cross-tenant data access** — anything that lets one device token / MCP
  client read or write another tenant's data on the server.
- **Auth bypass** — accepting an invalid/forged device token or OIDC assertion;
  the offset-continuity / append guards being tricked into overwriting another
  session's data.
- **Path traversal or injection in the parsers/collector** (transcripts, shadow
  filenames, project paths are all attacker-influenceable).
- **Prompt-injection through indexed content** reaching the MCP tool surface
  (`recall_search`, `recall_memory_search`, `recall_smart_resume`, …). The query
  sanitizer in `packages/engine/src/core/query-sanitizer.ts` is part of this
  defense — bypasses are interesting.
- **Credential leaks from the web API** (keys/tokens returned or logged; they
  should be masked as `••••xxxx`).

## What's out of scope

- Attacks that require already-root or already-same-uid access to the machine
  the collector runs on. The collector does not enforce a security boundary
  against the user it runs as.
- Attacks against upstream providers (Ollama, Gemini, OpenAI, Anthropic, the
  OIDC issuer, etc.).
- Denial of service via enormous transcripts. The collector caps and streams on
  a best-effort basis, but local CPU/disk is yours to manage.
