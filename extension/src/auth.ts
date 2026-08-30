/** The extension's own OAuth client ID. Public by design — an installed extension
 *  cannot hold a secret, and this client is restricted to the read-only scope below. */
const GOOGLE_OAUTH_CLIENT_ID = "1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com";

const DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";

/** Builds the implicit-grant OAuth URL for chrome.identity.launchWebAuthFlow.
 *  Requests read-only Docs structural access only, never content-write scopes. */
function buildAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: DOCS_API_SCOPE,
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Pulls the access_token out of the implicit-grant redirect URL fragment.
 *  Returns null when the fragment carries no token (denied or cancelled flow). */
function extractAccessToken(redirectedToUrl: string): string | null {
  const hash = new URL(redirectedToUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("access_token");
}

/** Runs the OAuth implicit-grant flow and returns an access token for the
 *  Docs API structure fetch, throwing when the flow is cancelled. */
export async function getAccessToken(): Promise<string> {
  const redirectUri = chrome.identity.getRedirectURL();
  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(redirectUri),
    interactive: true,
  });
  if (!resultUrl) throw new Error("OAuth flow was cancelled or returned no redirect");
  const token = extractAccessToken(resultUrl);
  if (!token) throw new Error("OAuth redirect did not include an access_token");
  return token;
}
