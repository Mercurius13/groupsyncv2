import type { AuthorId, MutationOp } from "../types/mutation";
import { commandToOps } from "./index";

/**
 * RETROACTIVE HISTORY FETCH — fixes the C4 gap in HANDOVER.md: index.ts's
 * capture only sees traffic from whenever the tab happened to be open, which
 * is a partial (and per C4, corrupt) history. This module fetches the
 * complete mutation log from document creation on demand, the way Docs' own
 * "Version history" menu does, so a professor can analyze a doc the
 * extension never watched live.
 *
 * CONFIRMED against a real captured response (2026-06-XX, see ME.MD) —
 * fully validated, not an assumption anymore:
 *   - Endpoint: GET .../document/d/<id>/revisions/load?id=<id>&start=<n>&end=<n>.
 *   - Body starts with the `)]}'` XSSI-protection prefix Google uses on
 *     several internal JSON endpoints; stripped before JSON.parse.
 *   - The remainder is ONE JSON object with two top-level fields:
 *     `chunkedSnapshot` and `changelog`.
 *   - `changelog` is the one we need: an array of entries shaped EXACTLY
 *     like the bind channel's PushChangeEntry —
 *     `[command, timestamp, authorId, rev, sessionId, ...]` — using the same
 *     is/ds/mlti command vocabulary. Confirmed character-for-character
 *     against a real response.
 *   - `chunkedSnapshot` is a flat list of raw command objects (including
 *     style/structure ops like "as"/"ae" with no per-command author or
 *     timestamp) — this looks like Google's own content+style
 *     reconstruction data for fast-rendering a revision in their UI, NOT an
 *     attributed changelog. Deliberately ignored here.
 *   - The growth-then-binary-search technique for finding the doc's
 *     revision ceiling works as documented, EXCEPT the "too high" signal is
 *     HTTP 400, not 500 — doesn't matter since the code only checks
 *     `res.ok`.
 */

export interface HistoryError extends Error {
  reason: "fetch-failed" | "unparseable-response";
}

function historyError(reason: HistoryError["reason"], message: string): HistoryError {
  const err = new Error(message) as HistoryError;
  err.reason = reason;
  return err;
}

/** How many revisions to request per page — kept well under Docs' own range
 *  limit (you cannot request an unbounded range; see module docstring) and
 *  small enough that one slow/failed page doesn't waste a huge refetch. */
const REVISIONS_PER_PAGE = 1000;

export function revisionLoadUrl(docId: string, start: number, end: number): string {
  return `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=${start}&end=${end}`;
}

async function revisionExists(docId: string, rev: number, fetchImpl: typeof fetch): Promise<boolean> {
  const res = await fetchImpl(revisionLoadUrl(docId, rev, rev), { credentials: "include" });
  return res.ok;
}

/** Finds the doc's highest revision number via the documented technique:
 *  grow the upper bound until a request fails (too high), then binary-search
 *  the gap. Revision 1 is assumed to always exist (every doc has one). */
export async function findMaxRevision(docId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  let low = 1;
  let high = 1;
  while (await revisionExists(docId, high, fetchImpl)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await revisionExists(docId, mid, fetchImpl)) low = mid;
    else high = mid;
  }
  return low;
}

/** Google's anti-JSON-hijacking prefix on several internal endpoints —
 *  confirmed present on every real revisions/load response observed. */
const XSSI_PREFIX = ")]}'";

function stripXssiPrefix(raw: string): string {
  const trimmed = raw.trimStart();
  return trimmed.startsWith(XSSI_PREFIX) ? trimmed.slice(XSSI_PREFIX.length) : trimmed;
}

interface RevisionLoadBody {
  changelog?: unknown[];
}

/** Converts one changelog entry into ops — same shape and same parsing as
 *  the bind channel's PushChangeEntry (see module docstring). */
function parseChangelogEntry(entry: unknown): MutationOp[] {
  if (!Array.isArray(entry) || entry.length < 3) return [];
  const [command, timestamp, authorId] = entry as [unknown, number, AuthorId, ...unknown[]];
  return commandToOps(command, authorId, timestamp);
}

/** Parses one .../revisions/load response into ops, reading only the
 *  `changelog` field (see module docstring — `chunkedSnapshot` is
 *  deliberately ignored, it carries no author/timestamp). A response with
 *  no `changelog` array at all, or one that isn't valid JSON once the XSSI
 *  prefix is stripped, throws — that's a structural break, not normal
 *  variation (unlike the bind channel, there's no streaming/truncation
 *  reason to tolerate a partial parse here: this is one complete HTTP
 *  response, not a long-poll chunk that can legitimately be mid-write). */
export function parseRevisionLoadResponse(raw: string): MutationOp[] {
  if (raw.length === 0) return [];

  let body: RevisionLoadBody;
  try {
    body = JSON.parse(stripXssiPrefix(raw)) as RevisionLoadBody;
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/load response was not valid JSON after stripping the XSSI prefix — the envelope may have changed; validate against a real doc before trusting this path."
    );
  }

  if (!Array.isArray(body.changelog)) {
    throw historyError(
      "unparseable-response",
      "revisions/load response had no 'changelog' array — the envelope may have changed; validate against a real doc before trusting this path."
    );
  }

  return body.changelog.flatMap(parseChangelogEntry);
}

/** Fetches and parses the complete mutation log for a doc, oldest revision
 *  first, paginated in REVISIONS_PER_PAGE chunks. This is what background/
 *  index.ts should call to REPLACE (not append to) whatever partial,
 *  live-captured ops it already has for the doc — the retroactive fetch is
 *  the authoritative complete log, per C4. */
export async function fetchFullHistory(docId: string, fetchImpl: typeof fetch = fetch): Promise<MutationOp[]> {
  const maxRev = await findMaxRevision(docId, fetchImpl);
  const ops: MutationOp[] = [];
  for (let start = 1; start <= maxRev; start += REVISIONS_PER_PAGE) {
    const end = Math.min(start + REVISIONS_PER_PAGE - 1, maxRev);
    const res = await fetchImpl(revisionLoadUrl(docId, start, end), { credentials: "include" });
    if (!res.ok) {
      throw historyError("fetch-failed", `revisions/load returned ${res.status} for range [${start}, ${end}]`);
    }
    ops.push(...parseRevisionLoadResponse(await res.text()));
  }
  return ops;
}
