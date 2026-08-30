import type { AuthorId } from "./capture";
import { historyError, stripXssiPrefix } from "./history";

export interface TileUserInfo {
  name?: string;
  attributionType?: number;
  anonymous?: boolean;
}

export interface TilesResponseBody {
  tileInfo?: Array<{ users?: string[] }>;
  userMap?: Record<string, TileUserInfo>;
}

export interface TileNames {
  names: Record<AuthorId, string>;
  anonymousIds: AuthorId[];
}

/** Returns an empty TileNames accumulator for parsing and merging tile
 *  responses. */
function emptyTileNames(): TileNames {
  return { names: {}, anonymousIds: [] };
}

/** Parses one revisions/tiles response into name and anonymous-id maps, keyed by
 *  the SAME changelog authorId namespace the mutation log uses. */
export function parseTilesResponse(raw: string): TileNames {
  const out = emptyTileNames();
  if (raw.length === 0) return out;

  let body: TilesResponseBody;
  try {
    body = JSON.parse(stripXssiPrefix(raw)) as TilesResponseBody;
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/tiles response was not valid JSON after stripping the XSSI prefix — the envelope may have changed."
    );
  }

  const userMap = body.userMap;
  if (!userMap || typeof userMap !== "object") return out;

  const anonymous = new Set<AuthorId>();
  for (const [id, info] of Object.entries(userMap)) {
    if (!info || typeof info !== "object") continue;
    const name = typeof info.name === "string" ? info.name.trim() : "";
    if (info.anonymous === true || info.attributionType === 0 || name.length === 0) {
      anonymous.add(id);
    } else {
      out.names[id] = name;
    }
  }
  out.anonymousIds = Array.from(anonymous);
  return out;
}

/** Merges a freshly fetched name map over the stored one under a single rule: a real
 *  name from ANY source wins, and the anonymous marker (null) survives only when nothing
 *  named that author. Without this, a tiles response marking an author anonymous would
 *  outrank the authoritative name from the changelog, and C2 would silently drop that
 *  student from the assessment as if they were the grader. */
export function mergeNameSources(
  stored: Record<AuthorId, string | null>,
  fetched: Record<AuthorId, string | null>
): Record<AuthorId, string | null> {
  const merged: Record<AuthorId, string | null> = {};
  for (const source of [stored, fetched]) {
    for (const [id, name] of Object.entries(source)) {
      if (name !== null && name !== undefined) merged[id] = name;
      else if (!(id in merged)) merged[id] = null;
    }
  }
  return merged;
}

/** Merges several parsed tile responses into one map set; an author stays
 *  anonymous only if no tile anywhere named them. */
export function mergeTileNames(parts: TileNames[]): TileNames {
  const merged = emptyTileNames();
  const anonymous = new Set<AuthorId>();
  for (const part of parts) {
    Object.assign(merged.names, part.names);
    for (const id of part.anonymousIds) anonymous.add(id);
  }
  merged.anonymousIds = Array.from(anonymous).filter((id) => !(id in merged.names));
  return merged;
}
