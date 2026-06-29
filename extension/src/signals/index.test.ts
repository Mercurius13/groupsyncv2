import { describe, expect, it } from "vitest";
import { deletionOverwriteMap, replay } from "../replay";
import { segmentIntoParagraphs } from "../structure";
import type { MutationLog } from "../types/mutation";
import {
  authorFootprints,
  CONCURRENT_EDIT_POSITION_DISTANCE,
  CONCURRENT_EDIT_WINDOW_MS,
  CONTRIBUTOR_SHARE_THRESHOLD,
  detectConcurrentEditBoundaries,
  detectLateConcentration,
  detectMissingRosterMembers,
  detectNonRosterAuthorship,
  detectPastes,
  detectQuarantineSignals,
  groupIntoSessions,
  narrationPhraseForShare,
  PASTE_CHAR_THRESHOLD,
  PRIMARY_AUTHOR_SHARE_THRESHOLD,
  QUARANTINE_CHURN_FRACTION,
  REVISION_DEPTH_NARRATION_THRESHOLD,
  revisionDepthSignals,
  SESSION_GAP_MS,
} from "./index";

describe("detectPastes (F4.1)", () => {
  it("flags an insert at or above the threshold", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "x".repeat(PASTE_CHAR_THRESHOLD) },
    ];
    expect(detectPastes(ops)).toEqual([
      { authorId: "A", timestamp: 1, position: 0, length: PASTE_CHAR_THRESHOLD },
    ]);
  });

  it("does not flag an insert just below the threshold", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "x".repeat(PASTE_CHAR_THRESHOLD - 1) },
    ];
    expect(detectPastes(ops)).toEqual([]);
  });

  it("ignores delete ops entirely", () => {
    const ops: MutationLog = [{ type: "delete", authorId: "A", timestamp: 1, range: { start: 0, end: 1000 } }];
    expect(detectPastes(ops)).toEqual([]);
  });
});

describe("groupIntoSessions (F3.1)", () => {
  it("keeps ops within the gap in one session", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "a" },
      { type: "insert", authorId: "A", timestamp: SESSION_GAP_MS - 1, position: 1, text: "b" },
    ];
    expect(groupIntoSessions(ops)).toHaveLength(1);
  });

  it("splits a session when the gap exceeds SESSION_GAP_MS", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "a" },
      { type: "insert", authorId: "A", timestamp: SESSION_GAP_MS + 1, position: 1, text: "b" },
    ];
    expect(groupIntoSessions(ops)).toHaveLength(2);
  });
});

describe("detectQuarantineSignals (F3.1)", () => {
  it("flags a session that churns at or above the threshold fraction of the doc", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "a".repeat(10) },
      // new session: deletes 5 of the 10 chars (50% churn, meets threshold)
      { type: "delete", authorId: "B", timestamp: SESSION_GAP_MS + 1, range: { start: 0, end: 5 } },
    ];
    const signals = detectQuarantineSignals(ops);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.churnFraction).toBe(QUARANTINE_CHURN_FRACTION);
  });

  it("does not flag a session that churns well below the threshold", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "a".repeat(10) },
      { type: "delete", authorId: "B", timestamp: SESSION_GAP_MS + 1, range: { start: 0, end: 1 } },
    ];
    expect(detectQuarantineSignals(ops)).toEqual([]);
  });

  it("skips a session with no baseline doc length to measure churn against", () => {
    const ops: MutationLog = [{ type: "delete", authorId: "A", timestamp: 0, range: { start: 0, end: 5 } }];
    expect(detectQuarantineSignals(ops)).toEqual([]);
  });
});

describe("authorFootprints (F7.4 integrator pattern)", () => {
  it("flags an author who touches most sections but originates little surviving content", () => {
    // 5 sections; integrator (I) adds 1 char of filler to 4 of them (80% breadth),
    // primary author (P) writes the bulk of each section's real content.
    const ops: MutationLog = [
      { type: "insert", authorId: "P", timestamp: 1, position: 0, text: "PPPPPPPPPP\n" }, // section 1
      { type: "insert", authorId: "I", timestamp: 2, position: 11, text: "i\n" }, // section 2 (integrator-only)
      { type: "insert", authorId: "P", timestamp: 3, position: 13, text: "PPPPPPPPPP\n" }, // section 3
      { type: "insert", authorId: "I", timestamp: 4, position: 24, text: "i\n" }, // section 4 (integrator-only)
      { type: "insert", authorId: "P", timestamp: 5, position: 26, text: "PPPPPPPPPP" }, // section 5
    ];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);

    const integrator = footprints.find((f) => f.authorId === "I");
    expect(integrator?.revisionBreadth).toBeCloseTo(2 / 5);
    expect(integrator?.isIntegratorPattern).toBe(false); // breadth too low in this fixture

    const primary = footprints.find((f) => f.authorId === "P");
    expect(primary?.isIntegratorPattern).toBe(false);
  });

  it("flags an author who touches most sections but contributes a thin share of surviving content", () => {
    // 5 sections. P writes the bulk of sections 1-4 (20 chars each) and all
    // of section 5; I adds a single filler char to sections 1-4 only.
    const bigSection = (n: number) => "P".repeat(n);
    const ops: MutationLog = [
      { type: "insert", authorId: "I", timestamp: 1, position: 0, text: "i" },
      { type: "insert", authorId: "P", timestamp: 2, position: 1, text: bigSection(20) + "\n" },
      { type: "insert", authorId: "I", timestamp: 3, position: 22, text: "i" },
      { type: "insert", authorId: "P", timestamp: 4, position: 23, text: bigSection(20) + "\n" },
      { type: "insert", authorId: "I", timestamp: 5, position: 44, text: "i" },
      { type: "insert", authorId: "P", timestamp: 6, position: 45, text: bigSection(20) + "\n" },
      { type: "insert", authorId: "I", timestamp: 7, position: 66, text: "i" },
      { type: "insert", authorId: "P", timestamp: 8, position: 67, text: bigSection(20) + "\n" },
      { type: "insert", authorId: "P", timestamp: 9, position: 88, text: bigSection(20) },
    ];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    expect(sections).toHaveLength(5);
    const footprints = authorFootprints(sections, originByPosition);

    const integrator = footprints.find((f) => f.authorId === "I");
    expect(integrator?.revisionBreadth).toBe(0.8); // touched 4 of 5 sections
    expect(integrator?.originShare).toBeLessThan(0.2);
    expect(integrator?.isIntegratorPattern).toBe(true);

    const primary = footprints.find((f) => f.authorId === "P");
    expect(primary?.isIntegratorPattern).toBe(false);
  });

  it("does not flag a primary author with high breadth and high origin share", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "A", timestamp: 1, position: 0, text: "all\nsections\nmine" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    expect(footprints[0]?.revisionBreadth).toBe(1);
    expect(footprints[0]?.isIntegratorPattern).toBe(false);
  });
});

describe("narrationPhraseForShare (F7.3)", () => {
  it("uses 'primarily authored' at/above the primary threshold", () => {
    expect(narrationPhraseForShare(PRIMARY_AUTHOR_SHARE_THRESHOLD)).toBe("primarily authored");
    expect(narrationPhraseForShare(0.99)).toBe("primarily authored");
  });

  it("uses 'contributed to' in the middle band", () => {
    expect(narrationPhraseForShare(CONTRIBUTOR_SHARE_THRESHOLD)).toBe("contributed to");
    expect(narrationPhraseForShare(0.3)).toBe("contributed to");
  });

  it("uses 'made minor edits to' below the contributor threshold", () => {
    expect(narrationPhraseForShare(0)).toBe("made minor edits to");
    expect(narrationPhraseForShare(CONTRIBUTOR_SHARE_THRESHOLD - 0.001)).toBe("made minor edits to");
  });
});

describe("detectLateConcentration (F6.4)", () => {
  it("flags an author whose inserts cluster in the final window of the timeline", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "early" },
      { type: "insert", authorId: "B", timestamp: 95, position: 5, text: "late1" },
      { type: "insert", authorId: "B", timestamp: 96, position: 10, text: "late2" },
      { type: "insert", authorId: "B", timestamp: 100, position: 15, text: "late3" },
    ];
    // timeline span 0-100; final 20% window starts at ts=80
    const signals = detectLateConcentration(ops);
    expect(signals).toEqual([{ authorId: "B", editsInLateWindow: 3, totalEdits: 3, lateFraction: 1 }]);
  });

  it("does not flag an author whose edits are spread across the timeline", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 0, position: 0, text: "a" },
      { type: "insert", authorId: "A", timestamp: 50, position: 1, text: "b" },
      { type: "insert", authorId: "A", timestamp: 100, position: 2, text: "c" },
    ];
    expect(detectLateConcentration(ops)).toEqual([]);
  });

  it("returns nothing for a zero-width timeline (no meaningful 'late')", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 5, position: 0, text: "a" },
      { type: "insert", authorId: "A", timestamp: 5, position: 1, text: "b" },
    ];
    expect(detectLateConcentration(ops)).toEqual([]);
  });
});

describe("revisionDepthSignals (F6.3)", () => {
  it("turns deletionOverwriteMap into a sorted, threshold-filtered signal list", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "a".repeat(30) },
      { type: "insert", authorId: "B", timestamp: 2, position: 30, text: "b".repeat(50) },
      { type: "delete", authorId: "C", timestamp: 3, range: { start: 0, end: 30 } }, // deletes all 30 of A's chars
      { type: "delete", authorId: "C", timestamp: 4, range: { start: 0, end: 5 } }, // deletes 5 of B's chars (below threshold)
    ];
    const { deletionLog } = replay(ops);
    const matrix = deletionOverwriteMap(deletionLog);
    expect(revisionDepthSignals(matrix)).toEqual([{ actorId: "C", targetId: "A", deletedCount: 30 }]);
  });

  it("excludes deletions below REVISION_DEPTH_NARRATION_THRESHOLD", () => {
    const belowThreshold = REVISION_DEPTH_NARRATION_THRESHOLD - 1;
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1, position: 0, text: "a".repeat(belowThreshold) },
      { type: "delete", authorId: "B", timestamp: 2, range: { start: 0, end: belowThreshold } },
    ];
    const { deletionLog } = replay(ops);
    expect(revisionDepthSignals(deletionOverwriteMap(deletionLog))).toEqual([]);
  });
});

describe("detectConcurrentEditBoundaries (F6.6)", () => {
  it("flags two different authors inserting near the same position within the time window", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1000, position: 100, text: "x" },
      { type: "insert", authorId: "B", timestamp: 1000 + CONCURRENT_EDIT_WINDOW_MS - 1, position: 102, text: "y" },
    ];
    expect(detectConcurrentEditBoundaries(ops)).toEqual([
      { authorA: "A", authorB: "B", timestampA: 1000, timestampB: 1000 + CONCURRENT_EDIT_WINDOW_MS - 1, positionA: 100, positionB: 102 },
    ]);
  });

  it("does not flag the same author editing near themselves", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1000, position: 100, text: "x" },
      { type: "insert", authorId: "A", timestamp: 1001, position: 101, text: "y" },
    ];
    expect(detectConcurrentEditBoundaries(ops)).toEqual([]);
  });

  it("does not flag inserts outside the time window", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1000, position: 100, text: "x" },
      { type: "insert", authorId: "B", timestamp: 1000 + CONCURRENT_EDIT_WINDOW_MS + 1, position: 100, text: "y" },
    ];
    expect(detectConcurrentEditBoundaries(ops)).toEqual([]);
  });

  it("does not flag inserts outside the position distance", () => {
    const ops: MutationLog = [
      { type: "insert", authorId: "A", timestamp: 1000, position: 100, text: "x" },
      { type: "insert", authorId: "B", timestamp: 1001, position: 100 + CONCURRENT_EDIT_POSITION_DISTANCE + 1, text: "y" },
    ];
    expect(detectConcurrentEditBoundaries(ops)).toEqual([]);
  });
});

describe("detectNonRosterAuthorship (F4.2)", () => {
  it("returns nothing when no expected roster was entered (never guess)", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    expect(detectNonRosterAuthorship([], footprints, {})).toEqual([]);
  });

  it("flags an author whose resolved name doesn't match any expected-roster entry", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const names = { "111": "Professor Smith" };
    expect(detectNonRosterAuthorship(["Ada Lovelace", "Grace Hopper"], footprints, names)).toEqual([
      { authorId: "111", originatedChars: 2 },
    ]);
  });

  it("does not flag an author whose resolved name matches, case/whitespace-insensitively", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const names = { "111": "  ADA lovelace  " };
    expect(detectNonRosterAuthorship(["Ada Lovelace"], footprints, names)).toEqual([]);
  });
});

describe("detectMissingRosterMembers (F7.5)", () => {
  it("flags an expected-roster entry with zero detected edits", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const names = { "111": "Ada Lovelace" };
    expect(detectMissingRosterMembers(["Ada Lovelace", "Grace Hopper"], footprints, names)).toEqual(["Grace Hopper"]);
  });

  it("returns nothing when every expected member has detected edits", () => {
    const ops: MutationLog = [{ type: "insert", authorId: "111", timestamp: 1, position: 0, text: "hi" }];
    const { originByPosition } = replay(ops);
    const sections = segmentIntoParagraphs(originByPosition);
    const footprints = authorFootprints(sections, originByPosition);
    const names = { "111": "Ada Lovelace" };
    expect(detectMissingRosterMembers(["Ada Lovelace"], footprints, names)).toEqual([]);
  });
});
