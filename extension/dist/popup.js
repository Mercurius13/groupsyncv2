// src/export/index.ts
function toContentStrippedSummary(narration, footprints, names = {}, now = Date.now) {
  return {
    disclaimer: narration.disclaimer,
    generatedAt: now(),
    sections: narration.sections.filter((s) => s.sentences.length > 0).map((s) => ({
      sectionLabel: s.headingText ?? `Paragraph ${s.paragraph}`,
      sentences: s.sentences.map((sentence) => sentence.text)
    })),
    signalNotes: narration.signalNotes,
    authorCounts: footprints.map((f) => ({
      authorId: f.authorId,
      authorName: names[f.authorId] ?? null,
      originatedChars: f.originatedChars,
      totalSurvivingChars: f.totalSurvivingChars,
      originShare: f.originShare
    }))
  };
}

// src/signals/index.ts
var PASTE_CHAR_THRESHOLD = 400;
function detectPastes(ops) {
  const signals = [];
  for (const op of ops) {
    if (op.type === "insert" && op.text.length >= PASTE_CHAR_THRESHOLD) {
      signals.push({ authorId: op.authorId, timestamp: op.timestamp, position: op.position, length: op.text.length });
    }
  }
  return signals;
}
var QUARANTINE_CHURN_FRACTION = 0.5;
var SESSION_GAP_MS = 30 * 60 * 1e3;
function groupIntoSessions(ops) {
  if (ops.length === 0) return [];
  const sorted = [...ops].sort((a, b) => a.timestamp - b.timestamp);
  const sessions = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const op = sorted[i];
    const prev = sorted[i - 1];
    if (op.timestamp - prev.timestamp > SESSION_GAP_MS) {
      sessions.push([]);
    }
    sessions[sessions.length - 1].push(op);
  }
  return sessions.map((sessionOps) => ({
    ops: sessionOps,
    startTimestamp: sessionOps[0].timestamp,
    endTimestamp: sessionOps[sessionOps.length - 1].timestamp
  }));
}
function detectQuarantineSignals(ops) {
  const sessions = groupIntoSessions(ops);
  const signals = [];
  let docLength = 0;
  for (const session of sessions) {
    const docLengthAtSessionStart = docLength;
    let deletedCount = 0;
    for (const op of session.ops) {
      if (op.type === "insert") {
        docLength += op.text.length;
      } else {
        const removed = op.range.end - op.range.start;
        docLength -= removed;
        deletedCount += removed;
      }
    }
    if (docLengthAtSessionStart > 0) {
      const churnFraction = deletedCount / docLengthAtSessionStart;
      if (churnFraction >= QUARANTINE_CHURN_FRACTION) {
        signals.push({ session, docLengthAtSessionStart, deletedCount, churnFraction });
      }
    }
  }
  return signals;
}
var INTEGRATOR_BREADTH_THRESHOLD = 0.6;
var INTEGRATOR_ORIGIN_SHARE_THRESHOLD = 0.2;
function authorFootprints(sections, originByPosition) {
  const totalSurvivingChars = originByPosition.length;
  const authorIds = /* @__PURE__ */ new Set();
  for (const section of sections) {
    for (const id of section.authorship.keys()) {
      if (id !== null) authorIds.add(id);
    }
  }
  return Array.from(authorIds).map((authorId) => {
    let sectionsTouched = 0;
    let originatedChars = 0;
    for (const section of sections) {
      const charsHere = section.authorship.get(authorId) ?? 0;
      if (charsHere > 0) sectionsTouched++;
      originatedChars += charsHere;
    }
    const revisionBreadth = sections.length === 0 ? 0 : sectionsTouched / sections.length;
    const originShare = totalSurvivingChars === 0 ? 0 : originatedChars / totalSurvivingChars;
    return {
      authorId,
      sectionsTouched,
      totalSections: sections.length,
      revisionBreadth,
      originatedChars,
      totalSurvivingChars,
      originShare,
      isIntegratorPattern: revisionBreadth >= INTEGRATOR_BREADTH_THRESHOLD && originShare < INTEGRATOR_ORIGIN_SHARE_THRESHOLD
    };
  });
}
var PRIMARY_AUTHOR_SHARE_THRESHOLD = 0.6;
var CONTRIBUTOR_SHARE_THRESHOLD = 0.15;
function narrationPhraseForShare(originShare) {
  if (originShare >= PRIMARY_AUTHOR_SHARE_THRESHOLD) return "primarily authored";
  if (originShare >= CONTRIBUTOR_SHARE_THRESHOLD) return "contributed to";
  return "made minor edits to";
}
var LATE_CONCENTRATION_EDIT_FRACTION = 0.6;
var LATE_CONCENTRATION_WINDOW_FRACTION = 0.2;
function detectLateConcentration(ops) {
  const inserts = ops.filter((op) => op.type === "insert");
  if (inserts.length === 0 || ops.length === 0) return [];
  const timestamps = ops.map((op) => op.timestamp);
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const span = maxTs - minTs;
  if (span === 0) return [];
  const lateWindowStart = maxTs - span * LATE_CONCENTRATION_WINDOW_FRACTION;
  const byAuthor = /* @__PURE__ */ new Map();
  for (const op of inserts) {
    const entry = byAuthor.get(op.authorId) ?? { total: 0, late: 0 };
    entry.total++;
    if (op.timestamp >= lateWindowStart) entry.late++;
    byAuthor.set(op.authorId, entry);
  }
  const signals = [];
  for (const [authorId, { total, late }] of byAuthor) {
    const lateFraction = late / total;
    if (lateFraction >= LATE_CONCENTRATION_EDIT_FRACTION) {
      signals.push({ authorId, editsInLateWindow: late, totalEdits: total, lateFraction });
    }
  }
  return signals;
}
var REVISION_DEPTH_NARRATION_THRESHOLD = 20;
function revisionDepthSignals(deletionOverwrite) {
  const signals = [];
  for (const [actorId, targets] of deletionOverwrite) {
    for (const [targetId, deletedCount] of targets) {
      if (deletedCount >= REVISION_DEPTH_NARRATION_THRESHOLD) {
        signals.push({ actorId, targetId, deletedCount });
      }
    }
  }
  return signals.sort((a, b) => b.deletedCount - a.deletedCount);
}
var CONCURRENT_EDIT_WINDOW_MS = 2e3;
var CONCURRENT_EDIT_POSITION_DISTANCE = 5;
function detectConcurrentEditBoundaries(ops) {
  const inserts = ops.filter((op) => op.type === "insert").sort((a, b) => a.timestamp - b.timestamp);
  const signals = [];
  for (let i = 0; i < inserts.length; i++) {
    const a = inserts[i];
    for (let j = i + 1; j < inserts.length; j++) {
      const b = inserts[j];
      if (b.timestamp - a.timestamp > CONCURRENT_EDIT_WINDOW_MS) break;
      if (b.authorId === a.authorId) continue;
      if (Math.abs(b.position - a.position) <= CONCURRENT_EDIT_POSITION_DISTANCE) {
        signals.push({
          authorA: a.authorId,
          authorB: b.authorId,
          timestampA: a.timestamp,
          timestampB: b.timestamp,
          positionA: a.position,
          positionB: b.position
        });
      }
    }
  }
  return signals;
}

// src/replay/index.ts
function padToLength(live, length, nextCharId) {
  while (live.length < length) {
    live.push({ charId: nextCharId(), authorId: null, char: null });
  }
}
function replay(ops) {
  const live = [];
  const deletionLog = [];
  let counter = 0;
  const nextCharId = () => counter++;
  for (const op of ops) {
    if (op.type === "insert") {
      padToLength(live, op.position, nextCharId);
      const inserted = Array.from(op.text, (char) => ({
        charId: nextCharId(),
        authorId: op.authorId,
        char
      }));
      live.splice(op.position, 0, ...inserted);
    } else {
      padToLength(live, op.range.end, nextCharId);
      const removed = live.splice(op.range.start, op.range.end - op.range.start);
      removed.forEach((char, offset) => {
        deletionLog.push({
          actor: op.authorId,
          target: char.authorId,
          charId: char.charId,
          timestamp: op.timestamp,
          position: op.range.start + offset
        });
      });
    }
  }
  return { originByPosition: live, deletionLog };
}
function survivingCharacterMap(originByPosition) {
  const counts = /* @__PURE__ */ new Map();
  for (const char of originByPosition) {
    counts.set(char.authorId, (counts.get(char.authorId) ?? 0) + 1);
  }
  return counts;
}
function deletionOverwriteMap(deletionLog) {
  const matrix = /* @__PURE__ */ new Map();
  for (const event of deletionLog) {
    let targets = matrix.get(event.actor);
    if (!targets) {
      targets = /* @__PURE__ */ new Map();
      matrix.set(event.actor, targets);
    }
    targets.set(event.target, (targets.get(event.target) ?? 0) + 1);
  }
  return matrix;
}

// src/structure/index.ts
function classifyForm(range) {
  return range.containsTable ? "calculations" : "discussion/theory";
}
var UNKNOWN_CHAR_PLACEHOLDER = "\uFFFD";
function reconstructText(chars) {
  return chars.map((c) => c.char ?? UNKNOWN_CHAR_PLACEHOLDER).join("");
}
function buildSection(chars, start, end) {
  const slice = chars.slice(start, end);
  return { start, end, text: reconstructText(slice), authorship: survivingCharacterMap(slice) };
}
function segmentIntoParagraphs(chars) {
  const sections = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i]?.char === "\n") {
      sections.push(buildSection(chars, start, i + 1));
      start = i + 1;
    }
  }
  if (start < chars.length) sections.push(buildSection(chars, start, chars.length));
  return sections;
}
function segmentByDocsStructure(chars, ranges) {
  return ranges.map((range) => {
    const start = Math.min(range.startIndex, chars.length);
    const end = Math.min(range.endIndex, chars.length);
    return { ...buildSection(chars, start, end), headingLevel: range.headingLevel, formClassification: classifyForm(range) };
  });
}
function sectionHeadingText(section) {
  if (section.headingLevel === null || section.headingLevel === void 0) return null;
  const firstLine = section.text.split("\n")[0]?.trim();
  return firstLine ? firstLine : null;
}

// src/narration/index.ts
var DISCLAIMER = "This tool measures on-document editing only. It cannot detect off-document work, in-person contribution, or content drafted elsewhere and pasted in. Use as evidence, not as a verdict.";
function pct(share) {
  return `${Math.round(share * 100)}%`;
}
function authorLabel(authorId, names) {
  return names[authorId] ?? `author ${authorId}`;
}
function sectionDescriptor(section) {
  if (!section.formClassification) return "this section";
  return `this ${section.formClassification} section`;
}
function narrateSection(section, names) {
  const total = Array.from(section.authorship.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return [];
  const sentences = [];
  const entries = Array.from(section.authorship.entries()).sort((a, b) => b[1] - a[1]);
  const descriptor = sectionDescriptor(section);
  for (const [authorId, count] of entries) {
    if (count === 0) continue;
    const share = count / total;
    if (authorId === null) {
      sentences.push({
        ruleId: "C5-unknown-origin",
        text: `${pct(share)} of ${descriptor}'s characters predate the captured edit history and have no known author.`
      });
      continue;
    }
    const phrase = narrationPhraseForShare(share);
    sentences.push({
      ruleId: "F7.3-section-authorship",
      text: `${authorLabel(authorId, names)} ${phrase} ${descriptor} (${pct(share)} of its surviving characters).`
    });
  }
  return sentences;
}
function narrateIntegratorPattern(footprint, names) {
  if (!footprint.isIntegratorPattern) return null;
  return {
    ruleId: "F7.4-integrator-pattern",
    text: `${authorLabel(footprint.authorId, names)} edited ${pct(footprint.revisionBreadth)} of the document's sections but originated only ${pct(footprint.originShare)} of its surviving text \u2014 a pattern consistent with integrating or reformatting others' work rather than drafting original content. This describes what the edit data shows, not a conclusion about effort or contribution.`
  };
}
function narratePaste(signal, names) {
  return {
    ruleId: "F4.1-paste",
    text: `${authorLabel(signal.authorId, names)} inserted ${signal.length} characters in a single action \u2014 consistent with pasted text rather than typing, though the tool cannot distinguish a paste of the author's own prior work from text drafted elsewhere.`
  };
}
function narrateQuarantine(signal) {
  const start = new Date(signal.session.startTimestamp).toISOString();
  const end = new Date(signal.session.endTimestamp).toISOString();
  return {
    ruleId: "F3.1-quarantine",
    text: `In the editing session from ${start} to ${end}, ${pct(signal.churnFraction)} of the document as it stood at that session's start was deleted \u2014 attribution across this session is less reliable than elsewhere in the doc.`
  };
}
function narrateLateConcentration(signal, names) {
  return {
    ruleId: "F6.4-late-concentration",
    text: `${pct(signal.lateFraction)} of ${authorLabel(signal.authorId, names)}'s edits occurred in the final ${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the document's overall editing timeline.`
  };
}
function narrateRevisionDepth(signal, names) {
  const targetLabel = signal.targetId === null ? "characters of unknown origin" : `${authorLabel(signal.targetId, names)}'s characters`;
  return {
    ruleId: "F6.3-revision-depth",
    text: `${authorLabel(signal.actorId, names)} deleted ${signal.deletedCount} ${targetLabel}.`
  };
}
function narrateConcurrentEdit(signal, names) {
  return {
    ruleId: "F6.6-concurrent-edit-boundary",
    text: `${authorLabel(signal.authorA, names)} and ${authorLabel(signal.authorB, names)} both inserted text within ${Math.abs(signal.timestampB - signal.timestampA)}ms of each other near the same position in the document \u2014 attribution at this boundary may be less certain than elsewhere (concurrent editing).`
  };
}
function buildNarrationReport(inputs) {
  const { names } = inputs;
  const sections = inputs.sections.map((section, i) => ({
    paragraph: i + 1,
    sentences: narrateSection(section, names),
    headingText: sectionHeadingText(section)
  }));
  const signalSentences = [
    ...inputs.footprints.map((f) => narrateIntegratorPattern(f, names)).filter((s) => s !== null),
    ...inputs.pastes.map((p) => narratePaste(p, names)),
    ...inputs.quarantineSignals.map((q) => narrateQuarantine(q)),
    ...inputs.lateConcentration.map((l) => narrateLateConcentration(l, names)),
    ...inputs.revisionDepth.map((r) => narrateRevisionDepth(r, names)),
    ...inputs.concurrentEdits.map((c) => narrateConcurrentEdit(c, names))
  ];
  return {
    disclaimer: DISCLAIMER,
    sections,
    signalNotes: signalSentences.map((s) => s.text),
    signalSentences,
    ruleTrace: [...sections.flatMap((s) => s.sentences), ...signalSentences]
  };
}

// src/utils.ts
function extractDocId(url) {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1] : null;
}

// src/ui/popup.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function getActiveDocId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return extractDocId(tab.url);
}
function setStatus(root, message) {
  root.innerHTML = `<p class="gs-status">${escapeHtml(message)}</p>`;
}
function labelKey(key, names) {
  if (key === null) return "(unknown)";
  const name = names[key];
  return name ? `${name} (${key})` : key;
}
function mapToObject(map, names) {
  const obj = {};
  for (const [key, value] of map) obj[labelKey(key, names)] = value;
  return obj;
}
function renderResolveNamesButton(root, docId) {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Resolve author names (People API + Drive permissions fallback)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Resolving names\u2026";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-resolve-names", docId });
    if (!result?.ok) {
      setStatus(root, `Name resolution failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    if (result.resolvedCount === 0 && result.totalCount > 0) {
      setStatus(
        root,
        `Resolved 0 of ${result.totalCount} author name(s) via People API or Drive permissions. This can happen if you don't have edit access to the doc, or no author IDs were captured yet.`
      );
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}
function renderNameLabelingSection(root, docId, rawSurviving, names) {
  const unresolved = Array.from(rawSurviving.keys()).filter((id) => id !== null && !names[id]).sort((a, b) => (rawSurviving.get(b) ?? 0) - (rawSurviving.get(a) ?? 0));
  if (unresolved.length === 0) return;
  const section = document.createElement("div");
  section.className = "gs-name-labeling";
  const heading = document.createElement("p");
  heading.innerHTML = `<strong>Label authors</strong> \u2014 ${unresolved.length} ID(s) couldn't be resolved automatically. Enter names to use them throughout the analysis.`;
  section.appendChild(heading);
  const inputs = /* @__PURE__ */ new Map();
  for (const authorId of unresolved) {
    const charCount = rawSurviving.get(authorId) ?? 0;
    const row = document.createElement("div");
    row.className = "gs-name-row";
    const label = document.createElement("span");
    label.className = "gs-author-id";
    label.textContent = `${charCount} chars \u2014 ${authorId}`;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter name\u2026";
    input.className = "gs-name-input";
    inputs.set(authorId, input);
    row.appendChild(label);
    row.appendChild(input);
    section.appendChild(row);
  }
  const saveBtn = document.createElement("button");
  saveBtn.className = "gs-button";
  saveBtn.textContent = "Save names";
  saveBtn.addEventListener("click", async () => {
    const updates = {};
    let hasAny = false;
    for (const [id, input] of inputs) {
      const val = input.value.trim();
      if (val) {
        updates[id] = val;
        hasAny = true;
      }
    }
    if (!hasAny) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving\u2026";
    await chrome.runtime.sendMessage({ type: "groupsync-save-names", docId, names: updates });
    await render(root, docId);
  });
  section.appendChild(saveBtn);
  root.prepend(section);
}
function renderFetchStructureButton(root, docId) {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Fetch document structure (Docs API)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Fetching structure\u2026";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-fetch-structure", docId });
    if (!result?.ok) {
      setStatus(root, `Docs API structure fetch failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}
function renderFetchHistoryButton(root, docId) {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Fetch full history (retroactive)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Fetching full history\u2026";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-fetch-history", docId });
    if (!result?.ok) {
      setStatus(root, `Retroactive history fetch failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}
function renderExportButton(root, summary) {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Export evidence summary (copy JSON, content-stripped)";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
    button.textContent = "Copied to clipboard";
    setTimeout(() => {
      button.textContent = "Export evidence summary (copy JSON, content-stripped)";
    }, 1500);
  });
  root.prepend(button);
}
function sentenceLi(sentence) {
  return `<li>${escapeHtml(sentence.text)} <span class="gs-rule-id">[${escapeHtml(sentence.ruleId)}]</span></li>`;
}
function renderNarration(narration) {
  const sectionsHtml = narration.sections.filter((s) => s.sentences.length > 0).map((s) => {
    const label = s.headingText ? `\xB6${s.paragraph} \u2014 ${escapeHtml(s.headingText)}` : `\xB6${s.paragraph}`;
    return `<div class="gs-section"><strong>${label}</strong><ul>${s.sentences.map(sentenceLi).join("")}</ul></div>`;
  }).join("");
  const signalsHtml = narration.signalSentences.length ? `<div class="gs-section"><strong>Signals</strong><ul>${narration.signalSentences.map(sentenceLi).join("")}</ul></div>` : "";
  return `<p class="gs-disclaimer">${escapeHtml(narration.disclaimer)}</p><div class="gs-narration">${sectionsHtml}${signalsHtml}</div>`;
}
async function render(root, docId) {
  const [opsResult, namesResult, structureResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: "groupsync-get-ops", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-names", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-structure", docId })
  ]);
  const ops = opsResult?.ops ?? [];
  const names = namesResult?.names ?? {};
  const structureRanges = structureResult?.ranges ?? [];
  if (ops.length === 0) {
    setStatus(
      root,
      "No edits captured yet for this doc \u2014 make an edit (insert or delete text) or fetch its full history below, then reopen this popup."
    );
    renderFetchHistoryButton(root, docId);
    return;
  }
  const { originByPosition, deletionLog } = replay(ops);
  const rawSurviving = survivingCharacterMap(originByPosition);
  const surviving = mapToObject(rawSurviving, names);
  const deletions = Object.fromEntries(
    Array.from(deletionOverwriteMap(deletionLog), ([actor, targets]) => [labelKey(actor, names), mapToObject(targets, names)])
  );
  const usingDocsStructure = structureRanges.length > 0;
  const parsedSections = usingDocsStructure ? segmentByDocsStructure(originByPosition, structureRanges) : segmentIntoParagraphs(originByPosition);
  const sections = parsedSections.map((section, i) => ({
    paragraph: i + 1,
    headingLevel: section.headingLevel,
    formClassification: section.formClassification,
    text: section.text,
    authorshipByAuthor: mapToObject(section.authorship, names)
  }));
  const rawFootprints = authorFootprints(parsedSections, originByPosition);
  const rawPastes = detectPastes(ops);
  const rawQuarantine = detectQuarantineSignals(ops);
  const rawLateConcentration = detectLateConcentration(ops);
  const rawRevisionDepth = revisionDepthSignals(deletionOverwriteMap(deletionLog));
  const rawConcurrentEdits = detectConcurrentEditBoundaries(ops);
  const footprints = rawFootprints.map((f) => ({
    author: labelKey(f.authorId, names),
    revisionBreadth: f.revisionBreadth,
    originShare: f.originShare,
    narrationPhrase: narrationPhraseForShare(f.originShare),
    isIntegratorPattern: f.isIntegratorPattern
  }));
  const pastes = rawPastes.map((p) => ({ ...p, authorId: labelKey(p.authorId, names) }));
  const quarantineSignals = rawQuarantine.map((q) => ({
    sessionStart: q.session.startTimestamp,
    sessionEnd: q.session.endTimestamp,
    churnFraction: q.churnFraction
  }));
  const lateConcentration = rawLateConcentration.map((l) => ({ ...l, authorId: labelKey(l.authorId, names) }));
  const revisionDepth = rawRevisionDepth.map((r) => ({
    ...r,
    actorId: labelKey(r.actorId, names),
    targetId: labelKey(r.targetId, names)
  }));
  const concurrentEdits = rawConcurrentEdits.map((c) => ({
    ...c,
    authorA: labelKey(c.authorA, names),
    authorB: labelKey(c.authorB, names)
  }));
  const debugData = {
    opsCaptured: ops.length,
    structureSource: usingDocsStructure ? "Docs API (headings/tables)" : "newline-only paragraphs (fallback)",
    survivingCharactersByAuthor: surviving,
    deletionOverwriteByActor: deletions,
    signals: {
      footprints,
      pastes,
      quarantineSignals,
      lateConcentration,
      revisionDepth,
      concurrentEdits
    }
  };
  const narration = buildNarrationReport({
    sections: parsedSections,
    footprints: rawFootprints,
    pastes: rawPastes,
    quarantineSignals: rawQuarantine,
    lateConcentration: rawLateConcentration,
    revisionDepth: rawRevisionDepth,
    concurrentEdits: rawConcurrentEdits,
    names
  });
  const summary = toContentStrippedSummary(narration, rawFootprints, names);
  root.innerHTML = `<p class="gs-status">Capture + replay + structure + signals + narration (first-draft wording \u2014 see ME.MD). Structure source: ${escapeHtml(debugData.structureSource)}.</p>` + renderNarration(narration) + `<pre class="gs-json">${escapeHtml(JSON.stringify(debugData, null, 2))}</pre>`;
  renderFetchHistoryButton(root, docId);
  renderNameLabelingSection(root, docId, rawSurviving, names);
  renderResolveNamesButton(root, docId);
  renderFetchStructureButton(root, docId);
  renderExportButton(root, summary);
}
async function main() {
  const root = document.getElementById("gs-root");
  if (!root) return;
  const docId = await getActiveDocId();
  if (!docId) {
    setStatus(root, "Open a Google Doc tab to capture its edit history.");
    return;
  }
  await render(root, docId);
}
main();
