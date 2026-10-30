# Sync skills, MCP servers, commands and agents across your tools

Each AI tool keeps its own skills, MCP servers, commands and agents. This guide
copies them between the tools on one machine, and installs your MCP servers on
another machine.

chat-recall writes to these tools: Claude Code (`claude`), Codex (`codex`),
Antigravity (`agy`), Cursor (`cursor`), OpenCode (`opencode`), Hermes Agent
(`hermes`) and pi (`pi`). The name in brackets is the tool id that the commands
below take.

## Copy everything to every tool on this machine

1. Run the sync:

   ```bash
   chat-recall toolkit sync
   ```

2. Read the report. It names each artifact it copied, and to which tool.

The sync copies each skill, MCP server, command and agent to every tool that
does not have it yet. It never overwrites an artifact that a tool already has.

To copy only some types, give `--types`. The types are `skill`, `mcp`,
`command` and `agent`:

```bash
chat-recall toolkit sync --types skill,mcp
```

Commands and agents change format on the way. For example, a Claude Code
command in Markdown becomes a TOML command for Antigravity, and a Claude Code
agent becomes a TOML agent for Codex. Instruction files get the name each tool
reads: `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`.

## Copy one artifact

```bash
chat-recall toolkit copy <type> <name> <fromTool> <toTool>
```

For example, to copy the skill `pdf` from Claude Code to Codex:

```bash
chat-recall toolkit copy skill pdf claude codex
```

## Install your MCP servers on a new machine

1. Install chat-recall on the new machine and log in:

   ```bash
   chat-recall login
   ```

2. See what the pull will install. This writes nothing:

   ```bash
   chat-recall toolkit pull --dry-run
   ```

3. Install the MCP servers:

   ```bash
   chat-recall toolkit pull
   ```

4. If the report names environment variables, set them for each MCP server
   that needs them.

The server keeps an inventory of your toolkit. For an MCP server, the inventory
holds the full registration: the command, the arguments, the URL, the allowed
tools and the names of its environment variables. The values of the variables
never leave the machine they are on, so step 4 is necessary when a server needs
a key.

The server does not hold the files of skills, agents and commands. The pull
reports them by name, and you copy them yourself or share them with
`chat-recall team publish` (see the [CLI reference](https://chatrecall.dev/docs/cli)).

An MCP server installs by itself only on a machine with the same operating
system as the device that registered it, so a macOS-only server does not reach a
Linux machine. To install one anyway, name it:

```bash
chat-recall toolkit pull --mcp acme-mcp,example-mcp
```

## Sync from the web app or from an assistant

The **Toolkit** view of the web app shows which artifact exists on which tool
and on which device. A sync that you start there waits in a queue, because only
the target machine can write its own config files. The target machine runs the
queue the next time its background service runs, or when you run:

```bash
chat-recall toolkit drain
```

An assistant does the same with two MCP tools:

- `recall_toolkit_status` shows which artifact exists on which tool and device.
- `recall_toolkit_sync` queues the work. With `scope: "pull"` it installs the
  account's MCP servers on a device. With `scope: "fan_out"` it copies one
  device's artifacts between that device's tools.

## Install the chat-recall skills

The chat-recall skills tell an agent when to use each `recall_*` tool.
`chat-recall init` installs them. To install them again, or into a tool that
you added later:

```bash
chat-recall install-skills
```

`--all-tools` installs them into every supported tool, also the tools that are
not found on this machine. `--uninstall` removes them.
