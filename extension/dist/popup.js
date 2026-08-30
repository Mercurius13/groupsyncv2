// src/capture.ts
function extractDocId(url) {
  const match = url.match(/\/document\/(?:u\/\d+\/)?d\/([^/]+)\//);
  return match ? match[1] : null;
}

// src/replay.ts
function padToLength(live, length, nextCharId) {
  while (live.length < length) {
    live.push({ charId: nextCharId(), authorId: null, char: null });
  }
}
var MAX_SPLICE_ARGS = 32768;
function spliceInsert(live, position, inserted) {
  if (inserted.length <= MAX_SPLICE_ARGS) {
    live.splice(position, 0, ...inserted);
    return;
  }
  for (let offset = 0; offset < inserted.length; offset += MAX_SPLICE_ARGS) {
    live.splice(position + offset, 0, ...inserted.slice(offset, offset + MAX_SPLICE_ARGS));
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
      const inserted = op.text.split("").map((char) => ({
        charId: nextCharId(),
        authorId: op.authorId,
        char
      }));
      spliceInsert(live, op.position, inserted);
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

// src/structure.ts
var WEIGHT_TABLE = 3;
var WEIGHT_NUMERIC = 1.5;
var WEIGHT_LIST = 1.25;
var WEIGHT_PARAGRAPH = 1;
var WEIGHT_HEADING = 1;
var NUMERIC_DIGIT_FRACTION = 0.3;
function digitFraction(text) {
  let digits = 0;
  let nonSpace = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    nonSpace++;
    if (ch >= "0" && ch <= "9") digits++;
  }
  return nonSpace === 0 ? 0 : digits / nonSpace;
}
function classifyContentForm(kind, text) {
  switch (kind) {
    case "table":
      return { contentForm: "table", weight: WEIGHT_TABLE };
    case "heading":
      return { contentForm: "heading", weight: WEIGHT_HEADING };
    case "list":
      return digitFraction(text) >= NUMERIC_DIGIT_FRACTION ? { contentForm: "numeric", weight: WEIGHT_NUMERIC } : { contentForm: "list", weight: WEIGHT_LIST };
    case "paragraph":
    default:
      return digitFraction(text) >= NUMERIC_DIGIT_FRACTION ? { contentForm: "numeric", weight: WEIGHT_NUMERIC } : { contentForm: "prose", weight: WEIGHT_PARAGRAPH };
  }
}
function formClassificationOf(contentForm) {
  return contentForm === "table" || contentForm === "numeric" ? "calculations" : "discussion/theory";
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
function isBlankSection(text) {
  return text.replace(/�/g, "").trim().length === 0;
}
function cellOwner(cellChars) {
  const counts = /* @__PURE__ */ new Map();
  const earliest = /* @__PURE__ */ new Map();
  let realChars = 0;
  for (const c of cellChars) {
    if (c.char === null) continue;
    realChars++;
    counts.set(c.authorId, (counts.get(c.authorId) ?? 0) + 1);
    if (!earliest.has(c.authorId)) earliest.set(c.authorId, c.charId);
  }
  if (realChars === 0) return null;
  let owner = null;
  let bestCount = -1;
  let bestEarliest = Infinity;
  for (const [authorId, count] of counts) {
    const first = earliest.get(authorId) ?? Infinity;
    if (count > bestCount || count === bestCount && first < bestEarliest) {
      owner = authorId;
      bestCount = count;
      bestEarliest = first;
    }
  }
  return { authorId: owner, realChars };
}
function clampIndex(index, offset, length) {
  return Math.max(0, Math.min(index + offset, length));
}
function buildTableSection(chars, el, offset) {
  const start = clampIndex(el.startIndex, offset, chars.length);
  const end = clampIndex(el.endIndex, offset, chars.length);
  const slice = chars.slice(start, end);
  const authorship = /* @__PURE__ */ new Map();
  const cellOwnership = /* @__PURE__ */ new Map();
  for (const cell of el.cells ?? []) {
    const owner = cellOwner(
      chars.slice(clampIndex(cell.startIndex, offset, chars.length), clampIndex(cell.endIndex, offset, chars.length))
    );
    if (!owner) continue;
    authorship.set(owner.authorId, (authorship.get(owner.authorId) ?? 0) + owner.realChars);
    cellOwnership.set(owner.authorId, (cellOwnership.get(owner.authorId) ?? 0) + 1);
  }
  const { contentForm, weight } = classifyContentForm("table", reconstructText(slice));
  return {
    start,
    end,
    text: reconstructText(slice),
    authorship,
    kind: "table",
    headingLevel: null,
    contentForm,
    weight,
    formClassification: formClassificationOf(contentForm),
    cellOwnership
  };
}
function segmentByElements(chars, elements, offset = 0) {
  const sections = [];
  for (const el of elements) {
    const start = clampIndex(el.startIndex, offset, chars.length);
    const end = clampIndex(el.endIndex, offset, chars.length);
    if (end <= start) continue;
    if (el.kind === "table") {
      sections.push(buildTableSection(chars, el, offset));
      continue;
    }
    const base = buildSection(chars, start, end);
    if (isBlankSection(base.text)) continue;
    const { contentForm, weight } = classifyContentForm(el.kind, base.text);
    sections.push({
      ...base,
      kind: el.kind,
      headingLevel: el.kind === "heading" ? el.level ?? null : null,
      contentForm,
      weight,
      formClassification: formClassificationOf(contentForm)
    });
  }
  return sections;
}
function sectionHeadingText(section) {
  if (section.headingLevel === null || section.headingLevel === void 0) return null;
  const firstLine = section.text.split("\n")[0]?.trim();
  return firstLine ? firstLine : null;
}
var ALIGNMENT_CONFIDENCE_THRESHOLD = 0.9;
var MAX_PROBE_OFFSET = 8;
var MIN_CHECKABLE_ELEMENTS = 3;
var DRIFT_SCORE_GAP = 0.3;
function isNewlineTerminated(el) {
  return el.kind === "paragraph" || el.kind === "heading" || el.kind === "list";
}
function scoreOffset(chars, elements, offset) {
  const hits = [];
  for (const el of elements) {
    if (!isNewlineTerminated(el)) continue;
    const position = el.endIndex - 1 + offset;
    if (position < 0 || position >= chars.length) continue;
    const char = chars[position]?.char;
    if (char === null || char === void 0) continue;
    hits.push(char === "\n");
  }
  const checked = hits.length;
  const score = checked === 0 ? 0 : hits.filter(Boolean).length / checked;
  return { score, checked, hits };
}
function candidateOffsets() {
  const offsets = [0];
  for (let i = 1; i <= MAX_PROBE_OFFSET; i++) offsets.push(i, -i);
  return offsets;
}
function halfScores(hits) {
  if (hits.length < 2) return { firstHalfScore: 0, secondHalfScore: 0 };
  const mid = Math.floor(hits.length / 2);
  const first = hits.slice(0, mid);
  const second = hits.slice(mid);
  const rate = (part) => part.length === 0 ? 0 : part.filter(Boolean).length / part.length;
  return { firstHalfScore: rate(first), secondHalfScore: rate(second) };
}
function detectIndexAlignment(chars, elements) {
  const scored = candidateOffsets().map((offset) => ({ offset, ...scoreOffset(chars, elements, offset) }));
  const eligible = scored.filter((s) => s.checked >= MIN_CHECKABLE_ELEMENTS);
  const pool = eligible.length > 0 ? eligible : scored;
  const best = pool.reduce((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? b : a;
    if (b.checked !== a.checked) return b.checked > a.checked ? b : a;
    return Math.abs(b.offset) < Math.abs(a.offset) ? b : a;
  }, pool[0] ?? { offset: 0, score: 0, checked: 0, hits: [] });
  const { firstHalfScore, secondHalfScore } = halfScores(best.hits);
  const driftDetected = firstHalfScore - secondHalfScore >= DRIFT_SCORE_GAP;
  let status;
  if (best.checked < MIN_CHECKABLE_ELEMENTS) {
    status = "insufficient-data";
  } else if (best.score < ALIGNMENT_CONFIDENCE_THRESHOLD) {
    status = "misaligned";
  } else {
    status = best.offset === 0 ? "aligned" : "offset";
  }
  return {
    status,
    offset: best.offset,
    score: best.score,
    checked: best.checked,
    firstHalfScore,
    secondHalfScore,
    driftDetected
  };
}
function isStructureTrustworthy(report) {
  return (report.status === "aligned" || report.status === "offset") && !report.driftDetected;
}
function describeAlignment(report) {
  const pct3 = `${Math.round(report.score * 100)}%`;
  switch (report.status) {
    case "aligned":
      return `Document structure lines up with the captured edit history (${pct3} of ${report.checked} checked boundaries).`;
    case "offset":
      return report.driftDetected ? `Structure indices drift through the document \u2014 falling back to newline paragraphs, so tables are not attributed cell-by-cell.` : `Document structure lines up after a ${report.offset}-character shift (${pct3} of ${report.checked} checked boundaries).`;
    case "misaligned":
      return `Document structure does not line up with the captured edit history (only ${pct3} of ${report.checked} checked boundaries matched) \u2014 falling back to newline paragraphs rather than risk misattributing sections.`;
    case "insufficient-data":
    default:
      return `Not enough of the document's history was captured to verify that its structure lines up \u2014 falling back to newline paragraphs.`;
  }
}

// src/narration.ts
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
function authorFootprints(sections) {
  const totalSurvivingChars = sections.reduce(
    (sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0),
    0
  );
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
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const op of ops) {
    if (op.timestamp < minTs) minTs = op.timestamp;
    if (op.timestamp > maxTs) maxTs = op.timestamp;
  }
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
var PASTE_HEAVY_FRACTION = 0.5;
function buildContributionProfiles(inputs) {
  const { sections, footprints, pastes, lateConcentration, quarantineSignals, deletionOverwrite } = inputs;
  const totalSurvivingChars = footprints[0]?.totalSurvivingChars ?? sections.reduce((sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0), 0);
  const totalWeightedChars = sections.reduce(
    (sum, s) => sum + Array.from(s.authorship.values()).reduce((a, b) => a + b, 0) * (s.weight ?? 1),
    0
  );
  const authorIds = /* @__PURE__ */ new Set();
  for (const f of footprints) authorIds.add(f.authorId);
  for (const p of pastes) authorIds.add(p.authorId);
  for (const l of lateConcentration) authorIds.add(l.authorId);
  for (const actorId of deletionOverwrite.keys()) authorIds.add(actorId);
  const footprintById = new Map(footprints.map((f) => [f.authorId, f]));
  const lateById = new Map(lateConcentration.map((l) => [l.authorId, l]));
  const quarantinedSessionsByAuthor = /* @__PURE__ */ new Map();
  for (const q of quarantineSignals) {
    const activeAuthors = new Set(q.session.ops.map((op) => op.authorId));
    for (const id of activeAuthors) {
      quarantinedSessionsByAuthor.set(id, (quarantinedSessionsByAuthor.get(id) ?? 0) + 1);
    }
  }
  const profiles = Array.from(authorIds).map((authorId) => {
    const footprint = footprintById.get(authorId);
    const originatedChars = footprint?.originatedChars ?? 0;
    const originShare = footprint?.originShare ?? 0;
    const primarySectionIndices = [];
    let weightedOriginatedChars = 0;
    sections.forEach((section, i) => {
      const sectionTotal = Array.from(section.authorship.values()).reduce((a, b) => a + b, 0);
      if (sectionTotal === 0) return;
      const chars = section.authorship.get(authorId) ?? 0;
      weightedOriginatedChars += chars * (section.weight ?? 1);
      if (chars / sectionTotal >= PRIMARY_AUTHOR_SHARE_THRESHOLD) primarySectionIndices.push(i);
    });
    const weightedOriginShare = totalWeightedChars === 0 ? 0 : weightedOriginatedChars / totalWeightedChars;
    const authorPastes = pastes.filter((p) => p.authorId === authorId);
    const pastedChars = authorPastes.reduce((sum, p) => sum + p.length, 0);
    let charsDeletedOfOthers = 0;
    for (const [targetId, count] of deletionOverwrite.get(authorId) ?? []) {
      if (targetId !== authorId) charsDeletedOfOthers += count;
    }
    const late = lateById.get(authorId) ?? null;
    const revisionBreadth = footprint?.revisionBreadth ?? 0;
    return {
      authorId,
      originatedChars,
      totalSurvivingChars,
      originShare,
      weightedOriginatedChars,
      totalWeightedChars,
      weightedOriginShare,
      sectionsTouched: footprint?.sectionsTouched ?? 0,
      totalSections: sections.length,
      revisionBreadth,
      primarySectionIndices,
      pasteCount: authorPastes.length,
      pastedChars,
      charsDeletedOfOthers,
      lateConcentration: late,
      quarantinedSessionCount: quarantinedSessionsByAuthor.get(authorId) ?? 0,
      isIntegratorPattern: revisionBreadth >= INTEGRATOR_BREADTH_THRESHOLD && weightedOriginShare < INTEGRATOR_ORIGIN_SHARE_THRESHOLD,
      isPasteHeavy: authorPastes.length > 0 && pastedChars >= PASTE_HEAVY_FRACTION * Math.max(originatedChars, 1),
      isLowOriginLateBurst: weightedOriginShare < CONTRIBUTOR_SHARE_THRESHOLD && late !== null
    };
  });
  return profiles.sort((a, b) => b.weightedOriginShare - a.weightedOriginShare);
}
function graderExcludedAuthorIds(authorIds, names, manuallyExcluded = []) {
  const excluded = new Set(manuallyExcluded);
  for (const id of authorIds) {
    if (!names[id]) excluded.add(id);
  }
  return excluded;
}
function excludeAuthorsFromSections(sections, excludedIds) {
  if (excludedIds.size === 0) return { sections, excluded: [] };
  const excludedChars = /* @__PURE__ */ new Map();
  const filtered = sections.map((section) => {
    const authorship = new Map(section.authorship);
    for (const id of excludedIds) {
      const n = authorship.get(id);
      if (n) {
        excludedChars.set(id, (excludedChars.get(id) ?? 0) + n);
        authorship.delete(id);
      }
    }
    return { ...section, authorship };
  });
  const excluded = Array.from(excludedChars, ([authorId, chars]) => ({ authorId, excludedChars: chars })).sort(
    (a, b) => b.excludedChars - a.excludedChars
  );
  return { sections: filtered, excluded };
}
function applyExclusions(inputs, excludedIds) {
  if (excludedIds.size === 0) return { ...inputs, excluded: [] };
  const { sections, excluded } = excludeAuthorsFromSections(inputs.sections, excludedIds);
  const deletionOverwrite = new Map(
    Array.from(inputs.deletionOverwrite).filter(([actor]) => !excludedIds.has(actor))
  );
  return {
    sections,
    pastes: inputs.pastes.filter((p) => !excludedIds.has(p.authorId)),
    lateConcentration: inputs.lateConcentration.filter((l) => !excludedIds.has(l.authorId)),
    concurrentEdits: inputs.concurrentEdits.filter((c) => !excludedIds.has(c.authorA) && !excludedIds.has(c.authorB)),
    deletionOverwrite,
    excluded
  };
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
var DISCLAIMER = "This tool measures on-document editing only. It cannot detect off-document work, in-person contribution, or content drafted elsewhere and pasted in. Use as evidence, not as a verdict.";
function pct(share) {
  return `${Math.round(share * 100)}%`;
}
function ratio(part, whole) {
  return `${part}/${whole} (${pct(whole === 0 ? 0 : part / whole)})`;
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
function narrateIntegratorPattern(footprint) {
  if (!footprint.isIntegratorPattern) return null;
  return {
    ruleId: "F7.4-integrator-pattern",
    text: `Edited ${pct(footprint.revisionBreadth)} of the document's sections but originated only ${pct(footprint.originShare)} of its surviving text \u2014 a pattern consistent with integrating or reformatting others' work rather than drafting original content. This describes what the edit data shows, not a conclusion about effort or contribution.`
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
function narrateLateConcentration(signal) {
  return {
    ruleId: "F6.4-late-concentration",
    text: `${pct(signal.lateFraction)} of their edits occurred in the final ${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the document's overall editing timeline.`
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
function narrateAuthorProfile(profile) {
  const sentences = [];
  sentences.push({
    ruleId: "F6.1-author-overview",
    text: `Created ${ratio(Math.round(profile.weightedOriginatedChars), Math.round(profile.totalWeightedChars))} of the document's form-weighted content (tables, figures and lists count for more than plain prose), with surviving text in ${ratio(profile.sectionsTouched, profile.totalSections)} sections.`
  });
  if (profile.primarySectionIndices.length > 0) {
    sentences.push({
      ruleId: "F7.3-primary-sections",
      text: `Is the primary author (at least ${pct(PRIMARY_AUTHOR_SHARE_THRESHOLD)} of surviving characters) of ${ratio(profile.primarySectionIndices.length, profile.totalSections)} sections.`
    });
  }
  const integrator = narrateIntegratorPattern({
    revisionBreadth: profile.revisionBreadth,
    originShare: profile.weightedOriginShare,
    isIntegratorPattern: profile.isIntegratorPattern
  });
  if (integrator) sentences.push(integrator);
  if (profile.lateConcentration) {
    sentences.push(narrateLateConcentration(profile.lateConcentration));
  }
  if (profile.isLowOriginLateBurst && profile.lateConcentration) {
    sentences.push({
      ruleId: "F6-low-origin-late-burst",
      text: `Taken together, they created ${pct(profile.weightedOriginShare)} of the document's form-weighted content with ${pct(profile.lateConcentration.lateFraction)} of their edits landing in the final ${pct(LATE_CONCENTRATION_WINDOW_FRACTION)} of the editing timeline \u2014 low surviving contribution combined with late-concentrated activity. These are on-document signals only; what they mean for the student's actual role is the professor's judgment.`
    });
  }
  if (profile.isPasteHeavy) {
    sentences.push({
      ruleId: "F4-paste-heavy",
      text: `A large amount of pasted content: ${profile.pastedChars} characters across ${profile.pasteCount} separate events, against ${profile.originatedChars} surviving characters they originated \u2014 much of their text arrived wholesale rather than being typed incrementally. The tool cannot distinguish pasting one's own drafted work from text drafted elsewhere.`
    });
  }
  if (profile.charsDeletedOfOthers >= REVISION_DEPTH_NARRATION_THRESHOLD) {
    sentences.push({
      ruleId: "F6.3-revision-summary",
      text: `Deleted ${profile.charsDeletedOfOthers} characters they did not originate (other authors' text or text of unknown origin) while revising.`
    });
  }
  if (profile.quarantinedSessionCount > 0) {
    sentences.push({
      ruleId: "F3.2-author-quarantine-note",
      text: `Was active in ${profile.quarantinedSessionCount} session(s) in which a large portion of the document was deleted \u2014 attribution for activity in those sessions is less reliable (see Signals).`
    });
  }
  if (profile.weightedOriginShare < CONTRIBUTOR_SHARE_THRESHOLD) {
    sentences.push({
      ruleId: "C5-limited-observed-activity",
      text: `The captured edit history shows relatively little surviving text from this contributor. This tool sees on-document editing only \u2014 drafting elsewhere, research, discussion, and in-person contribution are invisible to it, and absence of captured edits is not evidence of absence of contribution.`
    });
  }
  return sentences;
}
function narrateExclusion(summary, names) {
  const isAnonymous = names[summary.authorId] === null || names[summary.authorId] === void 0;
  const reason = isAnonymous ? `it is anonymous/unattributable in version history \u2014 the account running the extension appears anonymous, so this is the grader's own account (name them under "Who counts as a student" to count them as a student instead)` : `it was marked as a co-instructor/TA`;
  return {
    ruleId: "C2-grader-excluded",
    text: `${authorLabel(summary.authorId, names)}'s edits are excluded from this assessment because ${reason} \u2014 ${summary.excludedChars} surviving characters, counted in no contribution share.`
  };
}
function buildNarrationReport(inputs) {
  const { names } = inputs;
  const exclusions = (inputs.exclusions ?? []).map((e) => narrateExclusion(e, names));
  const authorProfiles = inputs.profiles.map((profile) => ({
    authorId: profile.authorId,
    label: authorLabel(profile.authorId, names),
    sentences: narrateAuthorProfile(profile)
  }));
  const sections = inputs.sections.map((section, i) => ({
    paragraph: i + 1,
    sentences: narrateSection(section, names),
    headingText: sectionHeadingText(section)
  }));
  const signalSentences = [
    ...inputs.pastes.map((p) => narratePaste(p, names)),
    ...inputs.quarantineSignals.map((q) => narrateQuarantine(q)),
    ...inputs.revisionDepth.map((r) => narrateRevisionDepth(r, names)),
    ...inputs.concurrentEdits.map((c) => narrateConcurrentEdit(c, names))
  ];
  return {
    disclaimer: DISCLAIMER,
    exclusions,
    authorProfiles,
    sections,
    signalNotes: signalSentences.map((s) => s.text),
    signalSentences,
    ruleTrace: [
      ...exclusions,
      ...authorProfiles.flatMap((p) => p.sentences),
      ...sections.flatMap((s) => s.sentences),
      ...signalSentences
    ]
  };
}
function toContentStrippedSummary(narration, footprints, names = {}, now = Date.now) {
  return {
    disclaimer: narration.disclaimer,
    generatedAt: now(),
    exclusionNotes: narration.exclusions.map((s) => s.text),
    authorSummaries: narration.authorProfiles.map((p) => ({
      authorId: p.authorId,
      authorName: names[p.authorId] ?? null,
      sentences: p.sentences.map((sentence) => sentence.text)
    })),
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

// src/popup.ts
var OPEN_VERSION_HISTORY_HINT = "open File \u2192 Version history \u2192 See version history in the doc and scroll through the revision list, then reopen this popup";
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
async function getActiveDocId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return extractDocId(tab.url);
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
function pct2(share) {
  return `${Math.round(share * 100)}%`;
}
var SERIES_SLOTS = 6;
function authorColorSlots(ops) {
  const slots = /* @__PURE__ */ new Map();
  for (const op of ops) {
    if (slots.has(op.authorId)) continue;
    slots.set(op.authorId, slots.size < SERIES_SLOTS ? slots.size + 1 : 0);
  }
  return slots;
}
function slotClass(slots, authorId) {
  if (authorId === null) return "gs-s0";
  return `gs-s${slots.get(authorId) ?? 0}`;
}
function panel(title) {
  const section = document.createElement("section");
  section.className = "gs-panel";
  if (title) {
    const heading = document.createElement("h2");
    heading.className = "gs-heading";
    heading.textContent = title;
    section.appendChild(heading);
  }
  return section;
}
function button(label, onClick, primary = false) {
  const btn = document.createElement("button");
  btn.className = primary ? "gs-button gs-button-primary" : "gs-button";
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}
function renderEmptyState(root, title, body, action) {
  root.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "gs-empty";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  wrap.append(h, p);
  if (action) wrap.appendChild(action);
  root.appendChild(wrap);
}
async function runFetch(root, docId, btn, type, pendingLabel) {
  const original = btn.textContent ?? "";
  btn.disabled = true;
  btn.textContent = pendingLabel;
  const result = await chrome.runtime.sendMessage({ type, docId });
  if (!result?.ok) {
    btn.disabled = false;
    btn.textContent = original;
    const err = document.createElement("p");
    err.className = "gs-status";
    err.textContent = `Failed: ${result?.error ?? "unknown error"}`;
    btn.after(err);
    return;
  }
  await render(root, docId);
}
function renderSources(root, docId, opCount, usingDocsStructure, unitCount, alignmentNote) {
  const section = panel("Data sources");
  const grid = document.createElement("div");
  grid.className = "gs-sources";
  const history = document.createElement("div");
  history.className = "gs-source";
  history.innerHTML = `<div class="gs-source-label">Edit history</div><div class="gs-source-value gs-source-ok">${opCount.toLocaleString()} captured edits</div>`;
  history.appendChild(
    button("Re-fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching\u2026"))
  );
  const structure = document.createElement("div");
  structure.className = "gs-source";
  const structureValue = usingDocsStructure ? `<div class="gs-source-value gs-source-ok">${unitCount} structural units, form-weighted</div>` : alignmentNote ? (
    // Structure was fetched but its indices could not be reconciled with the
    // replayed characters — say so, rather than showing confident section figures.
    `<div class="gs-source-value gs-pending">Fetched, but not usable for this document</div>`
  ) : `<div class="gs-source-value gs-pending">Not fetched \u2014 falling back to newline paragraphs, which inflates unit counts and drops form weighting</div>`;
  structure.innerHTML = `<div class="gs-source-label">Document structure</div>` + structureValue + (alignmentNote ? `<div class="gs-caption">${escapeHtml(alignmentNote)}</div>` : "");
  structure.appendChild(
    button(
      alignmentNote ? "Re-fetch structure" : "Fetch document structure",
      (btn) => runFetch(root, docId, btn, "groupsync-fetch-structure", "Fetching\u2026"),
      !usingDocsStructure
    )
  );
  grid.append(history, structure);
  section.appendChild(grid);
  return section;
}
function renderContributionSplit(profiles, names, slots) {
  const contributing = profiles.filter((p) => p.weightedOriginatedChars > 0);
  if (contributing.length === 0) return null;
  const known = contributing.reduce((sum, p) => sum + p.weightedOriginShare, 0);
  const unknownShare = Math.max(0, 1 - known);
  const segments = contributing.map((p) => ({
    label: names[p.authorId] ?? `author ${p.authorId}`,
    share: p.weightedOriginShare,
    chars: Math.round(p.weightedOriginatedChars),
    cls: slotClass(slots, p.authorId)
  }));
  if (unknownShare > 5e-3) {
    segments.push({
      label: "Unknown origin (predates captured history)",
      share: unknownShare,
      chars: Math.round(unknownShare * (contributing[0]?.totalWeightedChars ?? 0)),
      cls: "gs-s0"
    });
  }
  const section = panel("Contribution split");
  const caption = document.createElement("p");
  caption.className = "gs-caption";
  caption.textContent = "Share of the document's form-weighted content \u2014 tables, figures and lists count for more than plain prose, so these are weighted characters, not raw ones.";
  section.appendChild(caption);
  const bar = document.createElement("div");
  bar.className = "gs-split-bar";
  for (const seg of segments) {
    const fill = document.createElement("div");
    fill.className = `gs-split-seg ${seg.cls}`;
    fill.style.flex = `${Math.max(seg.share, 1e-3)}`;
    fill.title = `${seg.label} \u2014 ${pct2(seg.share)}`;
    bar.appendChild(fill);
  }
  const legend = document.createElement("div");
  legend.className = "gs-legend";
  for (const seg of segments) {
    const row = document.createElement("div");
    row.className = "gs-legend-row";
    row.innerHTML = `<span class="gs-swatch ${seg.cls}"></span><span class="gs-legend-name">${escapeHtml(seg.label)}</span><span class="gs-legend-share">${pct2(seg.share)}</span><span class="gs-legend-chars">${seg.chars.toLocaleString()} ch</span>`;
    legend.appendChild(row);
  }
  section.append(bar, legend);
  return section;
}
function flagChips(profile) {
  const flags = [];
  if (profile.isIntegratorPattern) flags.push("Integrator pattern");
  if (profile.isPasteHeavy) flags.push("Paste-heavy");
  if (profile.isLowOriginLateBurst) flags.push("Late burst, low origin");
  if (profile.quarantinedSessionCount > 0) {
    flags.push(`Active in ${profile.quarantinedSessionCount} high-churn session(s)`);
  }
  return flags;
}
function sentenceLi(sentence) {
  return `<li>${escapeHtml(sentence.text)} <span class="gs-rule-id">[${escapeHtml(sentence.ruleId)}]</span></li>`;
}
function renderAuthors(narration, profiles, slots) {
  if (narration.authorProfiles.length === 0) return null;
  const byId = new Map(profiles.map((p) => [p.authorId, p]));
  const section = panel("Authors");
  for (const authorNarration of narration.authorProfiles) {
    const profile = byId.get(authorNarration.authorId);
    const card = document.createElement("div");
    card.className = "gs-author-card gs-narration";
    const share = profile ? pct2(profile.weightedOriginShare) : "\u2014";
    const chips = profile ? flagChips(profile) : [];
    card.innerHTML = `<div class="gs-author-head"><span class="gs-swatch ${slotClass(slots, authorNarration.authorId)}"></span><span class="gs-author-name">${escapeHtml(authorNarration.label)}</span><span class="gs-author-share">${share}<small>of weighted content</small></span></div>` + (chips.length ? `<div class="gs-flags">${chips.map((f) => `<span class="gs-flag">${escapeHtml(f)}</span>`).join("")}</div>` : "") + `<ul>${authorNarration.sentences.map(sentenceLi).join("")}</ul>`;
    section.appendChild(card);
  }
  return section;
}
var SECTIONS_OPEN_BY_DEFAULT_LIMIT = 12;
function sectionGlance(section, names) {
  const tally = section.kind === "table" && section.cellOwnership ? section.cellOwnership : section.authorship;
  const unit = section.kind === "table" && section.cellOwnership ? "cells" : "%";
  const total = Array.from(tally.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "no surviving characters";
  let topId = null;
  let topCount = -1;
  for (const [id, count] of tally) {
    if (count > topCount) {
      topId = id;
      topCount = count;
    }
  }
  const who = topId === null ? "unknown origin" : names[topId] ?? `author ${topId}`;
  return unit === "cells" ? `mostly ${who} (${topCount}/${total} cells)` : `mostly ${who} (${Math.round(topCount / total * 100)}%)`;
}
function renderSections(narration, parsedSections, names, slots) {
  const narrated = narration.sections.filter((s) => s.sentences.length > 0);
  if (narrated.length === 0) return null;
  const open = narrated.length <= SECTIONS_OPEN_BY_DEFAULT_LIMIT ? " open" : "";
  const section = panel(`Sections (${narrated.length})`);
  const wrap = document.createElement("div");
  wrap.className = "gs-narration";
  wrap.innerHTML = narrated.map((s) => {
    const parsed = parsedSections[s.paragraph - 1];
    const tally = parsed && parsed.kind === "table" && parsed.cellOwnership ? parsed.cellOwnership : parsed?.authorship;
    let topId = null;
    let topCount = -1;
    for (const [id, count] of tally ?? []) {
      if (count > topCount) {
        topId = id;
        topCount = count;
      }
    }
    const swatch = parsed ? `<span class="gs-swatch ${slotClass(slots, topId)}"></span>` : "";
    const glance = parsed ? `<span class="gs-glance">${escapeHtml(sectionGlance(parsed, names))}</span>` : "";
    const form = parsed?.contentForm ? `<span class="gs-form-tag">${escapeHtml(parsed.contentForm)} \xD7${parsed.weight ?? 1}</span>` : parsed?.formClassification ? `<span class="gs-form-tag">${escapeHtml(parsed.formClassification)}</span>` : "";
    const label = s.headingText ? escapeHtml(s.headingText) : `Unit ${s.paragraph}`;
    return `<details class="gs-section-details"${open}><summary>${swatch}<span class="gs-section-title">${label}</span>${form}${glance}</summary><ul>${s.sentences.map(sentenceLi).join("")}</ul></details>`;
  }).join("");
  section.appendChild(wrap);
  return section;
}
function renderNotice(title, cssClass, sentences) {
  if (sentences.length === 0) return null;
  const section = panel(title);
  const box = document.createElement("div");
  box.className = `${cssClass} gs-narration`;
  box.innerHTML = `<ul>${sentences.map(sentenceLi).join("")}</ul>`;
  section.appendChild(box);
  return section;
}
function renderRoster(root, docId, authorIds, rawSurviving, names, manualExcluded, slots) {
  if (authorIds.length === 0) return null;
  const section = panel("Who counts as a student");
  const box = document.createElement("div");
  box.className = "gs-setup";
  const intro = document.createElement("p");
  intro.innerHTML = `Authors Google's version history won't name are treated as <strong>you, the grader</strong> \u2014 the account running this extension always appears unnamed there \u2014 and are left out of the assessment entirely. If one of them is actually a student, give them a name here and they'll be counted. Check a named author to exclude a co-instructor or TA.`;
  box.appendChild(intro);
  const inputs = /* @__PURE__ */ new Map();
  const checkboxes = /* @__PURE__ */ new Map();
  const manualSet = new Set(manualExcluded);
  const sorted = [...authorIds].sort((a, b) => {
    const unnamedDelta = Number(Boolean(names[a])) - Number(Boolean(names[b]));
    if (unnamedDelta !== 0) return unnamedDelta;
    return (rawSurviving.get(b) ?? 0) - (rawSurviving.get(a) ?? 0);
  });
  for (const authorId of sorted) {
    const charCount = rawSurviving.get(authorId) ?? 0;
    const name = names[authorId];
    const isUnnamed = !name;
    if (isUnnamed) {
      const row2 = document.createElement("div");
      row2.className = "gs-name-row";
      const label2 = document.createElement("span");
      label2.className = "gs-author-id";
      label2.innerHTML = `<span class="gs-swatch gs-s0"></span> Unnamed \u2014 counted as the grader \xB7 ${charCount.toLocaleString()} chars \xB7 <code>${escapeHtml(authorId)}</code>`;
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Name to count as a student\u2026";
      input.className = "gs-name-input";
      inputs.set(authorId, input);
      row2.append(label2, input);
      box.appendChild(row2);
      continue;
    }
    const row = document.createElement("label");
    row.className = "gs-grader-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = manualSet.has(authorId);
    checkboxes.set(authorId, checkbox);
    const label = document.createElement("span");
    label.className = "gs-author-id";
    label.innerHTML = `<span class="gs-swatch ${slotClass(slots, authorId)}"></span> ${escapeHtml(name)} \xB7 ${charCount.toLocaleString()} chars \xB7 exclude as co-instructor/TA`;
    row.append(checkbox, label);
    box.appendChild(row);
  }
  box.appendChild(
    button("Save", async (btn) => {
      const nameUpdates = {};
      for (const [id, input] of inputs) {
        const val = input.value.trim();
        if (val) nameUpdates[id] = val;
      }
      const excluded = Array.from(checkboxes.entries()).filter(([, checkbox]) => checkbox.checked).map(([id]) => id);
      btn.disabled = true;
      btn.textContent = "Saving\u2026";
      if (Object.keys(nameUpdates).length > 0) {
        await chrome.runtime.sendMessage({ type: "groupsync-save-names", docId, names: nameUpdates });
      }
      await chrome.runtime.sendMessage({ type: "groupsync-set-excluded", docId, excluded });
      await render(root, docId);
    })
  );
  section.appendChild(box);
  return section;
}
function renderDebug(debugData) {
  const details = document.createElement("details");
  details.className = "gs-debug";
  details.innerHTML = `<summary>Debug data (per-layer JSON)</summary><pre class="gs-json">${escapeHtml(JSON.stringify(debugData, null, 2))}</pre>`;
  return details;
}
async function render(root, docId) {
  const [opsResult, namesResult, structureResult, excludedResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: "groupsync-get-ops", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-names", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-structure", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-excluded", docId })
  ]);
  const ops = opsResult?.ops ?? [];
  const names = namesResult?.names ?? {};
  const structureElements = structureResult?.elements ?? [];
  const excludedList = excludedResult?.excluded ?? [];
  if (ops.length === 0) {
    renderEmptyState(
      root,
      "No edits captured yet",
      "Fetch this document's full history to analyse it \u2014 that pulls the changelog from revision 1, so the extension didn't need to be installed while the group was working.",
      button("Fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching\u2026"), true)
    );
    return;
  }
  if (Object.keys(names).length === 0) {
    renderEmptyState(
      root,
      "Author names not retrieved yet",
      `Results stay hidden until names are available, because attributing work to raw account IDs invites misattribution. To resolve them, ${OPEN_VERSION_HISTORY_HINT}.`,
      button("Fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching\u2026"), true)
    );
    return;
  }
  const { originByPosition, deletionLog } = replay(ops);
  const rawSurviving = survivingCharacterMap(originByPosition);
  const surviving = mapToObject(rawSurviving, names);
  const deletions = Object.fromEntries(
    Array.from(deletionOverwriteMap(deletionLog), ([actor, targets]) => [labelKey(actor, names), mapToObject(targets, names)])
  );
  const alignment = structureElements.length > 0 ? detectIndexAlignment(originByPosition, structureElements) : null;
  const parsedSections = alignment && isStructureTrustworthy(alignment) ? segmentByElements(originByPosition, structureElements, alignment.offset) : segmentIntoParagraphs(originByPosition);
  const usingDocsStructure = alignment !== null && isStructureTrustworthy(alignment);
  const allAuthorIds = Array.from(new Set(ops.map((op) => op.authorId)));
  const slots = authorColorSlots(ops);
  const excludedIds = graderExcludedAuthorIds(allAuthorIds, names, excludedList);
  const excluded = applyExclusions(
    {
      sections: parsedSections,
      pastes: detectPastes(ops),
      lateConcentration: detectLateConcentration(ops),
      concurrentEdits: detectConcurrentEditBoundaries(ops),
      deletionOverwrite: deletionOverwriteMap(deletionLog)
    },
    excludedIds
  );
  const assessedSections = excluded.sections;
  const sections = assessedSections.map((section, i) => ({
    paragraph: i + 1,
    kind: section.kind,
    headingLevel: section.headingLevel,
    contentForm: section.contentForm,
    weight: section.weight,
    formClassification: section.formClassification,
    text: section.text,
    authorshipByAuthor: mapToObject(section.authorship, names)
  }));
  const rawFootprints = authorFootprints(assessedSections);
  const rawPastes = excluded.pastes;
  const rawQuarantine = detectQuarantineSignals(ops);
  const rawLateConcentration = excluded.lateConcentration;
  const rawRevisionDepth = revisionDepthSignals(excluded.deletionOverwrite);
  const rawConcurrentEdits = excluded.concurrentEdits;
  const rawProfiles = buildContributionProfiles({
    sections: assessedSections,
    footprints: rawFootprints,
    pastes: rawPastes,
    lateConcentration: rawLateConcentration,
    quarantineSignals: rawQuarantine,
    deletionOverwrite: excluded.deletionOverwrite
  });
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
  const profilesForDebug = rawProfiles.map((p) => ({ ...p, authorId: labelKey(p.authorId, names) }));
  const excludedForDebug = excluded.excluded.map((e) => ({ ...e, authorId: labelKey(e.authorId, names) }));
  const structurePreview = assessedSections.map((section, i) => ({
    unit: i + 1,
    kind: section.kind ?? "paragraph",
    form: section.contentForm ?? section.formClassification,
    weight: section.weight ?? 1,
    cellOwnership: section.cellOwnership ? mapToObject(section.cellOwnership, names) : void 0,
    reconstructedText: section.text.length > 240 ? `${section.text.slice(0, 240)}\u2026` : section.text
  }));
  const debugData = {
    opsCaptured: ops.length,
    indexAlignment: alignment ?? "not measured \u2014 document structure has not been fetched",
    structureSource: usingDocsStructure ? `Docs API elements (${assessedSections.length} units: tables collapsed, lists per-item, blanks dropped, form-weighted)` : "newline-only paragraphs (fallback \u2014 unweighted, inflated by table cells/list items/blank lines; fetch structure to fix)",
    excludedFromAssessment: excludedForDebug.length > 0 ? excludedForDebug : "none",
    structurePreview,
    survivingCharactersByAuthor: surviving,
    deletionOverwriteByActor: deletions,
    signals: {
      footprints,
      profiles: profilesForDebug,
      pastes,
      quarantineSignals,
      lateConcentration,
      revisionDepth,
      concurrentEdits
    }
  };
  const narration = buildNarrationReport({
    sections: assessedSections,
    profiles: rawProfiles,
    pastes: rawPastes,
    quarantineSignals: rawQuarantine,
    revisionDepth: rawRevisionDepth,
    concurrentEdits: rawConcurrentEdits,
    exclusions: excluded.excluded,
    names
  });
  const summary = toContentStrippedSummary(narration, rawFootprints, names);
  let noAssessableAuthors = null;
  if (rawProfiles.length === 0) {
    noAssessableAuthors = panel("Nothing to assess yet");
    const note = document.createElement("p");
    note.className = "gs-status";
    note.textContent = "Version history didn't name any of this document's authors, so all of them are currently treated as the grader's own account and excluded. Name the students under \u201CWho counts as a student\u201D below to assess them.";
    noAssessableAuthors.appendChild(note);
  }
  root.innerHTML = "";
  const blocks = [
    renderSources(
      root,
      docId,
      ops.length,
      usingDocsStructure,
      assessedSections.length,
      alignment ? describeAlignment(alignment) : null
    ),
    noAssessableAuthors,
    renderContributionSplit(rawProfiles, names, slots),
    renderAuthors(narration, rawProfiles, slots),
    renderSections(narration, assessedSections, names, slots),
    renderNotice("Signals & flags", "gs-signals", narration.signalSentences),
    renderNotice("Excluded from assessment", "gs-exclusions", narration.exclusions),
    renderRoster(root, docId, allAuthorIds, rawSurviving, names, excludedList, slots)
  ];
  for (const block of blocks) {
    if (block) root.appendChild(block);
  }
  const exportPanel = panel("Export");
  exportPanel.appendChild(
    button("Copy evidence summary (content-stripped JSON)", async (btn) => {
      await navigator.clipboard.writeText(JSON.stringify(summary, null, 2));
      btn.textContent = "Copied to clipboard";
      setTimeout(() => {
        btn.textContent = "Copy evidence summary (content-stripped JSON)";
      }, 1500);
    })
  );
  exportPanel.appendChild(renderDebug(debugData));
  root.appendChild(exportPanel);
  const disclaimer = document.createElement("p");
  disclaimer.className = "gs-disclaimer";
  disclaimer.textContent = narration.disclaimer;
  root.appendChild(disclaimer);
}
async function main() {
  const root = document.getElementById("gs-root");
  if (!root) return;
  const docId = await getActiveDocId();
  if (!docId) {
    renderEmptyState(
      root,
      "No Google Doc in this tab",
      "Open the group's shared Google Doc, then click the GroupSync icon again to analyse its edit history."
    );
    return;
  }
  await render(root, docId);
}
main();
