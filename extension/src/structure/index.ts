import type { AuthorId } from "../types/mutation";
import { survivingCharacterMap, type LiveChar } from "../replay";
import { classifyForm, type FormClassification, type HeadingDelimitedRange } from "./docs-api";

/**
 * STRUCTURE DETECTION (HANDOVER.md build order step 3, EXTENSION.MD F5).
 *
 * Segments the final document into sections so authorship can be reported
 * per-section, not just globally. The only structural signal available
 * without capturing Google Docs' internal paragraph-style ops is the
 * literal newline character every paragraph ends with in the indexed
 * character stream `is`/`ds` operate over — capture/wire-types.ts
 * deliberately does not parse style/"as" commands (intentional: keeps
 * authorship robust to reformats, per replay.ts F2.5), so this is a
 * deliberately MINIMAL rule — paragraph-level sections only, no
 * heading/list/title detection — not a guess at richer structure we have
 * no confirmed way to capture. Every boundary is auditable: it's exactly
 * the newline characters in the final text (C3). See ME.MD for the open
 * item to validate this newline-boundary assumption against a real doc.
 */

export interface Section {
  /** Index into the final character sequence, inclusive. */
  start: number;
  /** Index into the final character sequence, exclusive. */
  end: number;
  /** Reconstructed text of this section, including its trailing newline if
   *  any. Unknown-origin characters (predate the capture window) render as
   *  U+FFFD rather than guessed text. */
  text: string;
  /** Surviving character count per origin-author within this section only —
   *  same shape as replay.ts's survivingCharacterMap, scoped to the slice. */
  authorship: Map<AuthorId | null, number>;
  /** F5.4/F5.3 — only set when this section came from segmentByDocsStructure
   *  (Docs API headings), null/undefined for the newline-only fallback. */
  headingLevel?: number | null;
  formClassification?: FormClassification;
}

const UNKNOWN_CHAR_PLACEHOLDER = "�";

function reconstructText(chars: LiveChar[]): string {
  return chars.map((c) => c.char ?? UNKNOWN_CHAR_PLACEHOLDER).join("");
}

/** Splits the final character sequence into paragraph-level sections at
 *  newline boundaries. A doc with no trailing newline still gets its final,
 *  un-terminated span as a section. */
export function segmentIntoParagraphs(chars: LiveChar[]): Section[] {
  const sections: Section[] = [];
  let start = 0;

  for (let i = 0; i < chars.length; i++) {
    if (chars[i]?.char === "\n") {
      sections.push(buildSection(chars, start, i + 1));
      start = i + 1;
    }
  }
  if (start < chars.length) {
    sections.push(buildSection(chars, start, chars.length));
  }

  return sections;
}

function buildSection(chars: LiveChar[], start: number, end: number): Section {
  const slice = chars.slice(start, end);
  return {
    start,
    end,
    text: reconstructText(slice),
    authorship: survivingCharacterMap(slice),
  };
}

/** F5.1-F5.4: sections from real Docs API heading-delimited ranges instead
 *  of newline-only guessing. UNCONFIRMED (see docs-api.ts module docstring):
 *  whether the Docs API's startIndex/endIndex align exactly with the
 *  position space `is`/`ds` ops and `chars` already use — both are Google's
 *  own internal indexing, so this is a reasonable expectation, not yet
 *  checked against a real document. Ranges are clamped to `chars.length` in
 *  case of any misalignment, rather than throwing — a future caller
 *  comparing output against segmentIntoParagraphs is how that gets caught. */
export function segmentByDocsStructure(chars: LiveChar[], ranges: HeadingDelimitedRange[]): Section[] {
  return ranges.map((range) => {
    const start = Math.min(range.startIndex, chars.length);
    const end = Math.min(range.endIndex, chars.length);
    const section = buildSection(chars, start, end);
    return { ...section, headingLevel: range.headingLevel, formClassification: classifyForm(range) };
  });
}
