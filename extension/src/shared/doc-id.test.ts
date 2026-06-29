import { describe, expect, it } from "vitest";
import { extractDocId } from "./doc-id";

describe("extractDocId", () => {
  it("extracts the doc id from an /edit URL", () => {
    expect(extractDocId("https://docs.google.com/document/d/1UikDwMqRFZm18Gsji-lX-ql6Toqt5Ncy/edit")).toBe(
      "1UikDwMqRFZm18Gsji-lX-ql6Toqt5Ncy"
    );
  });

  it("extracts the doc id from a /save or /bind URL with query params", () => {
    expect(
      extractDocId("https://docs.google.com/document/u/0/d/abc123/save?id=abc123&sid=x")
    ).toBe("abc123");
    expect(extractDocId("https://docs.google.com/document/u/0/d/abc123/bind?id=abc123")).toBe("abc123");
  });

  it("returns null for a non-document URL", () => {
    expect(extractDocId("https://docs.google.com/spreadsheets/d/abc123/edit")).toBeNull();
  });
});
