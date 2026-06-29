import { describe, expect, it, vi } from "vitest";
import { fetchFullHistory, findMaxRevision, parseRevisionLoadResponse, revisionLoadUrl } from "./history";

// Real envelope, confirmed against a captured response 2026-06-XX (see
// history.ts module docstring): XSSI prefix + one JSON object with
// "chunkedSnapshot" (ignored — no author/timestamp) and "changelog" (the one
// we parse — entries shaped exactly like the bind channel's PushChangeEntry).
function revisionLoadResponse(changelog: unknown[]): string {
  return `)]}'\n${JSON.stringify({ chunkedSnapshot: [], changelog })}`;
}

function mockResponse(res: { ok: boolean; status: number; text: string }): Response {
  return { ok: res.ok, status: res.status, text: async () => res.text } as unknown as Response;
}

function fakeFetch(responses: Map<string, { ok: boolean; status: number; text: string }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const res = responses.get(url);
    if (!res) throw new Error(`unexpected fetch: ${url}`);
    return mockResponse(res);
  });
}

describe("revisionLoadUrl", () => {
  it("builds the documented endpoint shape", () => {
    expect(revisionLoadUrl("doc123", 1, 10)).toBe(
      "https://docs.google.com/document/d/doc123/revisions/load?id=doc123&start=1&end=10"
    );
  });
});

describe("parseRevisionLoadResponse", () => {
  it("strips the XSSI prefix and extracts insert/delete ops from changelog entries", () => {
    const raw = revisionLoadResponse([
      [{ ty: "is", ibi: 0, s: "hi" }, 1000, "author-1", 5, "session-1", 1, null, null, false],
      [{ ty: "ds", si: 0, ei: 1 }, 1001, "author-2", 6, "session-1", 2, null, null, false],
    ]);
    expect(parseRevisionLoadResponse(raw)).toEqual([
      { type: "insert", authorId: "author-1", timestamp: 1000, position: 0, text: "hi" },
      { type: "delete", authorId: "author-2", timestamp: 1001, range: { start: 0, end: 1 } },
    ]);
  });

  it("unwraps mlti entries", () => {
    const raw = revisionLoadResponse([
      [
        { ty: "mlti", mts: [{ ty: "ds", si: 2, ei: 2 }, { ty: "ds", si: 1, ei: 1 }] },
        2000,
        "author-1",
        7,
        "session-1",
        3,
        null,
        null,
        false,
      ],
    ]);
    expect(parseRevisionLoadResponse(raw)).toEqual([
      { type: "delete", authorId: "author-1", timestamp: 2000, range: { start: 2, end: 2 } },
      { type: "delete", authorId: "author-1", timestamp: 2000, range: { start: 1, end: 1 } },
    ]);
  });

  it("ignores chunkedSnapshot entirely, even if present and large", () => {
    const raw = `)]}'\n${JSON.stringify({
      chunkedSnapshot: [[{ ty: "as", st: "paragraph" }, { ty: "ae", et: "list" }]],
      changelog: [[{ ty: "is", ibi: 0, s: "x" }, 1, "author-1", 1, "s", 1, null, null, false]],
    })}`;
    expect(parseRevisionLoadResponse(raw)).toEqual([
      { type: "insert", authorId: "author-1", timestamp: 1, position: 0, text: "x" },
    ]);
  });

  it("returns nothing for an empty response", () => {
    expect(parseRevisionLoadResponse("")).toEqual([]);
  });

  it("returns nothing for an empty changelog array", () => {
    expect(parseRevisionLoadResponse(revisionLoadResponse([]))).toEqual([]);
  });

  it("throws when the body isn't valid JSON after stripping the XSSI prefix", () => {
    expect(() => parseRevisionLoadResponse(")]}'\nnot-json")).toThrow(/envelope may have changed/);
  });

  it("throws when the response has no changelog array", () => {
    expect(() => parseRevisionLoadResponse(`)]}'\n${JSON.stringify({ chunkedSnapshot: [] })}`)).toThrow(
      /no 'changelog' array/
    );
  });
});

describe("findMaxRevision", () => {
  it("grows then binary-searches to find the highest ok revision, even when 'too high' is a 400 not a 500", async () => {
    const maxRev = 13;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const rev = Number(new URL(String(input)).searchParams.get("end"));
      return mockResponse({ ok: rev <= maxRev, status: rev <= maxRev ? 200 : 400, text: "" });
    });
    expect(await findMaxRevision("doc1", fetchImpl)).toBe(maxRev);
  });
});

describe("fetchFullHistory", () => {
  it("finds the revision ceiling, fetches that single page, and parses its ops", async () => {
    const pageUrl = revisionLoadUrl("doc1", 1, 3);
    const probe1 = revisionLoadUrl("doc1", 1, 1);
    const probe2 = revisionLoadUrl("doc1", 2, 2);
    const probe3 = revisionLoadUrl("doc1", 3, 3);
    const probe4 = revisionLoadUrl("doc1", 4, 4);

    const responses = new Map<string, { ok: boolean; status: number; text: string }>([
      [probe1, { ok: true, status: 200, text: "" }],
      [probe2, { ok: true, status: 200, text: "" }],
      [probe3, { ok: true, status: 200, text: "" }],
      [probe4, { ok: false, status: 400, text: "" }],
      [
        pageUrl,
        {
          ok: true,
          status: 200,
          text: revisionLoadResponse([
            [{ ty: "is", ibi: 0, s: "a" }, 1, "author-1", 1, "session-1", 1, null, null, false],
            [{ ty: "is", ibi: 1, s: "b" }, 2, "author-1", 2, "session-1", 2, null, null, false],
          ]),
        },
      ],
    ]);

    const ops = await fetchFullHistory("doc1", fakeFetch(responses) as unknown as typeof fetch);
    expect(ops).toEqual([
      { type: "insert", authorId: "author-1", timestamp: 1, position: 0, text: "a" },
      { type: "insert", authorId: "author-1", timestamp: 2, position: 1, text: "b" },
    ]);
  });
});
