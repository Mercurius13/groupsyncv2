/** Pulls the Google Doc ID out of a docs.google.com URL.
 *  Handles editor URLs (/document/d/<id>/edit) and internal save/bind URLs
 *  (/document/u/0/d/<id>/save) where an account-index segment precedes the ID. */
export function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1]! : null;
}
