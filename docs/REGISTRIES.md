# Getting listed where agents look

For an MCP server, a registry listing is not marketing — it is distribution. When
someone asks their assistant "how do I give Claude Code memory of past sessions",
the answer comes from a registry or from a page an assistant already trusts. If
chat-recall is not in those places, it does not exist to the thing doing the
asking.

Everything here is either already in the repo or a command someone with the right
credentials has to run. The auth steps cannot be automated, and they are marked.

## 1. The official MCP registry

`server.json` at the repo root is the manifest, and it validates against
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

The namespace is `io.github.munhq/chat-recall`, and the registry proves
ownership through GitHub. **Publishing is automated:** the `mcp-registry`
workflow authenticates with GitHub Actions OIDC — the workflow run itself is
the proof that the org speaks — and publishes on every `v*` tag, plus on
manual dispatch.

Do NOT publish interactively from a machine. `mcp-publisher login github`
cannot work for this namespace: munhq restricts third-party OAuth apps, so the
registry's app never sees the org membership in a user token (public
membership included) and every attempt 403s naming only the user's personal
namespace. That dead end is why the workflow exists.

`server.json`'s `version` and its package `version` must match the npm version
actually published, or the listing points at a tarball that does not exist —
the release checklist below covers it. The workflow treats "duplicate version"
as success, so a re-dispatch on an unchanged manifest stays green.

## 2. Smithery

`smithery.yaml` at the repo root describes how to start the server and what it
takes. Smithery reads it from the public repo, so no upload is involved.

**NEEDS A HUMAN:** sign in at <https://smithery.ai> with GitHub, then add the
`munhq/chat-recall` repository. It picks up `smithery.yaml` from `main`.

It is declared as `stdio` deliberately. Smithery can host a server remotely, and
this one must not be hosted: the CLI reads transcripts from the user's own disk
and redacts credentials there, before anything is uploaded. A remote copy could
do neither, which would throw away the property the whole security model rests
on.

## 3. Glama

Glama crawls GitHub for MCP servers rather than taking submissions, so the
repository's own metadata is the input. What makes it findable:

- topics: `mcp`, `mcp-server`, `model-context-protocol`
- a `server.json` it can parse — done
- a README that says what the tools do near the top — done

**NEEDS A HUMAN (optional):** claim the listing at <https://glama.ai> to edit it.

## 4. GitHub topics — already done

The primary training and search surface for coding assistants, and the repo is
already tagged for it:

```
agent-memory  ai-agents  antigravity  claude  claude-code  codex
developer-tools  gemini-cli  llm  mcp  mcp-server  memory
model-context-protocol  opencode  postgresql  semantic-search
```

All three of the ones Glama and GitHub search key on — `mcp`, `mcp-server`,
`model-context-protocol` — are present. Nothing to do.

## What actually drives adoption, in order

Ranked by what it costs against what it returns, having done all of it:

1. **Tool descriptions.** The single highest-leverage text in the product. An
   agent picks a tool from its description, so a vague one is an uninstalled
   feature. Ours carry explicit routing hints ("Reach for this FIRST when the
   user says continue…"), which is why they work.
2. **A lean default tool list.** 53 tools makes an agent worse at choosing. The
   default registers 25. That is a selection decision, and it affects usage more
   than any listing.
3. **The registries above.** Real distribution, one afternoon, done once.
4. **`llms.txt`.** One file. The convention is young and adoption is uneven, so
   do it and expect little.
5. **Reddit, GitHub discussions, Discord.** Where the retrieval-augmented answers
   are actually sourced from now. Stack Overflow's traffic for this class of
   question has collapsed; do not spend time there.

## Release checklist for the listings

On every version bump:

- [ ] `server.json` `version` and `packages[0].version` match the npm release
- [ ] the `mcp-registry` workflow ran green for the tag (it fires on `v*` automatically)
- [ ] the tool count on chatrecall.dev still matches the registry — enforced by
      `check-parity.mjs` in the site repo, which blocks the deploy on drift
