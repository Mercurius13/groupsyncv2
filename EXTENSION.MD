# GroupSync — Extension Requirements

> The extension is the analysis engine. It runs entirely in the professor's
> authenticated browser session and performs all attribution locally.
> Inherits all constraints from `00-architecture-overview.md`.

## Purpose

Given a Google Doc the professor can edit, capture the **complete character-level
mutation history from creation to present**, attribute authorship
deterministically, and produce a per-person, section-level evidence summary — all
without any data leaving the device. The full history is fetched retroactively on
demand; the extension does not need to have been present during editing.

## Current State (2026-06-29)

Capture, replay, retroactive history, name resolution, structure, signals,
narration, and export all exist and are wired end-to-end (`extension/src/`),
validated against real captured traffic including a real `revisions/load`
response (see `ME.MD`). As of this session, every F1-F8 requirement has an
implementation — what remains is live validation of several real but
unconfirmed assumptions, plus a few items that are deliberately out of
scope until a dependency exists (F5.5, F8.3):

- **F1 (capture)**: fully met, including F1.6's full-history-from-creation
  requirement (`capture/history.ts`'s retroactive fetch, confirmed against a
  real response) and F1.7's clear-error-on-failure behavior.
- **F2 (replay)**: fully met.
- **Identity/name resolution** (no F-number of its own, but real and worth
  documenting clearly): `identity/people.ts`'s People API call **confirmed
  broken for the common case 2026-06-29** — a live test completed the OAuth
  flow successfully but every author name came back null, because People
  API only resolves the signed-in professor's own contacts/connections, not
  an arbitrary doc collaborator. Fixed with `identity/drive.ts`: a fallback
  to the Drive API's file-permissions list (every editor with access to the
  specific doc, regardless of contacts status), tried for anything People
  API didn't resolve. Required a new OAuth scope
  (`drive.metadata.readonly`), a new host_permission, and an explicit
  addition to HANDOVER.md C1's list of permitted endpoints. **Still
  unconfirmed**: that a Drive permission's `id` field actually equals the
  same numeric account ID seen in the collab stream — standard real-world
  Drive API behavior, not officially documented by Google, not yet checked
  against a real multi-collaborator doc by this extension (see `ME.MD`).
- **F3 (quarantine)**: F3.1/F3.3 met via `signals/index.ts`'s
  `detectQuarantineSignals`. F3.2 ("surfaced... as a warning on the affected
  authors' cards") is still only partially met — narration attaches the
  quarantine note to a time range, not to specific authors' cards, since
  there's no "card" UI in the extension itself (that's the frontend's job,
  F4 there — `EvidenceViewer.tsx`'s "Signals & flags" block is the closest
  equivalent that exists today).
- **F4 (paste/template)**: F4.1/F4.3 met. **F4.2 (unmodified-template
  detection) is NOT implemented — removed by decision 2026-06-29.** It was
  briefly built (`detectNonRosterAuthorship`, comparing against a
  professor-typed "expected roster" textarea in the popup) but removed: the
  manual-entry requirement was confusing in practice (it looked related to
  the unrelated, automatic People-API name resolution) and provided little
  real value. No replacement input source is currently planned.
- **F5 (structure)**: F5.1 (Docs API `documents.get`, via
  `structure/docs-api.ts`'s `fetchDocumentStructure`, requesting structural
  metadata fields only — never paragraph text), F5.2 (table/heading
  classification — `classifyElements`), F5.3 (form-only classification —
  `classifyForm`: "calculations" for ranges containing a table,
  "discussion/theory" otherwise; equations are NOT detected, see below), and
  F5.4 (heading-delimited section boundaries — `sectionsFromHeadings`, a
  single isolated function as required) are all implemented and wired into
  the popup via a "Fetch document structure" button, falling back to the
  newline-only segmenter when not yet fetched. **F5.5 (self-applied section
  tags) remains NOT implemented** — still no defined input source for a
  student's self-claimed section.
  - Known limitation: equations are represented inline within a paragraph's
    `elements[]` in the real Docs API, not as a top-level structural kind —
    `classifyElements` does not descend into paragraph elements, so an
    equation-only paragraph is classified as "discussion/theory," not
    "calculations." Lists are also not distinguished from prose paragraphs.
  - **Resolved 2026-06-29 — section labels now use real heading text.**
    Positional-only labels ("Paragraph 47") turned out unusable in practice:
    a real ~400-paragraph doc gave a professor 400 unlabeled blocks with no
    way to tell which is which without the source doc open side by side.
    `structure/index.ts`'s `sectionHeadingText` extracts the heading line
    itself (never the prose body) and `export/index.ts` uses it as
    `sectionLabel` when one exists. This required a scoped exception to
    HANDOVER.md C1 (added 2026-06-29) — short navigational heading text may
    leave the extension, prose body content still never does.
  - **Unconfirmed, needs live validation** (see `ME.MD`): whether the Docs
    API's `startIndex`/`endIndex` actually align with the character
    positions `is`/`ds` ops use. High-confidence expectation (both are
    Google's own internal indexing into the same document), not a guess —
    but never checked against a real document.
- **F6 (signals)**: all six implemented. F6.3 (`revision_depth`) is
  `signals/index.ts`'s `revisionDepthSignals`, turning
  `replay.ts`'s already-computed `deletionOverwriteMap` into a named,
  threshold-filtered signal. F6.6 (concurrency) is `detectConcurrentEditBoundaries`
  — see its module docstring for why this is a *boundary* flag (two authors
  inserting near the same position within a short time window), not
  per-character "shared" attribution: the confirmed real capture format
  already carries one definite `authorId` per command, so there's no
  positional ambiguity to represent within replay itself. This is the most
  interpretive of the six signals — worth your read in `ME.MD`.
- **F7 (narration)**: F7.1, F7.4 met. F7.2 (named rule per sentence) is
  `narration/index.ts`'s `RuledSentence` type — every sentence everywhere
  carries a `ruleId`, surfaced in the popup's debug view next to the
  rendered text. F7.3's content-aware hedging now activates when Docs API
  structure is available ("this calculations section" / "this
  discussion/theory section"), falling back to neutral "this section" for
  the newline-only segmenter (which has no form information). **F7.5 (empty-
  signal author gets an explicit statement) is NOT implemented — removed by
  the same 2026-06-29 decision as F4.2** (`detectMissingRosterMembers` +
  `narrateMissingRosterMember` were built, then removed along with the
  manual-roster-entry UI). The extension never connects to our own backend
  in either direction (reaffirmed by decision 2026-06-29 — the backend's
  role is account/licensing administration, never a data source the
  extension depends on), so there's currently no input source at all for
  "who was expected to edit this doc."
- **F8 (synthetic test suite)**: the per-module vitest suites cover this in
  spirit (121 tests as of 2026-06-29). F8.1 (a dedicated reusable scenario
  generator) and F8.3 (the business-plan doc checked in as a regression
  fixture) remain not done — lower priority, deferred.

Remaining Work

1. Live-validate the Drive-permission-id-equals-author-id assumption
   (identity/drive.ts) against a real multi-collaborator doc — see `ME.MD`.
   This is now the load-bearing assumption for name resolution; if it's
   wrong, no name resolves for non-contacts at all (the original bug, not
   fixed).
2. Live-validate the Docs API index-alignment assumption (F5.1-F5.4) against
   a real document — see `ME.MD`.
3. Decide whether `classifyElements` should descend into paragraph elements
   to detect inline equations, and whether lists need their own form/kind
   distinct from prose paragraphs.
4. F4.2/F7.5 — both removed 2026-06-29, no replacement planned. If template
   detection or empty-signal-author reporting becomes worth doing again, it
   needs a real input source for "who was expected to edit this doc" that
   isn't a manual popup textarea — the extension-backend boundary stays
   closed (HANDOVER.md C1), so this would need a genuinely different idea,
   not a revival of the removed feature.
5. Live-validate the F6.6 concurrent-edit-boundary thresholds
   (`CONCURRENT_EDIT_WINDOW_MS`, `CONCURRENT_EDIT_POSITION_DISTANCE`) and
   re-read its module docstring's reasoning — this is the signal most likely
   to need a rethink if real concurrent-editing data contradicts the
   "every command already has one definite author" assumption it rests on.
6. F8.1/F8.3 — a reusable synthetic-scenario generator, and check in the
   business-plan doc (or a redacted derivative) as a regression fixture.

## Functional Requirements

### F1 — Capture (the load-bearing layer)

- **F1.1** Fetch the **complete ordered mutation log from document creation to
  present** from the Google Docs **internal collaboration endpoint** (the data
  source Draftback uses), in the professor's authenticated session. The unit of
  capture is the *entire history*, not the current session — attribution is
  impossible without the full log going back to creation.
- **F1.2** Capture MUST be **retroactive and on-demand**: the professor opens the
  extension at any point (including the final day of a multi-week project),
  triggers analysis, and the extension pulls the full history in that moment. The
  extension does NOT need to have been running during editing, and MUST NOT rely
  on observing a live stream. (This mirrors how Draftback operates on documents
  that are already weeks or months old.)
- **F1.3** Each mutation in the log MUST carry: operation type (insert/delete),
  affected character IDs (persistent), author ID, and timestamp.
- **F1.4** **Forbidden:** reconstructing history by diffing the rendered "version
  history" / "show changes" view. This produces lossy, mis-attributed,
  concurrency-blind data and is the root cause of the corruption observed in the
  current `versions.json`.
- **F1.5** The capture layer MUST be implemented against a **real captured
  response**, not an assumed format. Provide a typed interface and a paste-in
  fixture path; do not fabricate the parser.
- **F1.6** The fetch MUST retrieve history from the document's first revision. If
  the endpoint paginates or chunks the history, the capture layer MUST page
  through to the beginning — a partial history is a corrupt history, since any
  un-fetched early mutations mean origin-authorship is wrong for every character
  created in the missing range.
- **F1.7** On capture failure (endpoint format changed, no edit permission,
  view-only doc, incomplete history fetch), surface a clear, specific error.
  Never silently emit partial data or analyze an incomplete log.

### F2 — Replay engine (deterministic)

- **F2.1** Replay mutations in order, starting from an empty document.
- **F2.2** On **insert**: mint/track a persistent ID per character, tagged with
  its **origin-author**.
- **F2.3** On **delete**: remove those IDs from the live set, and log the deletion
  as `{ actor: who deleted, target: whose characters were deleted }`.
- **F2.4** Produce two maps:
  - **Surviving-character map** — current document characters keyed by
    origin-author.
  - **Deletion/overwrite map** — actor → target activity.
- **F2.5** Origin-authorship MUST survive reformats, moves, and pastes — a later
  editor reformatting the document MUST NOT acquire authorship of characters they
  did not originate. (This is the exact failure in the current snapshot data;
  the replay engine exists to prevent it.)

### F3 — Large-block / whole-document replace quarantine (RULE ZERO)

- **F3.1** Any single mutation (or tightly-clustered session) that deletes-and-
  re-adds a large fraction of the document MUST be flagged as
  **"uncertain attribution"** and excluded from origination credit.
- **F3.2** Such events are surfaced to the professor as a warning on the affected
  authors' cards, not silently absorbed.
- **F3.3** Threshold for "large fraction" is an explicit, configurable parameter,
  validated against the synthetic test suite (F8).

### F4 — Template / paste handling

- **F4.1** Large atomic inserts MUST be flagged as **paste**, distinct from
  incremental authorship.
- **F4.2** Document regions that remain unmodified template/boilerplate MUST be
  excluded from every author's contribution and reported separately as
  "unmodified template, authored by no group member."
- **F4.3** The product MUST NOT distinguish self-paste from external paste (it
  cannot); it flags the paste and leaves the judgment to the professor.

### F5 — Structure & section attribution

- **F5.1** Call the Docs API (`documents.get`) locally to retrieve structural
  elements (tables, equations, headings, lists, prose paragraphs) with index
  ranges.
- **F5.2** Intersect structure ranges with the surviving-character map to produce
  per-element authorship.
- **F5.3** Classify content by **form only**: table/equation regions →
  "calculations"; prose regions → "discussion/theory". The product MUST NOT claim
  to know the subject matter of text.
- **F5.4** Define sections by heading-delimited ranges. Section-boundary logic
  MUST be a single isolated, swappable function.
- **F5.5** Where the data permits, surface self-applied section tags (e.g.
  "-Michael" labels) as **claims**, shown alongside actual authorship, so
  divergence between claimed and actual is visible.

### F6 — Signals (per author, per section)

- **F6.1** `origin_share` — surviving characters originated, excluding template.
- **F6.2** `revision_breadth` — number of sections the author edited.
- **F6.3** `revision_depth` — characters overwritten/deleted by the author.
- **F6.4** `timing` — distribution of the author's work across the project
  window, with a late-concentration flag.
- **F6.5** `paste_flags` — large atomic inserts attributed to the author.
- **F6.6** Concurrency: where the source cannot disambiguate two simultaneous
  editors, attribution MUST be carried as **"shared/uncertain"**, never silently
  assigned to one.

### F7 — Narration (local templates, hedged)

- **F7.1** Generate per-person, plain-language role sentences from F6 signals
  using **rule-based templates only** (no model, no cloud call).
- **F7.2** Each sentence MUST map to a named rule, exposed in a debug view.
- **F7.3** Hedge to detectable form, not inferred content: "authored the
  discussion-style sections" / "produced the data tables and calculations" — never
  "wrote the theory of X".
- **F7.4** Integrator pattern (broad revision_breadth + low origin_share) →
  "made broad late-stage edits across most sections, consistent with revising
  others' work" — as an observation, not a verdict.
- **F7.5** Empty-signal author → state exactly what the data does/does not show
  (per C5); never "no role".

### F8 — Synthetic test suite (improvement mechanism)

- **F8.1** Ship a generator that produces mutation logs for scripted scenarios
  with **known correct attribution**: clean division of labor, reformat/whole-doc
  replace, large paste, concurrent edits, integrator pass, empty member.
- **F8.2** Each scenario asserts expected engine output. This is how thresholds
  and rules are tuned — not by collecting real student data.
- **F8.3** The team's own GroupSync business-plan doc is included as a real
  labeled fixture (ground truth known to the founders).

## Output

A per-member evidence panel rendered in-extension:
- Narration sentences (with rule IDs available in debug view)
- Section-by-section authorship table
- Per-author timeline of when work landed
- Quarantine/paste/concurrency warnings where applicable
- Persistent header: *"This tool measures on-document editing only. It cannot
  detect off-document work, in-person contribution, or content drafted elsewhere
  and pasted in. Use as evidence, not as a verdict."*

## Non-Functional Requirements

- **N1** All analysis runs client-side; no raw edit data transmitted (C1).
- **N2** Only network calls: People API, Docs API (IDs/structure only).
- **N3** Deterministic and reproducible: same input → same output (C3).
- **N4** Raw mutation data discarded after analysis; only the professor may
  export a content-stripped summary.
- **N5** Capture parser isolated and versioned, with tests against captured
  fixtures, since the underlying endpoint is undocumented and may change.

## Out of Scope

- Contribution percentages or single scores
- Any ML/model inference
- Transmitting raw edit data anywhere
- Distinguishing self-paste from external paste
- Judging intellectual subject matter of content