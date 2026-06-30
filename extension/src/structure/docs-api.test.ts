import { describe, expect, it, vi } from "vitest";
import {
  classifyElements,
  classifyForm,
  documentsApiUrl,
  fetchDocumentStructure,
  sectionsFromHeadings,
  type DocsApiStructuralElement,
} from ".";

describe("documentsApiUrl", () => {
  it("requests only structural metadata fields, never paragraph text", () => {
    const url = documentsApiUrl("doc123");
    expect(url).toContain("https://docs.googleapis.com/v1/documents/doc123");
    expect(url).toContain("startIndex");
    expect(url).toContain("namedStyleType");
    expect(url).not.toContain("textRun");
    expect(url).not.toContain("content)"); // i.e. not requesting the full content with text
  });
});

describe("fetchDocumentStructure", () => {
  it("sends the bearer token and returns the parsed document", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-123");
      expect(String(url)).toContain("doc123");
      return { ok: true, status: 200, json: async () => ({ body: { content: [] } }) } as unknown as Response;
    });
    const doc = await fetchDocumentStructure("doc123", "token-123", fetchImpl as unknown as typeof fetch);
    expect(doc).toEqual({ body: { content: [] } });
  });

  it("throws a clear error on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(fetchDocumentStructure("doc123", "token", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /documents.get failed: 403/
    );
  });
});

describe("classifyElements", () => {
  it("classifies headings by level, tables, and plain paragraphs", () => {
    const content: DocsApiStructuralElement[] = [
      { startIndex: 0, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" } } },
      { startIndex: 10, endIndex: 20, paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } },
      { startIndex: 20, endIndex: 30, table: { rows: 2, columns: 2 } },
    ];
    expect(classifyElements(content)).toEqual([
      { kind: "heading", level: 1, startIndex: 0, endIndex: 10 },
      { kind: "paragraph", startIndex: 10, endIndex: 20 },
      { kind: "table", startIndex: 20, endIndex: 30 },
    ]);
  });

  it("excludes TITLE/SUBTITLE from heading levels (document-level, not section headings)", () => {
    const content: DocsApiStructuralElement[] = [
      { startIndex: 0, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: "TITLE" } } },
    ];
    expect(classifyElements(content)).toEqual([{ kind: "paragraph", startIndex: 0, endIndex: 10 }]);
  });

  it("skips elements with no index range rather than guessing one", () => {
    const content: DocsApiStructuralElement[] = [{ paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } }];
    expect(classifyElements(content)).toEqual([]);
  });
});

describe("sectionsFromHeadings (F5.4)", () => {
  it("groups elements into heading-delimited ranges", () => {
    const elements = classifyElements([
      { startIndex: 0, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" } } },
      { startIndex: 10, endIndex: 20, paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } },
      { startIndex: 20, endIndex: 30, paragraph: { paragraphStyle: { namedStyleType: "HEADING_2" } } },
      { startIndex: 30, endIndex: 40, paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } },
    ]);
    expect(sectionsFromHeadings(elements)).toEqual([
      { startIndex: 0, endIndex: 20, headingLevel: 1, containsTable: false },
      { startIndex: 20, endIndex: 40, headingLevel: 2, containsTable: false },
    ]);
  });

  it("keeps content before the first heading as a leading range, not dropped", () => {
    const elements = classifyElements([
      { startIndex: 0, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } },
      { startIndex: 10, endIndex: 20, paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" } } },
    ]);
    expect(sectionsFromHeadings(elements)).toEqual([
      { startIndex: 0, endIndex: 10, headingLevel: null, containsTable: false },
      { startIndex: 10, endIndex: 20, headingLevel: 1, containsTable: false },
    ]);
  });

  it("marks a range as containing a table even when the table isn't the first element", () => {
    const elements = classifyElements([
      { startIndex: 0, endIndex: 10, paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" } } },
      { startIndex: 10, endIndex: 20, paragraph: { paragraphStyle: { namedStyleType: "NORMAL_TEXT" } } },
      { startIndex: 20, endIndex: 30, table: { rows: 1, columns: 1 } },
    ]);
    expect(sectionsFromHeadings(elements)[0]?.containsTable).toBe(true);
  });

  it("returns nothing for an empty document", () => {
    expect(sectionsFromHeadings([])).toEqual([]);
  });
});

describe("classifyForm (F5.3)", () => {
  it("classifies a range with a table as 'calculations'", () => {
    expect(classifyForm({ startIndex: 0, endIndex: 10, headingLevel: null, containsTable: true })).toBe("calculations");
  });

  it("classifies a range without a table as 'discussion/theory'", () => {
    expect(classifyForm({ startIndex: 0, endIndex: 10, headingLevel: null, containsTable: false })).toBe("discussion/theory");
  });
});
