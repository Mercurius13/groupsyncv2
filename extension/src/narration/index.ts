import type {
  AuthorFootprint,
  ConcurrentEditSignal,
  LateConcentrationSignal,
  PasteSignal,
  QuarantineSignal,
  RevisionDepthSignal,
} from "../signals";
import { LATE_CONCENTRATION_WINDOW_FRACTION, narrationPhraseForShare } from "../signals";
import { sectionHeadingText, type Section } from "../structure";
import type { AuthorId } from "../types/mutation";

/**
 * NARRATION (HANDOVER.md build order step 3, EXTENSION.MD F7) — assembles
 * structure + signals into the plain-language sentences a professor reads.
 *
 * F7.2: every sentence carries a `ruleId` (a fixed string, never inferred)
 * alongside its text — exposed in the popup's debug view so a contesting
 * student can be shown exactly which named rule produced a given claim
 * (C3). `NarrationReport.sections[]/signalNotes[]` stay as plain text for
 * `export/index.ts`'s content-stripped payload (the backend/frontend
 * contract doesn't need rule IDs); `ruleTrace` carries the same sentences
 * paired with their rule IDs for the debug view only.
 *
 * WORDING IS A FIRST DRAFT, not finalized — see ME.MD. The main risk to
 * watch for in review: staying descriptive ("the data shows X") rather
 * than accusatory or conclusory — C5 says "no role" and any judgment about
 * effort is the professor's conclusion, never this tool's.
 */

/** Spec-required banner, always shown at the top of any report or export. */
const DISCLAIMER =
  "This tool measures on-document editing only. It cannot detect off-document work, " +
  "in-person contribution, or content drafted elsewhere and pasted in. Use as evidence, not as a verdict.";

export interface RuledSentence {
  ruleId: string;
  text: string;
}

/** Formats a share fraction as a rounded percentage string. */
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Returns "Name" when the author is resolved, or "author <id>" when not. */
function authorLabel(authorId: AuthorId, names: Record<AuthorId, string | null>): string {
  return names[authorId] ?? `author ${authorId}`;
}

/** Returns "this calculations/discussion section" when form is known; "this section" otherwise (F7.3). */
function sectionDescriptor(section: Section): string {
  if (!section.formClassification) return "this section";
  return `this ${section.formClassification} section`;
}

/** One sentence per author with surviving characters in this section,
 *  ordered by descending share, plus an explicit "unknown origin" sentence
 *  when any of the section predates the captured edit history (C5: absence
 *  of data is reported as such, never silently omitted). */
export function narrateSection(section: Section, names: Record<AuthorId, string | null>): RuledSentence[] {
  const total = Array.from(section.authorship.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return [];

  const sentences: RuledSentence[] = [];
  const entries = Array.from(section.authorship.entries()).sort((a, b) => b[1] - a[1]);
  const descriptor = sectionDescriptor(section);

  for (const [authorId, count] of entries) {
    if (count === 0) continue;
    const share = count / total;
    if (authorId === null) {
      sentences.push({
        ruleId: "C5-unknown-origin",
        text: `${pct(share)} of ${descriptor}'s characters predate the captured edit history and have no known author.`,
      });
      continue;
    }
    const phrase = narrationPhraseForShare(share);
    sentences.push({
      ruleId: "F7.3-section-authorship",
      text: `${authorLabel(authorId, names)} ${phrase} ${descriptor} (${pct(share)} of its surviving characters).`,
    });
  }

  return sentences;
}

/** F7.4 — framed as a data observation, not a verdict on effort (C5). */
export function narrateIntegratorPattern(
  footprint: AuthorFootprint,
  names: Record<AuthorId, string | null>
): RuledSentence | null {
  if (!footprint.isIntegratorPattern) return null;
  return {
    ruleId: "F7.4-integrator-pattern",
    text:
      `${authorLabel(footprint.authorId, names)} edited ${pct(footprint.revisionBreadth)} of the document's sections ` +
      `but originated only ${pct(footprint.originShare)} of its surviving text — a pattern consistent with integrating ` +
      `or reformatting others' work rather than drafting original content. This describes what the edit data shows, ` +
      `not a conclusion about effort or contribution.`,
  };
}

/** F4.1 — a length+manner observation, not an accusation. */
export function narratePaste(signal: PasteSignal, names: Record<AuthorId, string | null>): RuledSentence {
  return {
    ruleId: "F4.1-paste",
    text:
      `${authorLabel(signal.authorId, names)} inserted ${signal.length} characters in a single action — consistent ` +
      `with pasted text rather than typing, though the tool cannot distinguish a paste of the author's own prior work ` +
      `from text drafted elsewhere.`,
  };
}

/** F3.1 — a reliability caveat about a time range, not about a person. */
export function narrateQuarantine(signal: QuarantineSignal): RuledSentence {
  const start = new Date(signal.session.startTimestamp).toISOString();
  const end = new Date(signal.session.endTimestamp).toISOString();
  return {
    ruleId: "F3.1-quarantine",
    text:
      `In the editing session from ${start} to ${end}, ${pct(signal.churnFraction)} of the document as it stood at ` +
      `that session's start was deleted — attribution across this session is less reliable than elsewhere in the doc.`,
  };
}

/** F6.4 — a timing observation; explicitly does not imply the work is illegitimate. */
export function narrateLateConcentration(
  signal: LateConcentrationSignal,
  names: Record<AuthorId, string | null>
): RuledSentence {
  return {
    ruleId: "F6.4-late-concentration",
    text:
      `${pct(signal.lateFraction)} of ${authorLabel(signal.authorId, names)}'s edits occurred in the final ` +
      `${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the document's overall editing timeline.`,
  };
}

/** F6.3 — a depth-of-revision observation, not framed as destructive. */
export function narrateRevisionDepth(
  signal: RevisionDepthSignal,
  names: Record<AuthorId, string | null>
): RuledSentence {
  const targetLabel = signal.targetId === null ? "characters of unknown origin" : `${authorLabel(signal.targetId, names)}'s characters`;
  return {
    ruleId: "F6.3-revision-depth",
    text: `${authorLabel(signal.actorId, names)} deleted ${signal.deletedCount} ${targetLabel}.`,
  };
}

/** F6.6 — flags a boundary, not a verdict on who "really" edited first. */
export function narrateConcurrentEdit(
  signal: ConcurrentEditSignal,
  names: Record<AuthorId, string | null>
): RuledSentence {
  return {
    ruleId: "F6.6-concurrent-edit-boundary",
    text:
      `${authorLabel(signal.authorA, names)} and ${authorLabel(signal.authorB, names)} both inserted text within ` +
      `${Math.abs(signal.timestampB - signal.timestampA)}ms of each other near the same position in the document — ` +
      `attribution at this boundary may be less certain than elsewhere (concurrent editing).`,
  };
}

export interface SectionNarration {
  paragraph: number;
  sentences: RuledSentence[];
  /** HANDOVER.md C1's scoped exception: the section's real heading text
   *  (structure/index.ts's sectionHeadingText), when one exists — null for
   *  the newline-only fallback or a heading-less section. Short navigational
   *  text only, never the prose body. */
  headingText: string | null;
}

export interface NarrationReport {
  disclaimer: string;
  sections: SectionNarration[];
  /** Plain text, for export/index.ts's content-stripped payload. */
  signalNotes: string[];
  /** Same sentences as signalNotes, paired with rule IDs — for the debug
   *  view (F7.2). */
  signalSentences: RuledSentence[];
  /** F7.2: every sentence in this report, paired with its rule ID — section
   *  sentences plus signalSentences, flattened, for the debug view. */
  ruleTrace: RuledSentence[];
}

export interface NarrationInputs {
  sections: Section[];
  footprints: AuthorFootprint[];
  pastes: PasteSignal[];
  quarantineSignals: QuarantineSignal[];
  lateConcentration: LateConcentrationSignal[];
  revisionDepth: RevisionDepthSignal[];
  concurrentEdits: ConcurrentEditSignal[];
  names: Record<AuthorId, string | null>;
}

export function buildNarrationReport(inputs: NarrationInputs): NarrationReport {
  const { names } = inputs;

  const sections: SectionNarration[] = inputs.sections.map((section, i) => ({
    paragraph: i + 1,
    sentences: narrateSection(section, names),
    headingText: sectionHeadingText(section),
  }));

  const signalSentences: RuledSentence[] = [
    ...inputs.footprints.map((f) => narrateIntegratorPattern(f, names)).filter((s): s is RuledSentence => s !== null),
    ...inputs.pastes.map((p) => narratePaste(p, names)),
    ...inputs.quarantineSignals.map((q) => narrateQuarantine(q)),
    ...inputs.lateConcentration.map((l) => narrateLateConcentration(l, names)),
    ...inputs.revisionDepth.map((r) => narrateRevisionDepth(r, names)),
    ...inputs.concurrentEdits.map((c) => narrateConcurrentEdit(c, names)),
  ];

  return {
    disclaimer: DISCLAIMER,
    sections,
    signalNotes: signalSentences.map((s) => s.text),
    signalSentences,
    ruleTrace: [...sections.flatMap((s) => s.sentences), ...signalSentences],
  };
}
