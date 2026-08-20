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
- **Network**: the collector talks only to the server(s) it is logged in to.
  `chat-recall init` defaults that server to the hosted service at
  `https://chatrecall.dev`; `chat-recall init --server <url>` or
  `chat-recall login <url>` points it at your own instead, and until it is
  logged in to something it sends nothing. There is no side channel: no
  telemetry, no analytics endpoint, no reporting to any origin other than the
  server you chose. Code-intelligence and auto-update fetch from that same
  origin.
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
- **Rules are served, execution is local.** A tenant rule marked *redact* is
  pulled at sync time and installed into the collector's in-process redactor, so
  detection improves without every device upgrading its CLI. The pack is
  **add-only** — it can make a client redact more, never less — and each rule is
  validated (must compile, must not match the empty string or benign text) both
  when saved and when installed.
- **Server-side re-scan (defence in depth).** Because detection is client-side, a
  device running old rules can ship us text with a secret still in it. The server
  periodically re-runs today's rules over the text it *already* stores; anything
  it finds is by definition a redaction miss, so it is recorded as a
  server-owned finding (which the offending client's next sync cannot delete) and
  alerted on so you can rotate. It only ever sees post-redaction text.
- **Server data at rest**: conversations, chunks, and the knowledge graph live
  in Postgres, scoped per tenant. Auth is OIDC (device flow) or a per-device
  token; a self-host server may run `AUTH_PROVIDER=none` for a single-tenant
  local box.

## Reporting a vulnerability

Open a GitHub Security Advisory:
<https://github.com/munhq/chat-recall/security/advisories/new>

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
