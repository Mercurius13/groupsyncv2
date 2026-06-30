import { describe, expect, it } from "vitest";
import { buildNarrationReport } from "../narration";
import { authorFootprints } from "../signals";
import { replay } from "../replay";
import { segmentByDocsStructure, segmentIntoParagraphs } from "../structure";
import type { MutationLog } from "../types/mutation";
import { toContentStrippedSummary } from "./index";

const NAMES = { "111": "Ada Lovelace" };

describe("toContentStrippedSummary", () => {
  it("never includes the raw document text, only a positional section label", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "111", timestamp: 1, position: 0, text: "a very specific secret sentence\n" },
    ];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });

    const summary = toContentStrippedSummary(narration, footprints, NAMES, () => 12345);

    expect(summary.sections).toEqual([
      {
        sectionLabel: "Paragraph 1",
        sentences: ["Ada Lovelace primarily authored this section (100% of its surviving characters)."],
      },
    ]);
    // Structural guarantee: no key on the exported section ever holds raw text.
    expect(Object.keys(summary.sections[0]!)).toEqual(["sectionLabel", "sentences"]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("a very specific secret sentence");
  });

  it("carries the standing disclaimer and a generation timestamp", () => {
    const narration = buildNarrationReport({
      sections: [],
      footprints: [],
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });
    const summary = toContentStrippedSummary(narration, [], NAMES, () => 99);
    expect(summary.disclaimer).toMatch(/Use as evidence, not as a verdict/);
    expect(summary.generatedAt).toBe(99);
  });

  it("omits empty sections (no surviving characters) rather than emitting a blank label", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "x\n\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });
    const summary = toContentStrippedSummary(narration, footprints, NAMES, () => 0);
    // 3 paragraphs reconstructed ("x\n", "\n", "" trailing) but only ones
    // with surviving chars get a narrated sentence.
    expect(summary.sections.every((s) => s.sentences.length > 0)).toBe(true);
  });

  it("reduces author footprints to plain counts, no section/structure detail", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "ab\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });
    const summary = toContentStrippedSummary(narration, footprints, NAMES, () => 0);
    expect(summary.authorCounts).toEqual([
      { authorId: "111", authorName: "Ada Lovelace", originatedChars: 3, totalSurvivingChars: 3, originShare: 1 },
    ]);
  });

  it("falls back to null authorName for an unresolved author, never inventing one", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "999", timestamp: 1, position: 0, text: "ab\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: {},
    });
    const summary = toContentStrippedSummary(narration, footprints, {}, () => 0);
    expect(summary.authorCounts).toEqual([
      { authorId: "999", authorName: null, originatedChars: 3, totalSurvivingChars: 3, originShare: 1 },
    ]);
  });

  it("uses the real heading text as sectionLabel when one exists (HANDOVER.md C1 scoped exception)", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "Executive Summary\nbody" }];
    const { originByPosition } = replay(ops);
    const sections = segmentByDocsStructure(originByPosition, [
      { startIndex: 0, endIndex: 22, headingLevel: 1, containsTable: false },
    ]);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });
    const summary = toContentStrippedSummary(narration, footprints, NAMES, () => 0);
    expect(summary.sections[0]?.sectionLabel).toBe("Executive Summary");
  });

  it("falls back to 'Paragraph N' when there's no heading, never leaking prose body text", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "a secret prose sentence\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: NAMES,
    });
    const summary = toContentStrippedSummary(narration, footprints, NAMES, () => 0);
    expect(summary.sections[0]?.sectionLabel).toBe("Paragraph 1");
    expect(JSON.stringify(summary)).not.toContain("a secret prose sentence");
  });

  it("defaults names to {} when omitted, so callers that don't have names still work", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "ab\n" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const narration = buildNarrationReport({
      sections,
      footprints,
      pastes: [],
      quarantineSignals: [],
      lateConcentration: [],
      revisionDepth: [],
      concurrentEdits: [],
      names: {},
    });
    const summary = toContentStrippedSummary(narration, footprints);
    expect(summary.authorCounts[0]?.authorName).toBeNull();
  });
});
