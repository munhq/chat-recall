/**
 * Shared utilities used across multiple modules.
 */

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/** Split markdown content by ## headers into sections */
export interface MarkdownSection {
  heading: string;
  text: string;
}

export function splitByHeaders(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      if (currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          text: currentLines.join('\n').trim(),
        });
      }
      currentHeading = headerMatch[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      text: currentLines.join('\n').trim(),
    });
  }

  return sections;
}

/** Claude model pricing per million tokens + context window limits */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6':    { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':  { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':   { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1 },
  'claude-sonnet-4-5':  { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
};

/** Context window limits per model (in tokens) */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6':           1_000_000,
  'claude-sonnet-4-6':         200_000,
  'claude-haiku-4-5':          200_000,
  'claude-sonnet-4-5':         200_000,
  'gemini-3-pro-preview':      1_000_000,
  'gemini-3-flash-preview':    1_000_000,
  'gemini-2.5-pro':            1_000_000,
  'gemini-2.5-flash':          1_000_000,
  'gemini-2.5-flash-lite':     1_000_000,
};

/** Get context window limit for a model (default 200k) */
export function getModelContextLimit(model: string): number {
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  for (const [key, val] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(key)) return val;
  }
  return 200_000; // default
}

export function getModelPricing(model: string): ModelPricing {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return val;
  }
  return MODEL_PRICING['claude-sonnet-4-6'];
}

/** Sanitize a string for use in LanceDB filter expressions */
export function sanitizeLanceFilter(value: string): string {
  return value.replace(/["'\\%_]/g, '');
}

/**
 * Discover all Claude data directories on the system.
 *
 * Checks:
 * - CLAUDE_DIRS env var (comma-separated paths)
 * - ~/.claude (standard)
 * - ~/.claude-work, ~/.claude-personal, etc. (multi-profile)
 *
 * Returns array of existing directory paths.
 */
export function getClaudeDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const seen = new Set<string>();

  const add = (dir: string) => {
    if (!seen.has(dir) && existsSync(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  };

  // 1. Explicit env var
  if (process.env.CLAUDE_DIRS) {
    for (const d of process.env.CLAUDE_DIRS.split(',')) {
      const trimmed = d.trim();
      if (trimmed) {
        // Expand ~ to home dir
        add(trimmed.startsWith('~/') ? join(home, trimmed.slice(2)) : trimmed);
      }
    }
  }

  // 2. Standard ~/.claude
  add(join(home, '.claude'));

  // 3. Auto-discover ~/.claude-* directories (multi-profile)
  try {
    const entries = readdirSync(home, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('.claude-') && entry.name !== '.claude-code') {
        // Verify it has a projects/ dir (not just random .claude-something)
        const candidate = join(home, entry.name);
        if (existsSync(join(candidate, 'projects'))) {
          add(candidate);
        }
      }
    }
  } catch {
    // Ignore permission errors
  }

  return dirs;
}

/**
 * Discover a specific subdirectory across all Claude directories.
 * E.g., discoverSubdirs('tasks') returns [~/.claude/tasks, ~/.claude-work/tasks, ...]
 */
export function discoverSubdirs(subdir: string): string[] {
  const result: string[] = [];
  for (const claudeDir of getClaudeDirs()) {
    const path = join(claudeDir, subdir);
    if (existsSync(path)) {
      result.push(path);
    }
  }
  return result.length > 0 ? result : [join(homedir(), '.claude', subdir)];
}
