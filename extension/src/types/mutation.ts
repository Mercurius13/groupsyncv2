/**
 * The typed mutation-stream interface the capture layer parses real Google
 * Docs traffic into, and the replay engine (src/replay) consumes. Per
 * EXTENSION.MD F1.2/F1.4: this is a typed interface validated against real
 * captured traffic (the internal collaboration endpoints' "is"/"ds"
 * commands), not an assumed format.
 *
 * Character IDs are NOT minted here — F2.2 assigns that to the replay
 * engine, at the moment a character is actually inserted into the live
 * document. An insert op's `position` + `text` is everything the replay
 * engine needs to do that; a delete op's `range` is a position range (the
 * real wire format Google sends, via "ds" commands) that the replay engine
 * resolves to the specific character IDs occupying that range at the time.
 */

/** Numeric Google account ID as seen in the realtime collab stream — not an email. */
export type AuthorId = string;

export interface InsertOp {
  type: "insert";
  authorId: AuthorId;
  /** ms since epoch */
  timestamp: number;
  /** character index in the live document where the text was inserted */
  position: number;
  text: string;
}

export interface DeleteOp {
  type: "delete";
  authorId: AuthorId;
  timestamp: number;
  /** character index range removed from the live document, [start, end) */
  range: { start: number; end: number };
}

export type MutationOp = InsertOp | DeleteOp;

/** Ordered log of ops as they occurred, oldest first. */
export type MutationLog = MutationOp[];
