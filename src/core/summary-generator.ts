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
  /**
   * - `cli`        — run any local CLI, prompt piped to stdin. Configure via
   *                  `cliCommand` (or env `SUMMARY_CLI_CMD`). No API key.
   * - `gemini-cli` — legacy alias: runs `gemini -m <model> -p " "`.
   * - `ollama`     — POST to local Ollama at `OLLAMA_HOST`.
   * - `claude`     — Anthropic HTTP API (requires `ANTHROPIC_API_KEY`).
   */
  provider: 'cli' | 'gemini-cli' | 'claude' | 'ollama';
  /** Shell command for the generic `cli` provider. Prompt is piped via stdin.
   *  Example: `gemini -p " "`, `claude -p " "`, `codex chat`, `aichat`. */
  cliCommand?: string;
  cliTimeoutMs?: number;
  geminiModel?: string;
  claudeModel?: string;
  ollamaModel?: string;
}

/**
 * Known invocation patterns for local coding-assistant CLIs. Users can opt in
 * with `SUMMARY_CLI_PRESET=<name>`, or override entirely with SUMMARY_CLI_CMD.
 * The placeholder `{prompt_file}` is substituted with a temp file containing
 * the prompt at runtime. Commands without any placeholder get the prompt
 * piped to stdin instead.
 */
/**
 * Normalise stdout from agentic CLIs: drop ANSI escapes, strip the one-line
 * session banner opencode/kilo print before the model reply (e.g.
 * `> build · kimi-k2.6:cloud`), and trim.
 */
function cleanCliOutput(raw: string): string {
  let out = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // ANSI CSI
  out = out.replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '');   // ANSI OSC (title-set)
  // opencode / kilo banner: "> build · <model:tag>"
  out = out.replace(/^>\s*\w+\s*·\s*[^\n]+\n/gm, '');
  out = out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n')
    .trim();
  // Drop common summary-generator echo prefixes
  out = out.replace(/^Summary:\s*/i, '').replace(/^\d+\.\s*/, '').trim();
  return out;
}

export const CLI_PRESETS: Record<string, string> = {
  // Coding-agent CLIs that take the message as a positional arg
  opencode: 'opencode run "$(cat {prompt_file})"',
  kilocode: 'kilocode run "$(cat {prompt_file})"',
  // Stdin-friendly CLIs (the prompt is piped in, command gets an empty "-p").
  // `--skip-trust` is required for Gemini CLI: it refuses to run in
  // directories not on its trusted-folder list, which the indexer's working
  // dir typically isn't. Without this flag every summary errored out with
  // "not running in a trusted directory". The flag is safe in this context
  // because we're only piping our own generated prompt, never reading the
  // workspace files.
  gemini: 'gemini --skip-trust -p " "',
  'claude-cli': 'claude -p " "',
  llm: 'llm --no-stream',
  aichat: 'aichat --no-stream',
};

export class SummaryGenerator {
  private config: SummaryGeneratorConfig;

  constructor(config?: Partial<SummaryGeneratorConfig>) {
    // Preset shortcuts: `SUMMARY_CLI_PRESET=opencode` picks a known invocation
    // so users don't need to know each CLI's flag conventions.
    const preset = (config?.cliCommand ? undefined : process.env.SUMMARY_CLI_PRESET)?.toLowerCase();
    const presetCmd = preset ? CLI_PRESETS[preset] : undefined;

    this.config = {
      provider: config?.provider || (process.env.SUMMARY_PROVIDER as any) || 'gemini-cli',
      cliCommand: config?.cliCommand || process.env.SUMMARY_CLI_CMD || presetCmd,
      cliTimeoutMs:
        config?.cliTimeoutMs ||
        (process.env.SUMMARY_CLI_TIMEOUT_MS ? parseInt(process.env.SUMMARY_CLI_TIMEOUT_MS, 10) : 120000),
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
      case 'cli':
        return this.generateWithCLI(context);
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

  /**
   * Generic local-CLI provider. Pipes the prompt to stdin of a user-configured
   * command so you can reuse whatever coding-assistant CLI you already have
   * logged in (gemini, claude, codex, aichat, llm, ollama run, …) without
   * managing API keys from this tool.
   *
   * Configure with `SUMMARY_CLI_CMD`. Examples:
   *   SUMMARY_CLI_CMD='gemini -p " "'
   *   SUMMARY_CLI_CMD='claude -p " "'
   *   SUMMARY_CLI_CMD='llm --no-stream'
   *   SUMMARY_CLI_CMD='aichat --no-stream'
   */
  private generateWithCLI(context: string): string {
    const cmd = this.config.cliCommand?.trim();
    if (!cmd) {
      throw new Error(
        "provider='cli' needs SUMMARY_CLI_CMD or SUMMARY_CLI_PRESET " +
          `(known presets: ${Object.keys(CLI_PRESETS).join(', ')})`
      );
    }
    const prompt = this.buildPrompt(context);
    const tempFile = join(tmpdir(), `summary-prompt-${Date.now()}-${process.pid}.txt`);
    writeFileSync(tempFile, prompt, 'utf-8');

    try {
      // Two invocation modes:
      //  (a) `{prompt_file}` placeholder — substituted with the temp file path.
      //      Use this for CLIs that take prompts as positional args
      //      (opencode run, kilo run, …).
      //  (b) No placeholder — prompt is piped to the command's stdin.
      //      Use this for streaming CLIs (gemini -p, claude -p, llm, aichat).
      const shellCmd = cmd.includes('{prompt_file}')
        ? cmd.replace(/\{prompt_file\}/g, tempFile)
        : `cat "${tempFile}" | ${cmd}`;

      const raw = execSync(shellCmd, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.config.cliTimeoutMs,
        cwd: tmpdir(), // neutral dir so agentic CLIs don't latch onto a project
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: '/bin/bash', // enable $(…) in presets
      });

      const summary = cleanCliOutput(raw);
      if (!summary || summary.length < 10) throw new Error('Generated summary too short');
      return summary;
    } finally {
      try { unlinkSync(tempFile); } catch {}
    }
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
