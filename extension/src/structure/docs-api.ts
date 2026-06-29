/**
 * DOCS API STRUCTURAL ELEMENTS (EXTENSION.MD F5.1-F5.4) — real headings,
 * tables, and lists instead of newline-only paragraph splitting. Unlike the
 * internal `revisions/load` endpoint, the Docs API is Google's OFFICIALLY
 * DOCUMENTED public API (https://developers.google.com/docs/api/reference/rest/v1/documents),
 * so this module's understanding of the response shape is high-confidence,
 * not a reverse-engineering guess — though it's still never been called
 * against a real document from this extension, so the index-alignment
 * assumption below is flagged for live validation (see ME.MD).
 *
 * F5.1: fetch via `fields` query param requesting ONLY structural metadata
 * (index ranges, paragraph style, table dimensions) — never paragraph text
 * content. This is "structure requests — never keystroke content" per C1.
 *
 * UNCONFIRMED ASSUMPTION: the Docs API's `startIndex`/`endIndex` (UTF-16
 * code units into the document body) align with the character positions
 * `is`/`ds` ops and this extension's replay engine already use. Both are
 * Google Docs' own internal indexing, so this is a reasonable expectation,
 * not a wild guess — but it has not been checked against a real document.
 */

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

const FIELDS = "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,table.rows,table.columns)";

export function documentsApiUrl(documentId: string): string {
  return `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(FIELDS)}`;
}

export async function fetchDocumentStructure(
  documentId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<DocsApiDocument> {
  const res = await fetchImpl(documentsApiUrl(documentId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new DocsApiError(`Docs API documents.get failed: ${res.status}`);
  }
  return (await res.json()) as DocsApiDocument;
}

/** F5.4 note: TITLE/SUBTITLE are document-level, not section headings —
 *  deliberately excluded so a doc's title doesn't open a spurious section. */
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

/** F5.1/F5.2: classifies each structural element by kind only — never by
 *  guessing subject matter (F5.3 forbids that). Elements missing index
 *  ranges are skipped rather than guessed at. */
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
      if (level !== undefined) {
        classified.push({ kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex });
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
  /** null = content before the document's first heading. */
  headingLevel: number | null;
  /** F5.3: a table anywhere in this range marks it "calculations" form. */
  containsTable: boolean;
}

/** F5.4: section boundaries are heading-delimited ranges — a single
 *  isolated, swappable function, per spec. Each heading starts a new range
 *  that absorbs every following non-heading element until the next
 *  heading. Content before the first heading becomes a leading range with
 *  headingLevel: null, not dropped. */
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

/** F5.3: classify by FORM only (presence of a table) — never by claiming to
 *  know what the prose is about. */
export function classifyForm(range: HeadingDelimitedRange): FormClassification {
  return range.containsTable ? "calculations" : "discussion/theory";
}
