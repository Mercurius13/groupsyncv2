/**
 * Runs in the page's own MAIN world (not the extension's isolated world) so
 * it can patch the page's real XMLHttpRequest before Google Docs' own JS
 * starts using it. Captures only request/response data for the two
 * confirmed-real internal collaboration endpoints — save (outbound) and
 * bind (inbound realtime push channel) — and posts it to the page (picked
 * up by content/index.ts, the isolated-world relay, and forwarded to the
 * background script). Never touches any other request.
 *
 * Both endpoints are confirmed XHR/BrowserChannel transport (TYPE=xmlhttp
 * present in their query string) from real captured traffic — see
 * src/capture/wire-types.ts.
 */
(() => {
  type Kind = "save" | "bind";

  const URL_PATTERNS: [RegExp, Kind][] = [
    [/\/document\/d\/[^/]+\/save(\?|$)/, "save"],
    [/\/document\/d\/[^/]+\/bind(\?|$)/, "bind"],
  ];

  function classify(url: string): Kind | null {
    for (const [pattern, kind] of URL_PATTERNS) {
      if (pattern.test(url)) return kind;
    }
    return null;
  }

  /** XHR.open accepts URLs relative to the page — resolve to absolute before
   *  this ever leaves the page context, so every downstream consumer can
   *  rely on it always being a full URL. */
  function toAbsoluteUrl(url: string): string {
    return new URL(url, window.location.href).toString();
  }

  function postCapture(kind: Kind, url: string, requestBody: string | null, responseText: string): void {
    try {
      window.postMessage(
        { source: "groupsync-inject", kind, url, requestBody, responseText, timestamp: Date.now() },
        window.location.origin
      );
    } catch (err) {
      console.warn("[GroupSync inject] postCapture failed", err);
    }
  }

  console.log("[GroupSync inject] active, watching for save/bind requests");

  const tracked = new WeakMap<XMLHttpRequest, { url: string; kind: Kind }>();
  const OriginalXHR = window.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
    const kind = classify(url);
    if (kind) tracked.set(this, { url: toAbsoluteUrl(url), kind });
    return (originalOpen as (...args: unknown[]) => unknown).apply(this, [method, url, ...rest]);
  } as typeof OriginalXHR.prototype.open;

  OriginalXHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = tracked.get(this);
    if (info) {
      const requestBody = info.kind === "save" && typeof body === "string" ? body : null;
      this.addEventListener("loadend", () => postCapture(info.kind, info.url, requestBody, this.responseText));
    }
    return originalSend.call(this, body as never);
  };
})();
