/**
 * AI-powered summary generator.
 *
 * Providers:
 * - gemini-cli: Local Gemini CLI (requires `gemini` installed)
 * - claude: Anthropic API (requires ANTHROPIC_API_KEY)
 * - ollama: Local Ollama (requires Ollama running + a chat model)
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionContent } from '../parsers/session.js';

export interface SummaryGeneratorConfig {
  provider: 'gemini-cli' | 'claude' | 'ollama';
  geminiModel?: string;
  claudeModel?: string;
  ollamaModel?: string;
}

export class SummaryGenerator {
  private config: SummaryGeneratorConfig;

  constructor(config?: Partial<SummaryGeneratorConfig>) {
    this.config = {
      provider: config?.provider || 'gemini-cli',
      geminiModel: config?.geminiModel || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
      claudeModel: config?.claudeModel || 'claude-3-5-haiku-20241022',
      ollamaModel: config?.ollamaModel || 'qwen2.5:7b',
    };
  }

  /**
   * Generate a concise summary for a session.
   */
  async generate(content: SessionContent): Promise<string> {
    // Build conversation context
    const context = this.buildContext(content);

    // Generate summary based on provider
    switch (this.config.provider) {
      case 'gemini-cli':
        return this.generateWithGeminiCLI(context);
      case 'claude':
        return this.generateWithClaude(context);
      case 'ollama':
        return this.generateWithOllama(context);
      default:
        throw new Error(`Unknown provider: ${this.config.provider}`);
    }
  }

  private buildContext(content: SessionContent): string {
    const parts: string[] = [];

    // Add first prompt (most important)
    if (content.firstPrompt) {
      parts.push(`User's initial request:\n${content.firstPrompt.slice(0, 1000)}`);
    }

    // Add user messages (context)
    if (content.userMessages.length > 0) {
      const userMsgs = content.userMessages
        .slice(0, 5) // First 5 user messages
        .map(m => m.text.slice(0, 300))
        .join('\n\n');
      parts.push(`\nUser messages:\n${userMsgs}`);
    }

    // Add assistant responses (what was done)
    if (content.assistantMessages.length > 0) {
      const assistantMsgs = content.assistantMessages
        .slice(0, 5) // First 5 assistant messages
        .map(m => m.text.slice(0, 300))
        .join('\n\n');
      parts.push(`\nAssistant responses:\n${assistantMsgs}`);
    }

    // Add tools used (technical context)
    if (content.toolsUsed.size > 0) {
      parts.push(`\nTools used: ${Array.from(content.toolsUsed).join(', ')}`);
    }

    return parts.join('\n\n');
  }

  private generateWithGeminiCLI(context: string): string {
    const prompt = this.buildPrompt(context);

    try {
      // Write prompt to temp file to avoid shell escaping issues
      const tempFile = join(tmpdir(), `gemini-prompt-${Date.now()}.txt`);
      writeFileSync(tempFile, prompt, 'utf-8');

      try {
        // Use gemini CLI in non-interactive headless mode (-p flag).
        // Run from /tmp so Gemini has no project workspace - when run from a
        // project directory, Gemini enters agentic mode and tries to use file
        // tools (grep_search, list_directory) instead of just summarizing the
        // piped text. Running from /tmp prevents it from detecting a project.
        const model = (this.config.geminiModel || 'gemini-2.0-flash-exp').replace(/[^a-zA-Z0-9._-]/g, '');
        const result = execSync(
          `cat "${tempFile}" | gemini -m "${model}" -p " "`,
          {
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024, // 10MB
            timeout: 60000, // 60s timeout
            cwd: tmpdir(), // Neutral dir - prevents Gemini project detection
            stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr
          }
        );

        unlinkSync(tempFile); // Clean up temp file

      // Clean up the result
      const summary = result
        .trim()
        .replace(/^Summary:\s*/i, '')
        .replace(/^\d+\.\s*/, '') // Remove leading numbers
        .trim();

      if (!summary || summary.length < 10) {
        throw new Error('Generated summary too short');
      }

        return summary;
      } finally {
        // Ensure temp file is cleaned up
        try { unlinkSync(tempFile); } catch {}
      }
    } catch (error) {
      console.error('Gemini CLI error:', error);
      // Fallback: Build summary from available context
      const lines = context.split('\n').filter(l => l.trim().length > 20);
      let fallback = '';

      // Extract user request
      const userMsgIndex = lines.findIndex(l => l.includes('User\'s initial request:'));
      if (userMsgIndex >= 0 && lines[userMsgIndex + 1]) {
        fallback += 'User requested: ' + lines[userMsgIndex + 1].slice(0, 200) + '. ';
      }

      // Extract assistant response
      const assistantIndex = lines.findIndex(l => l.includes('Assistant responses:'));
      if (assistantIndex >= 0 && lines[assistantIndex + 1]) {
        fallback += 'Accomplished: ' + lines[assistantIndex + 1].slice(0, 200) + '. ';
      }

      // Extract tools used
      const toolsIndex = lines.findIndex(l => l.includes('Tools used:'));
      if (toolsIndex >= 0 && lines[toolsIndex]) {
        fallback += lines[toolsIndex] + '.';
      }

      return fallback || lines[0]?.slice(0, 300) || 'No summary available';
    }
  }

  private async generateWithClaude(context: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY required for claude summary provider');
    }

    const model = this.config.claudeModel || 'claude-3-5-haiku-20241022';
    const prompt = this.buildPrompt(context);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Claude API error: ${response.status} ${body}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!text || text.length < 10) {
      throw new Error('Claude returned empty summary');
    }
    return text;
  }

  private async generateWithOllama(context: string): Promise<string> {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = this.config.ollamaModel || process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    const prompt = this.buildPrompt(context);

    const response = await fetch(`${host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 1024 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama generate error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { response: string };
    const text = data.response?.trim();

    if (!text || text.length < 10) {
      throw new Error('Ollama returned empty summary');
    }
    return text;
  }

  private buildPrompt(context: string): string {
    return `You are summarizing a coding assistant conversation. Create a structured technical summary using this format:

**Request:**
- What the user wanted to accomplish

**Plan:**
- Approach or strategy decided

**What was done:**
- Actions taken (file changes, debugging, implementation)
- Tools/technologies used
- Key findings or discoveries

**Remaining/Not done:**
- Current status
- Issues still open
- Next steps needed

Be specific and technical. Include file names, error messages, and specific changes. Use bullet points.

Conversation:
${context}

Summary:`;
  }

  /**
   * Generate summaries in batch (more efficient).
   */
  async generateBatch(
    sessions: Array<{ sessionId: string; content: SessionContent }>
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const { sessionId, content } of sessions) {
      try {
        const summary = await this.generate(content);
        results.set(sessionId, summary);
      } catch (error) {
        console.error(`Failed to generate summary for ${sessionId}:`, error);
        results.set(sessionId, content.firstPrompt.slice(0, 200));
      }
    }

    return results;
  }
}
