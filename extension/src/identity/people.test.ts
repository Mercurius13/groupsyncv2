import { describe, expect, it, vi } from "vitest";
import { buildAuthUrl, extractAccessToken, OAUTH_SCOPE, parseBatchGetResponse, resolveAuthorNames } from "./people";

describe("buildAuthUrl", () => {
  it("builds an implicit-grant auth URL requesting both the contacts and Docs API scopes in one consent flow", () => {
    const url = new URL(buildAuthUrl("client-1", "https://abc.chromiumapp.org/"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://abc.chromiumapp.org/");
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.get("scope")).toBe(OAUTH_SCOPE);
    expect(OAUTH_SCOPE).toContain("contacts.readonly");
    expect(OAUTH_SCOPE).toContain("documents.readonly");
  });
});

describe("extractAccessToken", () => {
  it("pulls the access_token out of the redirect URL's fragment", () => {
    const redirected = "https://abc.chromiumapp.org/#access_token=ya29.abc123&token_type=Bearer&expires_in=3599";
    expect(extractAccessToken(redirected)).toBe("ya29.abc123");
  });

  it("returns null when there is no access_token in the fragment", () => {
    expect(extractAccessToken("https://abc.chromiumapp.org/#error=access_denied")).toBeNull();
  });
});

describe("parseBatchGetResponse", () => {
  it("resolves display names by matching requestedResourceName", () => {
    const result = parseBatchGetResponse(["111", "222"], {
      responses: [
        { requestedResourceName: "people/111", person: { resourceName: "people/111", names: [{ displayName: "Ada Lovelace" }] } },
      ],
    });
    expect(result).toEqual([
      { authorId: "111", displayName: "Ada Lovelace" },
      { authorId: "222", displayName: null },
    ]);
  });

  it("never invents a name when a person has no names field", () => {
    const result = parseBatchGetResponse(["111"], {
      responses: [{ requestedResourceName: "people/111", person: { resourceName: "people/111" } }],
    });
    expect(result).toEqual([{ authorId: "111", displayName: null }]);
  });

  it("returns all-unresolved for an empty responses array", () => {
    expect(parseBatchGetResponse(["111", "222"], {})).toEqual([
      { authorId: "111", displayName: null },
      { authorId: "222", displayName: null },
    ]);
  });
});

describe("resolveAuthorNames", () => {
  it("returns an empty array without calling fetch when there are no author ids", async () => {
    const fetchImpl = vi.fn();
    expect(await resolveAuthorNames("token", [], fetchImpl as unknown as typeof fetch)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the bearer token and requested resourceNames, and parses the response", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-123");
      expect(String(url)).toContain("resourceNames=people%2F111");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          responses: [
            { requestedResourceName: "people/111", person: { names: [{ displayName: "Grace Hopper" }] } },
          ],
        }),
      } as unknown as Response;
    });

    const result = await resolveAuthorNames("token-123", ["111"], fetchImpl as unknown as typeof fetch);
    expect(result).toEqual([{ authorId: "111", displayName: "Grace Hopper" }]);
  });

  it("throws a clear error when the People API call fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response);
    await expect(resolveAuthorNames("token", ["111"], fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      /People API batchGet failed: 403/
    );
  });
});
