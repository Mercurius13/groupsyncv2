/** Single source of truth for pulling the Google Doc ID out of a docs.google.com
 *  URL — used by both the background script (keying accumulated ops) and the
 *  popup (figuring out which doc the active tab is showing). The editor URL
 *  (.../document/d/<id>/edit) omits the "/u/<n>/" account-index segment that
 *  the internal save/bind URLs include (.../document/u/0/d/<id>/save), so
 *  both forms need to match. */
export function extractDocId(url: string): string | null {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1]! : null;
}
