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
 * `sectionLabel` is HANDOVER.md C1's scoped exception (2026-06-29): when the
 * section has a real heading (Docs API structure), the label is that
 * heading's own text (e.g. "Executive Summary") — purely positional labels
 * ("Paragraph 47") turned out unusable in practice, no way to tell which
 * section is which without the source doc open side by side. This is
 * `narration/index.ts`'s `sectionHeadingText` output ONLY — the heading
 * LINE itself, never the prose body that follows it (`Section.text`'s full
 * reconstructed content never reaches this module). Falls back to
 * "Paragraph N" when there's no heading (the newline-only segmenter never
 * sets one).
 */

export interface ExportedSection {
  sectionLabel: string;
  sentences: string[];
}

export interface AuthorCount {
  authorId: AuthorId;
  /** Resolved via the People API (identity/people.ts) where available; null
   *  if unresolved. Never invented — readability addition alongside, not
   *  instead of, authorId (C3: the raw ID stays for traceability/audit). */
  authorName: string | null;
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
  names: Record<AuthorId, string | null> = {},
  now: () => number = Date.now
): ContentStrippedSummary {
  return {
    disclaimer: narration.disclaimer,
    generatedAt: now(),
    sections: narration.sections
      .filter((s) => s.sentences.length > 0)
      .map((s) => ({
        sectionLabel: s.headingText ?? `Paragraph ${s.paragraph}`,
        sentences: s.sentences.map((sentence) => sentence.text),
      })),
    signalNotes: narration.signalNotes,
    authorCounts: footprints.map((f) => ({
      authorId: f.authorId,
      authorName: names[f.authorId] ?? null,
      originatedChars: f.originatedChars,
      totalSurvivingChars: f.totalSurvivingChars,
      originShare: f.originShare,
    })),
  };
}
