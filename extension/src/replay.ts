import type { AuthorId, MutationLog } from "./capture";

export interface LiveChar {
  charId: number;
  authorId: AuthorId | null;
  char: string | null;
}

export interface DeletionEvent {
  actor: AuthorId;
  target: AuthorId | null;
  charId: number | null;
  timestamp: number;
  position: number;
}

export interface ReplayResult {
  originByPosition: LiveChar[];
  deletionLog: DeletionEvent[];
}

/** Pads the live character sequence with unknown-origin slots up to `length`,
 *  for positions referenced by an op before any insert there was observed. */
function padToLength(live: LiveChar[], length: number, nextCharId: () => number): void {
  while (live.length < length) {
    live.push({ charId: nextCharId(), authorId: null, char: null });
  }
}

/** Largest run of characters spread into one splice call. V8 throws RangeError past
 *  roughly 125k spread arguments, so a single large paste would otherwise crash the
 *  whole replay — C4 means the pipeline has to survive whatever the doc's history holds. */
const MAX_SPLICE_ARGS = 32768;

/** Inserts a run of characters at a position, in chunks small enough that the spread
 *  never exceeds the engine's argument limit. Sequential chunks keep insertion order. */
function spliceInsert(live: LiveChar[], position: number, inserted: LiveChar[]): void {
  if (inserted.length <= MAX_SPLICE_ARGS) {
    live.splice(position, 0, ...inserted);
    return;
  }
  for (let offset = 0; offset < inserted.length; offset += MAX_SPLICE_ARGS) {
    live.splice(position + offset, 0, ...inserted.slice(offset, offset + MAX_SPLICE_ARGS));
  }
}

/** Deterministically replays an ordered mutation log from an empty document,
 *  minting per-character origin-author IDs and logging every deletion as actor→target. */
export function replay(ops: MutationLog): ReplayResult {
  const live: LiveChar[] = [];
  const deletionLog: DeletionEvent[] = [];
  let counter = 0;
  const nextCharId = () => counter++;

  for (const op of ops) {
    if (op.type === "insert") {
      padToLength(live, op.position, nextCharId);
      const inserted: LiveChar[] = op.text.split("").map((char) => ({
        charId: nextCharId(),
        authorId: op.authorId,
        char,
      }));
      spliceInsert(live, op.position, inserted);
    } else {
      padToLength(live, op.range.end, nextCharId);
      const removed = live.splice(op.range.start, op.range.end - op.range.start);
      removed.forEach((char, offset) => {
        deletionLog.push({
          actor: op.authorId,
          target: char.authorId,
          charId: char.charId,
          timestamp: op.timestamp,
          position: op.range.start + offset,
        });
      });
    }
  }

  return { originByPosition: live, deletionLog };
}

/** Counts surviving characters per origin-author over the final character
 *  sequence; the null key aggregates unknown-origin characters. */
export function survivingCharacterMap(originByPosition: LiveChar[]): Map<AuthorId | null, number> {
  const counts = new Map<AuthorId | null, number>();
  for (const char of originByPosition) {
    counts.set(char.authorId, (counts.get(char.authorId) ?? 0) + 1);
  }
  return counts;
}

/** Aggregates the deletion log into an actor → origin-author → deleted-count
 *  matrix (whose characters each actor deleted, and how many). */
export function deletionOverwriteMap(deletionLog: DeletionEvent[]): Map<AuthorId, Map<AuthorId | null, number>> {
  const matrix = new Map<AuthorId, Map<AuthorId | null, number>>();
  for (const event of deletionLog) {
    let targets = matrix.get(event.actor);
    if (!targets) {
      targets = new Map<AuthorId | null, number>();
      matrix.set(event.actor, targets);
    }
    targets.set(event.target, (targets.get(event.target) ?? 0) + 1);
  }
  return matrix;
}
