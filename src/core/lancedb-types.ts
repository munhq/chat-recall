/**
 * Type definitions for the LanceDB table API.
 *
 * LanceDB's TypeScript types are incomplete, so we define
 * the interface we use here and cast once at connection time.
 */

export interface LanceTable {
  add(records: Record<string, unknown>[]): Promise<void>;
  delete(filter: string): Promise<void>;
  search(vector: number[]): LanceQuery;
  toArrow(): Promise<ArrowTable>;
  optimize(options?: {
    cleanupOlderThan?: Date;
    deleteUnverified?: boolean;
  }): Promise<OptimizeStats>;
  countRows(): Promise<number>;
}

export interface LanceQuery {
  limit(n: number): LanceQuery;
  where?(filter: string): LanceQuery;
  toArray(): Promise<Record<string, unknown>[]>;
}

export interface ArrowTable {
  toArray(): Record<string, unknown>[];
}

export interface OptimizeStats {
  compaction: { fragmentsRemoved: number; filesAdded: number };
  prune: { bytesRemoved: number; oldVersionsRemoved: number };
}
