import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inputSchemaOf } from './input-schema.js';
import { createMcpServer } from './tools.js';

describe('inputSchemaOf', () => {
  const schema = z.object({
    name: z.string().min(1).describe('The name.'),
    count: z.number().int().optional().default(5).describe('How many.'),
    kind: z.enum(['ask', 'fyi']).optional(),
    note: z.string().nullable().optional(),
  });

  test('describes the arguments of the zod object, with its required list and descriptions', () => {
    const json = inputSchemaOf(schema);
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties!).sort()).toEqual(['count', 'kind', 'name', 'note']);
    expect(json.required).toEqual(['name']);
    expect((json.properties as any).name.description).toBe('The name.');
    expect((json.properties as any).kind.enum).toEqual(['ask', 'fyi']);
  });

  test('leaves out $schema, the definitions table and additionalProperties, which some clients refuse', () => {
    const json = inputSchemaOf(schema);
    expect(json).not.toHaveProperty('$schema');
    expect(json).not.toHaveProperty('definitions');
    expect(json).not.toHaveProperty('additionalProperties');
  });

  test('refuses a schema that is not an object', () => {
    expect(() => inputSchemaOf(z.string())).toThrow(/zod object/);
  });
});

describe('the tool list a client receives', () => {
  let tools: Array<{ name: string; inputSchema: { type: string; properties?: Record<string, any>; required?: string[] } & Record<string, unknown> }> = [];
  const saved = process.env.CHAT_RECALL_MCP_PROFILE;

  beforeAll(async () => {
    process.env.CHAT_RECALL_MCP_PROFILE = 'full';
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'input-schema-test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    tools = (await client.listTools()).tools as typeof tools;
    await client.close();
  });
  afterAll(() => { process.env.CHAT_RECALL_MCP_PROFILE = saved; });

  test('lists the tools, each with an object schema and no $schema key', () => {
    expect(tools.length).toBeGreaterThan(60);
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.inputSchema, t.name).not.toHaveProperty('$schema');
    }
  });

  test('recall_message_send advertises the kind, the topic, the interrupt flag and the reply', () => {
    const send = tools.find((t) => t.name === 'recall_message_send')!;
    const props = send.inputSchema.properties!;
    for (const key of ['from', 'to', 'body', 'reply_to', 'kind', 'topic', 'interrupt', 'expect_cwd']) expect(props, key).toHaveProperty(key);
    expect(props.kind.enum).toEqual(['ask', 'report', 'blocked', 'handoff', 'fyi']);
    expect(send.inputSchema.required).toEqual(['to', 'body']);
  });

  test('an argument that the server accepts but nobody advertised before is advertised now', () => {
    const has = (tool: string, arg: string) => tools.find((t) => t.name === tool)!.inputSchema.properties![arg] !== undefined;
    expect(has('recall_context', 'include_turns')).toBe(true);
    expect(has('recall_user_prompts', 'with_markers')).toBe(true);
    expect(has('recall_decision_record', 'workspace')).toBe(true);
  });

  test('an argument that no handler reads is no longer advertised', () => {
    const has = (tool: string, arg: string) => tools.find((t) => t.name === tool)!.inputSchema.properties![arg] !== undefined;
    expect(has('recall_search', 'skip_ranking')).toBe(false);
    expect(has('recall_index', 'provider')).toBe(false);
  });
});
