#!/usr/bin/env node
// Publish a Smithery stdio release: the listing, its config schema, and the full
// tool card.
//
// This exists because the first listing was published with a handful of curl
// commands, and a listing published by hand is a listing that describes an old
// version forever. Everything the API needs is derived here from the same files
// and the same binary the release ships.
//
// Three things the API requires that its error messages do not say plainly, each
// of which cost an attempt:
//   - `bundle` is required for a stdio release. Without it: 400 "Missing
//     required part: bundle".
//   - `payload` is a form field holding JSON *as a string*, not a file upload.
//   - `serverCard.serverInfo` requires BOTH name and version. Omitting version
//     returns 400 "Invalid input: expected string, received undefined", which
//     names no field at all.
//
// Usage:
//   SMITHERY_API_KEY=… node scripts/smithery/publish-smithery.mjs \
//     --card card.json --bundle chat-recall-0.5.27.mcpb
// Optional: --namespace (default munhq), --server (default chat-recall), --dry-run.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const pkg = JSON.parse(readFileSync(path.join(repo, 'packages/cli/package.json'), 'utf8'));

const argv = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const has = (n) => argv.includes(n);

const namespace = argOf('--namespace', 'munhq');
const server = argOf('--server', 'chat-recall');
const cardPath = argOf('--card');
const bundlePath = argOf('--bundle');
const dryRun = has('--dry-run');

const die = (msg) => {
  process.stderr.write(`publish-smithery: ${msg}\n`);
  process.exit(1);
};

if (!cardPath || !bundlePath) die('need --card <tools.json> and --bundle <file.mcpb>');
const key = process.env.SMITHERY_API_KEY;
if (!key && !dryRun) {
  die('SMITHERY_API_KEY is not set. It is the bearer token from smithery.ai; nothing else authenticates this API.');
}

const card = JSON.parse(readFileSync(cardPath, 'utf8'));
const tools = card.tools || card.result?.tools || [];
if (!tools.length) die(`${cardPath} declares no tools — refusing to publish a listing with an empty tool card`);

// Mirrors smithery.yaml. Nothing is REQUIRED: a user with no account and no
// configuration gets a working install, because the first tool call that needs
// an account spawns `chat-recall init` (see packages/cli/src/mcp.ts), which runs
// the browser sign-in and then installs the skills, registers this server with
// their other AI tools and performs the first sync. Asking for a token here
// would put a wall in front of a flow that does not need one.
const configSchema = {
  type: 'object',
  properties: {
    chatRecallServer: {
      type: 'string',
      title: 'Server URL',
      description:
        'Where to sync. Leave empty for the hosted service at https://chatrecall.dev, or point it at your own '
        + 'instance — self-hosting is free for one person.',
      default: '',
    },
    profile: {
      type: 'string',
      title: 'Tool profile',
      description:
        '"lean" registers the tools people reach for most; "full" registers every tool. Lean is the default '
        + 'because tool choice degrades as the list grows, and every tool still works when called by name '
        + 'under either.',
      enum: ['lean', 'full'],
      default: 'lean',
    },
  },
  required: [],
};

const payload = {
  type: 'stdio',
  runtime: 'node',
  configSchema,
  serverCard: {
    serverInfo: {
      name: 'chat-recall',
      title: 'chat-recall',
      version: pkg.version,
      description:
        'One searchable memory across Claude Code, Gemini CLI, Codex, OpenCode, Antigravity and Cursor sessions.',
      websiteUrl: 'https://chatrecall.dev',
    },
    tools,
  },
};

const qualified = `${encodeURIComponent(`${namespace}/${server}`)}`;
const url = `https://api.smithery.ai/servers/${qualified}/releases`;

if (dryRun) {
  process.stdout.write(
    `dry run: PUT ${url}\n  version ${pkg.version}, ${tools.length} tools, bundle ${path.basename(bundlePath)}\n`
  );
  process.exit(0);
}

const form = new FormData();
// A string field. Sent as a file part, the API answers "expected string,
// received undefined" and names nothing.
form.append('payload', JSON.stringify(payload));
form.append(
  'bundle',
  new Blob([readFileSync(bundlePath)], { type: 'application/zip' }),
  path.basename(bundlePath)
);

const res = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${key}` }, body: form });
const text = await res.text();
if (!res.ok) die(`PUT ${url} -> HTTP ${res.status}: ${text}`);

let body;
try {
  body = JSON.parse(text);
} catch {
  die(`unparseable response: ${text.slice(0, 200)}`);
}
process.stdout.write(
  `published ${namespace}/${server} ${pkg.version}: status=${body.status} ` +
    `deployment=${body.deploymentId} url=${body.mcpUrl}\n` +
    `  ${tools.length} tools on the card\n`
);
for (const w of body.warnings || []) process.stderr.write(`  warning: ${w}\n`);
if (body.status && !['SUCCESS', 'QUEUED', 'WORKING'].includes(body.status)) {
  die(`release status is ${body.status}`);
}
