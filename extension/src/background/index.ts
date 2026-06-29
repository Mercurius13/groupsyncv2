import { parseOutboundSaveBody, parsePushChannelResponse } from "../capture";
import { fetchFullHistory } from "../capture/history";
import { GOOGLE_OAUTH_CLIENT_ID } from "../config";
import { getAccessToken, resolveAuthorNames } from "../identity/people";
import { extractDocId } from "../shared/doc-id";
import { classifyElements, fetchDocumentStructure, sectionsFromHeadings, type HeadingDelimitedRange } from "../structure/docs-api";
import type { AuthorId, MutationOp } from "../types/mutation";

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

function opsStorageKey(docId: string): string {
  return `groupsync-ops-${docId}`;
}

async function getStoredOps(docId: string): Promise<MutationOp[]> {
  const key = opsStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as MutationOp[] | undefined) ?? [];
}

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

/** Resolved names are identity metadata, not edit content — still kept
 *  session-only for now, matching the ops storage, since there's no
 *  established need yet for them to outlive the browser session. */
function namesStorageKey(docId: string): string {
  return `groupsync-names-${docId}`;
}

async function getStoredNames(docId: string): Promise<Record<AuthorId, string | null>> {
  const key = namesStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as Record<AuthorId, string | null> | undefined) ?? {};
}

/** F5.1: real Docs API heading-delimited ranges, kept session-only like
 *  everything else — structural metadata only, never document text. */
function structureStorageKey(docId: string): string {
  return `groupsync-structure-${docId}`;
}

async function getStoredStructure(docId: string): Promise<HeadingDelimitedRange[]> {
  const key = structureStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as HeadingDelimitedRange[] | undefined) ?? [];
}

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
        const ops = await fetchFullHistory(docId);
        await replaceOps(docId, ops);
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

  if (message?.type === "groupsync-resolve-names") {
    const docId = message.docId as string;
    (async () => {
      try {
        const ops = await getStoredOps(docId);
        const authorIds = Array.from(new Set(ops.map((op) => op.authorId)));
        const accessToken = await getAccessToken(GOOGLE_OAUTH_CLIENT_ID);
        const results = await resolveAuthorNames(accessToken, authorIds);
        const names = Object.fromEntries(results.map((r) => [r.authorId, r.displayName]));
        await chrome.storage.session.set({ [namesStorageKey(docId)]: names });
        console.log(`[GroupSync background] resolved names for ${docId}:`, names);
        sendResponse({ ok: true, names });
      } catch (err) {
        console.error("[GroupSync background] name resolution failed", docId, err);
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
