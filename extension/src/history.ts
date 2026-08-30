import { commandToOps, type AuthorId, type MutationOp } from "./capture";

export interface HistoryError extends Error {
  reason: "fetch-failed" | "unparseable-response";
}

/** Constructs a typed HistoryError carrying a machine-readable reason code
 *  alongside the human-readable message. */
export function historyError(reason: HistoryError["reason"], message: string): HistoryError {
  const err = new Error(message) as HistoryError;
  err.reason = reason;
  return err;
}

const REVISIONS_PER_PAGE = 1000;

/** Builds the revisions/load URL for one page of a doc's changelog.
 *  This endpoint needs only session cookies, no token. */
export function revisionLoadUrl(docId: string, start: number, end: number): string {
  return `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=${start}&end=${end}`;
}

/** Probes whether a revision number exists for this doc: a non-ok response
 *  from revisions/load means the number is past the doc's ceiling. */
async function revisionExists(docId: string, rev: number, fetchImpl: typeof fetch): Promise<boolean> {
  const res = await fetchImpl(revisionLoadUrl(docId, rev, rev), { credentials: "include" });
  return res.ok;
}

/** Finds the doc's highest revision number by doubling an upper bound until a
 *  probe fails, then binary-searching the gap. */
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

const XSSI_PREFIX = ")]}'";

/** Strips Google's anti-JSON-hijacking `)]}'` prefix from a raw response body,
 *  shared by the revisions/load and revisions/tiles parsers. */
export function stripXssiPrefix(raw: string): string {
  const trimmed = raw.trimStart();
  return trimmed.startsWith(XSSI_PREFIX) ? trimmed.slice(XSSI_PREFIX.length) : trimmed;
}

export type RevisionUserMap = Record<AuthorId, string>;

interface RevisionLoadBody {
  changelog?: unknown[];
  userMap?: unknown;
  users?: unknown;
  authorMap?: unknown;
  userInfo?: unknown;
}

/** Parses one changelog entry, shaped [command, timestamp, authorId, ...],
 *  into zero or more ops. */
function parseChangelogEntry(entry: unknown): MutationOp[] {
  if (!Array.isArray(entry) || entry.length < 3) return [];
  const [command, timestamp, authorId] = entry as [unknown, number, AuthorId, ...unknown[]];
  return commandToOps(command, authorId, timestamp);
}

/** Best-effort extraction of an authorId-to-name map from a revisions/load
 *  body; returns an empty object when no such field is present. */
export function parseUserMapFromBody(body: RevisionLoadBody): RevisionUserMap {
  const raw = body.userMap ?? body.users ?? body.authorMap ?? body.userInfo;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const result: RevisionUserMap = {};
  for (const [id, info] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof info === "string") {
      result[id] = info;
    } else if (info && typeof info === "object") {
      const obj = info as Record<string, unknown>;
      const name = obj["name"] ?? obj["displayName"] ?? obj["email"] ?? obj["emailAddress"];
      if (typeof name === "string" && name.length > 0) result[id] = name;
    }
  }
  return result;
}

/** Parses one revisions/load response into ops plus any embedded name map,
 *  throwing on unparseable JSON or a missing changelog array. */
export function parseRevisionLoadResponseWithNames(raw: string): { ops: MutationOp[]; names: RevisionUserMap } {
  if (raw.length === 0) return { ops: [], names: {} };

  let body: RevisionLoadBody;
  try {
    body = JSON.parse(stripXssiPrefix(raw)) as RevisionLoadBody;
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/load response was not valid JSON after stripping the XSSI prefix — the envelope may have changed."
    );
  }

  if (!Array.isArray(body.changelog)) {
    throw historyError(
      "unparseable-response",
      "revisions/load response had no 'changelog' array — the envelope may have changed."
    );
  }

  const ops = body.changelog.flatMap(parseChangelogEntry);
  const names = parseUserMapFromBody(body);
  return { ops, names };
}

/** Parses one revisions/load response and returns only the ops.
 *  Convenience wrapper over parseRevisionLoadResponseWithNames. */
export function parseRevisionLoadResponse(raw: string): MutationOp[] {
  return parseRevisionLoadResponseWithNames(raw).ops;
}

/** Fetches the complete mutation log from the doc's first revision, paging in
 *  fixed chunks, so callers can REPLACE any partial live-captured ops with it. */
export async function fetchFullHistory(
  docId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ops: MutationOp[]; names: RevisionUserMap }> {
  const maxRev = await findMaxRevision(docId, fetchImpl);
  const ops: MutationOp[] = [];
  const names: RevisionUserMap = {};
  for (let start = 1; start <= maxRev; start += REVISIONS_PER_PAGE) {
    const end = Math.min(start + REVISIONS_PER_PAGE - 1, maxRev);
    const res = await fetchImpl(revisionLoadUrl(docId, start, end), { credentials: "include" });
    if (!res.ok) {
      throw historyError("fetch-failed", `revisions/load returned ${res.status} for range [${start}, ${end}]`);
    }
    const page = parseRevisionLoadResponseWithNames(await res.text());
    // Appended in a loop, not spread: one page can carry more ops than the engine's
    // argument limit allows push(...) to take.
    for (const op of page.ops) ops.push(op);
    Object.assign(names, page.names);
  }
  return { ops, names };
}
