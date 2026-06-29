import { describe, expect, it } from "vitest";
import type { MutationLog } from "../types/mutation";
import { deletionOverwriteMap, replay, survivingCharacterMap } from "./index";

describe("replay", () => {
  it("attributes a simple insert to its author", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition, deletionLog } = replay(ops);
    expect(originByPosition.map((c) => c.authorId)).toEqual(["A", "A"]);
    expect(deletionLog).toEqual([]);
  });

  it("preserves order across interleaved inserts from two authors", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "ab" },
      { type: "insert", authorId: "B", timestamp: 2, position: 1, text: "X" },
    ];
    // Document: a X b  → A wrote a,b ; B wrote X, inserted between them
    const { originByPosition } = replay(ops);
    expect(originByPosition.map((c) => c.authorId)).toEqual(["A", "B", "A"]);
  });

  it("removes deleted characters from the live sequence", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "hello" },
      { type: "delete", authorId: "A", timestamp: 2, range: { start: 1, end: 3 } }, // removes "el"
    ];
    const { originByPosition } = replay(ops);
    expect(originByPosition).toHaveLength(3);
  });

  it("logs who deleted whose characters (actor/target), including B overwriting A's text", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "abc" },
      { type: "delete", authorId: "B", timestamp: 2, range: { start: 0, end: 2 } }, // B deletes A's "ab"
    ];
    const { deletionLog } = replay(ops);
    expect(deletionLog).toEqual([
      { actor: "B", target: "A", charId: 0, timestamp: 2, position: 0 },
      { actor: "B", target: "A", charId: 1, timestamp: 2, position: 1 },
    ]);
  });

  it("logs a self-delete (author deleting their own characters) the same way", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "x" },
      { type: "delete", authorId: "A", timestamp: 2, range: { start: 0, end: 1 } },
    ];
    const { deletionLog, originByPosition } = replay(ops);
    expect(originByPosition).toEqual([]);
    expect(deletionLog).toEqual([{ actor: "A", target: "A", charId: 0, timestamp: 2, position: 0 }]);
  });

  it("marks pre-capture content (deleted before any insert was observed) as unknown origin, not dropped", () => {
    // A delete referencing positions 0-3 with no prior insert in the log at
    // all — this is content that existed before the capture stream began.
    const ops: MutationLog = [{ type: "delete", authorId: "B", timestamp: 5, range: { start: 0, end: 3 } }];
    const { deletionLog } = replay(ops);
    expect(deletionLog).toEqual([
      { actor: "B", target: null, charId: 0, timestamp: 5, position: 0 },
      { actor: "B", target: null, charId: 1, timestamp: 5, position: 1 },
      { actor: "B", target: null, charId: 2, timestamp: 5, position: 2 },
    ]);
  });

  it("marks pre-capture content still live at the end as unknown origin in originByPosition", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 5, text: "x" }];
    const { originByPosition } = replay(ops);
    // positions 0-4 padded as unknown, position 5 is A's insert
    expect(originByPosition.map((c) => c.authorId)).toEqual([null, null, null, null, null, "A"]);
  });

  it("retains the literal character per position, null for unknown-origin padding", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 2, text: "hi" }];
    const { originByPosition } = replay(ops);
    expect(originByPosition.map((c) => c.char)).toEqual([null, null, "h", "i"]);
  });

  it("never lets a later editor acquire authorship of characters they didn't originate (F2.5)", () => {
    // A writes text; B comes along and "reformats" by deleting and
    // retyping the identical characters. Since this engine only sees real
    // content ops (no formatting op exists in this typed interface that
    // could silently relabel authorship), B's retype is logged as a real
    // delete-then-insert: A's original characters are gone, replaced by
    // genuinely new characters B authored. B never "inherits" A's old credit.
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "hi" },
      { type: "delete", authorId: "B", timestamp: 2, range: { start: 0, end: 2 } },
      { type: "insert", authorId: "B", timestamp: 3, position: 0, text: "hi" },
    ];
    const { originByPosition, deletionLog } = replay(ops);
    expect(originByPosition.map((c) => c.authorId)).toEqual(["B", "B"]);
    expect(deletionLog).toEqual([
      { actor: "B", target: "A", charId: 0, timestamp: 2, position: 0 },
      { actor: "B", target: "A", charId: 1, timestamp: 2, position: 1 },
    ]);
  });
});

describe("survivingCharacterMap", () => {
  it("counts surviving characters per author, including an unknown bucket", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 3, text: "aaa" },
      { type: "insert", authorId: "B", timestamp: 2, position: 6, text: "bb" },
    ];
    const { originByPosition } = replay(ops);
    const counts = survivingCharacterMap(originByPosition);
    expect(counts.get("A")).toBe(3);
    expect(counts.get("B")).toBe(2);
    expect(counts.get(null)).toBe(3); // the padded-unknown prefix
  });
});

describe("deletionOverwriteMap", () => {
  it("aggregates actor -> origin-author deletion counts", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "aaa" },
      { type: "insert", authorId: "B", timestamp: 2, position: 3, text: "bbb" },
      { type: "delete", authorId: "C", timestamp: 3, range: { start: 0, end: 6 } }, // C deletes both
    ];
    const { deletionLog } = replay(ops);
    const matrix = deletionOverwriteMap(deletionLog);
    expect(matrix.get("C")?.get("A")).toBe(3);
    expect(matrix.get("C")?.get("B")).toBe(3);
  });
});
