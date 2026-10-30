# Your first recall

In this tutorial, we install chat-recall, send our existing AI sessions to the
server, and ask an assistant about work it did not see. It takes about ten
minutes. You need Node.js 22 or later, and at least one AI coding tool that you
already used, such as Claude Code or Codex.

## 1. Install the CLI

```bash
npm install -g chat-recall
```

## 2. Connect this machine

```bash
chat-recall init
```

The command opens a browser page to sign in to chatrecall.dev. Approve the
device there. Then the command:

- finds the AI tools on this machine,
- registers the chat-recall MCP server in each of them,
- installs the hooks and the background service,
- shows what it will upload, and asks before the first upload.

Answer yes. The first upload sends the transcripts that are already on your
disk, with secrets masked before they leave the machine.

## 3. Look at what arrived

```bash
chat-recall status
```

You see the number of synced sessions and the projects they belong to. Now
search them:

```bash
chat-recall search "database migration"
```

The results name sessions from your own past work. Pick one id and read it:

```bash
chat-recall show <session_id>
```

## 4. Ask an assistant

Start a new session in your AI tool, in a project you worked on before. Ask:

> What did we decide about this project last time, and what was left open?

The assistant calls `recall_smart_resume` and answers from your earlier
sessions. In Claude Code, the start of the new session also holds the
decisions and facts of the project, from the wake-up hook.

Now ask about something from another tool. If you worked on the project in
Codex last week, ask the Claude Code session what that Codex session changed.
The assistant finds it with `recall_search`, because all your tools share one
memory.

## 5. Keep working

New sessions sync by themselves: the background service sends each new
transcript a short time after it changes. You do not run a command for that.

## What we did

We installed the CLI, connected the machine, synced the existing sessions,
searched them from the terminal, and used them from an assistant. Next:

- [Give a new session your context](./WAKE-UP.md)
- [Run sessions that work together](./SESSIONS.md)
- [Sync skills, MCP servers, commands and agents across your tools](./TOOLKIT.md)
