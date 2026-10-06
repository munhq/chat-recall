/**
 * AI-powered summary generator.
 *
 * Providers:
 * - gemini-cli: Local Gemini CLI (requires `gemini` installed)
 * - claude: Anthropic API (requires ANTHROPIC_API_KEY)
 * - ollama: Local Ollama (requires Ollama running + a chat model)
 */

import { execSync, spawn } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('summary-generator');

/**
 * Promise-based shell exec. Replaces `execSync` for summary generation
 * so the auto-indexer's main event loop isn't frozen for the duration
 * of long-running CLI calls (gemini-cli's quota waits used to freeze
 * everything for hours). Captures stdout up to a generous buffer,
 * enforces a wall-clock timeout, and rejects on non-zero exit so
 * callers see the same error semantics as before.
 */
// Module-level set of every live shell child we've spawned, so the
// indexer can reap them all on shutdown. Without this, SIGTERM to the
// indexer leaves orphan gemini procs reparented to systemd-user that
// never exit on their own. Each entry is the *negative* PID of the
// shell child — i.e. its process group id, since we spawn detached.
const liveShellGroups = new Set<number>();

function killGroup(pgid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
  try { process.kill(-pgid, signal); } catch { /* gone */ }
}

/**
 * Reap every shell child this module has ever spawned. Called by the
 * indexer's shutdown hooks. Safe to call multiple times. Sends SIGTERM
 * first so well-behaved children flush, then SIGKILL after a short
 * grace.
 */
export function reapShellChildren(): void {
  if (liveShellGroups.size === 0) return;
  for (const pgid of liveShellGroups) killGroup(pgid, 'SIGTERM');
  setTimeout(() => {
    for (const pgid of liveShellGroups) killGroup(pgid, 'SIGKILL');
  }, 1000).unref();
}

function runShellAsync(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // detached: true puts the child in its own process group, so a
    // single process.kill(-pid) signals the whole tree (bash AND its
    // gemini grandchild). Without this, SIGKILL on the bash wrapper
    // leaves gemini reparented to PID 1 and burning RAM until the next
    // reboot.
    const child = spawn('/bin/bash', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.platform === 'win32' ? undefined : '/tmp',
      detached: process.platform !== 'win32',
    });
    const pgid = child.pid!;
    liveShellGroups.add(pgid);
    let out = '';
    let err = '';
    const MAX_BYTES = 10 * 1024 * 1024;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killGroup(pgid, 'SIGKILL');
      reject(new Error(`CLI summary timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < MAX_BYTES) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < MAX_BYTES) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      liveShellGroups.delete(pgid);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      liveShellGroups.delete(pgid);
      if (killed) return; // already rejected by timeout
      if (code !== 0) {
        reject(new Error(`CLI exit ${code}: ${err.slice(0, 400)}`));
      } else {
        resolve(out);
      }
    });
  });
}
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
  provider: 'cli' | 'gemini-cli' | 'claude' | 'ollama' | 'openai-compat' | 'ollama-cloud' | 'openai' | 'nvidia';
  /** Shell command for the generic `cli` provider. Prompt is piped via stdin.
   *  Example: `gemini -p " "`, `claude -p " "`, `codex chat`, `aichat`. */
  cliCommand?: string;
  cliTimeoutMs?: number;
  geminiModel?: string;
  claudeModel?: string;
  ollamaModel?: string;
  /** OpenAI-compatible HTTP providers (openai-compat / ollama-cloud / openai /
   *  nvidia). One `/chat/completions` shape, three knobs: base URL, model, key.
   *  Covers OpenRouter, Ollama Cloud, Groq, Together, NVIDIA NIM, etc. */
  apiBaseUrl?: string;
  apiModel?: string;
  apiKey?: string;
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

/** Default `/chat/completions` base URL per HTTP provider. `openai-compat` has
 *  no default — the user supplies any OpenAI-compatible endpoint (OpenRouter,
 *  Groq, Together, a self-hosted gateway, …). */
export function defaultApiBaseUrl(provider?: string): string | undefined {
  switch (provider) {
    case 'openai':       return 'https://api.openai.com/v1';
    case 'ollama-cloud': return 'https://ollama.com/v1';
    case 'nvidia':       return 'https://integrate.api.nvidia.com/v1';
    default:             return undefined; // openai-compat → explicit base URL
  }
}

export const CLI_PRESETS: Record<string, string> = {
  // Coding-agent CLIs that take the message as a positional arg
  opencode: 'opencode run "$(cat {prompt_file})"',
  kilocode: 'kilocode run "$(cat {prompt_file})"',
  // Gemini CLI: pass the prompt as the `-p` argument (it ignores stdin
  // when `-p` already has a value, which previously made every summary
  // a hallucination of Gemini's session memory rather than our prompt).
  // `--skip-trust` is required because Gemini refuses to run in
  // directories not on its trusted-folder list.
  gemini: 'gemini --skip-trust -p "$(cat {prompt_file})"',
  // Claude CLI: same pattern — prompt as -p arg.
  'claude-cli': 'claude -p "$(cat {prompt_file})"',
  // Truly stdin-friendly CLIs: prompt piped in, no -p flag.
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
      apiBaseUrl: config?.apiBaseUrl || process.env.SUMMARY_API_BASE_URL || defaultApiBaseUrl(config?.provider || (process.env.SUMMARY_PROVIDER as any)),
      apiModel: config?.apiModel || process.env.SUMMARY_API_MODEL,
      apiKey: config?.apiKey || process.env.SUMMARY_API_KEY,
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
        return this.generateWithCLIAsync(context);
      case 'gemini-cli':
        return this.generateWithGeminiCLIAsync(context);
      case 'claude':
        return this.generateWithClaude(context);
      case 'ollama':
        return this.generateWithOllama(context);
      case 'openai-compat':
      case 'ollama-cloud':
      case 'openai':
      case 'nvidia':
        return this.generateWithOpenAICompatible(context);
      default:
        throw new Error(`Unknown provider: ${this.config.provider}`);
    }
  }

  /**
   * Async wrapper for `generateWithCLI`. The original used `execSync` —
   * which blocks Node's main event loop for the entire subprocess
   * duration. When the configured CLI (e.g. gemini-cli) hangs on a
   * quota wait or an unbounded retry, the auto-indexer's file watcher,
   * heartbeat, and HTTP server all freeze. Switching to `spawn` keeps
   * the event loop responsive while the child runs.
   */
  private async generateWithCLIAsync(context: string): Promise<string> {
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
      const shellCmd = cmd.includes('{prompt_file}')
        ? cmd.replace(/\{prompt_file\}/g, tempFile)
        : `cat "${tempFile}" | ${cmd}`;
      const raw = await runShellAsync(shellCmd, this.config.cliTimeoutMs ?? 120_000);
      const summary = cleanCliOutput(raw);
      if (!summary || summary.length < 10) throw new Error('Generated summary too short');
      return summary;
    } finally {
      try { unlinkSync(tempFile); } catch { /* swallow */ }
    }
  }

  /** Async equivalent of `generateWithGeminiCLI` — same change as above. */
  private async generateWithGeminiCLIAsync(context: string): Promise<string> {
    const prompt = this.buildPrompt(context);
    const tempFile = join(tmpdir(), `gemini-prompt-${Date.now()}.txt`);
    writeFileSync(tempFile, prompt, 'utf-8');
    try {
      const model = (this.config.geminiModel || 'gemini-2.0-flash-exp').replace(/[^a-zA-Z0-9._-]/g, '');
      // Same shell form as the sync path so semantics are identical.
      const shellCmd = `gemini -m ${model} -p "$(cat ${tempFile})"`;
      const raw = await runShellAsync(shellCmd, this.config.cliTimeoutMs ?? 120_000);
      const summary = cleanCliOutput(raw);
      if (!summary || summary.length < 10) throw new Error('Generated summary too short');
      return summary;
    } finally {
      try { unlinkSync(tempFile); } catch { /* swallow */ }
    }
  }

  private buildContext(content: SessionContent): string {
    return buildSummaryContext(content);
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
        // Gemini ignores stdin when `-p` has a value, so pass the prompt
        // as the -p argument via $(cat ...) instead of piping. Previously
        // every summary was a hallucination of Gemini's session memory.
        const result = execSync(
          `gemini -m "${model}" -p "$(cat "${tempFile}")"`,
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
      log.error({ err: error }, 'Gemini CLI error');
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

  /**
   * OpenAI-compatible `/chat/completions` provider. One implementation serves
   * `openai-compat` (any base URL — OpenRouter, Groq, Together, …),
   * `ollama-cloud`, `openai`, and `nvidia` — they differ only in default base
   * URL + which key. Key/base/model come from config (settings → env).
   */
  private async generateWithOpenAICompatible(context: string): Promise<string> {
    const baseUrl = (this.config.apiBaseUrl || '').replace(/\/+$/, '');
    const model = this.config.apiModel;
    const apiKey = this.config.apiKey;
    if (!baseUrl) throw new Error(`Provider '${this.config.provider}' needs a base URL (settings → summary apiBaseUrl / SUMMARY_API_BASE_URL)`);
    if (!model) throw new Error(`Provider '${this.config.provider}' needs a model (settings → summary apiModel / SUMMARY_API_MODEL)`);
    // `openai-compat` targets SELF-HOSTED endpoints (OVMS, vLLM, llama.cpp, local
    // gateways) that usually need NO auth — mirror the embedder (OpenAICompatible
    // Embedder only sends a Bearer when a key exists). Hosted providers
    // (ollama-cloud / openai / nvidia) still require one. Requiring a key for
    // openai-compat is what silently failed EVERY cluster summary pre-flight
    // (internal OVMS needs no key) — the entire backlog errored before any call.
    const keyRequired = this.config.provider !== 'openai-compat';
    if (keyRequired && !apiKey) throw new Error(`Provider '${this.config.provider}' needs an API key (settings → summary apiKey / SUMMARY_API_KEY)`);

    const prompt = this.buildPrompt(context);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.cliTimeoutMs ?? 120_000);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          // When pointed at axon, declare the call-type so axon resolves the
          // admin-assigned model (Call routing page). Deploy sets
          // SUMMARY_AXON_SOURCE=chat-recall.summary; unset = plain openai-compat.
          ...(process.env.SUMMARY_AXON_SOURCE ? { 'x-axon-source': process.env.SUMMARY_AXON_SOURCE } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          // Output cap. A summary is short (~hundreds of tokens), so 1024 is
          // ample. The old 4000 broke small-context self-hosted models: OVMS
          // Phi-4-mini has a 4096 ctx, and `prompt_tokens + max_tokens` must fit
          // it — 4000 left only 96 for the prompt, so EVERY summary 400'd
          // ("exceeds model max length: 4096"). Env-overridable for reasoning
          // models (deepseek-r1 etc.) that burn budget on hidden reasoning_content.
          max_tokens: Math.max(64, Number(process.env.SUMMARY_MAX_TOKENS) || 1024),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${this.config.provider} API error: ${response.status} ${response.statusText} ${body.slice(0, 200)}`);
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text || text.length < 10) throw new Error(`${this.config.provider} returned empty summary`);
      return text;
    } finally {
      clearTimeout(timer);
    }
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

The conversation below runs from the start of the session to its end, in order. A line in square brackets marks messages left out between two shown ones. The last messages show where the session stopped.

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
        log.error({ err: error, sessionId }, 'Failed to generate summary');
        results.set(sessionId, content.firstPrompt.slice(0, 200));
      }
    }

    return results;
  }
}

/** Characters of conversation one summary request carries. */
export const SUMMARY_CONTEXT_CHARS =
  Math.max(2000, Number(process.env.SUMMARY_CONTEXT_CHARS) || 16000);

const USER_MESSAGE_CHARS = 600;
const ASSISTANT_MESSAGE_CHARS = 400;
/** Messages always shown at each end: how the session began, and where it stopped. */
const HEAD_MESSAGES = 3;
const TAIL_MESSAGES = 8;

/**
 * The conversation text the summary model reads.
 *
 * This read the first 5 user and the first 5 assistant messages. A Hermes
 * session of 262 messages over 346 minutes was summarised from its first 15
 * minutes, and the summary said the session "was cut off" while starting a UI.
 *
 * Now every message is a candidate, in order, within `budget` characters. A
 * session that fits is sent whole. A larger one keeps its first and last
 * messages, then the person's messages, then the assistant's, each spread
 * evenly over the session, and marks each gap with the count it leaves out.
 */
export function buildSummaryContext(content: SessionContent, budget: number = SUMMARY_CONTEXT_CHARS): string {
  const parts: string[] = [];
  if (content.firstPrompt) parts.push(`User's initial request:\n${content.firstPrompt.slice(0, 1000)}`);
  if (content.toolsUsed.size > 0) parts.push(`Tools used: ${Array.from(content.toolsUsed).join(', ')}`);

  const messages = [
    ...content.userMessages.map((m) => ({ line: m.lineNumber, text: `User: ${clip(m.text, USER_MESSAGE_CHARS)}`, user: true })),
    ...content.assistantMessages.map((m) => ({ line: m.lineNumber, text: `Assistant: ${clip(m.text, ASSISTANT_MESSAGE_CHARS)}`, user: false })),
  ].sort((a, b) => a.line - b.line);
  if (messages.length === 0) return parts.join('\n\n');

  const cost = (i: number) => messages[i].text.length + 2;
  const chosen = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    if (chosen.has(i) || used + cost(i) > budget) return;
    chosen.add(i);
    used += cost(i);
  };
  const all = messages.map((_, i) => i);
  for (const i of [...all.slice(0, HEAD_MESSAGES), ...all.slice(-TAIL_MESSAGES)]) take(i);
  for (const i of spreadOrder(all.filter((i) => messages[i].user))) take(i);
  for (const i of spreadOrder(all.filter((i) => !messages[i].user))) take(i);

  const lines: string[] = [];
  let skipped = 0;
  for (const i of all) {
    if (!chosen.has(i)) { skipped++; continue; }
    if (skipped > 0) lines.push(`[${skipped} message${skipped === 1 ? '' : 's'} left out]`);
    skipped = 0;
    lines.push(messages[i].text);
  }
  if (skipped > 0) lines.push(`[${skipped} message${skipped === 1 ? '' : 's'} left out]`);
  parts.push(`Conversation (${messages.length} messages):\n${lines.join('\n\n')}`);
  return parts.join('\n\n');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * `items` reordered so that every prefix is spread over the whole range: the
 * ends first, then the middle, then the middles of each half, and so on. Taking
 * items in this order until a budget runs out samples the session evenly.
 */
export function spreadOrder<T>(items: T[]): T[] {
  if (items.length <= 2) return items.slice();
  const out: T[] = [items[0], items[items.length - 1]];
  let ranges: Array<[number, number]> = [[0, items.length - 1]];
  while (ranges.length > 0) {
    const next: Array<[number, number]> = [];
    for (const [lo, hi] of ranges) {
      if (hi - lo < 2) continue;
      const mid = (lo + hi) >> 1;
      out.push(items[mid]);
      next.push([lo, mid], [mid, hi]);
    }
    ranges = next;
  }
  return out;
}
