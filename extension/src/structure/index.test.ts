import { describe, expect, it } from "vitest";
import { replay } from "../replay";
import type { MutationLog } from "../types/mutation";
import { segmentByDocsStructure, segmentIntoParagraphs } from "./index";

describe("segmentIntoParagraphs", () => {
  it("splits into one section per paragraph, each including its trailing newline", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "hello\nworld\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections.map((s) => s.text)).toEqual(["hello\n", "world\n"]);
  });

  it("includes a final un-terminated section when the doc has no trailing newline", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "first\nsecond" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections.map((s) => s.text)).toEqual(["first\n", "second"]);
  });

  it("returns no sections for an empty document", () => {
    expect(segmentIntoParagraphs([])).toEqual([]);
  });

  it("reports start/end indices into the final character sequence", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "ab\ncd" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections).toEqual([
      expect.objectContaining({ start: 0, end: 3, text: "ab\n" }),
      expect.objectContaining({ start: 3, end: 5, text: "cd" }),
    ]);
  });

  it("scopes per-section authorship to that section's characters only", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "aaa\n" },
      { type: "insert", authorId: "B", timestamp: 2, position: 4, text: "bb" },
    ];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections[0]?.authorship.get("A")).toBe(4); // "aaa\n" — the newline is A's character too
    expect(sections[0]?.authorship.get("B")).toBeUndefined();
    expect(sections[1]?.authorship.get("B")).toBe(2);
    expect(sections[1]?.authorship.get("A")).toBeUndefined();
  });

  it("renders unknown-origin (pre-capture) characters as the placeholder, never a guess", () => {
    // A delete-only op referencing positions before any insert was observed
    // pads unknown-origin slots with char: null (see replay.ts).
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 3, text: "x" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections[0]?.text).toBe("���x");
    expect(sections[0]?.authorship.get(null)).toBe(3);
  });
});

describe("segmentByDocsStructure (F5.1-F5.4)", () => {
  it("builds sections from heading-delimited ranges, tagging level and form", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "Intro textTable rows" }];
    const { originByPosition } = replay(ops);
    const sections = segmentByDocsStructure(originByPosition, [
      { startIndex: 0, endIndex: 10, headingLevel: null, containsTable: false },
      { startIndex: 10, endIndex: 20, headingLevel: 2, containsTable: true },
    ]);
    expect(sections).toEqual([
      expect.objectContaining({ start: 0, end: 10, text: "Intro text", headingLevel: null, formClassification: "discussion/theory" }),
      expect.objectContaining({ start: 10, end: 20, text: "Table rows", headingLevel: 2, formClassification: "calculations" }),
    ]);
  });

  it("scopes authorship per range, same as the newline-based segmenter", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "aaaa" },
      { type: "insert", authorId: "B", timestamp: 2, position: 4, text: "bb" },
    ];
    const { originByPosition } = replay(ops);
    const sections = segmentByDocsStructure(originByPosition, [
      { startIndex: 0, endIndex: 4, headingLevel: null, containsTable: false },
      { startIndex: 4, endIndex: 6, headingLevel: null, containsTable: false },
    ]);
    expect(sections[0]?.authorship.get("A")).toBe(4);
    expect(sections[1]?.authorship.get("B")).toBe(2);
  });

  it("clamps ranges that overrun the actual character count rather than throwing", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentByDocsStructure(originByPosition, [
      { startIndex: 0, endIndex: 1000, headingLevel: null, containsTable: false },
    ]);
    expect(sections[0]?.text).toBe("hi");
    expect(sections[0]?.end).toBe(2);
  });

  it("returns nothing for an empty range list", () => {
    expect(segmentByDocsStructure([], [])).toEqual([]);
  });
});
