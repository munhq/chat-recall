/**
 * Plan memory source.
 *
 * Parses ~/.claude/plans/*.md files. Each plan is split by ## headers
 * into chunks for granular search. Agent plans (with -agent-<hash> suffix)
 * are linked back to their parent session.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  MemorySource,
  MemoryItem,
  MemoryChunk,
  MemoryLink,
} from '../types/memory.js';
import { splitByHeaders, discoverSubdirs } from '../core/utils.js';

const MAX_CHUNK_CHARS = 2000;

export class PlanSource implements MemorySource {
  readonly sourceType = 'plan' as const;

  private plansDirs: string[];

  private _knownProjectDirs: string[] | null = null;

  constructor(plansDir?: string) {
    this.plansDirs = plansDir ? [plansDir] : discoverSubdirs('plans');
  }

  /** Lazily discover project directories from ~/.claude/projects/ */
  private getKnownProjectDirs(): string[] {
    if (this._knownProjectDirs) return this._knownProjectDirs;

    const projectsDir = join(homedir(), '.claude', 'projects');
    this._knownProjectDirs = [];

    if (!existsSync(projectsDir)) return this._knownProjectDirs;

    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const projectPath = entry.name.replace(/^-/, '/').replace(/-/g, '/');
        if (existsSync(projectPath)) {
          this._knownProjectDirs.push(projectPath);
        }
      }
    } catch {
      // Ignore errors
    }

    return this._knownProjectDirs;
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    const seen = new Set<string>();
    for (const plansDir of this.plansDirs) {
      if (!existsSync(plansDir)) continue;

      const files = readdirSync(plansDir).filter(f => f.endsWith('.md'));

      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const filePath = join(plansDir, file);
      try {
        const stat = statSync(filePath);
        const planName = basename(file, '.md');
        const isAgentPlan = planName.includes('-agent-');

        // Read content for title and project path extraction
        const content = readFileSync(filePath, 'utf-8');
        const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').trim() || planName;

        // Extract project path from content
        const projectPath = this.extractProjectPath(content);

        yield {
          id: planName,
          sourceType: 'plan',
          title: firstLine.slice(0, 150),
          projectPath,
          filePath,
          mtime: stat.mtimeMs,
          contentPreview: content.slice(0, 300),
          extra: {
            isAgentPlan,
            fileSize: stat.size,
          },
        };
      } catch {
        continue;
      }
    }
    }
  }

  /** Extract project path from plan content by matching against known projects */
  private extractProjectPath(content: string): string {
    const knownProjects = this.getKnownProjectDirs();

    // Look for explicit full paths that match known project dirs
    const fullPathPattern = /(?:File|Path|Location|Directory|Working directory|Project|Repository):\s*`?([~/][^\s`\n]+)`?/gi;
    for (const match of content.matchAll(fullPathPattern)) {
      let path = (match[1] || '').trim();
      // Expand ~ to home dir for comparison
      if (path.startsWith('~/')) {
        path = join(homedir(), path.slice(2));
      }
      // Check if this path starts with any known project dir
      for (const projectDir of knownProjects) {
        if (path.startsWith(projectDir)) {
          return projectDir;
        }
      }
    }

    // Also scan for any absolute paths in content that match known projects
    const absolutePathPattern = /(?:^|\s)(\/[\w/.-]+)/gm;
    for (const match of content.matchAll(absolutePathPattern)) {
      const path = match[1];
      for (const projectDir of knownProjects) {
        if (path.startsWith(projectDir)) {
          return projectDir;
        }
      }
    }

    // Look for project name mentions in various formats
    const projectNamePatterns = [
      /(?:project|repo|repository|codebase|application):\s*`?([\w-]+)`?/gi,
      /(?:in|for|on)\s+(?:the\s+)?([\w-]+)\s+(?:project|repo|repository|codebase)/gi,
      /`([\w-]+)\/(?:src|lib|crates|packages|apps)\//g,  // Like `hft-relay/src/`
      /crates\/([\w-]+)\//g,  // Rust workspace crates
      /packages\/([\w-]+)\//g,  // JS monorepo packages
    ];

    const projectNames = new Set<string>();
    for (const pattern of projectNamePatterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        const name = match[1];
        if (name && name.length > 2 && !['src', 'lib', 'test', 'main', 'index'].includes(name)) {
          projectNames.add(name);
        }
      }
    }

    // Search for the project name in known project directories from ~/.claude/projects/
    for (const name of projectNames) {
      for (const projectDir of knownProjects) {
        if (projectDir.endsWith(`/${name}`) || projectDir.endsWith(`\\${name}`)) {
          return projectDir;
        }
      }
    }

    return '';
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = readFileSync(item.filePath, 'utf-8');
    const chunks: MemoryChunk[] = [];

    // Split by ## headers into sections
    const sections = splitByHeaders(content);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.text.trim() || section.text.trim().length < 20) continue;

      const text = section.text.slice(0, MAX_CHUNK_CHARS);
      const chunkType = i === 0 ? 'plan_overview' : 'plan_section';

      chunks.push({
        chunkId: `${item.id}_${chunkType}_${i}`,
        itemId: item.id,
        sourceType: 'plan',
        title: section.heading || item.title,
        text,
        chunkType,
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    // Limit to reasonable number of chunks per plan
    return chunks.slice(0, 10);
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    const links: MemoryLink[] = [];
    const planName = item.id;

    // Agent plans link to their parent session via the hash suffix
    // Pattern: name-agent-<7char_hash> -> parent plan is just name
    const agentMatch = planName.match(/^(.+)-agent-([a-f0-9]+)$/);
    if (agentMatch) {
      const parentPlanName = agentMatch[1];
      links.push({
        sourceType: 'plan',
        sourceId: planName,
        targetType: 'plan',
        targetId: parentPlanName,
        linkType: 'agent_plan_for_session',
        confidence: 1.0,
      });
    }

    // Try to extract project paths from plan content
    if (existsSync(item.filePath)) {
      const content = readFileSync(item.filePath, 'utf-8');

      // Look for file path references that suggest a project
      const pathPatterns = [
        /(?:File|Path|Location):\s*`?([~/][^\s`\n]+)`?/gi,
        /(?:src|web|scripts)\/[^\s\n]+/g,
      ];

      const mentionedPaths = new Set<string>();
      for (const pattern of pathPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
          const path = match[1] || match[0];
          if (path.includes('/')) {
            mentionedPaths.add(path);
          }
        }
      }

      // Extract project path from mentioned paths
      for (const path of mentionedPaths) {
        const projectMatch = path.match(/\/home\/\w+\/code\/\w+\/([^/]+)/);
        if (projectMatch) {
          links.push({
            sourceType: 'plan',
            sourceId: planName,
            targetType: 'claude_md',
            targetId: projectMatch[1],
            linkType: 'plan_for_project',
            confidence: 0.8,
          });
          break; // One project link is enough
        }
      }
    }

    return links;
  }
}

// splitByHeaders imported from '../core/utils.js'
