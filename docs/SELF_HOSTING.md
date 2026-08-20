# Self-hosting chat-recall

Run the whole thing on your own machine. Your transcripts never leave it, you
need no account, and nothing is sent anywhere.

This is a complete path — every command, in order, with what each one is for and
what to do when it does not work.

## What you get

Two containers: the chat-recall **server** (REST API + web dashboard) and
**Postgres** with pgvector. The CLI on each of your machines indexes the
transcripts your AI tools already wrote to disk, redacts secrets locally, and
pushes them to your server.

Full-text search works out of the box. Semantic (vector) search is optional and
needs an embedder — see [Optional: semantic search](#optional-semantic-search).

## Requirements

- Docker with the Compose v2 plugin (`docker compose version`)
- Node 22 or newer, on each machine whose sessions you want indexed
- ~2GB disk for the image build, plus whatever your history needs

## 1. Get the source

```bash
git clone https://github.com/munhq/chat-recall
cd chat-recall
```

The compose file **builds the server from source** — it has `build:`, not
`image:`. There is no published server image to pull.

## 2. Set two secrets

```bash
echo "ADMIN_KEY=$(openssl rand -hex 24)"         >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
```

`ADMIN_KEY` is what lets you create tenants and mint device tokens. Treat it
like a root password: anything holding it can read every tenant on the server.

## 3. Start it

```bash
docker compose up -d --build
```

> **The first run takes several minutes and looks stalled.** It is compiling the
> TypeScript monorepo inside the container. Do not interrupt it — a Ctrl-C
> throws the work away and the retry starts over. Later runs hit the layer cache
> and start in seconds.

Watch it come up:

```bash
docker compose logs -f server
```

It is ready when `/health` answers:

```bash
curl -fsS localhost:8080/health && echo OK
```

## 4. Create a tenant and a device token

A tenant is the box your data lives in; a device token is what one machine uses
to push into it.

```bash
source .env

curl -XPOST localhost:8080/api/tenants \
  -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"slug":"me","display_name":"Me"}'

curl -XPOST localhost:8080/api/tenants/me/tokens \
  -H "x-admin-key: $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"device_id":"laptop"}'
```

The second call returns a `ct_…` token. Copy it — it is shown once.

## 5. Connect a machine

On each machine whose sessions you want indexed:

```bash
npx chat-recall init --server http://<server-host>:8080 --token ct_…
```

That single command detects which AI tools you have, indexes the transcripts
already on disk, redacts secrets before anything is sent, registers the MCP
server in `~/.mcp.json`, installs the recall skills into every AI tool it found,
and runs the first sync.

Use `localhost:8080` if the server is on this same machine.

## 6. Check it worked

```bash
chat-recall doctor            # detected tools, hooks, skills, server reachable
chat-recall search "…"        # should return your own past sessions
```

Then open **http://localhost:8080** for the dashboard.

Inside an AI assistant, ask it to call `recall_status`. If it can, the MCP
wiring is correct and the agent can now search its own history.

## Team features (licence key)

Solo self-hosting is free and unlimited, forever. Collaboration is licensed:
inviting a second member, shared project history, the team task board and
per-member activity.

Buy a licence from the account page of any chat-recall server you can reach
(`/app?view=account`) — it is self-serve, no email thread. Then add the key to
`.env`:

```bash
echo "CHAT_RECALL_LICENSE=CR1...." >> .env
docker compose up -d
```

The key is verified offline — an Ed25519 signature checked locally against a key
compiled into the server. No licence server is contacted, so an air-gapped
deployment works and an outage on our side can never disable your install.

Check it applied:

```bash
curl -s localhost:8080/api/capabilities | grep -o '"license":{[^}]*}'
```

`"team":true` means it is active. A key carries an optional seat count; without
one it is a site licence with no member limit.

## Optional: semantic search

Full-text search needs nothing. For vector search, point the server at any
OpenAI-compatible embeddings endpoint — a local Ollama is the usual choice:

```bash
ollama pull nomic-embed-text
```

```yaml
# docker-compose.override.yml
services:
  server:
    environment:
      EMBEDDING_PROVIDER: ollama
      OLLAMA_HOST: http://host.docker.internal:11434
```

Then `chat-recall index --force` to backfill vectors for existing sessions.
Without an embedder every search silently falls back to full-text, which is
good enough that many people never add one.

## Bring your own Postgres

The bundled `db` service exists so `docker compose up` is self-contained. To use
an existing Postgres 16+ instead:

```yaml
services:
  server:
    environment:
      DATABASE_URL: postgres://user:pass@host:5432/chat_recall
```

The `pgvector` extension is needed only for semantic search.

## Upgrading

```bash
git pull
docker compose up -d --build
```

Migrations run automatically at boot. Your data lives in the `db` volume and
survives the rebuild.

## Backups

Everything is in Postgres:

```bash
docker compose exec db pg_dump -U postgres chat_recall | gzip > backup.sql.gz
```

## Troubleshooting

**`docker compose up` seems frozen.** It is building. See step 3 — first run
compiles from source. `docker compose logs -f server` shows progress.

**`chat-recall login` says connection refused.** The server binds inside Docker.
From another machine use the host's LAN address, not `localhost`, and confirm
port 8080 is reachable: `curl http://<host>:8080/health`.

**Search returns nothing after a sync.** Check the server saw the data:
`chat-recall status`. If sessions are 0, the CLI found no transcripts — run
`chat-recall doctor` to see which AI tools it detected.

**The agent has no `recall_*` tools.** The MCP server is registered in
`~/.mcp.json`, but the assistant must be restarted to read it. Restart it, then
ask the agent to call `recall_status`.

**A tenant's data appears empty in the dashboard.** The dashboard shows the
tenant your browser session belongs to. With `AUTH_PROVIDER=none` (the
self-host default) there is no login, and the server pins the tenant to
`default` — so use `--tenant default` when minting tokens, or set
`CHAT_RECALL_TENANT` to match the tenant you created.

## Where your data is

On your machine, in the Postgres volume, and nowhere else. The CLI redacts
secrets before anything leaves the host, and a self-hosted server makes no
outbound calls except to an embedder if you configure one.
