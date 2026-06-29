"use strict";
(() => {
  // src/content/index.ts
  console.log("[GroupSync relay] active, listening for postMessage from inject.ts");
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== "groupsync-inject") return;
    console.log("[GroupSync relay] forwarding capture to background", data.kind);
    chrome.runtime.sendMessage({ type: "groupsync-capture", payload: data }).catch((err) => {
      console.warn("[GroupSync relay] sendMessage to background failed", err);
    });
  });
})();
