import type { AuthorId } from "../types/mutation";
import { survivingCharacterMap, type LiveChar } from "../replay";

/**
 * DOCS API STRUCTURAL ELEMENTS (EXTENSION.MD F5.1-F5.4) and SECTION
 * SEGMENTATION — combined into one module since both concern how a document
 * is divided into sections for per-section authorship reporting.
 *
 * The Docs API is Google's officially documented public API so the response-
 * shape understanding here is high-confidence (unlike the internal
 * revisions/load endpoint). F5.1: the fetch requests ONLY structural metadata
 * via a `fields` param (index ranges, paragraph style, table dimensions) —
 * never paragraph text content (C1: "structure requests — never keystroke
 * content").
 *
 * UNCONFIRMED ASSUMPTION: the Docs API's startIndex/endIndex (UTF-16 code
 * units into the document body) align with the character positions is/ds ops
 * and the replay engine use. Both are Google Docs' own internal indexing —
 * reasonable expectation, not yet validated against a real document (ME.MD).
 *
 * Two segmentation strategies are available:
 *   segmentByDocsStructure  — heading-delimited ranges from the Docs API
 *   segmentIntoParagraphs   — newline-boundary fallback when Docs API hasn't run
 */

// ── Docs API types ───────────────────────────────────────────────────────────

export interface DocsApiParagraphStyle {
  namedStyleType?: string;
}

export interface DocsApiParagraph {
  paragraphStyle?: DocsApiParagraphStyle;
}

export interface DocsApiTable {
  rows?: number;
  columns?: number;
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
  "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,table.rows,table.columns)";

/** Builds the Docs API URL requesting only structural metadata, never paragraph text. */
export function documentsApiUrl(documentId: string): string {
  return `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(DOCS_API_FIELDS)}`;
}

/** Fetches structural metadata for a document (headings, tables, index ranges only). */
export async function fetchDocumentStructure(
  documentId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<DocsApiDocument> {
  const res = await fetchImpl(documentsApiUrl(documentId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DocsApiError(`Docs API documents.get failed: ${res.status}`);
  return (await res.json()) as DocsApiDocument;
}

/** F5.4 note: TITLE/SUBTITLE are document-level, not section headings —
 *  deliberately excluded so a document title doesn't open a spurious section. */
const HEADING_LEVELS: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

export type ElementKind = "heading" | "paragraph" | "table";

export interface ClassifiedElement {
  kind: ElementKind;
  /** Only set when kind === "heading". */
  level?: number;
  startIndex: number;
  endIndex: number;
}

/** F5.1/F5.2: classifies each structural element by kind — never by guessing subject matter (F5.3). */
export function classifyElements(content: DocsApiStructuralElement[]): ClassifiedElement[] {
  const classified: ClassifiedElement[] = [];
  for (const el of content) {
    if (el.startIndex === undefined || el.endIndex === undefined) continue;
    if (el.table) {
      classified.push({ kind: "table", startIndex: el.startIndex, endIndex: el.endIndex });
      continue;
    }
    if (el.paragraph) {
      const namedStyle = el.paragraph.paragraphStyle?.namedStyleType;
      const level = namedStyle ? HEADING_LEVELS[namedStyle] : undefined;
      classified.push(
        level !== undefined
          ? { kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex }
          : { kind: "paragraph", startIndex: el.startIndex, endIndex: el.endIndex }
      );
    }
  }
  return classified;
}

export interface HeadingDelimitedRange {
  startIndex: number;
  endIndex: number;
  /** null = content before the document's first heading. */
  headingLevel: number | null;
  /** F5.3: a table anywhere in this range marks it as "calculations" form. */
  containsTable: boolean;
}

/** F5.4: groups classified elements into heading-delimited ranges; content before
 *  the first heading becomes a leading range with headingLevel: null, never dropped. */
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

/** F5.3: classifies a range by FORM only (table present = "calculations") — never by prose content. */
export function classifyForm(range: HeadingDelimitedRange): FormClassification {
  return range.containsTable ? "calculations" : "discussion/theory";
}

// ── Section segmentation ─────────────────────────────────────────────────────

export interface Section {
  /** Index into the final character sequence, inclusive. */
  start: number;
  /** Index into the final character sequence, exclusive. */
  end: number;
  /** Reconstructed text of this section; unknown-origin characters render as U+FFFD. */
  text: string;
  /** Surviving character count per origin-author, scoped to this section only. */
  authorship: Map<AuthorId | null, number>;
  /** F5.4/F5.3: only set by segmentByDocsStructure; undefined for the newline fallback. */
  headingLevel?: number | null;
  formClassification?: FormClassification;
}

const UNKNOWN_CHAR_PLACEHOLDER = "�";

/** Reconstructs plain text from a char slice, rendering unknown-origin chars as U+FFFD. */
function reconstructText(chars: LiveChar[]): string {
  return chars.map((c) => c.char ?? UNKNOWN_CHAR_PLACEHOLDER).join("");
}

/** Builds a Section from a char slice, computing per-author character counts for that range. */
function buildSection(chars: LiveChar[], start: number, end: number): Section {
  const slice = chars.slice(start, end);
  return { start, end, text: reconstructText(slice), authorship: survivingCharacterMap(slice) };
}

/** Splits the final character sequence into paragraph-level sections at newline
 *  boundaries. A doc with no trailing newline still gets its final span as a section. */
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

/** F5.1-F5.4: segments by Docs API heading-delimited ranges instead of newlines.
 *  Ranges are clamped to chars.length rather than thrown on misalignment (see module docstring). */
export function segmentByDocsStructure(chars: LiveChar[], ranges: HeadingDelimitedRange[]): Section[] {
  return ranges.map((range) => {
    const start = Math.min(range.startIndex, chars.length);
    const end = Math.min(range.endIndex, chars.length);
    return { ...buildSection(chars, start, end), headingLevel: range.headingLevel, formClassification: classifyForm(range) };
  });
}

/** Returns the first line of a section's text when it has a real heading (C1 scoped exception,
 *  2026-06-29: short heading text only, never the prose body). Returns null when there's no
 *  heading or the heading line is blank — never fabricates a label. */
export function sectionHeadingText(section: Section): string | null {
  if (section.headingLevel === null || section.headingLevel === undefined) return null;
  const firstLine = section.text.split("\n")[0]?.trim();
  return firstLine ? firstLine : null;
}
