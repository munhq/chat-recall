# Control what syncs

chat-recall sends the transcripts of your AI tools to your server, with secrets
masked. This guide keeps a folder, a project or a tool off the server, limits
the sync to chosen projects, and deletes what is already there.

## See what syncs

```bash
chat-recall sources list
```

The list shows each transcript folder that chat-recall found, and whether it
syncs. A folder that chat-recall is not sure about waits for your decision:

- `chat-recall sources approve <path>` starts to sync it.
- `chat-recall sources decline <path>` keeps it off the server. Add
  `--delete-remote` to also delete what was already sent from it.
- `chat-recall sources add <path>` adds a folder that chat-recall did not
  find.

## Keep a project or a tool off the server

```bash
chat-recall exclude project ~/code/client-work
chat-recall exclude tool cursor
```

A project rule matches a part of the project path. The tool names are `claude`,
`gemini`, `codex`, `opencode`, `agy`, `cursor`, `hermes` and `pi`.

`chat-recall exclude` lists the rules, and `chat-recall exclude remove <value>`
removes one. An agent can add a project rule with `recall_exclude_path`, but it
cannot remove one.

A rule stops new uploads. Sessions that were sent before the rule stay on the
server until you delete them.

## Sync only chosen projects

```bash
chat-recall sync-only add git:github.com/acme/example-app
```

This switches to opt-in mode: only the projects on the list sync.
`chat-recall projects` lists the project ids on this machine.
`chat-recall sync-only all` switches back to all projects, and keeps the list.

## Delete sessions

> **Caution:** A delete is permanent on the server. It does not touch the
> transcript files of your AI tool.

```bash
chat-recall delete <session-id>
```

The command deletes the session on every server that this machine is logged in
to, and blocks it from the next syncs. To delete a whole project, use
`--project <id>`. `--dry-run` lists what it would delete.

`chat-recall restore <session-id>` lifts the block, so the session can sync
again. It does not bring the content back by itself: run
`chat-recall index --force` on a machine that still has the transcript.

An agent deletes one session with `recall_forget`, but only when you ask it to.

## Keep sessions for a limited time

```bash
chat-recall retention set 90
```

The server then deletes sessions older than 90 days. The command shows what it
will delete and asks first. `0` keeps everything.

## Hash or show project paths

By default the CLI sends a hash of each project path, so the server does not see
your folder names. On a self-hosted server, `chat-recall sync
--paths-cleartext` sends the paths as they are.
