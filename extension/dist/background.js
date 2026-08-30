// src/auth.ts
var GOOGLE_OAUTH_CLIENT_ID = "1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com";
var DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
function buildAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: DOCS_API_SCOPE,
    prompt: "consent"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function extractAccessToken(redirectedToUrl) {
  const hash = new URL(redirectedToUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("access_token");
}
async function getAccessToken() {
  const redirectUri = chrome.identity.getRedirectURL();
  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(redirectUri),
    interactive: true
  });
  if (!resultUrl) throw new Error("OAuth flow was cancelled or returned no redirect");
  const token = extractAccessToken(resultUrl);
  if (!token) throw new Error("OAuth redirect did not include an access_token");
  return token;
}

// src/capture.ts
function extractDocId(url) {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1] : null;
}
function isInsertStringCommand(cmd) {
  return !!cmd && typeof cmd === "object" && cmd.ty === "is";
}
function isDeleteStringCommand(cmd) {
  return !!cmd && typeof cmd === "object" && cmd.ty === "ds";
}
function isMultiCommand(cmd) {
  return !!cmd && typeof cmd === "object" && cmd.ty === "mlti" && Array.isArray(cmd.mts);
}
function isNoopPayload(payload) {
  return Array.isArray(payload) && payload[0] === "noop";
}
function isChangesPayload(payload) {
  if (!Array.isArray(payload) || payload.length < 3) return false;
  const body = payload[2];
  return !!body && Array.isArray(body.c);
}
function captureError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}
function pushAll(target, ops) {
  for (const op of ops) target.push(op);
}
function commandToOps(cmd, authorId, timestamp) {
  if (isInsertStringCommand(cmd)) {
    return [{ type: "insert", authorId, timestamp, position: cmd.ibi, text: cmd.s }];
  }
  if (isDeleteStringCommand(cmd)) {
    return [{ type: "delete", authorId, timestamp, range: { start: cmd.si, end: cmd.ei + 1 } }];
  }
  if (isMultiCommand(cmd)) {
    return cmd.mts.flatMap((sub) => commandToOps(sub, authorId, timestamp));
  }
  return [];
}
function parseOutboundSaveBody(rawFormBody, context) {
  const params = new URLSearchParams(rawFormBody);
  const bundlesRaw = params.get("bundles");
  if (!bundlesRaw) return [];
  let bundles;
  try {
    bundles = JSON.parse(bundlesRaw);
  } catch {
    throw captureError("unparseable-bundles", "save request's 'bundles' field was not valid JSON \u2014 capture format may have changed.");
  }
  return commandsToOps(bundles, context);
}
function commandsToOps(bundles, context) {
  const ops = [];
  for (const bundle of bundles) {
    for (const cmd of bundle.commands) {
      pushAll(ops, commandToOps(cmd, context.authorId, context.timestamp));
    }
  }
  return ops;
}
function tokenizeChunks(raw) {
  const chunks = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let j = i;
    while (j < raw.length && /[0-9]/.test(raw[j])) j++;
    if (j === i) break;
    const len = parseInt(raw.slice(i, j), 10);
    i = j;
    if (raw[i] === "\n") i++;
    chunks.push(raw.slice(i, i + len));
    i += len;
  }
  return chunks;
}
function parseChangeEntry(entry) {
  const [command, timestamp, authorId] = entry;
  return commandToOps(command, authorId, timestamp);
}
function parseFrame(frame) {
  const [, payload] = frame;
  if (isNoopPayload(payload)) return [];
  if (!isChangesPayload(payload)) return [];
  const [, , body] = payload;
  const ops = [];
  for (const entry of body.c) {
    pushAll(ops, parseChangeEntry(entry));
  }
  return ops;
}
function parsePushChannelResponse(raw) {
  const chunkTexts = tokenizeChunks(raw);
  const ops = [];
  let parsedCount = 0;
  for (const chunkText of chunkTexts) {
    let frames;
    try {
      frames = JSON.parse(chunkText);
    } catch {
      continue;
    }
    parsedCount++;
    for (const frame of frames) {
      pushAll(ops, parseFrame(frame));
    }
  }
  if (chunkTexts.length > 0 && parsedCount === 0) {
    throw captureError("no-parseable-chunks", "push channel response had no parseable chunks \u2014 capture format may have changed.");
  }
  return ops;
}

// src/history.ts
function historyError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}
var REVISIONS_PER_PAGE = 1e3;
function revisionLoadUrl(docId, start, end) {
  return `https://docs.google.com/document/d/${docId}/revisions/load?id=${docId}&start=${start}&end=${end}`;
}
async function revisionExists(docId, rev, fetchImpl) {
  const res = await fetchImpl(revisionLoadUrl(docId, rev, rev), { credentials: "include" });
  return res.ok;
}
async function findMaxRevision(docId, fetchImpl = fetch) {
  let low = 1;
  let high = 1;
  while (await revisionExists(docId, high, fetchImpl)) {
    low = high;
    high *= 2;
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await revisionExists(docId, mid, fetchImpl)) low = mid;
    else high = mid;
  }
  return low;
}
var XSSI_PREFIX = ")]}'";
function stripXssiPrefix(raw) {
  const trimmed = raw.trimStart();
  return trimmed.startsWith(XSSI_PREFIX) ? trimmed.slice(XSSI_PREFIX.length) : trimmed;
}
function parseChangelogEntry(entry) {
  if (!Array.isArray(entry) || entry.length < 3) return [];
  const [command, timestamp, authorId] = entry;
  return commandToOps(command, authorId, timestamp);
}
function parseUserMapFromBody(body) {
  const raw = body.userMap ?? body.users ?? body.authorMap ?? body.userInfo;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [id, info] of Object.entries(raw)) {
    if (typeof info === "string") {
      result[id] = info;
    } else if (info && typeof info === "object") {
      const obj = info;
      const name = obj["name"] ?? obj["displayName"] ?? obj["email"] ?? obj["emailAddress"];
      if (typeof name === "string" && name.length > 0) result[id] = name;
    }
  }
  return result;
}
function parseRevisionLoadResponseWithNames(raw) {
  if (raw.length === 0) return { ops: [], names: {} };
  let body;
  try {
    body = JSON.parse(stripXssiPrefix(raw));
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/load response was not valid JSON after stripping the XSSI prefix \u2014 the envelope may have changed."
    );
  }
  if (!Array.isArray(body.changelog)) {
    throw historyError(
      "unparseable-response",
      "revisions/load response had no 'changelog' array \u2014 the envelope may have changed."
    );
  }
  const ops = body.changelog.flatMap(parseChangelogEntry);
  const names = parseUserMapFromBody(body);
  return { ops, names };
}
async function fetchFullHistory(docId, fetchImpl = fetch) {
  const maxRev = await findMaxRevision(docId, fetchImpl);
  const ops = [];
  const names = {};
  for (let start = 1; start <= maxRev; start += REVISIONS_PER_PAGE) {
    const end = Math.min(start + REVISIONS_PER_PAGE - 1, maxRev);
    const res = await fetchImpl(revisionLoadUrl(docId, start, end), { credentials: "include" });
    if (!res.ok) {
      throw historyError("fetch-failed", `revisions/load returned ${res.status} for range [${start}, ${end}]`);
    }
    const page = parseRevisionLoadResponseWithNames(await res.text());
    for (const op of page.ops) ops.push(op);
    Object.assign(names, page.names);
  }
  return { ops, names };
}

// src/structure.ts
var DocsApiError = class extends Error {
};
var DOCS_API_FIELDS = "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,paragraph.bullet.listId,table.rows,table.columns,table.tableRows.tableCells(startIndex,endIndex))";
function documentsApiUrl(documentId) {
  return `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(DOCS_API_FIELDS)}`;
}
async function fetchDocumentStructure(documentId, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(documentsApiUrl(documentId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DocsApiError(`Docs API documents.get failed: ${res.status}`);
  return await res.json();
}
var HEADING_LEVELS = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6
};
function tableCellRanges(table) {
  const cells = [];
  for (const row of table.tableRows ?? []) {
    for (const cell of row.tableCells ?? []) {
      if (cell.startIndex !== void 0 && cell.endIndex !== void 0) {
        cells.push({ startIndex: cell.startIndex, endIndex: cell.endIndex });
      }
    }
  }
  return cells;
}
function classifyElements(content) {
  const classified = [];
  for (const el of content) {
    if (el.startIndex === void 0 || el.endIndex === void 0) continue;
    if (el.table) {
      classified.push({ kind: "table", startIndex: el.startIndex, endIndex: el.endIndex, cells: tableCellRanges(el.table) });
      continue;
    }
    if (el.paragraph) {
      const namedStyle = el.paragraph.paragraphStyle?.namedStyleType;
      const level = namedStyle ? HEADING_LEVELS[namedStyle] : void 0;
      if (level !== void 0) {
        classified.push({ kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex });
      } else if (el.paragraph.bullet) {
        classified.push({ kind: "list", startIndex: el.startIndex, endIndex: el.endIndex });
      } else {
        classified.push({ kind: "paragraph", startIndex: el.startIndex, endIndex: el.endIndex });
      }
    }
  }
  return classified;
}

// src/tiles.ts
function emptyTileNames() {
  return { names: {}, anonymousIds: [] };
}
function parseTilesResponse(raw) {
  const out = emptyTileNames();
  if (raw.length === 0) return out;
  let body;
  try {
    body = JSON.parse(stripXssiPrefix(raw));
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/tiles response was not valid JSON after stripping the XSSI prefix \u2014 the envelope may have changed."
    );
  }
  const userMap = body.userMap;
  if (!userMap || typeof userMap !== "object") return out;
  const anonymous = /* @__PURE__ */ new Set();
  for (const [id, info] of Object.entries(userMap)) {
    if (!info || typeof info !== "object") continue;
    const name = typeof info.name === "string" ? info.name.trim() : "";
    if (info.anonymous === true || info.attributionType === 0 || name.length === 0) {
      anonymous.add(id);
    } else {
      out.names[id] = name;
    }
  }
  out.anonymousIds = Array.from(anonymous);
  return out;
}
function mergeNameSources(stored, fetched) {
  const merged = {};
  for (const source of [stored, fetched]) {
    for (const [id, name] of Object.entries(source)) {
      if (name !== null && name !== void 0) merged[id] = name;
      else if (!(id in merged)) merged[id] = null;
    }
  }
  return merged;
}

// src/background.ts
function opsStorageKey(docId) {
  return `groupsync-ops-${docId}`;
}
async function getStoredOps(docId) {
  const key = opsStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? [];
}
async function appendOps(docId, newOps) {
  if (newOps.length === 0) return;
  const key = opsStorageKey(docId);
  const existing = await getStoredOps(docId);
  await chrome.storage.session.set({ [key]: [...existing, ...newOps] });
}
async function replaceOps(docId, ops) {
  await chrome.storage.session.set({ [opsStorageKey(docId)]: ops });
}
function namesStorageKey(docId) {
  return `groupsync-names-${docId}`;
}
async function getStoredNames(docId) {
  const key = namesStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? {};
}
function excludedStorageKey(docId) {
  return `groupsync-excluded-${docId}`;
}
async function getStoredExcluded(docId) {
  const key = excludedStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? [];
}
async function handleTilesCapture(docId, payload) {
  const parsed = parseTilesResponse(payload.responseText);
  const existing = await getStoredNames(docId);
  const fetched = { ...parsed.names };
  for (const id of parsed.anonymousIds) if (!(id in fetched)) fetched[id] = null;
  const merged = mergeNameSources(existing, fetched);
  await chrome.storage.session.set({ [namesStorageKey(docId)]: merged });
  console.log(
    `[GroupSync tiles] merged ${Object.keys(parsed.names).length} name(s), ${parsed.anonymousIds.length} anonymous, for ${docId}`
  );
}
function structureStorageKey(docId) {
  return `groupsync-structure-${docId}`;
}
async function getStoredStructure(docId) {
  const key = structureStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return result[key] ?? [];
}
function parseCapture(payload) {
  const url = new URL(payload.url);
  const ouid = url.searchParams.get("ouid");
  if (payload.kind === "save" && payload.requestBody) {
    return parseOutboundSaveBody(payload.requestBody, {
      authorId: ouid ?? "local-user",
      timestamp: payload.timestamp
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
    const payload = message.payload;
    const docId = extractDocId(payload.url);
    if (!docId) {
      console.warn("[GroupSync background] could not extract docId from URL, dropping capture", payload.url);
      sendResponse({ ok: false });
      return void 0;
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
      let ops = [];
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
    const docId = message.docId;
    getStoredOps(docId).then((ops) => sendResponse({ ops }));
    return true;
  }
  if (message?.type === "groupsync-fetch-history") {
    const docId = message.docId;
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
    const docId = message.docId;
    getStoredNames(docId).then((names) => sendResponse({ names }));
    return true;
  }
  if (message?.type === "groupsync-save-names") {
    const docId = message.docId;
    const updates = message.names;
    (async () => {
      const existing = await getStoredNames(docId);
      await chrome.storage.session.set({ [namesStorageKey(docId)]: { ...existing, ...updates } });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "groupsync-get-structure") {
    const docId = message.docId;
    getStoredStructure(docId).then((elements) => sendResponse({ elements }));
    return true;
  }
  if (message?.type === "groupsync-get-excluded") {
    const docId = message.docId;
    getStoredExcluded(docId).then((excluded) => sendResponse({ excluded }));
    return true;
  }
  if (message?.type === "groupsync-set-excluded") {
    const docId = message.docId;
    const excluded = message.excluded ?? [];
    chrome.storage.session.set({ [excludedStorageKey(docId)]: excluded }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "groupsync-fetch-structure") {
    const docId = message.docId;
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
  return void 0;
});
