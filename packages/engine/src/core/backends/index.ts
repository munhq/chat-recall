/**
 * Bootstrap: register every ToolBackend in the registry. Importing this
 * file once at startup makes `getBackend(...)` and `getBackendForId(...)`
 * usable everywhere else.
 *
 * Adding a new tool: implement ./<tool>.ts, export the singleton, and
 * register it below. No other file in the codebase needs to change.
 */

import { registerBackend, _setRegistryBootstrapper } from '../tool-backend.js';

import { claudeBackend, ClaudeBackend } from './claude.js';
import { geminiBackend, GeminiBackend } from './gemini.js';
import { opencodeBackend, OpencodeBackend } from './opencode.js';
import { codexBackend, CodexBackend } from './codex.js';
import { agyBackend, AgyBackend } from './agy.js';
import { cursorBackend, CursorBackend } from './cursor.js';

export function bootstrapBackends(): void {
  // Idempotent — registerBackend() calls Map.set, replacing if present, so
  // tests that reset the registry can call this directly to repopulate.
  registerBackend(claudeBackend);
  registerBackend(geminiBackend);
  registerBackend(opencodeBackend);
  registerBackend(codexBackend);
  registerBackend(agyBackend);
  registerBackend(cursorBackend);
}

// Defer registration to the first registry access (call time), not import
// time. This dodges a circular-import race: `live-session-scan.ts` imports
// this module for the registry, but its sibling files (the four backends)
// import `live-session-scan.ts` for helpers. Eager registration during the
// import chain would read `geminiBackend`/etc. before they're assigned.
_setRegistryBootstrapper(bootstrapBackends);

export {
  claudeBackend, ClaudeBackend,
  geminiBackend, GeminiBackend,
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
