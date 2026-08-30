"use strict";
(() => {
  // src/inject.ts
  (() => {
    const URL_PATTERNS = [
      [/\/document\/d\/[^/]+\/save(\?|$)/, "save"],
      [/\/document\/d\/[^/]+\/bind(\?|$)/, "bind"],
      [/\/document\/(?:u\/\d+\/)?d\/[^/]+\/revisions\/tiles(\?|$)/, "tiles"]
    ];
    function classify(url) {
      for (const [pattern, kind] of URL_PATTERNS) {
        if (pattern.test(url)) return kind;
      }
      return null;
    }
    function toAbsoluteUrl(url) {
      return new URL(url, window.location.href).toString();
    }
    function postCapture(kind, url, requestBody, responseText) {
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
    const tracked = /* @__PURE__ */ new WeakMap();
    const OriginalXHR = window.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    OriginalXHR.prototype.open = function(method, url, ...rest) {
      const kind = classify(url);
      if (kind) tracked.set(this, { url: toAbsoluteUrl(url), kind });
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    OriginalXHR.prototype.send = function(body) {
      const info = tracked.get(this);
      if (info) {
        const requestBody = info.kind === "save" && typeof body === "string" ? body : null;
        this.addEventListener("loadend", () => postCapture(info.kind, info.url, requestBody, this.responseText));
      }
      return originalSend.call(this, body);
    };
    function fetchUrlOf(input) {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      return input.url;
    }
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      const url = fetchUrlOf(input);
      const kind = classify(url);
      const promise = originalFetch.call(this, input, init);
      if (!kind) return promise;
      const absolute = toAbsoluteUrl(url);
      const requestBody = kind === "save" && typeof init?.body === "string" ? init.body : null;
      return promise.then((res) => {
        res.clone().text().then((responseText) => postCapture(kind, absolute, requestBody, responseText)).catch((err) => console.warn("[GroupSync inject] fetch body read failed", err));
        return res;
      });
    };
  })();
})();
