import type { AuthorId, InsertOp, MutationLog, MutationOp } from "./capture";
import { sectionHeadingText, type Section } from "./structure";

// Analysis output: named signals over the replayed sections, the ruled sentences
// built from them, and the content-stripped summary that is the only thing allowed
// to leave the extension.

// ---------------------------------------------------------------- signals

export const PASTE_CHAR_THRESHOLD = 400;

export interface PasteSignal {
  authorId: AuthorId;
  timestamp: number;
  position: number;
  length: number;
}

/** Flags any single insert op at or above PASTE_CHAR_THRESHOLD characters —
 *  one atomic op that large was not typed character-by-character. */
export function detectPastes(ops: MutationLog): PasteSignal[] {
  const signals: PasteSignal[] = [];
  for (const op of ops) {
    if (op.type === "insert" && op.text.length >= PASTE_CHAR_THRESHOLD) {
      signals.push({ authorId: op.authorId, timestamp: op.timestamp, position: op.position, length: op.text.length });
    }
  }
  return signals;
}

export const QUARANTINE_CHURN_FRACTION = 0.5;
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface EditSession {
  ops: MutationOp[];
  startTimestamp: number;
  endTimestamp: number;
}

/** Groups a mutation log into editing sessions, splitting wherever consecutive
 *  ops are more than SESSION_GAP_MS apart. */
export function groupIntoSessions(ops: MutationLog): EditSession[] {
  if (ops.length === 0) return [];
  const sorted = [...ops].sort((a, b) => a.timestamp - b.timestamp);
  const sessions: MutationOp[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const op = sorted[i]!;
    const prev = sorted[i - 1]!;
    if (op.timestamp - prev.timestamp > SESSION_GAP_MS) {
      sessions.push([]);
    }
    sessions[sessions.length - 1]!.push(op);
  }
  return sessions.map((sessionOps) => ({
    ops: sessionOps,
    startTimestamp: sessionOps[0]!.timestamp,
    endTimestamp: sessionOps[sessionOps.length - 1]!.timestamp,
  }));
}

export interface QuarantineSignal {
  session: EditSession;
  docLengthAtSessionStart: number;
  deletedCount: number;
  churnFraction: number;
}

/** Flags sessions whose deletions churn at least QUARANTINE_CHURN_FRACTION of
 *  the document as it stood at session start — attribution there is suspect. */
export function detectQuarantineSignals(ops: MutationLog): QuarantineSignal[] {
  const sessions = groupIntoSessions(ops);
  const signals: QuarantineSignal[] = [];
  let docLength = 0;

  for (const session of sessions) {
    const docLengthAtSessionStart = docLength;
    let deletedCount = 0;
    for (const op of session.ops) {
      if (op.type === "insert") {
        docLength += op.text.length;
      } else {
        const removed = op.range.end - op.range.start;
        docLength -= removed;
        deletedCount += removed;
      }
    }
    if (docLengthAtSessionStart > 0) {
      const churnFraction = deletedCount / docLengthAtSessionStart;
      if (churnFraction >= QUARANTINE_CHURN_FRACTION) {
        signals.push({ session, docLengthAtSessionStart, deletedCount, churnFraction });
      }
    }
  }

  return signals;
}

export const INTEGRATOR_BREADTH_THRESHOLD = 0.6;
export const INTEGRATOR_ORIGIN_SHARE_THRESHOLD = 0.2;

export interface AuthorFootprint {
  authorId: AuthorId;
  sectionsTouched: number;
  totalSections: number;
  revisionBreadth: number;
  originatedChars: number;
  totalSurvivingChars: number;
  originShare: number;
  isIntegratorPattern: boolean;
}

/** Computes per-author breadth and origin share from section authorship maps;
 *  the denominator sums those maps, so pre-excluded authors stay excluded. */
export function authorFootprints(sections: Section[]): AuthorFootprint[] {
  const totalSurvivingChars = sections.reduce(
    (sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0),
    0
  );
  const authorIds = new Set<AuthorId>();
  for (const section of sections) {
    for (const id of section.authorship.keys()) {
      if (id !== null) authorIds.add(id);
    }
  }

  return Array.from(authorIds).map((authorId) => {
    let sectionsTouched = 0;
    let originatedChars = 0;
    for (const section of sections) {
      const charsHere = section.authorship.get(authorId) ?? 0;
      if (charsHere > 0) sectionsTouched++;
      originatedChars += charsHere;
    }
    const revisionBreadth = sections.length === 0 ? 0 : sectionsTouched / sections.length;
    const originShare = totalSurvivingChars === 0 ? 0 : originatedChars / totalSurvivingChars;
    return {
      authorId,
      sectionsTouched,
      totalSections: sections.length,
      revisionBreadth,
      originatedChars,
      totalSurvivingChars,
      originShare,
      isIntegratorPattern:
        revisionBreadth >= INTEGRATOR_BREADTH_THRESHOLD && originShare < INTEGRATOR_ORIGIN_SHARE_THRESHOLD,
    };
  });
}

export const PRIMARY_AUTHOR_SHARE_THRESHOLD = 0.6;
export const CONTRIBUTOR_SHARE_THRESHOLD = 0.15;

export type NarrationPhrase = "primarily authored" | "contributed to" | "made minor edits to";

/** Maps an origin share to its fixed narration phrase bracket:
 *  primary at 60%+, contributor at 15%+, minor edits below. */
export function narrationPhraseForShare(originShare: number): NarrationPhrase {
  if (originShare >= PRIMARY_AUTHOR_SHARE_THRESHOLD) return "primarily authored";
  if (originShare >= CONTRIBUTOR_SHARE_THRESHOLD) return "contributed to";
  return "made minor edits to";
}

export const LATE_CONCENTRATION_EDIT_FRACTION = 0.6;
export const LATE_CONCENTRATION_WINDOW_FRACTION = 0.2;

export interface LateConcentrationSignal {
  authorId: AuthorId;
  editsInLateWindow: number;
  totalEdits: number;
  lateFraction: number;
}

/** Flags authors whose insert ops cluster late: at least 60% of their inserts
 *  in the final 20% of the whole project's edit timeline. */
export function detectLateConcentration(ops: MutationLog): LateConcentrationSignal[] {
  const inserts = ops.filter((op): op is InsertOp => op.type === "insert");
  if (inserts.length === 0 || ops.length === 0) return [];

  // Walked rather than spread: Math.min(...ops) throws RangeError past roughly 125k
  // arguments, which a long-lived group document's changelog exceeds.
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const op of ops) {
    if (op.timestamp < minTs) minTs = op.timestamp;
    if (op.timestamp > maxTs) maxTs = op.timestamp;
  }
  const span = maxTs - minTs;
  if (span === 0) return [];
  const lateWindowStart = maxTs - span * LATE_CONCENTRATION_WINDOW_FRACTION;

  const byAuthor = new Map<AuthorId, { total: number; late: number }>();
  for (const op of inserts) {
    const entry = byAuthor.get(op.authorId) ?? { total: 0, late: 0 };
    entry.total++;
    if (op.timestamp >= lateWindowStart) entry.late++;
    byAuthor.set(op.authorId, entry);
  }

  const signals: LateConcentrationSignal[] = [];
  for (const [authorId, { total, late }] of byAuthor) {
    const lateFraction = late / total;
    if (lateFraction >= LATE_CONCENTRATION_EDIT_FRACTION) {
      signals.push({ authorId, editsInLateWindow: late, totalEdits: total, lateFraction });
    }
  }
  return signals;
}

export const REVISION_DEPTH_NARRATION_THRESHOLD = 20;

export interface RevisionDepthSignal {
  actorId: AuthorId;
  targetId: AuthorId | null;
  deletedCount: number;
}

/** Flattens the deletion matrix into per-pair signals, keeping only deletions
 *  large enough to be more than typo-correction noise. */
export function revisionDepthSignals(
  deletionOverwrite: Map<AuthorId, Map<AuthorId | null, number>>
): RevisionDepthSignal[] {
  const signals: RevisionDepthSignal[] = [];
  for (const [actorId, targets] of deletionOverwrite) {
    for (const [targetId, deletedCount] of targets) {
      if (deletedCount >= REVISION_DEPTH_NARRATION_THRESHOLD) {
        signals.push({ actorId, targetId, deletedCount });
      }
    }
  }
  return signals.sort((a, b) => b.deletedCount - a.deletedCount);
}

export const PASTE_HEAVY_FRACTION = 0.5;

export interface AuthorContributionProfile {
  authorId: AuthorId;
  originatedChars: number;
  totalSurvivingChars: number;
  originShare: number;
  weightedOriginatedChars: number;
  totalWeightedChars: number;
  weightedOriginShare: number;
  sectionsTouched: number;
  totalSections: number;
  revisionBreadth: number;
  primarySectionIndices: number[];
  pasteCount: number;
  pastedChars: number;
  charsDeletedOfOthers: number;
  lateConcentration: LateConcentrationSignal | null;
  quarantinedSessionCount: number;
  isIntegratorPattern: boolean;
  isPasteHeavy: boolean;
  isLowOriginLateBurst: boolean;
}

export interface ContributionProfileInputs {
  sections: Section[];
  footprints: AuthorFootprint[];
  pastes: PasteSignal[];
  lateConcentration: LateConcentrationSignal[];
  quarantineSignals: QuarantineSignal[];
  deletionOverwrite: Map<AuthorId, Map<AuthorId | null, number>>;
}

/** Joins the individual signals into one profile per author (including
 *  deleter-only authors), with composite flags judged on the weighted share. */
export function buildContributionProfiles(inputs: ContributionProfileInputs): AuthorContributionProfile[] {
  const { sections, footprints, pastes, lateConcentration, quarantineSignals, deletionOverwrite } = inputs;

  const totalSurvivingChars =
    footprints[0]?.totalSurvivingChars ??
    sections.reduce((sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0), 0);

  const totalWeightedChars = sections.reduce(
    (sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0) * (s.weight ?? 1),
    0
  );

  const authorIds = new Set<AuthorId>();
  for (const f of footprints) authorIds.add(f.authorId);
  for (const p of pastes) authorIds.add(p.authorId);
  for (const l of lateConcentration) authorIds.add(l.authorId);
  for (const actorId of deletionOverwrite.keys()) authorIds.add(actorId);

  const footprintById = new Map(footprints.map((f) => [f.authorId, f]));
  const lateById = new Map(lateConcentration.map((l) => [l.authorId, l]));

  const quarantinedSessionsByAuthor = new Map<AuthorId, number>();
  for (const q of quarantineSignals) {
    const activeAuthors = new Set<AuthorId>(q.session.ops.map((op) => op.authorId));
    for (const id of activeAuthors) {
      quarantinedSessionsByAuthor.set(id, (quarantinedSessionsByAuthor.get(id) ?? 0) + 1);
    }
  }

  const profiles = Array.from(authorIds).map((authorId) => {
    const footprint = footprintById.get(authorId);
    const originatedChars = footprint?.originatedChars ?? 0;
    const originShare = footprint?.originShare ?? 0;

    const primarySectionIndices: number[] = [];
    let weightedOriginatedChars = 0;
    sections.forEach((section, i) => {
      const sectionTotal = Array.from(section.authorship.values()).reduce((a, b) => a + b, 0);
      if (sectionTotal === 0) return;
      const chars = section.authorship.get(authorId) ?? 0;
      weightedOriginatedChars += chars * (section.weight ?? 1);
      if (chars / sectionTotal >= PRIMARY_AUTHOR_SHARE_THRESHOLD) primarySectionIndices.push(i);
    });
    const weightedOriginShare = totalWeightedChars === 0 ? 0 : weightedOriginatedChars / totalWeightedChars;

    const authorPastes = pastes.filter((p) => p.authorId === authorId);
    const pastedChars = authorPastes.reduce((sum, p) => sum + p.length, 0);

    let charsDeletedOfOthers = 0;
    for (const [targetId, count] of deletionOverwrite.get(authorId) ?? []) {
      if (targetId !== authorId) charsDeletedOfOthers += count;
    }

    const late = lateById.get(authorId) ?? null;
    const revisionBreadth = footprint?.revisionBreadth ?? 0;

    return {
      authorId,
      originatedChars,
      totalSurvivingChars,
      originShare,
      weightedOriginatedChars,
      totalWeightedChars,
      weightedOriginShare,
      sectionsTouched: footprint?.sectionsTouched ?? 0,
      totalSections: sections.length,
      revisionBreadth,
      primarySectionIndices,
      pasteCount: authorPastes.length,
      pastedChars,
      charsDeletedOfOthers,
      lateConcentration: late,
      quarantinedSessionCount: quarantinedSessionsByAuthor.get(authorId) ?? 0,
      isIntegratorPattern:
        revisionBreadth >= INTEGRATOR_BREADTH_THRESHOLD && weightedOriginShare < INTEGRATOR_ORIGIN_SHARE_THRESHOLD,
      isPasteHeavy: authorPastes.length > 0 && pastedChars >= PASTE_HEAVY_FRACTION * Math.max(originatedChars, 1),
      isLowOriginLateBurst: weightedOriginShare < CONTRIBUTOR_SHARE_THRESHOLD && late !== null,
    };
  });

  return profiles.sort((a, b) => b.weightedOriginShare - a.weightedOriginShare);
}

/** C2: any author version history won't name is the grader's own account — the
 *  account running the extension always appears unnamed there — so it is excluded
 *  from assessment alongside the professor's manually-checked co-instructors.
 *  Covers both authors Google reports as anonymous (null) and authors no response
 *  named at all (absent); giving one a name promotes them back to a student. */
export function graderExcludedAuthorIds(
  authorIds: AuthorId[],
  names: Record<AuthorId, string | null>,
  manuallyExcluded: AuthorId[] = []
): Set<AuthorId> {
  const excluded = new Set<AuthorId>(manuallyExcluded);
  for (const id of authorIds) {
    if (!names[id]) excluded.add(id);
  }
  return excluded;
}

export interface ExcludedAuthorSummary {
  authorId: AuthorId;
  excludedChars: number;
}

/** Removes the given authors (the grader/instructor) from every section's
 *  authorship map POST-replay, returning how many characters each removed. */
export function excludeAuthorsFromSections(
  sections: Section[],
  excludedIds: Set<AuthorId>
): { sections: Section[]; excluded: ExcludedAuthorSummary[] } {
  if (excludedIds.size === 0) return { sections, excluded: [] };
  const excludedChars = new Map<AuthorId, number>();
  const filtered = sections.map((section) => {
    const authorship = new Map(section.authorship);
    for (const id of excludedIds) {
      const n = authorship.get(id);
      if (n) {
        excludedChars.set(id, (excludedChars.get(id) ?? 0) + n);
        authorship.delete(id);
      }
    }
    return { ...section, authorship };
  });
  const excluded = Array.from(excludedChars, ([authorId, chars]) => ({ authorId, excludedChars: chars })).sort(
    (a, b) => b.excludedChars - a.excludedChars
  );
  return { sections: filtered, excluded };
}

export interface ExclusionInputs {
  sections: Section[];
  pastes: PasteSignal[];
  lateConcentration: LateConcentrationSignal[];
  concurrentEdits: ConcurrentEditSignal[];
  deletionOverwrite: Map<AuthorId, Map<AuthorId | null, number>>;
}

/** Strips excluded authors from the sections AND every op-derived signal so
 *  they appear nowhere in the assessment; never filters the mutation log itself. */
export function applyExclusions(
  inputs: ExclusionInputs,
  excludedIds: Set<AuthorId>
): ExclusionInputs & { excluded: ExcludedAuthorSummary[] } {
  if (excludedIds.size === 0) return { ...inputs, excluded: [] };
  const { sections, excluded } = excludeAuthorsFromSections(inputs.sections, excludedIds);
  const deletionOverwrite = new Map(
    Array.from(inputs.deletionOverwrite).filter(([actor]) => !excludedIds.has(actor))
  );
  return {
    sections,
    pastes: inputs.pastes.filter((p) => !excludedIds.has(p.authorId)),
    lateConcentration: inputs.lateConcentration.filter((l) => !excludedIds.has(l.authorId)),
    concurrentEdits: inputs.concurrentEdits.filter((c) => !excludedIds.has(c.authorA) && !excludedIds.has(c.authorB)),
    deletionOverwrite,
    excluded,
  };
}

export const CONCURRENT_EDIT_WINDOW_MS = 2000;
export const CONCURRENT_EDIT_POSITION_DISTANCE = 5;

export interface ConcurrentEditSignal {
  authorA: AuthorId;
  authorB: AuthorId;
  timestampA: number;
  timestampB: number;
  positionA: number;
  positionB: number;
}

/** Flags pairs of inserts from different authors within the concurrency window
 *  and position distance — a boundary where attribution confidence is lowest. */
export function detectConcurrentEditBoundaries(ops: MutationLog): ConcurrentEditSignal[] {
  const inserts = ops.filter((op): op is InsertOp => op.type === "insert").sort((a, b) => a.timestamp - b.timestamp);
  const signals: ConcurrentEditSignal[] = [];

  for (let i = 0; i < inserts.length; i++) {
    const a = inserts[i]!;
    for (let j = i + 1; j < inserts.length; j++) {
      const b = inserts[j]!;
      if (b.timestamp - a.timestamp > CONCURRENT_EDIT_WINDOW_MS) break;
      if (b.authorId === a.authorId) continue;
      if (Math.abs(b.position - a.position) <= CONCURRENT_EDIT_POSITION_DISTANCE) {
        signals.push({
          authorA: a.authorId,
          authorB: b.authorId,
          timestampA: a.timestamp,
          timestampB: b.timestamp,
          positionA: a.position,
          positionB: b.position,
        });
      }
    }
  }

  return signals;
}

// -------------------------------------------------------------- narration

const DISCLAIMER =
  "This tool measures on-document editing only. It cannot detect off-document work, " +
  "in-person contribution, or content drafted elsewhere and pasted in. Use as evidence, not as a verdict.";

export interface RuledSentence {
  ruleId: string;
  text: string;
}

/** Formats a share fraction as a rounded percentage string.
 *  0.847 renders as "85%". */
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** Formats a part-of-whole as "part/whole (rounded %)" so readers see both
 *  the raw scale and the proportion; a zero whole reads as 0%. */
function ratio(part: number, whole: number): string {
  return `${part}/${whole} (${pct(whole === 0 ? 0 : part / whole)})`;
}

/** Returns the resolved display name for an author, or "author <id>" when
 *  unresolved — never an invented name. */
function authorLabel(authorId: AuthorId, names: Record<AuthorId, string | null>): string {
  return names[authorId] ?? `author ${authorId}`;
}

/** Returns "this calculations/discussion section" when the section's form is
 *  known, or the generic "this section" for the newline fallback. */
function sectionDescriptor(section: Section): string {
  if (!section.formClassification) return "this section";
  return `this ${section.formClassification} section`;
}

/** Narrates one section's authorship: one sentence per contributing author by
 *  descending share, plus an explicit unknown-origin sentence when applicable. */
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

/** Narrates the integrator pattern (broad edits, little origination) as a data
 *  observation without an author label — the profile card heading names them. */
export function narrateIntegratorPattern(
  footprint: Pick<AuthorFootprint, "revisionBreadth" | "originShare" | "isIntegratorPattern">
): RuledSentence | null {
  if (!footprint.isIntegratorPattern) return null;
  return {
    ruleId: "F7.4-integrator-pattern",
    text:
      `Edited ${pct(footprint.revisionBreadth)} of the document's sections but originated only ` +
      `${pct(footprint.originShare)} of its surviving text — a pattern consistent with integrating or ` +
      `reformatting others' work rather than drafting original content. This describes what the edit data ` +
      `shows, not a conclusion about effort or contribution.`,
  };
}

/** Narrates one large single-action insert as a length-and-manner observation,
 *  explicitly noting the tool cannot distinguish self-paste from external paste. */
export function narratePaste(signal: PasteSignal, names: Record<AuthorId, string | null>): RuledSentence {
  return {
    ruleId: "F4.1-paste",
    text:
      `${authorLabel(signal.authorId, names)} inserted ${signal.length} characters in a single action — consistent ` +
      `with pasted text rather than typing, though the tool cannot distinguish a paste of the author's own prior work ` +
      `from text drafted elsewhere.`,
  };
}

/** Narrates a quarantined session as a reliability caveat about a time range,
 *  never about a person. */
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

/** Narrates the late-concentration timing observation as a profile card line;
 *  "their" refers to the card's author. */
export function narrateLateConcentration(signal: LateConcentrationSignal): RuledSentence {
  return {
    ruleId: "F6.4-late-concentration",
    text:
      `${pct(signal.lateFraction)} of their edits occurred in the final ` +
      `${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the document's overall editing timeline.`,
  };
}

/** Narrates one actor-deleted-target's-characters pair as a depth-of-revision
 *  observation, naming an unknown-origin target explicitly rather than guessing. */
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

/** Narrates a concurrent-edit boundary as reduced attribution confidence at a
 *  time+position, not a verdict on who edited first. */
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

/** Narrates each per-author card line from the contribution profile: overview,
 *  patterns, and caveats, all name-free since the card heading carries the name. */
export function narrateAuthorProfile(profile: AuthorContributionProfile): RuledSentence[] {
  const sentences: RuledSentence[] = [];

  sentences.push({
    ruleId: "F6.1-author-overview",
    text:
      `Created ${ratio(Math.round(profile.weightedOriginatedChars), Math.round(profile.totalWeightedChars))} of the ` +
      `document's form-weighted content (tables, figures and lists count for more than plain prose), with surviving ` +
      `text in ${ratio(profile.sectionsTouched, profile.totalSections)} sections.`,
  });

  if (profile.primarySectionIndices.length > 0) {
    sentences.push({
      ruleId: "F7.3-primary-sections",
      text:
        `Is the primary author (at least ${pct(PRIMARY_AUTHOR_SHARE_THRESHOLD)} of surviving characters) of ` +
        `${ratio(profile.primarySectionIndices.length, profile.totalSections)} sections.`,
    });
  }

  const integrator = narrateIntegratorPattern({
    revisionBreadth: profile.revisionBreadth,
    originShare: profile.weightedOriginShare,
    isIntegratorPattern: profile.isIntegratorPattern,
  });
  if (integrator) sentences.push(integrator);

  if (profile.lateConcentration) {
    sentences.push(narrateLateConcentration(profile.lateConcentration));
  }

  if (profile.isLowOriginLateBurst && profile.lateConcentration) {
    sentences.push({
      ruleId: "F6-low-origin-late-burst",
      text:
        `Taken together, they created ${pct(profile.weightedOriginShare)} of the document's form-weighted content with ` +
        `${pct(profile.lateConcentration.lateFraction)} of their edits landing in the final ` +
        `${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the editing timeline — low surviving contribution combined ` +
        `with late-concentrated activity. These are on-document signals only; what they mean for the student's ` +
        `actual role is the professor's judgment.`,
    });
  }

  if (profile.isPasteHeavy) {
    sentences.push({
      ruleId: "F4-paste-heavy",
      text:
        `A large amount of pasted content: ${profile.pastedChars} characters across ${profile.pasteCount} ` +
        `separate events, against ${profile.originatedChars} surviving characters they originated — much of their ` +
        `text arrived wholesale rather than being typed incrementally. The tool cannot distinguish pasting one's ` +
        `own drafted work from text drafted elsewhere.`,
    });
  }

  if (profile.charsDeletedOfOthers >= REVISION_DEPTH_NARRATION_THRESHOLD) {
    sentences.push({
      ruleId: "F6.3-revision-summary",
      text:
        `Deleted ${profile.charsDeletedOfOthers} characters they did not originate ` +
        `(other authors' text or text of unknown origin) while revising.`,
    });
  }

  if (profile.quarantinedSessionCount > 0) {
    sentences.push({
      ruleId: "F3.2-author-quarantine-note",
      text:
        `Was active in ${profile.quarantinedSessionCount} session(s) in which a large portion of the document ` +
        `was deleted — attribution for activity in those sessions is less reliable (see Signals).`,
    });
  }

  if (profile.weightedOriginShare < CONTRIBUTOR_SHARE_THRESHOLD) {
    sentences.push({
      ruleId: "C5-limited-observed-activity",
      text:
        `The captured edit history shows relatively little surviving text from this contributor. This tool sees ` +
        `on-document editing only — drafting elsewhere, research, discussion, and in-person contribution are ` +
        `invisible to it, and absence of captured edits is not evidence of absence of contribution.`,
    });
  }

  return sentences;
}

/** Narrates a grader/instructor exclusion with its character count, so the
 *  exclusion is reported and auditable rather than silently applied. */
export function narrateExclusion(
  summary: ExcludedAuthorSummary,
  names: Record<AuthorId, string | null>
): RuledSentence {
  const isAnonymous = names[summary.authorId] === null || names[summary.authorId] === undefined;
  const reason = isAnonymous
    ? `it is anonymous/unattributable in version history — the account running the extension appears ` +
      `anonymous, so this is the grader's own account (name them under "Who counts as a student" to ` +
      `count them as a student instead)`
    : `it was marked as a co-instructor/TA`;
  return {
    ruleId: "C2-grader-excluded",
    text:
      `${authorLabel(summary.authorId, names)}'s edits are excluded from this assessment because ${reason} — ` +
      `${summary.excludedChars} surviving characters, counted in no contribution share.`,
  };
}

export interface AuthorProfileNarration {
  authorId: AuthorId;
  label: string;
  sentences: RuledSentence[];
}

export interface SectionNarration {
  paragraph: number;
  sentences: RuledSentence[];
  headingText: string | null;
}

export interface NarrationReport {
  disclaimer: string;
  exclusions: RuledSentence[];
  authorProfiles: AuthorProfileNarration[];
  sections: SectionNarration[];
  signalNotes: string[];
  signalSentences: RuledSentence[];
  ruleTrace: RuledSentence[];
}

export interface NarrationInputs {
  sections: Section[];
  profiles: AuthorContributionProfile[];
  pastes: PasteSignal[];
  quarantineSignals: QuarantineSignal[];
  revisionDepth: RevisionDepthSignal[];
  concurrentEdits: ConcurrentEditSignal[];
  exclusions?: ExcludedAuthorSummary[];
  names: Record<AuthorId, string | null>;
}

/** Assembles the full narration report: exclusion notes, per-author profile
 *  cards, per-section sentences, event-level signals, and the flat rule trace. */
export function buildNarrationReport(inputs: NarrationInputs): NarrationReport {
  const { names } = inputs;

  const exclusions: RuledSentence[] = (inputs.exclusions ?? []).map((e) => narrateExclusion(e, names));

  const authorProfiles: AuthorProfileNarration[] = inputs.profiles.map((profile) => ({
    authorId: profile.authorId,
    label: authorLabel(profile.authorId, names),
    sentences: narrateAuthorProfile(profile),
  }));

  const sections: SectionNarration[] = inputs.sections.map((section, i) => ({
    paragraph: i + 1,
    sentences: narrateSection(section, names),
    headingText: sectionHeadingText(section),
  }));

  const signalSentences: RuledSentence[] = [
    ...inputs.pastes.map((p) => narratePaste(p, names)),
    ...inputs.quarantineSignals.map((q) => narrateQuarantine(q)),
    ...inputs.revisionDepth.map((r) => narrateRevisionDepth(r, names)),
    ...inputs.concurrentEdits.map((c) => narrateConcurrentEdit(c, names)),
  ];

  return {
    disclaimer: DISCLAIMER,
    exclusions,
    authorProfiles,
    sections,
    signalNotes: signalSentences.map((s) => s.text),
    signalSentences,
    ruleTrace: [
      ...exclusions,
      ...authorProfiles.flatMap((p) => p.sentences),
      ...sections.flatMap((s) => s.sentences),
      ...signalSentences,
    ],
  };
}

// ----------------------------------------------------------------- export

export interface ExportedSection {
  sectionLabel: string;
  sentences: string[];
}

export interface ExportedAuthorSummary {
  authorId: AuthorId;
  authorName: string | null;
  sentences: string[];
}

export interface AuthorCount {
  authorId: AuthorId;
  authorName: string | null;
  originatedChars: number;
  totalSurvivingChars: number;
  originShare: number;
}

export interface ContentStrippedSummary {
  disclaimer: string;
  generatedAt: number;
  exclusionNotes: string[];
  authorSummaries: ExportedAuthorSummary[];
  sections: ExportedSection[];
  signalNotes: string[];
  authorCounts: AuthorCount[];
}

/** Reduces a narration report to the only shape allowed to leave the extension:
 *  narration text, counts, and short section labels — never prose or raw mutations. */
export function toContentStrippedSummary(
  narration: NarrationReport,
  footprints: AuthorFootprint[],
  names: Record<AuthorId, string | null> = {},
  now: () => number = Date.now
): ContentStrippedSummary {
  return {
    disclaimer: narration.disclaimer,
    generatedAt: now(),
    exclusionNotes: narration.exclusions.map((s) => s.text),
    authorSummaries: narration.authorProfiles.map((p) => ({
      authorId: p.authorId,
      authorName: names[p.authorId] ?? null,
      sentences: p.sentences.map((sentence) => sentence.text),
    })),
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
