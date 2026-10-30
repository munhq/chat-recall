# Troubleshooting

## Start with doctor

```bash
chat-recall doctor
```

It checks the login, the server, the credentials, the hooks of each AI tool,
the MCP server and codeindex, and names the command that fixes each problem.

## A new session does not show up on the server

1. Check the background service:

   ```bash
   chat-recall service status
   ```

   If it does not run, start it with `chat-recall service install`.

2. Send the sessions now:

   ```bash
   chat-recall sync
   ```

3. Check that the server holds what this machine has:

   ```bash
   chat-recall verify
   ```

   `--repair` sends again every session that the check finds missing.

If the session is still missing, check the rules: `chat-recall exclude` and
`chat-recall sync-only`. See [Control what syncs](./SYNC-CONTROL.md).

## The login fails or expired

```bash
chat-recall login --check
```

It exits with 0 when this machine has a working credential. If not, run
`chat-recall login` again.

## A session on the server is shorter than the transcript

Some tools rewrite a transcript in place, for example when a session resumes,
and the rewrite can drop earlier turns. chat-recall keeps a raw archive that
never shrinks, and rebuilds the session from it:

```bash
chat-recall repair --all
chat-recall repair --all --apply
```

The first command lists the damaged sessions. The second writes the repair.

## The assistant has no chat-recall tools

1. Run `chat-recall doctor`. It shows the MCP registration of each tool.
2. Run `chat-recall init --skip-sync` to register the MCP server again.
3. Restart the AI tool.

A new Claude Code session lists a short set of tools and `recall_help`, which
names all of them. That is normal. Set `CHAT_RECALL_MCP_PROFILE=full` to list
all tools.

## A message to another session fails

The error "No session matches" means the target session never reported to the
server. Its AI tool has no message hook, or the session started before the hook
was installed. Run `chat-recall install-hooks`, start a new session, and see
[Run sessions that work together](./SESSIONS.md).

## Update the CLI

```bash
chat-recall update
```

It updates from the server you sync to, and checks the checksum. If the server
does not have the newest release yet, use `--from-npm`.
