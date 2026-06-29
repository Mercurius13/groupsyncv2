import type { NarrationReport } from "../narration";
import type { AuthorFootprint } from "../signals";
import type { AuthorId } from "../types/mutation";

/**
 * CONTENT-STRIPPED EVIDENCE EXPORT (FRONTEND.md F5.1, DATABASE.md E9) — the
 * only shape of evidence that may ever leave the extension. Per C1, no
 * document text or raw mutation data may be transmitted or persisted
 * outside the extension; per FRONTEND.md F5.1 the payload is narration +
 * counts + section labels ONLY.
 *
 * This is enforced by the TYPE, not a runtime filter: ExportedSection has
 * no `text` field, so there is no field to forget to strip. `NarrationReport.
 * sections[].text` from narration/index.ts (used for the LOCAL, in-extension
 * debug view only, never exported) is the thing this module must never
 * forward — `sectionLabel` below is a purely positional placeholder
 * ("Paragraph N"), not an excerpt, precisely because even a short excerpt is
 * document content. See ME.MD: a future evidence viewer wanting a more
 * readable label needs its own design discussion, not silently piping
 * `section.text` through.
 */

export interface ExportedSection {
  sectionLabel: string;
  sentences: string[];
}

export interface AuthorCount {
  authorId: AuthorId;
  originatedChars: number;
  totalSurvivingChars: number;
  originShare: number;
}

export interface ContentStrippedSummary {
  disclaimer: string;
  generatedAt: number;
  sections: ExportedSection[];
  signalNotes: string[];
  authorCounts: AuthorCount[];
}

export function toContentStrippedSummary(
  narration: NarrationReport,
  footprints: AuthorFootprint[],
  now: () => number = Date.now
): ContentStrippedSummary {
  return {
    disclaimer: narration.disclaimer,
    generatedAt: now(),
    sections: narration.sections
      .filter((s) => s.sentences.length > 0)
      .map((s) => ({ sectionLabel: `Paragraph ${s.paragraph}`, sentences: s.sentences.map((sentence) => sentence.text) })),
    signalNotes: narration.signalNotes,
    authorCounts: footprints.map((f) => ({
      authorId: f.authorId,
      originatedChars: f.originatedChars,
      totalSurvivingChars: f.totalSurvivingChars,
      originShare: f.originShare,
    })),
  };
}
