#!/usr/bin/env tsx
import { SummaryGenerator } from '../src/core/summary-generator.js';
import type { SessionContent } from '../src/parsers/session.js';

const preset = process.argv[2] || 'opencode';
process.env.SUMMARY_CLI_PRESET = preset;

const content: SessionContent = {
  sessionPath: '',
  summaries: [],
  userMessages: [
    { text: 'Refactor the parser to handle Windows line endings cleanly.', lineNumber: 0, contentType: 'user' as any },
    { text: 'Add a test covering CRLF input.', lineNumber: 0, contentType: 'user' as any },
  ],
  assistantMessages: [
    { text: 'Replaced \\r\\n normalisation in parse(); added parser.crlf.test.ts covering mixed line endings.', lineNumber: 0, contentType: 'assistant' as any },
  ],
  toolResults: [],
  toolsUsed: new Set<string>(['Edit', 'Bash']),
  firstPrompt: 'Refactor the parser to handle Windows line endings cleanly.',
  metadata: {} as any,
};

const gen = new SummaryGenerator({ provider: 'cli' });
console.log(`using preset: ${preset}`);
const t0 = Date.now();
const summary = await gen.generate(content);
console.log(`(${Date.now() - t0} ms)`);
console.log('----');
console.log(summary);
