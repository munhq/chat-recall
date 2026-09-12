/**
 * Bootstrap: register every ToolBackend in the registry. Importing this
 * file once at startup makes `getBackend(...)` and `getBackendForId(...)`
 * usable everywhere else.
 *
 * Adding a new tool: implement ./<tool>.ts, export the singleton, and
 * register it below. That is what the REGISTRY needs. Thirty other files list
 * the tool ids by name — per-tool skill and MCP paths, sync policy, artifact
 * encoding, the toolkit matrix, several server routes — and a tool missing from
 * one of them reads as "this tool has nothing" with no error anywhere. See
 * docs/ADDING_A_TOOL.md for the command that finds them.
 */

import { registerBackend, _setRegistryBootstrapper } from '../tool-backend.js';

import { claudeBackend, ClaudeBackend } from './claude.js';
import { opencodeBackend, OpencodeBackend } from './opencode.js';
import { codexBackend, CodexBackend } from './codex.js';
import { agyBackend, AgyBackend } from './agy.js';
import { cursorBackend, CursorBackend } from './cursor.js';

export function bootstrapBackends(): void {
  // Idempotent — registerBackend() calls Map.set, replacing if present, so
  // tests that reset the registry can call this directly to repopulate.
  registerBackend(claudeBackend);
    registerBackend(opencodeBackend);
  registerBackend(codexBackend);
  registerBackend(agyBackend);
  registerBackend(cursorBackend);
}

// Defer registration to the first registry access (call time), not import
// time. This dodges a circular-import race: `live-session-scan.ts` imports
// this module for the registry, but its sibling files (the four backends)
// import `live-session-scan.ts` for helpers. Eager registration during the
// import chain would read `claudeBackend`/etc. before they're assigned.
_setRegistryBootstrapper(bootstrapBackends);

export {
  claudeBackend, ClaudeBackend,
  opencodeBackend, OpencodeBackend,
  codexBackend, CodexBackend,
  agyBackend, AgyBackend,
  cursorBackend, CursorBackend,
};
export {
  registerBackend,
  getBackend,
  tryGetBackend,
  getBackendForId,
  listAllBackends,
  listAvailableBackends,
} from '../tool-backend.js';
export type {
  ToolBackend,
  AiTool,
  SessionLocation,
  SessionRef,
  ListSessionsOpts,
  ExtractTurnsOpts,
  LiveScanEditsResult,
} from '../tool-backend.js';
