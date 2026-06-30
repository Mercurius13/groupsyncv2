import { describe, expect, it, vi } from "vitest";
import {
  fetchFilePermissions,
  filePermissionsUrl,
  matchPermissionsToAuthorIds,
  resolveAuthorNamesViaDrive,
} from ".";

describe("filePermissionsUrl", () => {
  it("requests only metadata fields, never file content", () => {
    const url = filePermissionsUrl("doc123");
    expect(url).toContain("https://www.googleapis.com/drive/v3/files/doc123/permissions");
    expect(url).toContain("displayName");
    expect(url).toContain("emailAddress");
  });
});

describe("fetchFilePermissions", () => {
  it("sends the bearer token and returns the permissions list", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-123");
      expect(String(url)).toContain("doc123");
      return {
        ok: true,
        status: 200,
        json: async () => ({ permissions: [{ id: "111", displayName: "Ada Lovelace", type: "user" }] }),
      } as unknown as Response;
    });
    const permissions = await fetchFilePermissions("doc123", "token-123", fetchImpl as unknown as typeof fetch);
    expect(permissions).toEqual([{ id: "111", displayName: "Ada Lovelace", type: "user" }]);
  });

  it("throws a clear error on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(fetchFilePermissions("doc123", "token", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /permissions.list failed: 403/
    );
  });

  it("returns an empty list when the response has no permissions field", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
    expect(await fetchFilePermissions("doc123", "token", fetchImpl as unknown as typeof fetch)).toEqual([]);
  });
});

describe("matchPermissionsToAuthorIds", () => {
  it("matches by exact permission id, never fuzzy", () => {
    const result = matchPermissionsToAuthorIds(
      ["111", "222"],
      [{ id: "111", displayName: "Ada Lovelace", type: "user" }]
    );
    expect(result).toEqual([
      { authorId: "111", displayName: "Ada Lovelace" },
      { authorId: "222", displayName: null },
    ]);
  });

  it("matches numerically when IDs differ only in leading zeros", () => {
    // Drive may return "3917199682802182266" while the collab stream carries
    // "03917199682802182266" — BigInt comparison strips the leading zero.
    const result = matchPermissionsToAuthorIds(
      ["03917199682802182266"],
      [{ id: "3917199682802182266", displayName: "Ada Lovelace", type: "user" }]
    );
    expect(result).toEqual([{ authorId: "03917199682802182266", displayName: "Ada Lovelace" }]);
  });

  it("falls back to emailAddress when displayName is absent but the permission matched", () => {
    const result = matchPermissionsToAuthorIds(
      ["111"],
      [{ id: "111", emailAddress: "ada@example.com", type: "user" }]
    );
    expect(result).toEqual([{ authorId: "111", displayName: "ada@example.com" }]);
  });

  it("never invents a name when a permission has no displayName or emailAddress", () => {
    const result = matchPermissionsToAuthorIds(["111"], [{ id: "111", type: "user" }]);
    expect(result).toEqual([{ authorId: "111", displayName: null }]);
  });

  it("ignores permissions with no id rather than crashing", () => {
    const result = matchPermissionsToAuthorIds(["111"], [{ displayName: "No ID Here", type: "user" }]);
    expect(result).toEqual([{ authorId: "111", displayName: null }]);
  });
});

describe("resolveAuthorNamesViaDrive", () => {
  it("returns an empty array without calling fetch when there are no author ids", async () => {
    const fetchImpl = vi.fn();
    expect(await resolveAuthorNamesViaDrive("doc1", "token", [], fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches permissions and resolves the requested author ids", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ permissions: [{ id: "111", displayName: "Grace Hopper", type: "user" }] }),
        }) as unknown as Response
    );
    const result = await resolveAuthorNamesViaDrive("doc1", "token", ["111"], fetchImpl as unknown as typeof fetch);
    expect(result).toEqual([{ authorId: "111", displayName: "Grace Hopper" }]);
  });
});
