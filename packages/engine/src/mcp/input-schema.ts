/**
 * The JSON schema of a tool's arguments, made from the zod schema that parses them.
 *
 * A client reads this schema from the tool list to learn which arguments exist.
 * It was once written by hand beside the zod schema, and the two drifted: an
 * argument that the server accepted was missing from the list, so no client sent it.
 * One source cannot drift.
 */
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type InputSchema = { type: 'object'; properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;

/**
 * `schema` as the `inputSchema` of an MCP tool.
 *
 * `$schema` and the definitions table are left out: some clients reject them.
 * `additionalProperties` is left out at the top: the zod object ignores an
 * argument it does not know, and a client that sends one must not be refused.
 */
export function inputSchemaOf(schema: ZodTypeAny): InputSchema {
  // The typed signature of zodToJsonSchema recurses without end on a generic zod type; the call is plain.
  const convert = zodToJsonSchema as unknown as (s: unknown, o: Record<string, unknown>) => Record<string, unknown>;
  const json = convert(schema, { target: 'jsonSchema7', $refStrategy: 'none', effectStrategy: 'input' });
  const { $schema: _s, definitions: _d, additionalProperties: _a, ...rest } = json;
  if (rest.type !== 'object') throw new Error('inputSchemaOf needs a zod object');
  return rest as InputSchema;
}
