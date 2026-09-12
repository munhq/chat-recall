/**
 * Date handling for the temporal knowledge graph.
 *
 * Its own module because both KG drivers need it and one of them must not
 * import the other: knowledge-graph.ts pulls in better-sqlite3, so the
 * Postgres driver reached these helpers through a dynamic import and could not
 * use them outside an async method. Nothing here has a dependency.
 */

/**
 * Normalize a KG date to date-only `YYYY-MM-DD`. Facts are day-granular, and
 * storing a mix of full ISO timestamps and date-only strings broke lexical
 * comparison (`'2026-01-01T10:00Z' <= '2026-01-01'` is false), so `as_of`
 * queries silently dropped facts. Canonical date-only makes string compare
 * chronological again.
 */
export function normalizeKgDate(d?: string | null): string | null {
  if (!d) return null;
  const m = d.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : d;
}

/** Today as the day-granular `YYYY-MM-DD` the KG stores. */
export function kgToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The `valid_from` a triple is stored with.
 *
 * An asserted fact gets today when the caller names no date. Somebody recorded
 * it now, so now is when it starts being true, and the register can say when.
 * Every decision written through `/api/decisions` and `/api/kg/add` came back
 * with `since: null`, because neither route passes `validFrom` and a null was
 * stored verbatim. A null also sorts last, so the history of a superseded area
 * came back in arbitrary order.
 *
 * An extracted fact keeps the null. The extractor reads old transcripts, and
 * the index date is not the date the fact became true — it passes the source's
 * own date when it has one.
 */
export function resolveValidFrom(validFrom?: string | null, origin?: string): string | null {
  return normalizeKgDate(validFrom) ?? (origin === 'asserted' ? kgToday() : null);
}

/**
 * The day a stored row was written, from its `extracted_at`. Accepts the TEXT
 * both stores hold and the Date a driver may hand back.
 */
export function kgDay(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? normalizeKgDate(v) : null;
}
