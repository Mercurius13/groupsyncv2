import { describe, expect, it } from "vitest";
import { replay, deletionOverwriteMap } from "../replay";
import {
  detectConcurrentEditBoundaries,
  detectLateConcentration,
  detectPastes,
  detectQuarantineSignals,
  revisionDepthSignals,
  SESSION_GAP_MS,
} from "../signals";
import { segmentByDocsStructure, segmentIntoParagraphs } from "../structure";
import type { MutationLog } from "../types/mutation";
import {
  buildNarrationReport,
  narrateConcurrentEdit,
  narrateIntegratorPattern,
  narrateLateConcentration,
  narratePaste,
  narrateQuarantine,
  narrateRevisionDepth,
  narrateSection,
} from "./index";

const NAMES = { "111": "Ada Lovelace", "222": "Grace Hopper" };

function texts(sentences: { text: string }[]): string[] {
  return sentences.map((s) => s.text);
}

const EMPTY_INPUTS = {
  sections: [],
  footprints: [],
  pastes: [],
  quarantineSignals: [],
  lateConcentration: [],
  revisionDepth: [],
  concurrentEdits: [],
  names: NAMES,
};

describe("narrateSection", () => {
  it("describes the majority author as 'primarily authored' with their share", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hello" }];
    const { originByPosition } = replay(ops);
    const [section] = segmentIntoParagraphs(originByPosition);
    expect(texts(narrateSection(section!, NAMES))).toEqual([
      "Ada Lovelace primarily authored this section (100% of its surviving characters).",
    ]);
    expect(narrateSection(section!, NAMES)[0]?.ruleId).toBe("F7.3-section-authorship");
  });

  it("orders multiple authors by descending share and uses the right phrase per bracket", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "111", timestamp: 1, position: 0, text: "a".repeat(80) },
      { type: "insert", authorId: "222", timestamp: 2, position: 80, text: "b".repeat(20) },
    ];
    const { originByPosition } = replay(ops);
    const [section] = segmentIntoParagraphs(originByPosition);
    expect(texts(narrateSection(section!, NAMES))).toEqual([
      "Ada Lovelace primarily authored this section (80% of its surviving characters).",
      "Grace Hopper contributed to this section (20% of its surviving characters).",
    ]);
  });

  it("calls out unknown-origin characters explicitly instead of omitting them", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 5, text: "x" }];
    const { originByPosition } = replay(ops);
    const [section] = segmentIntoParagraphs(originByPosition);
    const sentences = narrateSection(section!, NAMES);
    expect(texts(sentences)).toEqual([
      "83% of this section's characters predate the captured edit history and have no known author.",
      "Ada Lovelace contributed to this section (17% of its surviving characters).",
    ]);
    expect(sentences[0]?.ruleId).toBe("C5-unknown-origin");
  });

  it("falls back to a raw-id label when a name hasn't been resolved", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "999", timestamp: 1, position: 0, text: "x" }];
    const { originByPosition } = replay(ops);
    const [section] = segmentIntoParagraphs(originByPosition);
    expect(texts(narrateSection(section!, NAMES))).toEqual([
      "author 999 primarily authored this section (100% of its surviving characters).",
    ]);
  });

  it("hedges to FORM only ('this calculations section') when Docs API structure is known (F7.3)", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "table data" }];
    const { originByPosition } = replay(ops);
    const [section] = segmentByDocsStructure(originByPosition, [
      { startIndex: 0, endIndex: 10, headingLevel: null, containsTable: true },
    ]);
    expect(texts(narrateSection(section!, NAMES))).toEqual([
      "Ada Lovelace primarily authored this calculations section (100% of its surviving characters).",
    ]);
  });
});

describe("narrateIntegratorPattern", () => {
  it("frames the pattern as a data observation, not a verdict", () => {
    const sentence = narrateIntegratorPattern(
      { authorId: "222", sectionsTouched: 4, totalSections: 5, revisionBreadth: 0.8, originatedChars: 4, totalSurvivingChars: 100, originShare: 0.04, isIntegratorPattern: true },
      NAMES
    );
    expect(sentence?.text).toBe(
      "Grace Hopper edited 80% of the document's sections but originated only 4% of its surviving text — a pattern consistent with integrating or reformatting others' work rather than drafting original content. This describes what the edit data shows, not a conclusion about effort or contribution."
    );
    expect(sentence?.ruleId).toBe("F7.4-integrator-pattern");
  });

  it("returns null when the pattern doesn't apply", () => {
    const sentence = narrateIntegratorPattern(
      { authorId: "111", sectionsTouched: 1, totalSections: 5, revisionBreadth: 0.2, originatedChars: 80, totalSurvivingChars: 100, originShare: 0.8, isIntegratorPattern: false },
      NAMES
    );
    expect(sentence).toBeNull();
  });
});

describe("narratePaste", () => {
  it("notes the length and cannot rule out the author's own prior work", () => {
    const [signal] = detectPastes([{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "x".repeat(500) }]);
    expect(narratePaste(signal!, NAMES).text).toBe(
      "Ada Lovelace inserted 500 characters in a single action — consistent with pasted text rather than typing, though the tool cannot distinguish a paste of the author's own prior work from text drafted elsewhere."
    );
  });
});

describe("narrateQuarantine", () => {
  it("frames the caveat around a time range, not a person", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "111", timestamp: 0, position: 0, text: "a".repeat(10) },
      { type: "delete", authorId: "222", timestamp: SESSION_GAP_MS + 1, range: { start: 0, end: 5 } },
    ];
    const [signal] = detectQuarantineSignals(ops);
    const sentence = narrateQuarantine(signal!).text;
    expect(sentence).toContain("50% of the document as it stood at that session's start was deleted");
    expect(sentence).toMatch(/^In the editing session from .* to .*,/);
  });
});

describe("narrateLateConcentration", () => {
  it("describes the timing observation without implying illegitimacy", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "111", timestamp: 0, position: 0, text: "a" },
      { type: "insert", authorId: "222", timestamp: 95, position: 1, text: "b" },
      { type: "insert", authorId: "222", timestamp: 100, position: 2, text: "c" },
    ];
    const [signal] = detectLateConcentration(ops);
    expect(narrateLateConcentration(signal!, NAMES).text).toBe(
      "100% of Grace Hopper's edits occurred in the final 20% of the document's overall editing timeline."
    );
  });
});

describe("narrateRevisionDepth (F6.3)", () => {
  it("names the actor, target, and count", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "111", timestamp: 1, position: 0, text: "a".repeat(30) },
      { type: "delete", authorId: "222", timestamp: 2, range: { start: 0, end: 30 } },
    ];
    const { deletionLog } = replay(ops);
    const [signal] = revisionDepthSignals(deletionOverwriteMap(deletionLog));
    expect(narrateRevisionDepth(signal!, NAMES).text).toBe("Grace Hopper deleted 30 Ada Lovelace's characters.");
  });

  it("describes an unknown-origin target without inventing an author", () => {
    const ops: MutationLog = [{ type: "delete", authorId: "222", timestamp: 1, range: { start: 0, end: 25 } }];
    const { deletionLog } = replay(ops);
    const [signal] = revisionDepthSignals(deletionOverwriteMap(deletionLog));
    expect(narrateRevisionDepth(signal!, NAMES).text).toBe("Grace Hopper deleted 25 characters of unknown origin.");
  });
});

describe("narrateConcurrentEdit (F6.6)", () => {
  it("frames the boundary, not a verdict on who edited first", () => {
    const [signal] = detectConcurrentEditBoundaries([
      { type: "insert", authorId: "111", timestamp: 1000, position: 50, text: "x" },
      { type: "insert", authorId: "222", timestamp: 1500, position: 52, text: "y" },
    ]);
    const text = narrateConcurrentEdit(signal!, NAMES).text;
    expect(text).toContain("Ada Lovelace and Grace Hopper both inserted text within 500ms");
    expect(text).toContain("attribution at this boundary may be less certain");
  });
});

describe("buildNarrationReport", () => {
  it("always includes the standing disclaimer", () => {
    const report = buildNarrationReport(EMPTY_INPUTS);
    expect(report.disclaimer).toMatch(/Use as evidence, not as a verdict/);
  });

  it("assembles per-section sentences and all signal notes together, plus a flat ruleTrace", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hello" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const pastes = detectPastes([{ type: "insert", authorId: "222", timestamp: 1, position: 0, text: "x".repeat(500) }]);

    const report = buildNarrationReport({ ...EMPTY_INPUTS, sections, pastes });
    expect(report.sections).toEqual([
      {
        paragraph: 1,
        headingText: null,
        sentences: [
          { ruleId: "F7.3-section-authorship", text: "Ada Lovelace primarily authored this section (100% of its surviving characters)." },
        ],
      },
    ]);
    expect(report.signalNotes).toHaveLength(1);
    expect(report.signalNotes[0]).toContain("Grace Hopper inserted 500 characters");
    expect(report.ruleTrace).toHaveLength(2); // 1 section sentence + 1 signal note
    expect(report.ruleTrace.map((r) => r.ruleId)).toEqual(["F7.3-section-authorship", "F4.1-paste"]);
  });
});
