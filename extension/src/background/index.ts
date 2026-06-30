import { parseOutboundSaveBody, parsePushChannelResponse } from "../capture";
import { fetchFullHistory } from "../capture/history";
import { GOOGLE_OAUTH_CLIENT_ID } from "../config";
import { getAccessToken, resolveAuthorNames, resolveAuthorNamesViaDrive, type PersonResult } from "../identity";
import { classifyElements, fetchDocumentStructure, sectionsFromHeadings, type HeadingDelimitedRange } from "../structure";
import type { AuthorId, MutationOp } from "../types/mutation";
import { extractDocId } from "../utils";

/**
 * Accumulates the captured mutation stream per document in
 * chrome.storage.session — memory-only, cleared on browser close, matching
 * C1 ("raw edit data... is never... persisted in raw form"). The professor's
 * browser, while she has the doc open with Edit access, is the only place
 * this raw stream ever exists.
 */

interface CapturePayload {
  kind: "save" | "bind";
  url: string;
  requestBody: string | null;
  responseText: string;
  timestamp: number;
}

/** Returns the session-storage key for a doc's ops list. */
function opsStorageKey(docId: string): string {
  return `groupsync-ops-${docId}`;
}

/** Reads the stored op list for a doc from session storage (empty array if none). */
async function getStoredOps(docId: string): Promise<MutationOp[]> {
  const key = opsStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as MutationOp[] | undefined) ?? [];
}

/** Appends new ops to the stored list for a doc (no-ops if newOps is empty). */
async function appendOps(docId: string, newOps: MutationOp[]): Promise<void> {
  if (newOps.length === 0) return;
  const key = opsStorageKey(docId);
  const existing = await getStoredOps(docId);
  await chrome.storage.session.set({ [key]: [...existing, ...newOps] });
}

/** The retroactive history fetch (C4) returns the complete authoritative
 *  log, so it REPLACES whatever partial, live-captured ops are stored for
 *  this doc rather than appending — appending would duplicate every op the
 *  live capture already saw. */
async function replaceOps(docId: string, ops: MutationOp[]): Promise<void> {
  await chrome.storage.session.set({ [opsStorageKey(docId)]: ops });
}

/** Returns the session-storage key for a doc's resolved author-name map. */
function namesStorageKey(docId: string): string {
  return `groupsync-names-${docId}`;
}

/** Reads the stored author-name map for a doc from session storage (empty object if none). */
async function getStoredNames(docId: string): Promise<Record<AuthorId, string | null>> {
  const key = namesStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as Record<AuthorId, string | null> | undefined) ?? {};
}

/** Returns the session-storage key for a doc's Docs API structure ranges. */
function structureStorageKey(docId: string): string {
  return `groupsync-structure-${docId}`;
}

/** Reads the stored heading-delimited ranges for a doc (empty array if none fetched yet). */
async function getStoredStructure(docId: string): Promise<HeadingDelimitedRange[]> {
  const key = structureStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as HeadingDelimitedRange[] | undefined) ?? [];
}

/** Dispatches to the outbound or inbound capture parser based on request kind. */
function parseCapture(payload: CapturePayload): MutationOp[] {
  const url = new URL(payload.url);
  const ouid = url.searchParams.get("ouid");
  if (payload.kind === "save" && payload.requestBody) {
    return parseOutboundSaveBody(payload.requestBody, {
      authorId: ouid ?? "local-user",
      timestamp: payload.timestamp,
    });
  }
  if (payload.kind === "bind" && payload.responseText) {
    return parsePushChannelResponse(payload.responseText);
  }
  return [];
}

console.log("[GroupSync background] service worker started, listening for messages");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "groupsync-capture") {
    const payload = message.payload as CapturePayload;
    const docId = extractDocId(payload.url);
    if (!docId) {
      console.warn("[GroupSync background] could not extract docId from URL, dropping capture", payload.url);
      sendResponse({ ok: false });
      return undefined;
    }
    (async () => {
      let ops: MutationOp[] = [];
      try {
        ops = parseCapture(payload);
      } catch (err) {
        // F1.5: surface capture failures clearly rather than silently
        // dropping them — logged here since there's no UI surface yet for
        // capture-layer errors (structure/signals/narration not built yet).
        console.error("[GroupSync background] capture parse failed", payload.kind, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      await appendOps(docId, ops);
      if (ops.length > 0) {
        console.log(`[GroupSync background] appended ${ops.length} op(s) for ${docId} (kind=${payload.kind})`);
      }
      sendResponse({ ok: true });
    })();
    return true; // keep the message channel open for the async response
  }

  if (message?.type === "groupsync-get-ops") {
    const docId = message.docId as string;
    getStoredOps(docId).then((ops) => {
      console.log(`[GroupSync background] groupsync-get-ops for ${docId} -> ${ops.length} op(s)`);
      sendResponse({ ops });
    });
    return true;
  }

  if (message?.type === "groupsync-fetch-history") {
    const docId = message.docId as string;
    (async () => {
      try {
        const { ops, names } = await fetchFullHistory(docId);
        await replaceOps(docId, ops);
        // Store any names the history response included — these come for free
        // from the same request and are more reliable than a separate API call
        // (they come directly from the source that also owns the changelog).
        if (Object.keys(names).length > 0) {
          const stored = await getStoredNames(docId);
          await chrome.storage.session.set({ [namesStorageKey(docId)]: { ...names, ...stored } });
          console.log(`[GroupSync background] stored ${Object.keys(names).length} name(s) from history response`);
        }
        console.log(`[GroupSync background] retroactive history fetch for ${docId} -> ${ops.length} op(s)`);
        sendResponse({ ok: true, count: ops.length });
      } catch (err) {
        console.error("[GroupSync background] retroactive history fetch failed", docId, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "groupsync-get-names") {
    const docId = message.docId as string;
    getStoredNames(docId).then((names) => sendResponse({ names }));
    return true;
  }

  if (message?.type === "groupsync-save-names") {
    const docId = message.docId as string;
    const updates = message.names as Record<AuthorId, string | null>;
    (async () => {
      const existing = await getStoredNames(docId);
      await chrome.storage.session.set({ [namesStorageKey(docId)]: { ...existing, ...updates } });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message?.type === "groupsync-resolve-names") {
    const docId = message.docId as string;
    (async () => {
      try {
        const ops = await getStoredOps(docId);
        const authorIds = Array.from(new Set(ops.map((op) => op.authorId)));
        console.log(`[GroupSync names] starting resolution for ${docId}, ${authorIds.length} author id(s):`, authorIds);

        const accessToken = await getAccessToken(GOOGLE_OAUTH_CLIENT_ID);
        console.log(`[GroupSync names] got access token, length=${accessToken.length}`);

        // Confirmed 2026-06-29: People API alone doesn't resolve non-contact
        // collaborators (the common classroom case) — every name came back
        // null on a real multi-author doc. Fall back to Drive's
        // file-permissions list (identity/drive.ts) for anything People API
        // didn't resolve, rather than reporting "resolved" with all nulls.
        let peopleResults: PersonResult[];
        try {
          peopleResults = await resolveAuthorNames(accessToken, authorIds);
          console.log("[GroupSync names] People API results:", peopleResults);
        } catch (err) {
          console.error("[GroupSync names] People API call itself threw — Drive fallback will still run", err);
          peopleResults = authorIds.map((authorId) => ({ authorId, displayName: null }));
        }

        const stillUnresolved = peopleResults.filter((r) => r.displayName === null).map((r) => r.authorId);
        console.log(`[GroupSync names] still unresolved after People API: ${stillUnresolved.length}`, stillUnresolved);

        let driveResults: PersonResult[] = [];
        if (stillUnresolved.length > 0) {
          try {
            driveResults = await resolveAuthorNamesViaDrive(docId, accessToken, stillUnresolved);
            console.log("[GroupSync names] Drive permissions fallback results:", driveResults);
          } catch (err) {
            console.error("[GroupSync names] Drive permissions fallback failed", err);
          }
        }
        const driveByAuthorId = new Map(driveResults.map((r): [string, PersonResult] => [r.authorId, r]));

        const merged = peopleResults.map((r) => (r.displayName !== null ? r : driveByAuthorId.get(r.authorId) ?? r));

        const names = Object.fromEntries(merged.map((r) => [r.authorId, r.displayName]));
        await chrome.storage.session.set({ [namesStorageKey(docId)]: names });

        const resolvedCount = merged.filter((r) => r.displayName !== null).length;
        console.log(`[GroupSync names] FINAL: resolved ${resolvedCount}/${merged.length} name(s) for ${docId}:`, names);
        sendResponse({ ok: true, names, resolvedCount, totalCount: merged.length });
      } catch (err) {
        console.error("[GroupSync names] name resolution failed outright", docId, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "groupsync-get-structure") {
    const docId = message.docId as string;
    getStoredStructure(docId).then((ranges) => sendResponse({ ranges }));
    return true;
  }

  if (message?.type === "groupsync-fetch-structure") {
    const docId = message.docId as string;
    (async () => {
      try {
        const accessToken = await getAccessToken(GOOGLE_OAUTH_CLIENT_ID);
        const doc = await fetchDocumentStructure(docId, accessToken);
        const elements = classifyElements(doc.body?.content ?? []);
        const ranges = sectionsFromHeadings(elements);
        await chrome.storage.session.set({ [structureStorageKey(docId)]: ranges });
        console.log(`[GroupSync background] fetched Docs API structure for ${docId} -> ${ranges.length} range(s)`);
        sendResponse({ ok: true, count: ranges.length });
      } catch (err) {
        console.error("[GroupSync background] Docs API structure fetch failed", docId, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
