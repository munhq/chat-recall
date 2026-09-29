/**
 * The handshake carries instructions, so a model that never loads the skill
 * still reads how to reach a message in a past session.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { createMcpServer } from './tools.js';

describe('server instructions', () => {
  test('a connecting client receives them', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(clientSide);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
    await server.close();
  });

  test('every tool and parameter they name exists', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tools.ts'), 'utf-8');
    for (const tool of SERVER_INSTRUCTIONS.match(/recall_[a-z_]+/g)!.filter((t) => t !== 'recall_')) {
      expect(src, tool).toContain(`name: '${tool}'`);
    }
    for (const param of ['query', 'around_line', 'from_end', 'expand_line']) {
      expect(src, param).toMatch(new RegExp(`\\b${param}:\\s+\\{ type:`));
    }
  });
});
