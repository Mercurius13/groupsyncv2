import { describe, expect, it } from "vitest";
import { parseOutboundSaveBody } from "./index";

// Real captured POST bodies to .../document/d/<id>/save, 2026-06-19.
const INSERT_BODY =
  "id=1UikDwMqRFZm18Gsji-lX-ql6Toqt5Ncy&sid=479f1a2054914e00&vc=1&c=1&w=1&flr=0" +
  "&rev=6611&bundles=" +
  encodeURIComponent(
    JSON.stringify([{ commands: [{ ty: "is", ibi: 2323, s: "e" }], sid: "479f1a2054914e00", reqId: 50 }])
  );

const DELETE_BODY =
  "id=1UikDwMqRFZm18Gsji-lX-ql6Toqt5Ncy&sid=479f1a2054914e00&vc=1&c=1&w=1&flr=0" +
  "&rev=6612&bundles=" +
  encodeURIComponent(
    JSON.stringify([{ commands: [{ ty: "ds", si: 2323, ei: 2323 }], sid: "479f1a2054914e00", reqId: 51 }])
  );

describe("parseOutboundSaveBody", () => {
  it("parses an insert-string command", () => {
    const ops = parseOutboundSaveBody(INSERT_BODY, { authorId: "author-1", timestamp: 1000 });
    expect(ops).toEqual([
      { type: "insert", authorId: "author-1", timestamp: 1000, position: 2323, text: "e" },
    ]);
  });

  it("parses a delete-string command", () => {
    const ops = parseOutboundSaveBody(DELETE_BODY, { authorId: "author-1", timestamp: 2000 });
    expect(ops).toEqual([
      { type: "delete", authorId: "author-1", timestamp: 2000, range: { start: 2323, end: 2323 } },
    ]);
  });

  it("returns an empty array when bundles is absent (no edits this round-trip, not an error)", () => {
    expect(parseOutboundSaveBody("id=abc&rev=1", { authorId: "author-1", timestamp: 0 })).toEqual([]);
  });

  it("skips unknown command types instead of guessing", () => {
    const body =
      "bundles=" + encodeURIComponent(JSON.stringify([{ commands: [{ ty: "mystery", x: 1 }], sid: "s", reqId: 1 }]));
    expect(parseOutboundSaveBody(body, { authorId: "author-1", timestamp: 0 })).toEqual([]);
  });

  it("throws a clear, specific error when 'bundles' is present but not valid JSON (F1.5)", () => {
    const body = "bundles=" + encodeURIComponent("{not valid json");
    expect(() => parseOutboundSaveBody(body, { authorId: "author-1", timestamp: 0 })).toThrow(
      /capture format may have changed/
    );
  });

  it("unwraps a real 'mlti' bundle into multiple ops instead of dropping them", () => {
    // Lifted from a real captured push-channel frame structure (same command
    // vocabulary as save) — a single backspace burst as three "ds" sub-commands.
    const body =
      "bundles=" +
      encodeURIComponent(
        JSON.stringify([
          {
            commands: [
              {
                ty: "mlti",
                mts: [
                  { ty: "ds", si: 10, ei: 10 },
                  { ty: "ds", si: 9, ei: 9 },
                ],
              },
            ],
            sid: "s",
            reqId: 1,
          },
        ])
      );
    const ops = parseOutboundSaveBody(body, { authorId: "author-1", timestamp: 5 });
    expect(ops).toEqual([
      { type: "delete", authorId: "author-1", timestamp: 5, range: { start: 10, end: 10 } },
      { type: "delete", authorId: "author-1", timestamp: 5, range: { start: 9, end: 9 } },
    ]);
  });
});
