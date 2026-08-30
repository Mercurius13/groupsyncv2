import type { AuthorId } from "./capture";
import { survivingCharacterMap, type LiveChar } from "./replay";

export interface DocsApiParagraphStyle {
  namedStyleType?: string;
}

export interface DocsApiBullet {
  listId?: string;
}

export interface DocsApiParagraph {
  paragraphStyle?: DocsApiParagraphStyle;
  bullet?: DocsApiBullet;
}

export interface DocsApiTableCell {
  startIndex?: number;
  endIndex?: number;
}

export interface DocsApiTableRow {
  tableCells?: DocsApiTableCell[];
}

export interface DocsApiTable {
  rows?: number;
  columns?: number;
  tableRows?: DocsApiTableRow[];
}

export interface DocsApiStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsApiParagraph;
  table?: DocsApiTable;
}

export interface DocsApiDocument {
  body?: { content?: DocsApiStructuralElement[] };
}

export class DocsApiError extends Error {}

const DOCS_API_FIELDS =
  "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,paragraph.bullet.listId,table.rows,table.columns,table.tableRows.tableCells(startIndex,endIndex))";

/** Builds the Docs API documents.get URL with a fields mask requesting only
 *  structural metadata — index ranges, styles, list bullets, table dimensions — never text. */
export function documentsApiUrl(documentId: string): string {
  return `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(DOCS_API_FIELDS)}`;
}

/** Fetches a document's structural metadata (headings, tables, lists, index
 *  ranges only) from the Docs API. */
export async function fetchDocumentStructure(
  documentId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<DocsApiDocument> {
  const res = await fetchImpl(documentsApiUrl(documentId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DocsApiError(`Docs API documents.get failed: ${res.status}`);
  return (await res.json()) as DocsApiDocument;
}

const HEADING_LEVELS: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

export type ElementKind = "heading" | "paragraph" | "list" | "table";

export interface CellRange {
  startIndex: number;
  endIndex: number;
}

export interface ClassifiedElement {
  kind: ElementKind;
  level?: number;
  startIndex: number;
  endIndex: number;
  cells?: CellRange[];
}

/** Collects each table cell's index range from the Docs API tableRows so a table
 *  can be attributed cell-by-cell while still displaying as one collapsed unit. */
function tableCellRanges(table: DocsApiTable): CellRange[] {
  const cells: CellRange[] = [];
  for (const row of table.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) {
      if (cell.startIndex !== undefined && cell.endIndex !== undefined) {
        cells.push({ startIndex: cell.startIndex, endIndex: cell.endIndex });
      }
    }
  }
  return cells;
}

/** Classifies each top-level structural element by kind; a table is ONE element
 *  spanning all its cells, which is what keeps unit counts at real-element level. */
export function classifyElements(content: DocsApiStructuralElement[]): ClassifiedElement[] {
  const classified: ClassifiedElement[] = [];
  for (const el of content) {
    if (el.startIndex === undefined || el.endIndex === undefined) continue;
    if (el.table) {
      classified.push({ kind: "table", startIndex: el.startIndex, endIndex: el.endIndex, cells: tableCellRanges(el.table) });
      continue;
    }
    if (el.paragraph) {
      const namedStyle = el.paragraph.paragraphStyle?.namedStyleType;
      const level = namedStyle ? HEADING_LEVELS[namedStyle] : undefined;
      if (level !== undefined) {
        classified.push({ kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex });
      } else if (el.paragraph.bullet) {
        classified.push({ kind: "list", startIndex: el.startIndex, endIndex: el.endIndex });
      } else {
        classified.push({ kind: "paragraph", startIndex: el.startIndex, endIndex: el.endIndex });
      }
    }
  }
  return classified;
}

export interface HeadingDelimitedRange {
  startIndex: number;
  endIndex: number;
  headingLevel: number | null;
  containsTable: boolean;
}

/** Groups classified elements into heading-delimited ranges; content before the
 *  first heading becomes a leading null-level range, never dropped. */
export function sectionsFromHeadings(elements: ClassifiedElement[]): HeadingDelimitedRange[] {
  const ranges: HeadingDelimitedRange[] = [];
  let current: HeadingDelimitedRange | null = null;

  for (const el of elements) {
    if (el.kind === "heading") {
      if (current) ranges.push(current);
      current = { startIndex: el.startIndex, endIndex: el.endIndex, headingLevel: el.level ?? null, containsTable: false };
      continue;
    }
    if (!current) {
      current = { startIndex: el.startIndex, endIndex: el.endIndex, headingLevel: null, containsTable: el.kind === "table" };
    } else {
      current.endIndex = el.endIndex;
      if (el.kind === "table") current.containsTable = true;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

export type FormClassification = "calculations" | "discussion/theory";

/** Classifies a heading-delimited range by form only: any table inside makes
 *  it "calculations", otherwise "discussion/theory" — never by subject matter. */
export function classifyForm(range: HeadingDelimitedRange): FormClassification {
  return range.containsTable ? "calculations" : "discussion/theory";
}

export const WEIGHT_TABLE = 3;
export const WEIGHT_NUMERIC = 1.5;
export const WEIGHT_LIST = 1.25;
export const WEIGHT_PARAGRAPH = 1;
export const WEIGHT_HEADING = 1;
export const NUMERIC_DIGIT_FRACTION = 0.3;

export type ContentForm = "table" | "numeric" | "list" | "prose" | "heading";

/** Computes the fraction of a text's non-whitespace characters that are ASCII
 *  digits, the input to numeric-content promotion. */
function digitFraction(text: string): number {
  let digits = 0;
  let nonSpace = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (ch >= "0" && ch <= "9") digits++;
  }
  return nonSpace === 0 ? 0 : digits / nonSpace;
}

/** Maps a structural kind plus locally reconstructed text to a content form and
 *  its named weight; digit-dense paragraphs and list items promote to "numeric". */
export function classifyContentForm(kind: ElementKind, text: string): { contentForm: ContentForm; weight: number } {
  switch (kind) {
    case "table":
      return { contentForm: "table", weight: WEIGHT_TABLE };
    case "heading":
      return { contentForm: "heading", weight: WEIGHT_HEADING };
    case "list":
      return digitFraction(text) >= NUMERIC_DIGIT_FRACTION
        ? { contentForm: "numeric", weight: WEIGHT_NUMERIC }
        : { contentForm: "list", weight: WEIGHT_LIST };
    case "paragraph":
    default:
      return digitFraction(text) >= NUMERIC_DIGIT_FRACTION
        ? { contentForm: "numeric", weight: WEIGHT_NUMERIC }
        : { contentForm: "prose", weight: WEIGHT_PARAGRAPH };
  }
}

/** Derives the two-way narration form hedge from the finer content form:
 *  table/numeric read as "calculations", everything else as "discussion/theory". */
function formClassificationOf(contentForm: ContentForm): FormClassification {
  return contentForm === "table" || contentForm === "numeric" ? "calculations" : "discussion/theory";
}

export interface Section {
  start: number;
  end: number;
  text: string;
  authorship: Map<AuthorId | null, number>;
  headingLevel?: number | null;
  formClassification?: FormClassification;
  kind?: ElementKind;
  contentForm?: ContentForm;
  weight?: number;
  cellOwnership?: Map<AuthorId | null, number>;
}

const UNKNOWN_CHAR_PLACEHOLDER = "�";

/** Reconstructs plain text from a live-character slice, rendering unknown-origin
 *  characters as the U+FFFD placeholder rather than guessing content. */
function reconstructText(chars: LiveChar[]): string {
  return chars.map((c) => c.char ?? UNKNOWN_CHAR_PLACEHOLDER).join("");
}

/** Builds one Section over a character range, computing that range's
 *  per-origin-author surviving character counts. */
function buildSection(chars: LiveChar[], start: number, end: number): Section {
  const slice = chars.slice(start, end);
  return { start, end, text: reconstructText(slice), authorship: survivingCharacterMap(slice) };
}

/** Splits the final character sequence into one section per newline-terminated
 *  paragraph — the unweighted fallback used until Docs structure is fetched. */
export function segmentIntoParagraphs(chars: LiveChar[]): Section[] {
  const sections: Section[] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]?.char === "\n") {
      sections.push(buildSection(chars, start, i + 1));
      start = i + 1;
    }
  }
  if (start < chars.length) sections.push(buildSection(chars, start, chars.length));
  return sections;
}

/** Reports whether a section holds no real content — only whitespace and
 *  unknown-origin placeholders, as spacer paragraphs do. */
function isBlankSection(text: string): boolean {
  return text.replace(/�/g, "").trim().length === 0;
}

/** Returns a cell's majority origin-author (ties broken toward the earliest
 *  origin, favoring the builder over a reviser) and its real character count. */
function cellOwner(cellChars: LiveChar[]): { authorId: AuthorId | null; realChars: number } | null {
  const counts = new Map<AuthorId | null, number>();
  const earliest = new Map<AuthorId | null, number>();
  let realChars = 0;
  for (const c of cellChars) {
    if (c.char === null) continue;
    realChars++;
    counts.set(c.authorId, (counts.get(c.authorId) ?? 0) + 1);
    if (!earliest.has(c.authorId)) earliest.set(c.authorId, c.charId);
  }
  if (realChars === 0) return null;
  let owner: AuthorId | null = null;
  let bestCount = -1;
  let bestEarliest = Infinity;
  for (const [authorId, count] of counts) {
    const first = earliest.get(authorId) ?? Infinity;
    if (count > bestCount || (count === bestCount && first < bestEarliest)) {
      owner = authorId;
      bestCount = count;
      bestEarliest = first;
    }
  }
  return { authorId: owner, realChars };
}

/** Clamps a Docs API index onto the replayed character array, applying the measured
 *  alignment offset so both spaces are addressed consistently (see alignment.ts). */
function clampIndex(index: number, offset: number, length: number): number {
  return Math.max(0, Math.min(index + offset, length));
}

/** Builds a collapsed table Section whose authorship credits each cell
 *  winner-take-all to its majority origin-author, so a reviser cannot outweigh the builder. */
function buildTableSection(chars: LiveChar[], el: ClassifiedElement, offset: number): Section {
  const start = clampIndex(el.startIndex, offset, chars.length);
  const end = clampIndex(el.endIndex, offset, chars.length);
  const slice = chars.slice(start, end);
  const authorship = new Map<AuthorId | null, number>();
  const cellOwnership = new Map<AuthorId | null, number>();
  for (const cell of el.cells ?? []) {
    const owner = cellOwner(
      chars.slice(clampIndex(cell.startIndex, offset, chars.length), clampIndex(cell.endIndex, offset, chars.length))
    );
    if (!owner) continue;
    authorship.set(owner.authorId, (authorship.get(owner.authorId) ?? 0) + owner.realChars);
    cellOwnership.set(owner.authorId, (cellOwnership.get(owner.authorId) ?? 0) + 1);
  }
  const { contentForm, weight } = classifyContentForm("table", reconstructText(slice));
  return {
    start,
    end,
    text: reconstructText(slice),
    authorship,
    kind: "table",
    headingLevel: null,
    contentForm,
    weight,
    formClassification: formClassificationOf(contentForm),
    cellOwnership,
  };
}

/** Segments by real structural elements — one section per paragraph, list item,
 *  and heading, each table as ONE cell-attributed weighted unit, blank spacers dropped.
 *  `offset` is the alignment shift measured by detectIndexAlignment; callers pass 0 only
 *  when the two index spaces were confirmed to agree. */
export function segmentByElements(chars: LiveChar[], elements: ClassifiedElement[], offset = 0): Section[] {
  const sections: Section[] = [];
  for (const el of elements) {
    const start = clampIndex(el.startIndex, offset, chars.length);
    const end = clampIndex(el.endIndex, offset, chars.length);
    if (end <= start) continue;
    if (el.kind === "table") {
      sections.push(buildTableSection(chars, el, offset));
      continue;
    }
    const base = buildSection(chars, start, end);
    if (isBlankSection(base.text)) continue;
    const { contentForm, weight } = classifyContentForm(el.kind, base.text);
    sections.push({
      ...base,
      kind: el.kind,
      headingLevel: el.kind === "heading" ? el.level ?? null : null,
      contentForm,
      weight,
      formClassification: formClassificationOf(contentForm),
    });
  }
  return sections;
}

/** Segments by heading-delimited Docs API ranges, clamping ranges that overrun
 *  the reconstructed character count rather than throwing. */
export function segmentByDocsStructure(chars: LiveChar[], ranges: HeadingDelimitedRange[]): Section[] {
  return ranges.map((range) => {
    const start = Math.min(range.startIndex, chars.length);
    const end = Math.min(range.endIndex, chars.length);
    return { ...buildSection(chars, start, end), headingLevel: range.headingLevel, formClassification: classifyForm(range) };
  });
}

/** Returns a heading section's first-line text for use as its label — short
 *  navigational text only — or null when the section has no heading. */
export function sectionHeadingText(section: Section): string | null {
  if (section.headingLevel === null || section.headingLevel === undefined) return null;
  const firstLine = section.text.split("\n")[0]?.trim();
  return firstLine ? firstLine : null;
}

/**
 * Validates the assumption that Docs API `startIndex`/`endIndex` address the same
 * index space as the replayed mutation stream. That assumption is what lets
 * segmentByElements slice `LiveChar[]` with Docs API ranges, and nothing else in the
 * pipeline checks it — a silent mismatch would attribute whole sections to the wrong
 * author with full confidence, which is exactly the failure C3/C5 exist to prevent.
 *
 * The probe: in Docs API index space every paragraph, heading and list item ends with
 * a newline, so a correctly aligned replay has `chars[endIndex - 1].char === "\n"`.
 * That is a cheap, doc-independent invariant we can test on real data at runtime.
 */

export const ALIGNMENT_CONFIDENCE_THRESHOLD = 0.9;
export const MAX_PROBE_OFFSET = 8;
export const MIN_CHECKABLE_ELEMENTS = 3;
export const DRIFT_SCORE_GAP = 0.3;

export type AlignmentStatus = "aligned" | "offset" | "misaligned" | "insufficient-data";

export interface AlignmentReport {
  status: AlignmentStatus;
  /** Index shift that best aligns Docs ranges onto the replayed characters; 0 when they already agree. */
  offset: number;
  /** Fraction of checkable elements whose terminal position holds a newline, at `offset`. */
  score: number;
  checked: number;
  firstHalfScore: number;
  secondHalfScore: number;
  /** True when alignment decays through the document — a single global offset cannot fix it. */
  driftDetected: boolean;
}

/** Elements whose Docs range is expected to end on a newline. Tables are excluded:
 *  they are attributed per cell, and their own end index follows structural positions
 *  the mutation parser never emits. */
function isNewlineTerminated(el: ClassifiedElement): boolean {
  return el.kind === "paragraph" || el.kind === "heading" || el.kind === "list";
}

/** Scores one candidate offset: the fraction of newline-terminated elements whose
 *  shifted end position actually lands on a newline. Positions that are out of range
 *  or hold null-origin padding are not counted either way — absence of data is not
 *  evidence of misalignment. */
function scoreOffset(
  chars: LiveChar[],
  elements: ClassifiedElement[],
  offset: number
): { score: number; checked: number; hits: boolean[] } {
  const hits: boolean[] = [];
  for (const el of elements) {
    if (!isNewlineTerminated(el)) continue;
    const position = el.endIndex - 1 + offset;
    if (position < 0 || position >= chars.length) continue;
    const char = chars[position]?.char;
    if (char === null || char === undefined) continue;
    hits.push(char === "\n");
  }
  const checked = hits.length;
  const score = checked === 0 ? 0 : hits.filter(Boolean).length / checked;
  return { score, checked, hits };
}

/** Candidate offsets ordered by increasing magnitude, so a tie always resolves to
 *  the smallest shift rather than an arbitrary larger one. */
function candidateOffsets(): number[] {
  const offsets = [0];
  for (let i = 1; i <= MAX_PROBE_OFFSET; i++) offsets.push(i, -i);
  return offsets;
}

/** Splits a hit sequence in document order and scores each half, so progressive drift
 *  (fine early, wrong after the first table) is distinguishable from a constant shift. */
function halfScores(hits: boolean[]): { firstHalfScore: number; secondHalfScore: number } {
  if (hits.length < 2) return { firstHalfScore: 0, secondHalfScore: 0 };
  const mid = Math.floor(hits.length / 2);
  const first = hits.slice(0, mid);
  const second = hits.slice(mid);
  const rate = (part: boolean[]) => (part.length === 0 ? 0 : part.filter(Boolean).length / part.length);
  return { firstHalfScore: rate(first), secondHalfScore: rate(second) };
}

/** Measures whether the Docs API index space lines up with the replayed character
 *  array, returning the best global offset and how well it holds. Callers apply the
 *  offset when it is trustworthy and fall back to newline paragraphs when it is not. */
export function detectIndexAlignment(chars: LiveChar[], elements: ClassifiedElement[]): AlignmentReport {
  const scored = candidateOffsets().map((offset) => ({ offset, ...scoreOffset(chars, elements, offset) }));

  // A large shift can score perfectly by pushing all but one or two elements out of
  // range. Judge only offsets that keep a real sample; fall back to the widest-sample
  // offset when none does, which surfaces as insufficient-data rather than a false pass.
  const eligible = scored.filter((s) => s.checked >= MIN_CHECKABLE_ELEMENTS);
  const pool = eligible.length > 0 ? eligible : scored;
  const best = pool.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a;
    if (b.checked !== a.checked) return b.checked > a.checked ? b : a;
    return Math.abs(b.offset) < Math.abs(a.offset) ? b : a;
  }, pool[0] ?? { offset: 0, score: 0, checked: 0, hits: [] as boolean[] });

  const { firstHalfScore, secondHalfScore } = halfScores(best.hits);
  const driftDetected = firstHalfScore - secondHalfScore >= DRIFT_SCORE_GAP;

  let status: AlignmentStatus;
  if (best.checked < MIN_CHECKABLE_ELEMENTS) {
    status = "insufficient-data";
  } else if (best.score < ALIGNMENT_CONFIDENCE_THRESHOLD) {
    status = "misaligned";
  } else {
    status = best.offset === 0 ? "aligned" : "offset";
  }

  return {
    status,
    offset: best.offset,
    score: best.score,
    checked: best.checked,
    firstHalfScore,
    secondHalfScore,
    driftDetected,
  };
}

/** Whether structural segmentation may be trusted for this doc. Only a confidently
 *  measured, drift-free alignment qualifies; everything else falls back to unweighted
 *  paragraphs, because a wrong section boundary is worse than a coarse one (C3/C5). */
export function isStructureTrustworthy(report: AlignmentReport): boolean {
  return (report.status === "aligned" || report.status === "offset") && !report.driftDetected;
}

/** One plain sentence explaining the alignment result, for the popup's data-source
 *  card — the professor needs to know when table attribution is not being shown. */
export function describeAlignment(report: AlignmentReport): string {
  const pct = `${Math.round(report.score * 100)}%`;
  switch (report.status) {
    case "aligned":
      return `Document structure lines up with the captured edit history (${pct} of ${report.checked} checked boundaries).`;
    case "offset":
      return report.driftDetected
        ? `Structure indices drift through the document — falling back to newline paragraphs, so tables are not attributed cell-by-cell.`
        : `Document structure lines up after a ${report.offset}-character shift (${pct} of ${report.checked} checked boundaries).`;
    case "misaligned":
      return `Document structure does not line up with the captured edit history (only ${pct} of ${report.checked} checked boundaries matched) — falling back to newline paragraphs rather than risk misattributing sections.`;
    case "insufficient-data":
    default:
      return `Not enough of the document's history was captured to verify that its structure lines up — falling back to newline paragraphs.`;
  }
}
