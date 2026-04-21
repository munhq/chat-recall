/**
 * Entity Extractor — auto-extracts entities and relationships from text
 * to populate the knowledge graph during indexing.
 *
 * Extracts:
 * - Projects (from file paths, project references)
 * - Tools/Technologies (languages, frameworks, databases, libraries)
 * - Decisions (X chosen over Y)
 * - People (names referenced in conversations)
 *
 * All extraction is regex/heuristic — no LLM needed.
 */

import type { KnowledgeGraph } from './knowledge-graph.js';

export interface ExtractedTriple {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  confidence: number;
}

// ── Tool/Technology detection ────────────────────────────────────

const KNOWN_TOOLS: Record<string, string> = {
  // Languages
  'typescript': 'language', 'javascript': 'language', 'python': 'language',
  'rust': 'language', 'go': 'language', 'java': 'language', 'ruby': 'language',
  'c\\+\\+': 'language', 'swift': 'language', 'kotlin': 'language',
  'solidity': 'language', 'move': 'language', 'haskell': 'language',
  // Frameworks
  'react': 'framework', 'next[.]js': 'framework', 'nextjs': 'framework',
  'vue': 'framework', 'angular': 'framework', 'svelte': 'framework',
  'express': 'framework', 'fastapi': 'framework', 'django': 'framework',
  'flask': 'framework', 'rails': 'framework', 'spring': 'framework',
  'pingora': 'framework', 'actix': 'framework', 'axum': 'framework',
  'tailwind': 'framework', 'shadcn': 'framework',
  // Databases
  'postgresql': 'database', 'postgres': 'database', 'sqlite': 'database',
  'mysql': 'database', 'mongodb': 'database', 'redis': 'database',
  'dragonfly': 'database', 'lancedb': 'database', 'chromadb': 'database',
  'supabase': 'database', 'dynamodb': 'database',
  // Infrastructure
  'docker': 'infra', 'kubernetes': 'infra', 'k8s': 'infra',
  'terraform': 'infra', 'ansible': 'infra', 'nginx': 'infra',
  'caddy': 'infra', 'cloudflare': 'infra', 'gcp': 'infra',
  'aws': 'infra', 'azure': 'infra', 'vercel': 'infra',
  // Tools
  'git': 'tool', 'github': 'tool', 'gitlab': 'tool',
  'vscode': 'tool', 'neovim': 'tool', 'zellij': 'tool',
  'ollama': 'tool', 'gemini': 'tool', 'claude': 'tool',
  'nushell': 'tool', 'zsh': 'tool', 'bash': 'tool',
  // Libraries
  'better-sqlite3': 'library', 'commander': 'library',
  'zod': 'library', 'playwright': 'library', 'vitest': 'library',
  'jest': 'library', 'webpack': 'library', 'vite': 'library',
  'esbuild': 'library', 'turbopack': 'library',
};

// Build regex from known tools — word-boundary match, case insensitive
const TOOL_PATTERNS: Array<{ pattern: RegExp; name: string; category: string }> = [];
for (const [tool, category] of Object.entries(KNOWN_TOOLS)) {
  // For patterns with escaped special chars (like c\+\+), use lookaround instead of \b
  const hasSpecialChars = /\\[+.^$*?]/.test(tool) || /\[/.test(tool);
  const pat = hasSpecialChars
    ? new RegExp(`(?:^|[\\s,;(])${tool}(?:[\\s,;)]|$)`, 'i')
    : new RegExp(`\\b${tool}\\b`, 'i');

  // Clean up the display name
  const name = tool
    .replace(/\\\+/g, '+')
    .replace(/\[.\]/g, '.')
    .replace(/\[\+\]/g, '+')
    .replace(/\[([^\]]+)\]/g, '$1');

  TOOL_PATTERNS.push({ pattern: pat, name, category });
}

// ── Decision extraction ──────────────────────────────────────────

const DECISION_PATTERNS = [
  // "decided to use X" / "going with X" / "chose X"
  /\b(?:decided to use|going with|chose|selected|adopted|switched to|migrated to)\s+([A-Za-z][A-Za-z0-9._-]{1,30})/gi,
  // "X over Y" / "X instead of Y"
  /\b([A-Za-z][A-Za-z0-9._-]{1,25})\s+(?:over|instead of|rather than)\s+([A-Za-z][A-Za-z0-9._-]{1,25})/gi,
  // "replaced X with Y"
  /\b(?:replaced|swapped)\s+([A-Za-z][A-Za-z0-9._-]{1,25})\s+(?:with|for)\s+([A-Za-z][A-Za-z0-9._-]{1,25})/gi,
];

// ── Project extraction from paths ────────────────────────────────

const PROJECT_PATH_PATTERN = /\/(?:home|Users)\/\w+\/(?:code|projects|work|dev|src)\/(?:\w+\/)?([a-zA-Z][a-zA-Z0-9_-]{1,40})/g;

// ── People extraction ────────────────────────────────────────────

const PEOPLE_PATTERNS = [
  /\b(?:my name is|I'm|I am)\s+([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?)/g,
  /\b(?:working with|collaborating with|team includes?|pair(?:ed|ing) with)\s+([A-Z][a-z]{1,15}(?:\s+[A-Z][a-z]{1,15})?)/g,
  /\b(?:@)([a-zA-Z][a-zA-Z0-9_-]{2,20})\b/g,
];

// Common false positives for people names
const NOT_PEOPLE = new Set([
  'the', 'this', 'that', 'here', 'there', 'when', 'what', 'where', 'how',
  'claude', 'gemini', 'chatgpt', 'copilot', 'assistant', 'human', 'user',
  'error', 'warning', 'debug', 'info', 'note', 'todo', 'fixme',
  'true', 'false', 'null', 'undefined', 'none', 'string', 'number',
  'react', 'node', 'python', 'rust', 'typescript', 'javascript',
  'file', 'function', 'class', 'module', 'import', 'export', 'return',
]);

// ── Main extraction ──────────────────────────────────────────────

/**
 * Extract entity-relationship triples from text.
 * Returns triples ready to be added to the KG.
 */
export function extractEntities(
  text: string,
  context: {
    projectPath?: string;
    sourceType?: string;
    sessionId?: string;
  } = {}
): ExtractedTriple[] {
  const triples: ExtractedTriple[] = [];
  const seen = new Set<string>();

  const addTriple = (s: string, p: string, o: string, conf = 0.7) => {
    const key = `${s.toLowerCase()}|${p}|${o.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    triples.push({ subject: s, predicate: p, object: o, confidence: conf });
  };

  // Derive project name from path
  const projectName = context.projectPath
    ? context.projectPath.split('/').filter(Boolean).pop() || ''
    : '';

  // 1. Extract tools/technologies mentioned
  for (const { pattern, name, category } of TOOL_PATTERNS) {
    if (pattern.test(text)) {
      // If we have a project context, link tool to project
      if (projectName) {
        addTriple(projectName, 'uses', name, 0.6);
      }
      // Also add the tool as an entity with its category
      addTriple(name, 'is_a', category, 0.9);
    }
  }

  // 2. Extract decisions
  for (const pattern of DECISION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const chosen = match[1]?.trim();
      const rejected = match[2]?.trim();

      if (chosen && chosen.length > 1 && chosen.length < 30) {
        if (projectName) {
          addTriple(projectName, 'chose', chosen, 0.8);
        }
        if (rejected && rejected.length > 1 && rejected.length < 30) {
          addTriple(projectName || 'project', 'rejected', rejected, 0.7);
          addTriple(chosen, 'chosen_over', rejected, 0.8);
        }
      }
    }
  }

  // 3. Extract project names from file paths
  const pathProjects = new Set<string>();
  PROJECT_PATH_PATTERN.lastIndex = 0;
  let pathMatch;
  while ((pathMatch = PROJECT_PATH_PATTERN.exec(text)) !== null) {
    const proj = pathMatch[1];
    if (proj && !pathProjects.has(proj) && proj.length > 1) {
      pathProjects.add(proj);
      addTriple(proj, 'is_a', 'project', 0.8);
    }
  }

  // 4. Extract people
  for (const pattern of PEOPLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1]?.trim();
      if (name && name.length > 1 && name.length < 30 && !NOT_PEOPLE.has(name.toLowerCase())) {
        addTriple(name, 'is_a', 'person', 0.6);
        if (projectName) {
          addTriple(name, 'works_on', projectName, 0.5);
        }
      }
    }
  }

  return triples;
}

/**
 * Extract entities from text and add them to the knowledge graph.
 * Call this during indexing for each item.
 */
export function extractAndPopulateKG(
  kg: KnowledgeGraph,
  text: string,
  context: {
    projectPath?: string;
    sourceType?: string;
    sessionId?: string;
    validFrom?: string;
  } = {}
): number {
  const triples = extractEntities(text, context);
  let added = 0;

  for (const triple of triples) {
    try {
      kg.addTriple(triple.subject, triple.predicate, triple.object, {
        validFrom: context.validFrom,
        confidence: triple.confidence,
        sourceSession: context.sessionId,
      });
      added++;
    } catch {
      // Skip duplicates or errors
    }
  }

  return added;
}
