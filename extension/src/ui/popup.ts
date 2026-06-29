import { toContentStrippedSummary } from "../export";
import { buildNarrationReport } from "../narration";
import { deletionOverwriteMap, replay, survivingCharacterMap } from "../replay";
import {
  authorFootprints,
  detectConcurrentEditBoundaries,
  detectLateConcentration,
  detectMissingRosterMembers,
  detectNonRosterAuthorship,
  detectPastes,
  detectQuarantineSignals,
  narrationPhraseForShare,
  revisionDepthSignals,
} from "../signals";
import { extractDocId } from "../shared/doc-id";
import { segmentByDocsStructure, segmentIntoParagraphs, type Section } from "../structure";
import type { HeadingDelimitedRange } from "../structure/docs-api";
import type { AuthorId, MutationOp } from "../types/mutation";

/**
 * Debug view for capture + replay + structure + signals + narration. The
 * rendered narration sentences are the closest thing to "real product
 * output" so far — everything above them (JSON dump) is debug detail kept
 * for verifying each layer independently. Narration wording is a first
 * draft pending review (see ME.MD), not finalized.
 */

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function getActiveDocId(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return extractDocId(tab.url);
}

function setStatus(root: HTMLElement, message: string): void {
  root.innerHTML = `<p class="gs-status">${escapeHtml(message)}</p>`;
}

/** Labels a key with its resolved name when known — never invents one when
 *  unresolved, just falls back to the raw id (or "(unknown)" for a null
 *  origin-author, meaning the capture window started after that character
 *  was written; see replay/index.ts). */
function labelKey(key: string | null, names: Record<AuthorId, string | null>): string {
  if (key === null) return "(unknown)";
  const name = names[key];
  return name ? `${name} (${key})` : key;
}

function mapToObject<K extends string | null, V>(map: Map<K, V>, names: Record<AuthorId, string | null>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [key, value] of map) obj[labelKey(key, names)] = value;
  return obj;
}

/** F4.2/F7.5's expected roster: typed locally by the professor, stored in
 *  chrome.storage.session (same place ops/names live), NEVER fetched over
 *  the network — C1 only permits Google People/Docs API calls, not calls to
 *  our own backend, even though the backend now has a real roster (see
 *  ME.MD: that's a deliberate, not-yet-made scope decision, not an oversight). */
function rosterStorageKey(docId: string): string {
  return `groupsync-roster-${docId}`;
}

async function getStoredRoster(docId: string): Promise<string[]> {
  const key = rosterStorageKey(docId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as string[] | undefined) ?? [];
}

function parseRosterInput(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function renderRosterInput(root: HTMLElement, docId: string, currentRoster: string[]): void {
  const wrapper = document.createElement("div");
  wrapper.className = "gs-roster-input";
  const label = document.createElement("label");
  label.textContent = "Expected group members (one name per line, as resolved by People API):";
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.value = currentRoster.join("\n");
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Save expected roster";
  button.addEventListener("click", async () => {
    await chrome.storage.session.set({ [rosterStorageKey(docId)]: parseRosterInput(textarea.value) });
    await render(root, docId);
  });
  wrapper.append(label, textarea, button);
  root.prepend(wrapper);
}

function renderResolveNamesButton(root: HTMLElement, docId: string): void {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Resolve author names (People API)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Resolving names…";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-resolve-names", docId });
    if (!result?.ok) {
      setStatus(root, `Name resolution failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}

/** F5.1: fetches real headings/tables from the Docs API. Opt-in (separate
 *  button, not automatic) since it's an extra OAuth-scoped network call;
 *  falls back to the newline-only segmenter until this has been run once
 *  for a doc. */
function renderFetchStructureButton(root: HTMLElement, docId: string): void {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Fetch document structure (Docs API)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Fetching structure…";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-fetch-structure", docId });
    if (!result?.ok) {
      setStatus(root, `Docs API structure fetch failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}

function renderFetchHistoryButton(root: HTMLElement, docId: string): void {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Fetch full history (retroactive)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Fetching full history…";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-fetch-history", docId });
    if (!result?.ok) {
      setStatus(root, `Retroactive history fetch failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}

/** F5.2: exporting is opt-in per click, never automatic — nothing is copied
 *  or sent anywhere until the professor presses this button. Copies the
 *  content-stripped summary JSON to the clipboard; there's no backend
 *  endpoint to send it to yet (that's a separate, not-yet-built task). */
function renderExportButton(root: HTMLElement, summary: ReturnType<typeof toContentStrippedSummary>): void {
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

/** F7.2: every sentence is shown with the named rule that produced it, in a
 *  muted tag, so a contesting student can be told exactly which fixed rule
 *  backs a given claim (C3) — not just the prose. */
function sentenceLi(sentence: { ruleId: string; text: string }): string {
  return `<li>${escapeHtml(sentence.text)} <span class="gs-rule-id">[${escapeHtml(sentence.ruleId)}]</span></li>`;
}

function renderNarration(narration: ReturnType<typeof buildNarrationReport>): string {
  const sectionsHtml = narration.sections
    .filter((s) => s.sentences.length > 0)
    .map((s) => `<div class="gs-section"><strong>¶${s.paragraph}</strong><ul>${s.sentences.map(sentenceLi).join("")}</ul></div>`)
    .join("");
  const signalsHtml = narration.signalSentences.length
    ? `<div class="gs-section"><strong>Signals</strong><ul>${narration.signalSentences.map(sentenceLi).join("")}</ul></div>`
    : "";
  return (
    `<p class="gs-disclaimer">${escapeHtml(narration.disclaimer)}</p>` +
    `<div class="gs-narration">${sectionsHtml}${signalsHtml}</div>`
  );
}

async function render(root: HTMLElement, docId: string): Promise<void> {
  const [opsResult, namesResult, structureResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: "groupsync-get-ops", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-names", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-structure", docId }),
  ]);
  const ops = (opsResult?.ops as MutationOp[] | undefined) ?? [];
  const names = (namesResult?.names as Record<AuthorId, string | null> | undefined) ?? {};
  const structureRanges = (structureResult?.ranges as HeadingDelimitedRange[] | undefined) ?? [];

  if (ops.length === 0) {
    setStatus(
      root,
      "No edits captured yet for this doc — make an edit (insert or delete text) or fetch its full history below, then reopen this popup."
    );
    renderFetchHistoryButton(root, docId);
    return;
  }

  const { originByPosition, deletionLog } = replay(ops);
  const surviving = mapToObject(survivingCharacterMap(originByPosition), names);
  const deletions = Object.fromEntries(
    Array.from(deletionOverwriteMap(deletionLog), ([actor, targets]) => [labelKey(actor, names), mapToObject(targets, names)])
  );
  // F5.1-F5.4: use real Docs API heading-delimited sections once fetched for
  // this doc, otherwise fall back to the newline-only paragraph segmenter.
  const usingDocsStructure = structureRanges.length > 0;
  const parsedSections: Section[] = usingDocsStructure
    ? segmentByDocsStructure(originByPosition, structureRanges)
    : segmentIntoParagraphs(originByPosition);
  const sections = parsedSections.map((section, i) => ({
    paragraph: i + 1,
    headingLevel: section.headingLevel,
    formClassification: section.formClassification,
    text: section.text,
    authorshipByAuthor: mapToObject(section.authorship, names),
  }));

  const rawFootprints = authorFootprints(parsedSections, originByPosition);
  const rawPastes = detectPastes(ops);
  const rawQuarantine = detectQuarantineSignals(ops);
  const rawLateConcentration = detectLateConcentration(ops);
  const rawRevisionDepth = revisionDepthSignals(deletionOverwriteMap(deletionLog));
  const rawConcurrentEdits = detectConcurrentEditBoundaries(ops);

  const expectedRoster = await getStoredRoster(docId);
  const rawNonRosterAuthors = detectNonRosterAuthorship(expectedRoster, rawFootprints, names);
  const missingRosterMembers = detectMissingRosterMembers(expectedRoster, rawFootprints, names);

  const footprints = rawFootprints.map((f) => ({
    author: labelKey(f.authorId, names),
    revisionBreadth: f.revisionBreadth,
    originShare: f.originShare,
    narrationPhrase: narrationPhraseForShare(f.originShare),
    isIntegratorPattern: f.isIntegratorPattern,
  }));
  const pastes = rawPastes.map((p) => ({ ...p, authorId: labelKey(p.authorId, names) }));
  const quarantineSignals = rawQuarantine.map((q) => ({
    sessionStart: q.session.startTimestamp,
    sessionEnd: q.session.endTimestamp,
    churnFraction: q.churnFraction,
  }));
  const lateConcentration = rawLateConcentration.map((l) => ({ ...l, authorId: labelKey(l.authorId, names) }));
  const revisionDepth = rawRevisionDepth.map((r) => ({
    ...r,
    actorId: labelKey(r.actorId, names),
    targetId: labelKey(r.targetId, names),
  }));
  const concurrentEdits = rawConcurrentEdits.map((c) => ({
    ...c,
    authorA: labelKey(c.authorA, names),
    authorB: labelKey(c.authorB, names),
  }));
  const nonRosterAuthors = rawNonRosterAuthors.map((n) => ({ ...n, authorId: labelKey(n.authorId, names) }));

  const debugData = {
    opsCaptured: ops.length,
    structureSource: usingDocsStructure ? "Docs API (headings/tables)" : "newline-only paragraphs (fallback)",
    survivingCharactersByAuthor: surviving,
    deletionOverwriteByActor: deletions,
    expectedRoster,
    signals: {
      footprints,
      pastes,
      quarantineSignals,
      lateConcentration,
      revisionDepth,
      concurrentEdits,
      nonRosterAuthors,
      missingRosterMembers,
    },
  };

  const narration = buildNarrationReport({
    sections: parsedSections,
    footprints: rawFootprints,
    pastes: rawPastes,
    quarantineSignals: rawQuarantine,
    lateConcentration: rawLateConcentration,
    revisionDepth: rawRevisionDepth,
    concurrentEdits: rawConcurrentEdits,
    nonRosterAuthors: rawNonRosterAuthors,
    missingRosterMembers,
    names,
  });
  const summary = toContentStrippedSummary(narration, rawFootprints);

  root.innerHTML =
    `<p class="gs-status">Capture + replay + structure + signals + narration (first-draft wording — see ME.MD). ` +
    `Structure source: ${escapeHtml(debugData.structureSource)}.</p>` +
    renderNarration(narration) +
    `<pre class="gs-json">${escapeHtml(JSON.stringify(debugData, null, 2))}</pre>`;
  renderFetchHistoryButton(root, docId);
  renderResolveNamesButton(root, docId);
  renderFetchStructureButton(root, docId);
  renderExportButton(root, summary);
  renderRosterInput(root, docId, expectedRoster);
}

async function main(): Promise<void> {
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
