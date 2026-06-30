import { toContentStrippedSummary } from "../export";
import { buildNarrationReport } from "../narration";
import { deletionOverwriteMap, replay, survivingCharacterMap } from "../replay";
import {
  authorFootprints,
  detectConcurrentEditBoundaries,
  detectLateConcentration,
  detectPastes,
  detectQuarantineSignals,
  narrationPhraseForShare,
  revisionDepthSignals,
} from "../signals";
import { segmentByDocsStructure, segmentIntoParagraphs, type HeadingDelimitedRange, type Section } from "../structure";
import { extractDocId } from "../utils";
import type { AuthorId, MutationOp } from "../types/mutation";

/**
 * Debug view for capture + replay + structure + signals + narration. The
 * rendered narration sentences are the closest thing to "real product
 * output" so far — everything above them (JSON dump) is debug detail kept
 * for verifying each layer independently. Narration wording is a first
 * draft pending review (see ME.MD), not finalized.
 */

/** Escapes HTML special chars to prevent injection when building innerHTML strings. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns the Google Doc ID from the active tab URL, or null if the active tab isn't a Google Doc. */
async function getActiveDocId(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return extractDocId(tab.url);
}

/** Replaces root's content with a single status paragraph. */
function setStatus(root: HTMLElement, message: string): void {
  root.innerHTML = `<p class="gs-status">${escapeHtml(message)}</p>`;
}

/** Returns "Name (id)" when resolved, the raw id when not, or "(unknown)" for null-origin characters. */
function labelKey(key: string | null, names: Record<AuthorId, string | null>): string {
  if (key === null) return "(unknown)";
  const name = names[key];
  return name ? `${name} (${key})` : key;
}

/** Converts a Map to a plain object, applying labelKey to all keys for display. */
function mapToObject<K extends string | null, V>(map: Map<K, V>, names: Record<AuthorId, string | null>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [key, value] of map) obj[labelKey(key, names)] = value;
  return obj;
}

function renderResolveNamesButton(root: HTMLElement, docId: string): void {
  const button = document.createElement("button");
  button.className = "gs-button";
  button.textContent = "Resolve author names (People API + Drive permissions fallback)";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Resolving names…";
    const result = await chrome.runtime.sendMessage({ type: "groupsync-resolve-names", docId });
    if (!result?.ok) {
      setStatus(root, `Name resolution failed: ${result?.error ?? "unknown error"}`);
      return;
    }
    // Always visible feedback, even when 0 resolved — "did nothing" was a
    // real complaint when this silently re-rendered with all-null names.
    if (result.resolvedCount === 0 && result.totalCount > 0) {
      setStatus(
        root,
        `Resolved 0 of ${result.totalCount} author name(s) via People API or Drive permissions. ` +
          `This can happen if you don't have edit access to the doc, or no author IDs were captured yet.`
      );
      return;
    }
    await render(root, docId);
  });
  root.prepend(button);
}

/** Shows unresolved author IDs with text inputs so the professor can label
 *  them manually. Authors are sorted by surviving character count (most chars
 *  first) so the heaviest contributor is easiest to identify. Saved names are
 *  merged with any auto-resolved names already in session storage. */
function renderNameLabelingSection(
  root: HTMLElement,
  docId: string,
  rawSurviving: Map<string | null, number>,
  names: Record<AuthorId, string | null>
): void {
  const unresolved = Array.from(rawSurviving.keys())
    .filter((id): id is AuthorId => id !== null && !names[id])
    .sort((a, b) => (rawSurviving.get(b) ?? 0) - (rawSurviving.get(a) ?? 0));

  if (unresolved.length === 0) return;

  const section = document.createElement("div");
  section.className = "gs-name-labeling";

  const heading = document.createElement("p");
  heading.innerHTML = `<strong>Label authors</strong> — ${unresolved.length} ID(s) couldn't be resolved automatically. Enter names to use them throughout the analysis.`;
  section.appendChild(heading);

  const inputs = new Map<AuthorId, HTMLInputElement>();
  for (const authorId of unresolved) {
    const charCount = rawSurviving.get(authorId) ?? 0;
    const row = document.createElement("div");
    row.className = "gs-name-row";

    const label = document.createElement("span");
    label.className = "gs-author-id";
    label.textContent = `${charCount} chars — ${authorId}`;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter name…";
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
    const updates: Record<AuthorId, string | null> = {};
    let hasAny = false;
    for (const [id, input] of inputs) {
      const val = input.value.trim();
      if (val) { updates[id] = val; hasAny = true; }
    }
    if (!hasAny) return;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    await chrome.runtime.sendMessage({ type: "groupsync-save-names", docId, names: updates });
    await render(root, docId);
  });
  section.appendChild(saveBtn);
  root.prepend(section);
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

/** Renders one narration sentence as an <li> with its rule ID shown in a muted tag (F7.2/C3). */
function sentenceLi(sentence: { ruleId: string; text: string }): string {
  return `<li>${escapeHtml(sentence.text)} <span class="gs-rule-id">[${escapeHtml(sentence.ruleId)}]</span></li>`;
}

/** Renders the full narration report (disclaimer + sections + signals) as an HTML string. */
function renderNarration(narration: ReturnType<typeof buildNarrationReport>): string {
  const sectionsHtml = narration.sections
    .filter((s) => s.sentences.length > 0)
    .map((s) => {
      const label = s.headingText ? `¶${s.paragraph} — ${escapeHtml(s.headingText)}` : `¶${s.paragraph}`;
      return `<div class="gs-section"><strong>${label}</strong><ul>${s.sentences.map(sentenceLi).join("")}</ul></div>`;
    })
    .join("");
  const signalsHtml = narration.signalSentences.length
    ? `<div class="gs-section"><strong>Signals</strong><ul>${narration.signalSentences.map(sentenceLi).join("")}</ul></div>`
    : "";
  return (
    `<p class="gs-disclaimer">${escapeHtml(narration.disclaimer)}</p>` +
    `<div class="gs-narration">${sectionsHtml}${signalsHtml}</div>`
  );
}

/** Fetches stored ops/names/structure, runs the full analysis pipeline, and renders the popup. */
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
  const rawSurviving = survivingCharacterMap(originByPosition);
  const surviving = mapToObject(rawSurviving, names);
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
      concurrentEdits,
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
    names,
  });
  const summary = toContentStrippedSummary(narration, rawFootprints, names);

  root.innerHTML =
    `<p class="gs-status">Capture + replay + structure + signals + narration (first-draft wording — see ME.MD). ` +
    `Structure source: ${escapeHtml(debugData.structureSource)}.</p>` +
    renderNarration(narration) +
    `<pre class="gs-json">${escapeHtml(JSON.stringify(debugData, null, 2))}</pre>`;
  renderFetchHistoryButton(root, docId);
  renderNameLabelingSection(root, docId, rawSurviving, names);
  renderResolveNamesButton(root, docId);
  renderFetchStructureButton(root, docId);
  renderExportButton(root, summary);
}

/** Entry point: gets the active tab's doc ID and renders the popup. */
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
