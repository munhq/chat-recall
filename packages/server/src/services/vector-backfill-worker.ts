/**
 * Server-side vector backfill — the permanent mechanism that embeds chunks
 * which exist in FTS (`memory_chunks`) but have no row in `memory_vectors`.
 *
 * This backlog appears whenever embeddings weren't being produced for a while
 * (embedder off, model just switched on, a missed batch). New ingests embed on
 * the fly; THIS worker catches up everything else — across ALL tenants — so
 * semantic search becomes complete on its own. No one-off scripts.
 *
 * Gated by EMBEDDING_PROVIDER (mirrors the summary worker's SUMMARY_PROVIDER
 * gate): unset/`none` ⇒ no-op. Each tenant is drained in `batch`-sized embeds
 * up to `perTenantCap` per sweep so one tick stays bounded; the next tick
 * continues where it left off.
 */

import { createControlPlane, createVectorStore, getEmbedder } from '../imports.js';
import type { EmbedderProvider } from '../imports.js';

/** True when an embedder is configured (so vectors can actually be produced). */
export function serverEmbedderConfigured(): boolean {
  const p = (process.env.EMBEDDING_PROVIDER || '').trim();
  return p.length > 0 && p !== 'none';
}

export interface BackfillResult {
  embedded: number;
  tenants: number;
}

export interface BackfillOptions {
  /** Chunks embedded per round-trip (the embedder batches internally too). */
  batch?: number;
  /** Max chunks embedded per tenant per sweep — bounds one tick's work. */
  perTenantCap?: number;
}

export async function embedMissingVectors(opts: BackfillOptions = {}): Promise<BackfillResult> {
  if (!serverEmbedderConfigured()) return { embedded: 0, tenants: 0 };

  const batch = Math.max(1, opts.batch ?? 256);
  const perTenantCap = Math.max(batch, opts.perTenantCap ?? 5000);
  const embedder = getEmbedder(process.env.EMBEDDING_PROVIDER as EmbedderProvider);

  // Enumerate tenants from the control-plane registry (RLS hides other tenants
  // from a scoped query, so we can't just SELECT DISTINCT under one context).
  const cp = await createControlPlane();
  let tenants: string[] = [];
  try { tenants = await cp.listTenants(); } catch { /* fall through to default */ }
  if (tenants.length === 0) tenants = [process.env.CHAT_RECALL_TENANT || 'default'];

  let embedded = 0;
  let touched = 0;
  for (const tenant of tenants) {
    try {
      // createVectorStore is async and init()s the store internally — await it
      // (don't call init() again). embedMissing lives on the pg vector store.
      const vs = await createVectorStore(embedder, { tenant }) as unknown as {
        embedMissing(limit: number): Promise<{ embedded: number; scanned: number }>;
      };
      let perTenant = 0;
      while (perTenant < perTenantCap) {
        const r = await vs.embedMissing(batch);
        embedded += r.embedded;
        perTenant += r.embedded;
        if (r.scanned < batch) break; // no more missing for this tenant
      }
      if (perTenant > 0) touched++;
    } catch {
      // One bad tenant must never abort the whole sweep — continue.
      continue;
    }
  }
  return { embedded, tenants: touched };
}
