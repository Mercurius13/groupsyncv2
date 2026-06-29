import type { AuthorId, MutationLog } from "../types/mutation";

/**
 * Deterministic replay engine (EXTENSION.MD F2). Replays mutations in order
 * starting from an empty document, minting a persistent ID for each
 * inserted character tagged with its origin-author (F2.1/F2.2), and logging
 * every deletion as {actor, target} (F2.3). Produces the two maps F2.4
 * requires: surviving characters by origin-author, and deletion/overwrite
 * activity by actor → target.
 *
 * F2.5 (origin-authorship must survive reformats/moves/pastes) holds by
 * construction: this engine only ever mutates the live character set in
 * response to real "is"/"ds" content ops. Google Docs' formatting ops
 * ("as"/"ae" — style, headers, lists, etc.) are filtered out entirely by the
 * capture layer before they ever reach here, so a later editor reformatting
 * text can never acquire authorship of characters they didn't originate —
 * there is no code path that would let them.
 *
 * A `null` authorId anywhere in this module means "unknown origin" — text
 * that existed in the document before the capture stream started recording
 * (F2.1's "starting from an empty document" describes this engine's own
 * baseline; a real capture run that begins mid-document-life will still
 * reference positions no insert has been seen for yet). This is surfaced
 * explicitly, never silently dropped or guessed at — directly serves C5
 * (conservative "no role" handling: absence of data is reported as such).
 */

export interface LiveChar {
  /** Persistent unique ID minted at insert time (F2.2). */
  charId: number;
  authorId: AuthorId | null;
  /** The literal character. null alongside a null authorId for unknown-origin
   *  padding slots (F2.1) — content predating the capture window is just as
   *  unknown as its author; never invented. Needed by structure detection
   *  (F5) to find paragraph boundaries, since formatting ops are otherwise
   *  filtered out entirely (see module docstring). */
  char: string | null;
}

export interface DeletionEvent {
  /** Who performed the deletion. */
  actor: AuthorId;
  /** Who originally wrote the character that got deleted (null = unknown origin). */
  target: AuthorId | null;
  charId: number | null;
  timestamp: number;
  /** The character's index in the live document at the moment of deletion. */
  position: number;
}

export interface ReplayResult {
  /** Final document's character sequence, in order — index in this array
   *  corresponds to the character's final position in the live document. */
  originByPosition: LiveChar[];
  /** Every deletion that occurred during replay, oldest first (F2.3). */
  deletionLog: DeletionEvent[];
}

/** Pads the live sequence with unknown-origin slots up to `length`, for
 *  positions referenced by an op before any insert at that position was
 *  observed (i.e. content that predates the capture window). */
function padToLength(live: LiveChar[], length: number, nextCharId: () => number): void {
  while (live.length < length) {
    live.push({ charId: nextCharId(), authorId: null, char: null });
  }
}

/** Replays an ordered mutation log into the final per-character origin map
 *  and a full deletion log. Pure and deterministic — same input always
 *  produces the same output (C3). */
export function replay(ops: MutationLog): ReplayResult {
  const live: LiveChar[] = [];
  const deletionLog: DeletionEvent[] = [];
  let counter = 0;
  const nextCharId = () => counter++;

  for (const op of ops) {
    if (op.type === "insert") {
      padToLength(live, op.position, nextCharId);
      const inserted: LiveChar[] = Array.from(op.text, (char) => ({
        charId: nextCharId(),
        authorId: op.authorId,
        char,
      }));
      live.splice(op.position, 0, ...inserted);
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

/** Map (a) from F2.4: surviving character count per origin-author. */
export function survivingCharacterMap(originByPosition: LiveChar[]): Map<AuthorId | null, number> {
  const counts = new Map<AuthorId | null, number>();
  for (const char of originByPosition) {
    counts.set(char.authorId, (counts.get(char.authorId) ?? 0) + 1);
  }
  return counts;
}

/** Map (b) from F2.4: deletion/overwrite activity by actor -> target
 *  (target = the origin author whose characters got deleted) -> count. */
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
