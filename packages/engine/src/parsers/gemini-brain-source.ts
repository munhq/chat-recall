/**
 * Gemini Brain memory source.
 *
 * Indexes Gemini CLI "brain" artifacts from ~/.gemini/antigravity/brain/<uuid>/
 * Each brain session contains: task.md, implementation_plan.md, session_summary.md,
 * and other markdown files with plans, findings, and status reports.
 *
 * Maps to plan + task source types.
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
import { geminiBackend as GEMINI } from '../core/backends/gemini.js';
import { splitByHeaders } from '../core/utils.js';
import { isSourceEnabled } from '../core/settings.js';

const MAX_CHUNK_CHARS = 2000;

export class GeminiBrainSource implements MemorySource {
  readonly sourceType = 'plan' as const;

  private brainDir: string;

  constructor(brainDir?: string) {
    this.brainDir = brainDir || GEMINI.antigravityBrainDir();
  }

  async *discover(): AsyncGenerator<MemoryItem> {
    if (!isSourceEnabled('gemini', 'brain')) return;
    if (!existsSync(this.brainDir)) return;

    const sessions = readdirSync(this.brainDir, { withFileTypes: true });

    for (const entry of sessions) {
      if (!entry.isDirectory()) continue;

      const sessionDir = join(this.brainDir, entry.name);
      const files = readdirSync(sessionDir)
        .filter(f => f.endsWith('.md') && !f.includes('.resolved') && !f.includes('.metadata'));

      if (files.length === 0) continue;

      for (const file of files) {
        const filePath = join(sessionDir, file);
        try {
          const stat = statSync(filePath);
          const content = readFileSync(filePath, 'utf-8');
          const firstLine = content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || '';
          const heading = content.split('\n').find(l => l.startsWith('#'))?.replace(/^#+\s*/, '').trim() || file;

          // Read metadata if available
          const metaPath = `${filePath}.metadata.json`;
          let metaSummary = '';
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
              metaSummary = meta.summary || '';
            } catch {}
          }

          const artifactType = file.replace('.md', '');
          const itemId = `${GEMINI.idPrefix}brain_${entry.name}_${artifactType}`;

          yield {
            id: itemId,
            sourceType: 'plan',
            title: `[Gemini] ${heading}`,
            projectPath: '', // Brain sessions don't have project paths
            filePath,
            mtime: stat.mtimeMs,
            contentPreview: metaSummary || firstLine.slice(0, 200),
            extra: {
              tool: 'gemini',
              brainSessionId: entry.name,
              artifactType,
            },
          };
        } catch {
          continue;
        }
      }
    }
  }

  async parse(item: MemoryItem): Promise<MemoryChunk[]> {
    if (!existsSync(item.filePath)) return [];

    const content = readFileSync(item.filePath, 'utf-8');
    const chunks: MemoryChunk[] = [];

    const sections = splitByHeaders(content);

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      if (!section.text.trim() || section.text.trim().length < 20) continue;

      chunks.push({
        chunkId: `${item.id}_section_${i}`,
        itemId: item.id,
        sourceType: 'plan',
        title: section.heading || item.title,
        text: section.text.slice(0, MAX_CHUNK_CHARS),
        chunkType: 'plan_section',
        projectPath: item.projectPath,
        filePath: item.filePath,
        mtime: item.mtime,
      });
    }

    return chunks.slice(0, 10);
  }

  async extractLinks(item: MemoryItem): Promise<MemoryLink[]> {
    // Link brain artifacts to their parent brain session
    const extra = item.extra || {};
    const brainId = extra.brainSessionId as string;
    if (brainId) {
      return [{
        sourceType: 'plan',
        sourceId: item.id,
        targetType: 'session',
        targetId: GEMINI.toPrefixedId(brainId),
        linkType: 'brain_artifact_for_session',
        confidence: 0.8,
      }];
    }
    return [];
  }
}
