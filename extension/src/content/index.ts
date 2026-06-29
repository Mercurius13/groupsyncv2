/**
 * Isolated-world content script. Listens for the captures that inject.ts
 * (running in the page's MAIN world) posts via window.postMessage, and
 * forwards them to the background script — postMessage can't reach the
 * background directly, chrome.runtime.sendMessage can't be called from the
 * MAIN world, so this script is the bridge between the two.
 */
console.log("[GroupSync relay] active, listening for postMessage from inject.ts");

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data as { source?: string; kind?: string } | undefined;
  if (data?.source !== "groupsync-inject") return;

  console.log("[GroupSync relay] forwarding capture to background", data.kind);
  chrome.runtime.sendMessage({ type: "groupsync-capture", payload: data }).catch((err) => {
    console.warn("[GroupSync relay] sendMessage to background failed", err);
  });
});
