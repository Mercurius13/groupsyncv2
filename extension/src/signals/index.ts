import type { LiveChar } from "../replay";
import type { Section } from "../structure";
import type { AuthorId, InsertOp, MutationLog, MutationOp } from "../types/mutation";

/**
 * SIGNALS (HANDOVER.md build order step 3, EXTENSION.MD F3/F4/F6/F7).
 * Every threshold below is a named, fixed rule a contesting student can be
 * shown directly (C3) — never an inferred or model-derived judgment.
 * Thresholds are calibrated estimates pending validation against real docs
 * (tracked in ME.MD), not measured constants — if real cases prove them
 * wrong, change the constant here, not the rule's shape.
 *
 * Self-claimed-vs-actual comparison (the other half of F6) is NOT
 * implemented here: it needs a still-undefined input (where would a
 * student's self-claimed section come from? no such data source exists
 * yet) — same reasoning applies to F4.2 (non-roster authorship) and F7.5
 * (missing roster member), which WERE implemented in an earlier version of
 * this module (a manually-typed expected-roster list in the popup) but were
 * removed by decision 2026-06-29: requiring the professor to retype a
 * roster by hand provided little real value and confused the (unrelated,
 * automatic) name-resolution flow. All signals below derive entirely from
 * the mutation log plus People-API/Drive-API-resolved names — no
 * externally-provided roster of any kind.
 */

// ── F4.1 — large-paste detection ───────────────────────────────────────────
// A normal fast typist commits ~50-150 chars per burst; a paste is usually
// 300+. Start at 400 to stay clearly above typing bursts.
export const PASTE_CHAR_THRESHOLD = 400;

export interface PasteSignal {
  authorId: AuthorId;
  timestamp: number;
  position: number;
  length: number;
}

/** Flags any single insert op at or above PASTE_CHAR_THRESHOLD — one atomic
 *  op this large was not typed character-by-character. */
export function detectPastes(ops: MutationLog): PasteSignal[] {
  const signals: PasteSignal[] = [];
  for (const op of ops) {
    if (op.type === "insert" && op.text.length >= PASTE_CHAR_THRESHOLD) {
      signals.push({ authorId: op.authorId, timestamp: op.timestamp, position: op.position, length: op.text.length });
    }
  }
  return signals;
}

// ── F3.1 — whole-doc-replace / quarantine ──────────────────────────────────
// A real heavy edit rarely churns more than ~40-50% of the doc at once; a
// reformat/replace churns close to 100%. Start the line at 50%.
export const QUARANTINE_CHURN_FRACTION = 0.5;
// Ops with a gap longer than this between them are treated as separate
// editing sessions, so churn is measured within one sitting, not summed
// across the whole document's lifetime.
export const SESSION_GAP_MS = 30 * 60 * 1000;

export interface EditSession {
  ops: MutationOp[];
  startTimestamp: number;
  endTimestamp: number;
}

/** Groups a chronologically-ordered mutation log into sessions, splitting
 *  wherever consecutive ops are more than SESSION_GAP_MS apart. */
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

/** F3.1: walks sessions in order, tracking live doc length as a plain
 *  counter (insert adds text.length, delete subtracts range size) — this
 *  only needs a length, not full replay's per-character bookkeeping. Flags
 *  any session whose deletions churn >= QUARANTINE_CHURN_FRACTION of the
 *  doc length as it stood at that session's start. A session starting from
 *  an empty/unknown doc length (0) is skipped — there's no baseline to
 *  measure churn against. */
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

// ── F7.4 — integrator pattern ──────────────────────────────────────────────
// "Touched most sections" means >=60% of sections; "low origin" means <20%
// of surviving characters doc-wide.
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

/** F7.4: "touched a section" is scoped to surviving authorship only — a
 *  deletion's recorded position is in LIVE-document coordinates at the
 *  moment it happened, which does not safely map onto final section
 *  boundaries (computed from the FINAL document), since earlier deletions
 *  shift later positions. Deleted-but-not-surviving activity is therefore
 *  not counted toward breadth here — only "this author has surviving
 *  characters in this section" is a sound, final-document-relative claim. */
export function authorFootprints(sections: Section[], originByPosition: LiveChar[]): AuthorFootprint[] {
  const totalSurvivingChars = originByPosition.length;
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

// ── F7.3 — narration phrasing cutoffs ──────────────────────────────────────
// >=60% origin share is a clear majority ("primarily authored"); 15-60% is
// meaningful-but-minority ("contributed to"); below 15% is "made minor
// edits to".
export const PRIMARY_AUTHOR_SHARE_THRESHOLD = 0.6;
export const CONTRIBUTOR_SHARE_THRESHOLD = 0.15;

export type NarrationPhrase = "primarily authored" | "contributed to" | "made minor edits to";

/** F7.3: pure mapping from an origin share (doc-wide or section-scoped —
 *  caller decides which) to the fixed phrase for that bracket. */
export function narrationPhraseForShare(originShare: number): NarrationPhrase {
  if (originShare >= PRIMARY_AUTHOR_SHARE_THRESHOLD) return "primarily authored";
  if (originShare >= CONTRIBUTOR_SHARE_THRESHOLD) return "contributed to";
  return "made minor edits to";
}

// ── F6.4 — late-concentration flag ─────────────────────────────────────────
// Flags an author whose edits cluster suspiciously late rather than
// spreading across the editing period: >60% of their inserts landing in the
// final 20% of the project's overall timeline.
export const LATE_CONCENTRATION_EDIT_FRACTION = 0.6;
export const LATE_CONCENTRATION_WINDOW_FRACTION = 0.2;

export interface LateConcentrationSignal {
  authorId: AuthorId;
  editsInLateWindow: number;
  totalEdits: number;
  lateFraction: number;
}

/** F6.4: "edits" = insert op count (not characters) per author. The late
 *  window is the final LATE_CONCENTRATION_WINDOW_FRACTION of the full ops
 *  log's own timestamp span — not the author's own span, since the point is
 *  comparing against the whole project's timeline. A zero-width timeline
 *  (every op at the same timestamp) has no meaningful "late" window, so it
 *  produces no signals rather than a degenerate always-true flag. */
export function detectLateConcentration(ops: MutationLog): LateConcentrationSignal[] {
  const inserts = ops.filter((op): op is InsertOp => op.type === "insert");
  if (inserts.length === 0 || ops.length === 0) return [];

  const timestamps = ops.map((op) => op.timestamp);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
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

// ── F6.3 — revision_depth ──────────────────────────────────────────────────
// Below this many characters, a deletion is treated as ordinary editing
// noise (typo backspaces, autocomplete corrections) rather than a notable
// "depth" of revision worth narrating.
export const REVISION_DEPTH_NARRATION_THRESHOLD = 20;

export interface RevisionDepthSignal {
  actorId: AuthorId;
  /** Whose characters were deleted; null = unknown origin. */
  targetId: AuthorId | null;
  deletedCount: number;
}

/** F6.3: turns replay.ts's deletionOverwriteMap (actor -> target -> count)
 *  into a flat, sorted list of signals, filtered to deletions large enough
 *  to be worth narrating. This was already-computed data sitting unused —
 *  no new replay logic, just a named signal on top of it. */
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

// ── F6.6 — concurrency → shared/uncertain attribution ──────────────────────
// Given the confirmed real capture format (every changelog entry already
// carries one definite authorId — see HANDOVER.md's mutation-format-
// dependency section), there is no per-character ambiguity in WHO inserted
// a given character; Google's server has already linearized concurrent
// edits before we ever see them. What IS still genuinely uncertain is
// whether two authors editing within a short window near the same position
// were truly working independently or racing each other — the boundary
// between their insertions is where attribution confidence is lowest. This
// is the closest sound interpretation of F6.6 given the real data shape;
// it flags a time+position boundary, not a single ambiguous character.
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

/** F6.6: flags pairs of inserts from different authors within
 *  CONCURRENT_EDIT_WINDOW_MS of each other and within
 *  CONCURRENT_EDIT_POSITION_DISTANCE characters of each other's insert
 *  position. Compares each insert only to the next few by timestamp
 *  (sorted), not all pairs — still named/auditable, just bounded. */
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
