import type { AuthorId } from "../types/mutation";

/**
 * Resolves the numeric Google account IDs seen in the collab stream to
 * display names via the People API — the only name-resolution path
 * HANDOVER.md C1 sanctions ("the only network calls the extension may
 * make are to Google's own People API and Docs API... carrying IDs and
 * structure requests — never keystroke content").
 *
 * Uses chrome.identity.launchWebAuthFlow (implicit grant, no client secret)
 * rather than chrome.identity.getAuthToken, because the existing
 * GOOGLE_CLIENT_ID (shared with backend/config.py) is a Web-application
 * OAuth client, not a Chrome-App client — getAuthToken requires the latter.
 * launchWebAuthFlow's redirect URI (chrome.identity.getRedirectURL(), a
 * https://<extension-id>.chromiumapp.org/ URL) MUST be added to that OAuth
 * client's "Authorized redirect URIs" in Google Cloud Console before this
 * will work — a manual console step, not something this code can do.
 *
 * UNCONFIRMED, validate before relying on this for real students:
 * people.getBatchGet reliably resolves the signed-in user's own profile and
 * contacts/connections. Whether it resolves an arbitrary doc collaborator
 * who is NOT a contact (the common classroom case) is not confirmed. If
 * live testing shows it can't, the likely fallback is the Drive API's file
 * permissions list (every editor with doc access, keyed by
 * email/displayName/photoLink) — but that needs a host_permissions addition
 * (www.googleapis.com) and an update to HANDOVER.md C1's endpoint list, not
 * a silent addition on top of this module.
 */

const PEOPLE_API_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
/** F5.1: read-only structural access for Docs API (structure/docs-api.ts) —
 *  requested in the SAME consent flow as the People API scope so the
 *  professor only sees one OAuth prompt covering both features. */
const DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
export const OAUTH_SCOPE = `${PEOPLE_API_SCOPE} ${DOCS_API_SCOPE}`;

export function buildAuthUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: OAUTH_SCOPE,
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Pulls the access_token out of launchWebAuthFlow's redirected-to URL
 *  (implicit grant returns it in the URL fragment, not a query param). */
export function extractAccessToken(redirectedToUrl: string): string | null {
  const hash = new URL(redirectedToUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("access_token");
}

export async function getAccessToken(clientId: string): Promise<string> {
  const redirectUri = chrome.identity.getRedirectURL();
  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(clientId, redirectUri),
    interactive: true,
  });
  if (!resultUrl) throw new Error("OAuth flow was cancelled or returned no redirect");
  const token = extractAccessToken(resultUrl);
  if (!token) throw new Error("OAuth redirect did not include an access_token");
  return token;
}

export interface PersonResult {
  authorId: AuthorId;
  /** null = unresolved. Never invent or guess a name (C5-style conservatism
   *  extended to identity, not just authorship). */
  displayName: string | null;
}

interface PeopleApiPerson {
  resourceName?: string;
  names?: { displayName?: string }[];
}
interface PeopleApiBatchResponse {
  responses?: { person?: PeopleApiPerson; requestedResourceName?: string }[];
}

export function parseBatchGetResponse(authorIds: AuthorId[], body: PeopleApiBatchResponse): PersonResult[] {
  const byResource = new Map<string, string | null>();
  for (const entry of body.responses ?? []) {
    const resourceName = entry.requestedResourceName ?? entry.person?.resourceName;
    if (!resourceName) continue;
    byResource.set(resourceName, entry.person?.names?.[0]?.displayName ?? null);
  }
  return authorIds.map((authorId) => ({
    authorId,
    displayName: byResource.get(`people/${authorId}`) ?? null,
  }));
}

export async function resolveAuthorNames(
  accessToken: string,
  authorIds: AuthorId[],
  fetchImpl: typeof fetch = fetch
): Promise<PersonResult[]> {
  if (authorIds.length === 0) return [];
  const params = new URLSearchParams({ personFields: "names" });
  for (const id of authorIds) params.append("resourceNames", `people/${id}`);

  const res = await fetchImpl(`https://people.googleapis.com/v1/people:batchGet?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`People API batchGet failed: ${res.status}`);
  }
  const body = (await res.json()) as PeopleApiBatchResponse;
  return parseBatchGetResponse(authorIds, body);
}
