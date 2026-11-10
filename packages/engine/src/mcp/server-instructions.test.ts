/**
 * The handshake carries instructions, so a model that never loads the skill
 * still reads how to reach a message in a past session.
 */
import { describe, test, expect } from 'vitest';
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

  test('every tool and parameter they name exists', async () => {
    // The list a client receives, not the source text: the schemas are made from the zod schemas.
    const saved = process.env.CHAT_RECALL_MCP_PROFILE;
    process.env.CHAT_RECALL_MCP_PROFILE = 'full';
    try {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer();
      await server.connect(serverSide);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(clientSide);
      const tools = (await client.listTools()).tools;
      const names = new Set(tools.map((t) => t.name));
      for (const tool of SERVER_INSTRUCTIONS.match(/recall_[a-z_]+/g)!.filter((t) => t !== 'recall_')) {
        expect(names.has(tool), tool).toBe(true);
      }
      const show = tools.find((t) => t.name === 'recall_show')!;
      for (const param of ['query', 'around_line', 'from_end', 'expand_line']) {
        expect(show.inputSchema.properties, param).toHaveProperty(param);
      }
      await client.close();
      await server.close();
    } finally {
      process.env.CHAT_RECALL_MCP_PROFILE = saved;
    }
  });
});
