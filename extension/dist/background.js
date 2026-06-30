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
      "revisions/load response was not valid JSON after stripping the XSSI prefix \u2014 the envelope may have changed; validate against a real doc before trusting this path."
    );
  }
  console.log("[GroupSync history] top-level keys in revisions/load response:", Object.keys(body));
  if (!Array.isArray(body.changelog)) {
    throw historyError(
      "unparseable-response",
      "revisions/load response had no 'changelog' array \u2014 the envelope may have changed; validate against a real doc before trusting this path."
    );
  }
  const ops = body.changelog.flatMap(parseChangelogEntry);
  const names = parseUserMapFromBody(body);
  if (Object.keys(names).length > 0) {
    console.log("[GroupSync history] extracted user map from response:", names);
  } else {
    console.log("[GroupSync history] no user map found in response (tried: userMap, users, authorMap, userInfo)");
  }
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
    ops.push(...page.ops);
    Object.assign(names, page.names);
  }
  return { ops, names };
}

// src/config.ts
var GOOGLE_OAUTH_CLIENT_ID = "1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com";

// src/identity/index.ts
var PEOPLE_API_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
var DOCS_API_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
var DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
var OAUTH_SCOPE = `${PEOPLE_API_SCOPE} ${DOCS_API_SCOPE} ${DRIVE_METADATA_SCOPE}`;
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
  if (!res.ok) throw new Error(`People API batchGet failed: ${res.status}`);
  const body = await res.json();
  return parseBatchGetResponse(authorIds, body);
}
var DriveApiError = class extends Error {
};
var DRIVE_FIELDS = "permissions(id,displayName,emailAddress,type)";
function filePermissionsUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=${encodeURIComponent(DRIVE_FIELDS)}`;
}
async function fetchFilePermissions(fileId, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(filePermissionsUrl(fileId), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DriveApiError(`Drive API permissions.list failed: ${res.status}`);
  const body = await res.json();
  return body.permissions ?? [];
}
function matchPermissionsToAuthorIds(authorIds, permissions) {
  console.log(`[GroupSync drive] ${permissions.length} permission(s) to match against ${authorIds.length} author id(s)`);
  const byStringId = /* @__PURE__ */ new Map();
  for (const perm of permissions) {
    if (perm.id) byStringId.set(perm.id, perm);
  }
  const permsByBigInt = /* @__PURE__ */ new Map();
  for (const [id, perm] of byStringId) {
    try {
      permsByBigInt.set(BigInt(id), perm);
    } catch {
    }
  }
  return authorIds.map((authorId) => {
    let matched = byStringId.get(authorId);
    if (!matched) {
      try {
        matched = permsByBigInt.get(BigInt(authorId));
      } catch {
      }
    }
    const displayName = matched?.displayName ?? matched?.emailAddress ?? null;
    console.log(`[GroupSync drive] authorId=${authorId} matched=${matched?.id ?? "none"} -> "${displayName ?? "null"}"`);
    return { authorId, displayName };
  });
}
async function resolveAuthorNamesViaDrive(fileId, accessToken, authorIds, fetchImpl = fetch) {
  if (authorIds.length === 0) return [];
  const permissions = await fetchFilePermissions(fileId, accessToken, fetchImpl);
  return matchPermissionsToAuthorIds(authorIds, permissions);
}

// src/structure/index.ts
var DocsApiError = class extends Error {
};
var DOCS_API_FIELDS = "body.content(startIndex,endIndex,paragraph.paragraphStyle.namedStyleType,table.rows,table.columns)";
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
      classified.push(
        level !== void 0 ? { kind: "heading", level, startIndex: el.startIndex, endIndex: el.endIndex } : { kind: "paragraph", startIndex: el.startIndex, endIndex: el.endIndex }
      );
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

// src/utils.ts
function extractDocId(url) {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1] : null;
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
        const { ops, names } = await fetchFullHistory(docId);
        await replaceOps(docId, ops);
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
  if (message?.type === "groupsync-resolve-names") {
    const docId = message.docId;
    (async () => {
      try {
        const ops = await getStoredOps(docId);
        const authorIds = Array.from(new Set(ops.map((op) => op.authorId)));
        console.log(`[GroupSync names] starting resolution for ${docId}, ${authorIds.length} author id(s):`, authorIds);
        const accessToken = await getAccessToken(GOOGLE_OAUTH_CLIENT_ID);
        console.log(`[GroupSync names] got access token, length=${accessToken.length}`);
        let peopleResults;
        try {
          peopleResults = await resolveAuthorNames(accessToken, authorIds);
          console.log("[GroupSync names] People API results:", peopleResults);
        } catch (err) {
          console.error("[GroupSync names] People API call itself threw \u2014 Drive fallback will still run", err);
          peopleResults = authorIds.map((authorId) => ({ authorId, displayName: null }));
        }
        const stillUnresolved = peopleResults.filter((r) => r.displayName === null).map((r) => r.authorId);
        console.log(`[GroupSync names] still unresolved after People API: ${stillUnresolved.length}`, stillUnresolved);
        let driveResults = [];
        if (stillUnresolved.length > 0) {
          try {
            driveResults = await resolveAuthorNamesViaDrive(docId, accessToken, stillUnresolved);
            console.log("[GroupSync names] Drive permissions fallback results:", driveResults);
          } catch (err) {
            console.error("[GroupSync names] Drive permissions fallback failed", err);
          }
        }
        const driveByAuthorId = new Map(driveResults.map((r) => [r.authorId, r]));
        const merged = peopleResults.map((r) => r.displayName !== null ? r : driveByAuthorId.get(r.authorId) ?? r);
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
