// src/capture/wire-types.ts
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

// src/capture/index.ts
function captureError(reason, message) {
  const err = new Error(message);
  err.reason = reason;
  return err;
}
function commandToOps(cmd, authorId, timestamp) {
  if (isInsertStringCommand(cmd)) {
    return [{ type: "insert", authorId, timestamp, position: cmd.ibi, text: cmd.s }];
  }
  if (isDeleteStringCommand(cmd)) {
    return [{ type: "delete", authorId, timestamp, range: { start: cmd.si, end: cmd.ei } }];
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
      ops.push(...commandToOps(cmd, context.authorId, context.timestamp));
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
    ops.push(...parseChangeEntry(entry));
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
      ops.push(...parseFrame(frame));
    }
  }
  if (chunkTexts.length > 0 && parsedCount === 0) {
    throw captureError("no-parseable-chunks", "push channel response had no parseable chunks \u2014 capture format may have changed.");
  }
  return ops;
}

// src/capture/history.ts
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
function parseRevisionLoadResponse(raw) {
  if (raw.length === 0) return [];
  let body;
  try {
    body = JSON.parse(stripXssiPrefix(raw));
  } catch {
    throw historyError(
      "unparseable-response",
      "revisions/load response was not valid JSON after stripping the XSSI prefix \u2014 the envelope may have changed; validate against a real doc before trusting this path."
    );
  }
  if (!Array.isArray(body.changelog)) {
    throw historyError(
      "unparseable-response",
      "revisions/load response had no 'changelog' array \u2014 the envelope may have changed; validate against a real doc before trusting this path."
    );
  }
  return body.changelog.flatMap(parseChangelogEntry);
}
async function fetchFullHistory(docId, fetchImpl = fetch) {
  const maxRev = await findMaxRevision(docId, fetchImpl);
  const ops = [];
  for (let start = 1; start <= maxRev; start += REVISIONS_PER_PAGE) {
    const end = Math.min(start + REVISIONS_PER_PAGE - 1, maxRev);
    const res = await fetchImpl(revisionLoadUrl(docId, start, end), { credentials: "include" });
    if (!res.ok) {
      throw historyError("fetch-failed", `revisions/load returned ${res.status} for range [${start}, ${end}]`);
    }
    ops.push(...parseRevisionLoadResponse(await res.text()));
  }
  return ops;
}

// src/config.ts
var GOOGLE_OAUTH_CLIENT_ID = "1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com";

// src/identity/people.ts
var PEOPLE_API_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
var DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
var OAUTH_SCOPE = `${PEOPLE_API_SCOPE} ${DOCS_API_SCOPE}`;
function buildAuthUrl(clientId, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: OAUTH_SCOPE,
    prompt: "consent"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function extractAccessToken(redirectedToUrl) {
  const hash = new URL(redirectedToUrl).hash.replace(/^#/, "");
  return new URLSearchParams(hash).get("access_token");
}
async function getAccessToken(clientId) {
  const redirectUri = chrome.identity.getRedirectURL();
  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(clientId, redirectUri),
    interactive: true
  });
  if (!resultUrl) throw new Error("OAuth flow was cancelled or returned no redirect");
  const token = extractAccessToken(resultUrl);
  if (!token) throw new Error("OAuth redirect did not include an access_token");
  return token;
}
function parseBatchGetResponse(authorIds, body) {
  const byResource = /* @__PURE__ */ new Map();
  for (const entry of body.responses ?? []) {
    const resourceName = entry.requestedResourceName ?? entry.person?.resourceName;
    if (!resourceName) continue;
    byResource.set(resourceName, entry.person?.names?.[0]?.displayName ?? null);
  }
  return authorIds.map((authorId) => ({
    authorId,
    displayName: byResource.get(`people/${authorId}`) ?? null
  }));
}
async function resolveAuthorNames(accessToken, authorIds, fetchImpl = fetch) {
  if (authorIds.length === 0) return [];
  const params = new URLSearchParams({ personFields: "names" });
  for (const id of authorIds) params.append("resourceNames", `people/${id}`);
  const res = await fetchImpl(`https://people.googleapis.com/v1/people:batchGet?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error(`People API batchGet failed: ${res.status}`);
  }
  const body = await res.json();
  return parseBatchGetResponse(authorIds, body);
}

// src/shared/doc-id.ts
function extractDocId(url) {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1] : null;
}

// src/structure/docs-api.ts
var DocsApiError = class extends Error {
};
var FIELDS = "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,table.rows,table.columns)";
function documentsApiUrl(documentId) {
  return `https://docs.googleapis.com/v1/documents/${documentId}?fields=${encodeURIComponent(FIELDS)}`;
}
async function fetchDocumentStructure(documentId, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(documentsApiUrl(documentId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    throw new DocsApiError(`Docs API documents.get failed: ${res.status}`);
  }
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
function classifyElements(content) {
  const classified = [];
  for (const el of content) {
    if (el.startIndex === void 0 || el.endIndex === void 0) continue;
    if (el.table) {
      classified.push({ kind: "table", startIndex: el.startIndex, endIndex: el.endIndex });
      continue;
    }
    if (el.paragraph) {
      const namedStyle = el.paragraph.paragraphStyle?.namedStyleType;
      const level = namedStyle ? HEADING_LEVELS[namedStyle] : void 0;
      if (level !== void 0) {
        classified.push({ kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex });
      } else {
        classified.push({ kind: "paragraph", startIndex: el.startIndex, endIndex: el.endIndex });
      }
    }
  }
  return classified;
}
function sectionsFromHeadings(elements) {
  const ranges = [];
  let current = null;
  for (const el of elements) {
    if (el.kind === "heading") {
      if (current) ranges.push(current);
      current = { startIndex: el.startIndex, endIndex: el.endIndex, headingLevel: el.level ?? null, containsTable: false };
      continue;
    }
    if (!current) {
      current = { startIndex: el.startIndex, endIndex: el.endIndex, headingLevel: null, containsTable: el.kind === "table" };
    } else {
      current.endIndex = el.endIndex;
      if (el.kind === "table") current.containsTable = true;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

// src/background/index.ts
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
    getStoredOps(docId).then((ops) => {
      console.log(`[GroupSync background] groupsync-get-ops for ${docId} -> ${ops.length} op(s)`);
      sendResponse({ ops });
    });
    return true;
  }
  if (message?.type === "groupsync-fetch-history") {
    const docId = message.docId;
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
    const docId = message.docId;
    getStoredNames(docId).then((names) => sendResponse({ names }));
    return true;
  }
  if (message?.type === "groupsync-resolve-names") {
    const docId = message.docId;
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
    const docId = message.docId;
    getStoredStructure(docId).then((ranges) => sendResponse({ ranges }));
    return true;
  }
  if (message?.type === "groupsync-fetch-structure") {
    const docId = message.docId;
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
  return void 0;
});
