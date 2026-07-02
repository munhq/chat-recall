/**
 * Tenant-scoped in-process TTL cache.
 *
 * Every module-level response cache in a multi-tenant server MUST go through
 * this (or key by `currentTenant()` itself). A plain module-level
 * `let cache = …` predates multi-tenancy and serves the first caller's data
 * to every other tenant for the TTL window — a cross-tenant leak. This class
 * prefixes every key with the request's ambient tenant (AsyncLocalStorage,
 * set by the auth middleware via runWithTenant), so entries can never cross
 * tenants no matter what the caller uses as a key.
 */
import { currentTenant } from '@chat-recall/engine/core/store/tenant-context.js';

const SEP = '\u0000'; // NUL can't appear in a tenant slug or a sane cache key.

export class TenantTtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    /** Cap across ALL tenants; oldest-inserted entries evict first. */
    private readonly maxEntries = 256,
  ) {}

  private scopedKey(key: string): string {
    return `${currentTenant() ?? 'default'}${SEP}${key}`;
  }

  get(key = ''): T | undefined {
    const k = this.scopedKey(key);
    const hit = this.entries.get(k);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(k);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void;
  set(value: T): void;
  set(keyOrValue: string | T, maybeValue?: T): void {
    const key = arguments.length === 2 ? (keyOrValue as string) : '';
    const value = arguments.length === 2 ? (maybeValue as T) : (keyOrValue as T);
    const k = this.scopedKey(key);
    this.entries.set(k, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Drop every entry (all tenants). For tests and post-write invalidation. */
  clear(): void {
    this.entries.clear();
  }
}
