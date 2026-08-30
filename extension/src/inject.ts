(() => {
  type Kind = "save" | "bind" | "tiles";

  const URL_PATTERNS: [RegExp, Kind][] = [
    [/\/document\/d\/[^/]+\/save(\?|$)/, "save"],
    [/\/document\/d\/[^/]+\/bind(\?|$)/, "bind"],
    [/\/document\/(?:u\/\d+\/)?d\/[^/]+\/revisions\/tiles(\?|$)/, "tiles"],
  ];

  /** Matches a request URL against the watched internal-endpoint patterns.
   *  Returns the endpoint kind, or null for every other request. */
  function classify(url: string): Kind | null {
    for (const [pattern, kind] of URL_PATTERNS) {
      if (pattern.test(url)) return kind;
    }
    return null;
  }

  /** Resolves a possibly page-relative request URL to an absolute URL so
   *  downstream consumers can always parse it. */
  function toAbsoluteUrl(url: string): string {
    return new URL(url, window.location.href).toString();
  }

  /** Posts one captured request/response to the isolated-world relay via
   *  window.postMessage, which forwards it to the background worker. */
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

  console.log("[GroupSync inject] active, watching for save/bind/tiles requests");

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

  /** Resolves the request URL from the several shapes fetch() accepts (string,
   *  URL, or Request), so the same classifier works for XHR and fetch. */
  function fetchUrlOf(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
  }

  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = fetchUrlOf(input);
    const kind = classify(url);
    const promise = originalFetch.call(this, input as RequestInfo, init);
    if (!kind) return promise;
    const absolute = toAbsoluteUrl(url);
    const requestBody = kind === "save" && typeof init?.body === "string" ? init.body : null;
    return promise.then((res) => {
      res
        .clone()
        .text()
        .then((responseText) => postCapture(kind, absolute, requestBody, responseText))
        .catch((err) => console.warn("[GroupSync inject] fetch body read failed", err));
      return res;
    });
  } as typeof window.fetch;
})();
