/**
 * The metadata response must carry the project path.
 *
 * This file exists because of a shipped defect found by using the product:
 * `recall_smart_resume` answered "**Project:** (unknown)" for a session that
 * had a perfectly good project path, and the assistant on top of it then told
 * the user it "did not have the repository path exposed in the resume summary"
 * and suggested resuming from a CLI instead. Nothing was broken in the resume
 * tool; the endpoint it reads simply never returned the field.
 *
 * The cause is a split source of truth. `computeMetadataResponse` builds the
 * response from `extra_json`, and the project path is not in `extra_json` — it
 * is a COLUMN on the memory_metadata row. Five other readers in sessions.ts
 * already read `item.project_path`; `getSessionMetadata` did not, so it was the
 * one path that answered without it.
 *
 * Asserted against the SOURCE rather than by calling the function, for the same
 * reason route-manifest.test.ts and skills-catalog.test.ts do: reaching
 * getSessionMetadata needs a live store and a metadata cache, while the rule
 * worth protecting is one line — the response gets project_path attached from
 * the row. A refactor that rebuilds the response and forgets it again fails
 * here, with no database required.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'sessions.ts'), 'utf-8');

/** The body of getSessionMetadata, up to the next top-level export. */
function getSessionMetadataBody(): string {
  const start = SRC.indexOf('export async function getSessionMetadata');
  expect(start, 'getSessionMetadata has been renamed — update this test').toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  return end === -1 ? rest : rest.slice(0, end);
}

describe('session metadata carries the project path', () => {
  test('the response type declares projectPath', () => {
    const iface = SRC.slice(
      SRC.indexOf('export interface SessionMetadataResponse'),
      SRC.indexOf('export interface SessionMetadataResponse') + 2000,
    );
    expect(iface).toMatch(/projectPath\?:\s*string/);
  });

  test('getSessionMetadata attaches project_path from the row', () => {
    // The field is NOT in extra_json, so the only way it can reach the response
    // is an explicit assignment from the store item.
    expect(getSessionMetadataBody()).toMatch(/response\.projectPath\s*=\s*meta\.project_path/);
  });

  test('it is read from the row, not from extra_json', () => {
    // A future "fix" that pulls it out of extra.projectPath would pass the test
    // above while still answering (unknown) for every session, because the
    // producer does not put the path there.
    const body = getSessionMetadataBody();
    expect(body).not.toMatch(/response\.projectPath\s*=\s*extra\./);
  });

  test('recall_smart_resume still reads the field this endpoint sets', () => {
    // The two halves are in different packages; if the tool stops reading
    // projectPath, attaching it here becomes dead code and the dossier goes
    // back to saying (unknown) with nothing failing.
    const tools = readFileSync(
      join(here, '..', '..', '..', 'engine', 'src', 'mcp', 'tools.ts'), 'utf-8');
    expect(tools).toMatch(/meta\.project_path\s*\?\?\s*meta\.projectPath/);
  });
});
