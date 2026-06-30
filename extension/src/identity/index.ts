import type { AuthorId } from "../types/mutation";

/**
 * AUTHOR NAME RESOLUTION — two-stage pipeline (background/index.ts orchestrates both):
 *
 * Stage 1 — People API: resolves Gaia IDs for the professor's own contacts and connections.
 * Confirmed 2026-06-29 to return all-null for typical classroom collaborators who aren't
 * in the professor's contacts — the common case.
 *
 * Stage 2 — Drive permissions fallback: fetches named permissions for THIS specific file,
 * which includes every editor granted explicit access regardless of contacts status.
 * Uses metadata-only scope (drive.metadata.readonly) — never reads file content (C1).
 *
 * Both paths use chrome.identity.launchWebAuthFlow (implicit grant, no client secret)
 * because the OAuth client ID is a Web-application client, not a Chrome-App client.
 * The extension's redirect URI must be added to the client's Authorized redirect URIs
 * in Google Cloud Console — a one-time manual step (see HANDOVER.md).
 *
 * CONFIRMED LIMITATION: Drive permission IDs and collab-stream Gaia IDs are in different
 * namespaces — matching is attempted via exact string, then BigInt numeric comparison
 * (for leading-zero encoding differences), then email fallback. If all fail, the author
 * ID stays unresolved and the professor can label it manually in the popup.
 */

// ── OAuth ────────────────────────────────────────────────────────────────────

const PEOPLE_API_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
/** F5.1: read-only structural access — requested in the same consent flow so the
 *  professor sees one prompt covering name resolution AND structure fetching. */
const DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
/** Drive fallback name resolution — metadata-only, no file content access (C1). */
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

/** Space-separated scope string covering all three OAuth needs in one consent prompt. */
export const OAUTH_SCOPE = `${PEOPLE_API_SCOPE} ${DOCS_API_SCOPE} ${DRIVE_METADATA_SCOPE}`;

/** Builds an implicit-grant auth URL for chrome.identity.launchWebAuthFlow. */
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

/** Pulls the access_token out of launchWebAuthFlow's redirect URL fragment (implicit grant). */
export function extractAccessToken(redirectedToUrl: string): string | null {
  const hash = new URL(redirectedToUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("access_token");
}

/** Runs the OAuth implicit grant flow and returns the access token, throwing if cancelled. */
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

// ── People API ───────────────────────────────────────────────────────────────

export interface PersonResult {
  authorId: AuthorId;
  /** null = unresolved; never invented — absence of a name is reported as-is (C5). */
  displayName: string | null;
}

interface PeopleApiPerson {
  resourceName?: string;
  names?: { displayName?: string }[];
}
interface PeopleApiBatchResponse {
  responses?: { person?: PeopleApiPerson; requestedResourceName?: string }[];
}

/** Maps People API batchGet response entries back to the requested author IDs. */
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

/** Resolves Gaia IDs to display names via People API batchGet (contacts/connections only). */
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
  if (!res.ok) throw new Error(`People API batchGet failed: ${res.status}`);
  const body = (await res.json()) as PeopleApiBatchResponse;
  return parseBatchGetResponse(authorIds, body);
}

// ── Drive API permissions fallback ───────────────────────────────────────────

export interface DrivePermission {
  id?: string;
  displayName?: string;
  emailAddress?: string;
  type?: string;
}

interface DrivePermissionsListResponse {
  permissions?: DrivePermission[];
}

export class DriveApiError extends Error {}

const DRIVE_FIELDS = "permissions(id,displayName,emailAddress,type)";

/** Builds the Drive API URL requesting only identity metadata for a file's permissions. */
export function filePermissionsUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=${encodeURIComponent(DRIVE_FIELDS)}`;
}

/** Fetches all named permissions for a Drive file (metadata-only scope). */
export async function fetchFilePermissions(
  fileId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<DrivePermission[]> {
  const res = await fetchImpl(filePermissionsUrl(fileId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DriveApiError(`Drive API permissions.list failed: ${res.status}`);
  const body = (await res.json()) as DrivePermissionsListResponse;
  return body.permissions ?? [];
}

/** Matches Drive permission records to author IDs via three-tier strategy:
 *  (1) exact string, (2) BigInt numeric (strips leading-zero encoding differences),
 *  (3) emailAddress as display-name fallback when displayName is absent. */
export function matchPermissionsToAuthorIds(authorIds: AuthorId[], permissions: DrivePermission[]): PersonResult[] {
  console.log(`[GroupSync drive] ${permissions.length} permission(s) to match against ${authorIds.length} author id(s)`);

  const byStringId = new Map<string, DrivePermission>();
  for (const perm of permissions) {
    if (perm.id) byStringId.set(perm.id, perm);
  }

  const permsByBigInt = new Map<bigint, DrivePermission>();
  for (const [id, perm] of byStringId) {
    try { permsByBigInt.set(BigInt(id), perm); } catch { /* non-numeric id — skip */ }
  }

  return authorIds.map((authorId) => {
    let matched = byStringId.get(authorId);
    if (!matched) {
      try { matched = permsByBigInt.get(BigInt(authorId)); } catch { /* not numeric */ }
    }
    const displayName = matched?.displayName ?? matched?.emailAddress ?? null;
    console.log(`[GroupSync drive] authorId=${authorId} matched=${matched?.id ?? "none"} -> "${displayName ?? "null"}"`);
    return { authorId, displayName };
  });
}

/** Resolves author IDs to names via Drive file permissions (fallback when People API returns nulls). */
export async function resolveAuthorNamesViaDrive(
  fileId: string,
  accessToken: string,
  authorIds: AuthorId[],
  fetchImpl: typeof fetch = fetch
): Promise<PersonResult[]> {
  if (authorIds.length === 0) return [];
  const permissions = await fetchFilePermissions(fileId, accessToken, fetchImpl);
  return matchPermissionsToAuthorIds(authorIds, permissions);
}
