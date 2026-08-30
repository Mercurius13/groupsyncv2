import { getAccessToken } from "./auth";
import {
  extractDocId,
  parseOutboundSaveBody,
  parsePushChannelResponse,
  type AuthorId,
  type MutationOp,
} from "./capture";
import { fetchFullHistory } from "./history";
import { classifyElements, fetchDocumentStructure, type ClassifiedElement } from "./structure";
import { mergeNameSources, parseTilesResponse } from "./tiles";

interface CapturePayload {
  kind: "save" | "bind" | "tiles";
  url: string;
  requestBody: string | null;
  responseText: string;
  timestamp: number;
}

/** Returns the session-storage key holding a doc's captured mutation ops.
 *  Session storage clears on browser close, so raw edit data never persists (C1). */
function opsStorageKey(docId: string): string {
  return `groupsync-ops-${docId}`;
}

/** Reads the stored op list for a doc from session storage.
 *  Returns an empty array when nothing has been captured yet. */
async function getStoredOps(docId: string): Promise<MutationOp[]> {
  const key = opsStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as MutationOp[] | undefined) ?? [];
}

/** Appends newly captured ops to a doc's stored op list.
 *  No-ops when the new list is empty. */
async function appendOps(docId: string, newOps: MutationOp[]): Promise<void> {
  if (newOps.length === 0) return;
  const key = opsStorageKey(docId);
  const existing = await getStoredOps(docId);
  await chrome.storage.session.set({ [key]: [...existing, ...newOps] });
}

/** Replaces a doc's stored ops with the retroactive full-history fetch result,
 *  which is the authoritative complete log (appending would duplicate live-captured ops). */
async function replaceOps(docId: string, ops: MutationOp[]): Promise<void> {
  await chrome.storage.session.set({ [opsStorageKey(docId)]: ops });
}

/** Returns the session-storage key holding a doc's authorId-to-name map.
 *  Populated by intercepted revisions/tiles responses and manual labels. */
function namesStorageKey(docId: string): string {
  return `groupsync-names-${docId}`;
}

/** Reads the stored author-name map for a doc.
 *  Values are display names, or null for Google-anonymous (unattributable) authors. */
async function getStoredNames(docId: string): Promise<Record<AuthorId, string | null>> {
  const key = namesStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as Record<AuthorId, string | null> | undefined) ?? {};
}

/** Returns the session-storage key holding the changelog authorIds the professor
 *  marked as graders/non-students, whose edits are excluded from assessment (C2). */
function excludedStorageKey(docId: string): string {
  return `groupsync-excluded-${docId}`;
}

/** Reads the professor-selected excluded authorIds for a doc.
 *  Returns an empty array when the professor hasn't marked anyone yet. */
async function getStoredExcluded(docId: string): Promise<AuthorId[]> {
  const key = excludedStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as AuthorId[] | undefined) ?? [];
}

/** Parses an intercepted revisions/tiles response and merges its userMap names
 *  into the doc's name cache; anonymous entries are stored as null (unresolved). */
async function handleTilesCapture(docId: string, payload: CapturePayload): Promise<void> {
  const parsed = parseTilesResponse(payload.responseText);
  const existing = await getStoredNames(docId);
  const fetched: Record<AuthorId, string | null> = { ...parsed.names };
  for (const id of parsed.anonymousIds) if (!(id in fetched)) fetched[id] = null;
  const merged = mergeNameSources(existing, fetched);
  await chrome.storage.session.set({ [namesStorageKey(docId)]: merged });
  console.log(
    `[GroupSync tiles] merged ${Object.keys(parsed.names).length} name(s), ` +
      `${parsed.anonymousIds.length} anonymous, for ${docId}`
  );
}

/** Returns the session-storage key holding a doc's classified Docs API structural elements.
 *  segmentByElements turns these into weighted per-element sections. */
function structureStorageKey(docId: string): string {
  return `groupsync-structure-${docId}`;
}

/** Reads a doc's stored classified structural elements.
 *  Returns an empty array when the Docs API structure fetch hasn't run yet. */
async function getStoredStructure(docId: string): Promise<ClassifiedElement[]> {
  const key = structureStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as ClassifiedElement[] | undefined) ?? [];
}

/** Routes an intercepted save/bind payload to the matching capture parser.
 *  Returns the parsed ops, or an empty array for payload kinds carrying none. */
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
      if (payload.kind === "tiles") {
        try {
          await handleTilesCapture(docId, payload);
          sendResponse({ ok: true });
        } catch (err) {
          console.error("[GroupSync background] tiles capture failed", err);
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      let ops: MutationOp[] = [];
      try {
        ops = parseCapture(payload);
      } catch (err) {
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
    return true;
  }

  if (message?.type === "groupsync-get-ops") {
    const docId = message.docId as string;
    getStoredOps(docId).then((ops) => sendResponse({ ops }));
    return true;
  }

  if (message?.type === "groupsync-fetch-history") {
    const docId = message.docId as string;
    (async () => {
      try {
        const { ops, names } = await fetchFullHistory(docId);
        await replaceOps(docId, ops);
        if (Object.keys(names).length > 0) {
          const stored = await getStoredNames(docId);
          await chrome.storage.session.set({ [namesStorageKey(docId)]: mergeNameSources(stored, names) });
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

  if (message?.type === "groupsync-get-structure") {
    const docId = message.docId as string;
    getStoredStructure(docId).then((elements) => sendResponse({ elements }));
    return true;
  }

  if (message?.type === "groupsync-get-excluded") {
    const docId = message.docId as string;
    getStoredExcluded(docId).then((excluded) => sendResponse({ excluded }));
    return true;
  }

  if (message?.type === "groupsync-set-excluded") {
    const docId = message.docId as string;
    const excluded = (message.excluded as AuthorId[] | undefined) ?? [];
    chrome.storage.session
      .set({ [excludedStorageKey(docId)]: excluded })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "groupsync-fetch-structure") {
    const docId = message.docId as string;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        const doc = await fetchDocumentStructure(docId, accessToken);
        const elements = classifyElements(doc.body?.content ?? []);
        await chrome.storage.session.set({ [structureStorageKey(docId)]: elements });
        console.log(`[GroupSync background] fetched Docs API structure for ${docId} -> ${elements.length} element(s)`);
        sendResponse({ ok: true, count: elements.length });
      } catch (err) {
        console.error("[GroupSync background] Docs API structure fetch failed", docId, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
