/**
 * The line the sync route logs before it works on a batch (issue #27).
 *
 * A request that kills its pod leaves no log line, because the route logs a
 * request when it ends. On 2026-11-16 the pods were OOM-killed 3 seconds into a
 * `POST /api/sync` and nothing named the request. This line is written first, so
 * the last line of a pod that dies names the batch it was working on.
 */

export interface IngestBatchInput {
  conversations: ReadonlyArray<{
    session_id?: string;
    append?: boolean;
    raw_size?: unknown;
    envelope?: { messages?: unknown } | null;
    raw_b64?: string;
  }>;
  bodyBytes: number;
  tenant: string;
}

export interface IngestBatchSummary {
  tenant: string;
  bodyBytes: number;
  conversations: number;
  appends: number;
  fulls: number;
  largest: Array<{ session: string; mode: 'append' | 'full'; messages: number; rawBytes: number }>;
  memory: { rssMb: number; heapUsedMb: number; externalMb: number; arrayBuffersMb: number };
}

const mb = (n: number): number => Math.round(n / 1048576);

export function summariseIngestBatch(
  input: IngestBatchInput,
  usage: NodeJS.MemoryUsage = process.memoryUsage(),
  top = 5,
): IngestBatchSummary {
  const rows = input.conversations.map((cv) => {
    const messages = Array.isArray(cv.envelope?.messages) ? (cv.envelope!.messages as unknown[]).length : 0;
    const rawBytes = Number(cv.raw_size) || (cv.raw_b64 ? Math.floor(cv.raw_b64.length * 0.75) : 0);
    return { session: String(cv.session_id ?? ''), mode: cv.append ? 'append' as const : 'full' as const, messages, rawBytes };
  });
  const weight = (r: { messages: number; rawBytes: number }): number => r.rawBytes + r.messages;
  return {
    tenant: input.tenant,
    bodyBytes: input.bodyBytes,
    conversations: rows.length,
    appends: rows.filter((r) => r.mode === 'append').length,
    fulls: rows.filter((r) => r.mode === 'full').length,
    largest: [...rows].sort((a, b) => weight(b) - weight(a)).slice(0, top),
    memory: {
      rssMb: mb(usage.rss), heapUsedMb: mb(usage.heapUsed),
      externalMb: mb(usage.external), arrayBuffersMb: mb(usage.arrayBuffers),
    },
  };
}
