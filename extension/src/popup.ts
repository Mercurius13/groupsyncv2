import { extractDocId, type AuthorId, type MutationOp } from "./capture";
import {
  applyExclusions,
  authorFootprints,
  buildContributionProfiles,
  buildNarrationReport,
  detectConcurrentEditBoundaries,
  detectLateConcentration,
  detectPastes,
  detectQuarantineSignals,
  graderExcludedAuthorIds,
  narrationPhraseForShare,
  revisionDepthSignals,
  toContentStrippedSummary,
  type AuthorContributionProfile,
} from "./narration";
import { deletionOverwriteMap, replay, survivingCharacterMap } from "./replay";
import {
  describeAlignment,
  detectIndexAlignment,
  isStructureTrustworthy,
  segmentByElements,
  segmentIntoParagraphs,
  type ClassifiedElement,
  type Section,
} from "./structure";

const OPEN_VERSION_HISTORY_HINT =
  "open File → Version history → See version history in the doc and scroll through the revision list, then reopen this popup";

/** Escapes HTML special characters so text can be safely embedded in innerHTML strings.
 *  Applied to every dynamic value rendered by this popup. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Returns the Google Doc ID from the active tab's URL.
 *  Returns null when the active tab isn't a Google Doc. */
async function getActiveDocId(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  return extractDocId(tab.url);
}

/** Formats an author key for display: "Name (id)" when resolved, the raw id
 *  when not, or "(unknown)" for null-origin characters. */
function labelKey(key: string | null, names: Record<AuthorId, string | null>): string {
  if (key === null) return "(unknown)";
  const name = names[key];
  return name ? `${name} (${key})` : key;
}

/** Converts a Map into a plain object for JSON display, labeling every key
 *  with labelKey so debug output shows resolved names. */
function mapToObject<K extends string | null, V>(map: Map<K, V>, names: Record<AuthorId, string | null>): Record<string, V> {
  const obj: Record<string, V> = {};
  for (const [key, value] of map) obj[labelKey(key, names)] = value;
  return obj;
}

/** Formats a share fraction as a rounded percentage string. */
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

const SERIES_SLOTS = 6;

/** Assigns each author a categorical color slot in order of first appearance in
 *  the mutation log — a stable identity, so excluding or naming someone never
 *  repaints anyone else. Authors past the slot count share the neutral "other" slot. */
function authorColorSlots(ops: MutationOp[]): Map<AuthorId, number> {
  const slots = new Map<AuthorId, number>();
  for (const op of ops) {
    if (slots.has(op.authorId)) continue;
    slots.set(op.authorId, slots.size < SERIES_SLOTS ? slots.size + 1 : 0);
  }
  return slots;
}

/** Returns the CSS class carrying an author's series color, or the neutral
 *  slot for unknown-origin text and authors past the categorical cap. */
function slotClass(slots: Map<AuthorId, number>, authorId: AuthorId | null): string {
  if (authorId === null) return "gs-s0";
  return `gs-s${slots.get(authorId) ?? 0}`;
}

/** Creates a titled panel element, so every block on the page is built and
 *  appended in a deliberate reading order rather than prepended ad hoc. */
function panel(title: string | null): HTMLElement {
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

/** Builds a button, defaulting to the secondary style; `primary` marks the one
 *  action a given state is asking the professor to take. */
function button(label: string, onClick: (btn: HTMLButtonElement) => void, primary = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = primary ? "gs-button gs-button-primary" : "gs-button";
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  return btn;
}

/** Renders a full-panel state (no data yet, names missing, not a doc) as a
 *  headline, an explanation, and at most one suggested action. */
function renderEmptyState(root: HTMLElement, title: string, body: string, action?: HTMLElement): void {
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

/** Sends a message to the background worker and re-renders, surfacing the
 *  failure in place when the fetch didn't succeed. */
async function runFetch(
  root: HTMLElement,
  docId: string,
  btn: HTMLButtonElement,
  type: string,
  pendingLabel: string
): Promise<void> {
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

/** Renders the two data-source cards — captured edit history and document
 *  structure — each showing its current state next to the action that improves it. */
function renderSources(
  root: HTMLElement,
  docId: string,
  opCount: number,
  usingDocsStructure: boolean,
  unitCount: number,
  alignmentNote: string | null
): HTMLElement {
  const section = panel("Data sources");
  const grid = document.createElement("div");
  grid.className = "gs-sources";

  const history = document.createElement("div");
  history.className = "gs-source";
  history.innerHTML =
    `<div class="gs-source-label">Edit history</div>` +
    `<div class="gs-source-value gs-source-ok">${opCount.toLocaleString()} captured edits</div>`;
  history.appendChild(
    button("Re-fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching…"))
  );

  const structure = document.createElement("div");
  structure.className = "gs-source";
  const structureValue = usingDocsStructure
    ? `<div class="gs-source-value gs-source-ok">${unitCount} structural units, form-weighted</div>`
    : alignmentNote
      ? // Structure was fetched but its indices could not be reconciled with the
        // replayed characters — say so, rather than showing confident section figures.
        `<div class="gs-source-value gs-pending">Fetched, but not usable for this document</div>`
      : `<div class="gs-source-value gs-pending">Not fetched — falling back to newline paragraphs, ` +
        `which inflates unit counts and drops form weighting</div>`;
  structure.innerHTML =
    `<div class="gs-source-label">Document structure</div>` +
    structureValue +
    (alignmentNote ? `<div class="gs-caption">${escapeHtml(alignmentNote)}</div>` : "");
  structure.appendChild(
    button(
      alignmentNote ? "Re-fetch structure" : "Fetch document structure",
      (btn) => runFetch(root, docId, btn, "groupsync-fetch-structure", "Fetching…"),
      !usingDocsStructure
    )
  );

  grid.append(history, structure);
  section.appendChild(grid);
  return section;
}

/** Renders the whole-document contribution split as one part-to-whole stacked
 *  bar plus a legend carrying the exact figures — so no value is hover-gated. */
function renderContributionSplit(
  profiles: AuthorContributionProfile[],
  names: Record<AuthorId, string | null>,
  slots: Map<AuthorId, number>
): HTMLElement | null {
  const contributing = profiles.filter((p) => p.weightedOriginatedChars > 0);
  if (contributing.length === 0) return null;

  const known = contributing.reduce((sum, p) => sum + p.weightedOriginShare, 0);
  const unknownShare = Math.max(0, 1 - known);

  type Segment = { label: string; share: number; chars: number; cls: string };
  const segments: Segment[] = contributing.map((p) => ({
    label: names[p.authorId] ?? `author ${p.authorId}`,
    share: p.weightedOriginShare,
    chars: Math.round(p.weightedOriginatedChars),
    cls: slotClass(slots, p.authorId),
  }));
  if (unknownShare > 0.005) {
    segments.push({
      label: "Unknown origin (predates captured history)",
      share: unknownShare,
      chars: Math.round(unknownShare * (contributing[0]?.totalWeightedChars ?? 0)),
      cls: "gs-s0",
    });
  }

  const section = panel("Contribution split");
  const caption = document.createElement("p");
  caption.className = "gs-caption";
  caption.textContent =
    "Share of the document's form-weighted content — tables, figures and lists count for more than plain " +
    "prose, so these are weighted characters, not raw ones.";
  section.appendChild(caption);

  const bar = document.createElement("div");
  bar.className = "gs-split-bar";
  for (const seg of segments) {
    const fill = document.createElement("div");
    fill.className = `gs-split-seg ${seg.cls}`;
    fill.style.flex = `${Math.max(seg.share, 0.001)}`;
    fill.title = `${seg.label} — ${pct(seg.share)}`;
    bar.appendChild(fill);
  }

  const legend = document.createElement("div");
  legend.className = "gs-legend";
  for (const seg of segments) {
    const row = document.createElement("div");
    row.className = "gs-legend-row";
    row.innerHTML =
      `<span class="gs-swatch ${seg.cls}"></span>` +
      `<span class="gs-legend-name">${escapeHtml(seg.label)}</span>` +
      `<span class="gs-legend-share">${pct(seg.share)}</span>` +
      `<span class="gs-legend-chars">${seg.chars.toLocaleString()} ch</span>`;
    legend.appendChild(row);
  }

  section.append(bar, legend);
  return section;
}

/** Lists an author's composite pattern flags as scannable chips; each chip's
 *  detail sentence, with its rule ID, follows in the card body. */
function flagChips(profile: AuthorContributionProfile): string[] {
  const flags: string[] = [];
  if (profile.isIntegratorPattern) flags.push("Integrator pattern");
  if (profile.isPasteHeavy) flags.push("Paste-heavy");
  if (profile.isLowOriginLateBurst) flags.push("Late burst, low origin");
  if (profile.quarantinedSessionCount > 0) {
    flags.push(`Active in ${profile.quarantinedSessionCount} high-churn session(s)`);
  }
  return flags;
}

/** Renders one narration sentence as a list item with its rule ID in a muted
 *  tag, so every displayed claim is traceable to its named rule. */
function sentenceLi(sentence: { ruleId: string; text: string }): string {
  return `<li>${escapeHtml(sentence.text)} <span class="gs-rule-id">[${escapeHtml(sentence.ruleId)}]</span></li>`;
}

/** Renders one card per author: identity swatch, headline share, pattern chips,
 *  then the ruled narration sentences. */
function renderAuthors(
  narration: ReturnType<typeof buildNarrationReport>,
  profiles: AuthorContributionProfile[],
  slots: Map<AuthorId, number>
): HTMLElement | null {
  if (narration.authorProfiles.length === 0) return null;
  const byId = new Map(profiles.map((p) => [p.authorId, p]));
  const section = panel("Authors");

  for (const authorNarration of narration.authorProfiles) {
    const profile = byId.get(authorNarration.authorId);
    const card = document.createElement("div");
    card.className = "gs-author-card gs-narration";
    const share = profile ? pct(profile.weightedOriginShare) : "—";
    const chips = profile ? flagChips(profile) : [];
    card.innerHTML =
      `<div class="gs-author-head">` +
      `<span class="gs-swatch ${slotClass(slots, authorNarration.authorId)}"></span>` +
      `<span class="gs-author-name">${escapeHtml(authorNarration.label)}</span>` +
      `<span class="gs-author-share">${share}<small>of weighted content</small></span>` +
      `</div>` +
      (chips.length
        ? `<div class="gs-flags">${chips.map((f) => `<span class="gs-flag">${escapeHtml(f)}</span>`).join("")}</div>`
        : "") +
      `<ul>${authorNarration.sentences.map(sentenceLi).join("")}</ul>`;
    section.appendChild(card);
  }
  return section;
}

const SECTIONS_OPEN_BY_DEFAULT_LIMIT = 12;

/** Produces the one-line authorship glance for a collapsed section summary,
 *  naming the top origin-author and their share — by owned cells for a table. */
function sectionGlance(section: Section, names: Record<AuthorId, string | null>): string {
  const tally = section.kind === "table" && section.cellOwnership ? section.cellOwnership : section.authorship;
  const unit = section.kind === "table" && section.cellOwnership ? "cells" : "%";
  const total = Array.from(tally.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "no surviving characters";
  let topId: AuthorId | null = null;
  let topCount = -1;
  for (const [id, count] of tally) {
    if (count > topCount) {
      topId = id;
      topCount = count;
    }
  }
  const who = topId === null ? "unknown origin" : (names[topId] ?? `author ${topId}`);
  return unit === "cells" ? `mostly ${who} (${topCount}/${total} cells)` : `mostly ${who} (${Math.round((topCount / total) * 100)}%)`;
}

/** Renders the collapsible per-section detail, each summary carrying the
 *  section's form tag, its top author, and a swatch matching the split bar. */
function renderSections(
  narration: ReturnType<typeof buildNarrationReport>,
  parsedSections: Section[],
  names: Record<AuthorId, string | null>,
  slots: Map<AuthorId, number>
): HTMLElement | null {
  const narrated = narration.sections.filter((s) => s.sentences.length > 0);
  if (narrated.length === 0) return null;
  const open = narrated.length <= SECTIONS_OPEN_BY_DEFAULT_LIMIT ? " open" : "";

  const section = panel(`Sections (${narrated.length})`);
  const wrap = document.createElement("div");
  wrap.className = "gs-narration";
  wrap.innerHTML = narrated
    .map((s) => {
      const parsed = parsedSections[s.paragraph - 1];
      const tally = parsed && parsed.kind === "table" && parsed.cellOwnership ? parsed.cellOwnership : parsed?.authorship;
      let topId: AuthorId | null = null;
      let topCount = -1;
      for (const [id, count] of tally ?? []) {
        if (count > topCount) {
          topId = id;
          topCount = count;
        }
      }
      const swatch = parsed ? `<span class="gs-swatch ${slotClass(slots, topId)}"></span>` : "";
      const glance = parsed ? `<span class="gs-glance">${escapeHtml(sectionGlance(parsed, names))}</span>` : "";
      const form = parsed?.contentForm
        ? `<span class="gs-form-tag">${escapeHtml(parsed.contentForm)} ×${parsed.weight ?? 1}</span>`
        : parsed?.formClassification
          ? `<span class="gs-form-tag">${escapeHtml(parsed.formClassification)}</span>`
          : "";
      const label = s.headingText ? escapeHtml(s.headingText) : `Unit ${s.paragraph}`;
      return (
        `<details class="gs-section-details"${open}>` +
        `<summary>${swatch}<span class="gs-section-title">${label}</span>${form}${glance}</summary>` +
        `<ul>${s.sentences.map(sentenceLi).join("")}</ul></details>`
      );
    })
    .join("");
  section.appendChild(wrap);
  return section;
}

/** Renders a bordered notice panel (exclusions, signals) from ruled sentences. */
function renderNotice(
  title: string,
  cssClass: string,
  sentences: { ruleId: string; text: string }[]
): HTMLElement | null {
  if (sentences.length === 0) return null;
  const section = panel(title);
  const box = document.createElement("div");
  box.className = `${cssClass} gs-narration`;
  box.innerHTML = `<ul>${sentences.map(sentenceLi).join("")}</ul>`;
  section.appendChild(box);
  return section;
}

/** Renders the single roster panel: one row per author, where naming an unnamed
 *  author promotes them to a student and checking a named one excludes them as
 *  a co-instructor. Both edits save together. */
function renderRoster(
  root: HTMLElement,
  docId: string,
  authorIds: AuthorId[],
  rawSurviving: Map<string | null, number>,
  names: Record<AuthorId, string | null>,
  manualExcluded: AuthorId[],
  slots: Map<AuthorId, number>
): HTMLElement | null {
  if (authorIds.length === 0) return null;

  const section = panel("Who counts as a student");
  const box = document.createElement("div");
  box.className = "gs-setup";

  const intro = document.createElement("p");
  intro.innerHTML =
    `Authors Google's version history won't name are treated as <strong>you, the grader</strong> — the ` +
    `account running this extension always appears unnamed there — and are left out of the assessment ` +
    `entirely. If one of them is actually a student, give them a name here and they'll be counted. ` +
    `Check a named author to exclude a co-instructor or TA.`;
  box.appendChild(intro);

  const inputs = new Map<AuthorId, HTMLInputElement>();
  const checkboxes = new Map<AuthorId, HTMLInputElement>();
  const manualSet = new Set(manualExcluded);
  // Unnamed authors first — they are the rows asking the professor for a decision.
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
      const row = document.createElement("div");
      row.className = "gs-name-row";
      const label = document.createElement("span");
      label.className = "gs-author-id";
      label.innerHTML =
        `<span class="gs-swatch gs-s0"></span> Unnamed — counted as the grader · ` +
        `${charCount.toLocaleString()} chars · <code>${escapeHtml(authorId)}</code>`;
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Name to count as a student…";
      input.className = "gs-name-input";
      inputs.set(authorId, input);
      row.append(label, input);
      box.appendChild(row);
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
    label.innerHTML =
      `<span class="gs-swatch ${slotClass(slots, authorId)}"></span> ${escapeHtml(name)} · ` +
      `${charCount.toLocaleString()} chars · exclude as co-instructor/TA`;
    row.append(checkbox, label);
    box.appendChild(row);
  }

  box.appendChild(
    button("Save", async (btn) => {
      const nameUpdates: Record<AuthorId, string | null> = {};
      for (const [id, input] of inputs) {
        const val = input.value.trim();
        if (val) nameUpdates[id] = val;
      }
      const excluded = Array.from(checkboxes.entries())
        .filter(([, checkbox]) => checkbox.checked)
        .map(([id]) => id);
      btn.disabled = true;
      btn.textContent = "Saving…";
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

/** Renders the collapsed per-layer debug JSON, the audit view behind every
 *  figure the panel shows. */
function renderDebug(debugData: unknown): HTMLElement {
  const details = document.createElement("details");
  details.className = "gs-debug";
  details.innerHTML =
    `<summary>Debug data (per-layer JSON)</summary>` +
    `<pre class="gs-json">${escapeHtml(JSON.stringify(debugData, null, 2))}</pre>`;
  return details;
}

/** Loads a doc's captured state, runs the full analysis pipeline, and renders
 *  the popup — gated until author names have been retrieved from version history. */
async function render(root: HTMLElement, docId: string): Promise<void> {
  const [opsResult, namesResult, structureResult, excludedResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: "groupsync-get-ops", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-names", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-structure", docId }),
    chrome.runtime.sendMessage({ type: "groupsync-get-excluded", docId }),
  ]);
  const ops = (opsResult?.ops as MutationOp[] | undefined) ?? [];
  const names = (namesResult?.names as Record<AuthorId, string | null> | undefined) ?? {};
  const structureElements = (structureResult?.elements as ClassifiedElement[] | undefined) ?? [];
  const excludedList = (excludedResult?.excluded as AuthorId[] | undefined) ?? [];

  if (ops.length === 0) {
    renderEmptyState(
      root,
      "No edits captured yet",
      "Fetch this document's full history to analyse it — that pulls the changelog from revision 1, so the " +
        "extension didn't need to be installed while the group was working.",
      button("Fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching…"), true)
    );
    return;
  }

  if (Object.keys(names).length === 0) {
    renderEmptyState(
      root,
      "Author names not retrieved yet",
      `Results stay hidden until names are available, because attributing work to raw account IDs invites ` +
        `misattribution. To resolve them, ${OPEN_VERSION_HISTORY_HINT}.`,
      button("Fetch full history", (btn) => runFetch(root, docId, btn, "groupsync-fetch-history", "Fetching…"), true)
    );
    return;
  }

  const { originByPosition, deletionLog } = replay(ops);
  const rawSurviving = survivingCharacterMap(originByPosition);
  const surviving = mapToObject(rawSurviving, names);
  const deletions = Object.fromEntries(
    Array.from(deletionOverwriteMap(deletionLog), ([actor, targets]) => [labelKey(actor, names), mapToObject(targets, names)])
  );
  // The Docs API and the mutation stream are two index spaces, and nothing guarantees
  // they agree. Measure it before slicing by structure; a doc whose alignment can't be
  // established falls back to newline paragraphs rather than misattributing sections.
  const alignment = structureElements.length > 0 ? detectIndexAlignment(originByPosition, structureElements) : null;
  const parsedSections: Section[] =
    alignment && isStructureTrustworthy(alignment)
      ? segmentByElements(originByPosition, structureElements, alignment.offset)
      : segmentIntoParagraphs(originByPosition);
  const usingDocsStructure = alignment !== null && isStructureTrustworthy(alignment);

  // Every author who ever edited, in first-appearance order: the stable universe
  // for color slots and for the roster panel (a deleter with no surviving text
  // still belongs in both).
  const allAuthorIds = Array.from(new Set(ops.map((op) => op.authorId)));
  const slots = authorColorSlots(ops);

  const excludedIds = graderExcludedAuthorIds(allAuthorIds, names, excludedList);
  const excluded = applyExclusions(
    {
      sections: parsedSections,
      pastes: detectPastes(ops),
      lateConcentration: detectLateConcentration(ops),
      concurrentEdits: detectConcurrentEditBoundaries(ops),
      deletionOverwrite: deletionOverwriteMap(deletionLog),
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
    authorshipByAuthor: mapToObject(section.authorship, names),
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
    deletionOverwrite: excluded.deletionOverwrite,
  });

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
  const profilesForDebug = rawProfiles.map((p) => ({ ...p, authorId: labelKey(p.authorId, names) }));
  const excludedForDebug = excluded.excluded.map((e) => ({ ...e, authorId: labelKey(e.authorId, names) }));

  const structurePreview = assessedSections.map((section, i) => ({
    unit: i + 1,
    kind: section.kind ?? "paragraph",
    form: section.contentForm ?? section.formClassification,
    weight: section.weight ?? 1,
    cellOwnership: section.cellOwnership ? mapToObject(section.cellOwnership, names) : undefined,
    reconstructedText: section.text.length > 240 ? `${section.text.slice(0, 240)}…` : section.text,
  }));

  const debugData = {
    opsCaptured: ops.length,
    indexAlignment: alignment ?? "not measured — document structure has not been fetched",
    structureSource: usingDocsStructure
      ? `Docs API elements (${assessedSections.length} units: tables collapsed, lists per-item, blanks dropped, form-weighted)`
      : "newline-only paragraphs (fallback — unweighted, inflated by table cells/list items/blank lines; fetch structure to fix)",
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
      concurrentEdits,
    },
  };

  const narration = buildNarrationReport({
    sections: assessedSections,
    profiles: rawProfiles,
    pastes: rawPastes,
    quarantineSignals: rawQuarantine,
    revisionDepth: rawRevisionDepth,
    concurrentEdits: rawConcurrentEdits,
    exclusions: excluded.excluded,
    names,
  });
  const summary = toContentStrippedSummary(narration, rawFootprints, names);

  // Every author unnamed means everyone was treated as the grader and nothing
  // is left to assess — say so, rather than showing an empty report.
  let noAssessableAuthors: HTMLElement | null = null;
  if (rawProfiles.length === 0) {
    noAssessableAuthors = panel("Nothing to assess yet");
    const note = document.createElement("p");
    note.className = "gs-status";
    note.textContent =
      "Version history didn't name any of this document's authors, so all of them are currently treated as " +
      "the grader's own account and excluded. Name the students under “Who counts as a student” below to " +
      "assess them.";
    noAssessableAuthors.appendChild(note);
  }

  root.innerHTML = "";
  const blocks: (HTMLElement | null)[] = [
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
    renderRoster(root, docId, allAuthorIds, rawSurviving, names, excludedList, slots),
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

/** Popup entry point: renders analysis for the active tab's doc, or a prompt
 *  to open a Google Doc when the active tab isn't one. */
async function main(): Promise<void> {
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
