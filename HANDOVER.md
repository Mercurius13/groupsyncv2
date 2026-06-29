# GroupSync — Architecture Overview & Cross-Cutting Constraints

> Read this first. Every component spec (extension, frontend, backend, database)
> inherits the constraints below. Where a component requirement conflicts with
> this document, this document wins.

## What GroupSync is

An **evidence tool** for professors grading collaborative Google Docs work. It
attributes authorship at the character level and produces a per-person,
section-level, plain-language description of who did what, when. The professor
applies all judgment.

## What GroupSync is NOT

- **Not a scoring tool.** It never outputs a contribution percentage or a single
  verdict.
- **Not an ML system.** Attribution is deterministic replay + rule-based
  narration. There is no model and no training data.
- **Not a surveillance backend.** Raw edit data never leaves the professor's
  device.

## Architecture shape (the inversion)

The product was originally designed as thin-client / server-side analysis. It is
now **fat-extension / local analysis**. The components rescope accordingly:

| Component | Role | Touches student edit data? |
|-----------|------|----------------------------|
| **Extension** | The analysis engine. Capture + replay + structure + signals + narration. Runs entirely in the professor's browser session. | YES — locally only, never transmitted |
| **Frontend** | Management dashboard + evidence viewer. Account, licensing, roster, disclosure setup. Displays evidence the extension produced. | NO raw data — only final, content-stripped summaries the professor chooses to save |
| **Backend** | Identity, licensing/billing, rosters, disclosure records. Content-free. | NO |
| **Database** | Persists accounts, licenses, rosters, disclosure records, and optional content-stripped summaries. | NO raw mutations, ever |

## Cross-cutting constraints (NON-NEGOTIABLE)

### C1 — Local-only data residency
Raw edit data (the mutation stream and any document content) is processed and
discarded **inside the extension, on the professor's machine**. It is never
transmitted to the backend, never persisted in raw form, and never sent to any
cloud service (this rules out Groq or any cloud LLM). The only network calls the
extension may make are to Google's own People API and Docs API, carrying IDs and
structure requests — never keystroke content.

### C2 — Authorization model
Access derives from the **professor's existing Edit permission on the doc plus
disclosure**, not from a student consent checkbox. The professor must disclose
tracking (syllabus / assignment brief) before work begins. The product ships
template disclosure language. Institutional sign-off (NJIT student-data policy)
is required before running on a real graded class. Edit permission ≠ authority;
disclosure + institutional clearance = authority.

### C3 — Deterministic, auditable attribution
Every claim the product makes must trace to a named rule that can be shown to a
contesting student. No black-box inference anywhere in the attribution or
narration path.

### C4 — Capture is the load-bearing interface
The entire pipeline depends on the **complete mutation history from document
creation to present** — a clean ordered log with persistent per-character IDs and
origin-author tags — obtained from the Google Docs internal collaboration
endpoint (the Draftback approach) — **NOT** by diffing the rendered "version
history" view. The full history is fetched **retroactively, on demand**: the
professor can analyze a weeks-old doc without the extension having run during
editing. A partial history is a corrupt history — missing early mutations mean
wrong origin-authorship for every character created in the gap. Snapshot-diffing
is forbidden: it produces lossy data (dropped characters), cannot survive
reformats (whole-doc-replace artifacts), and cannot represent concurrency. See
`01-extension-requirements.md` §Capture.

### C5 — Conservative "no role" handling
The product never declares a student contributed nothing. Absence of detected
edits is reported as *what the data does and does not show*, always carrying the
caveat that off-document work is invisible. "No role" is the professor's
conclusion, never the tool's.

## The mutation-format dependency — CONFIRMED (was an assumption, now validated)

This section originally described an assumed mutation shape pending
validation. It has since been built and confirmed end-to-end against real
Google Docs traffic, including a real `revisions/load` response (2026-06-28).
The actual confirmed shapes (`extension/src/types/mutation.ts`):

```
{ type: "insert", authorId: "...", timestamp: ..., position: <index>, text: "..." }
{ type: "delete", authorId: "...", timestamp: ..., range: { start: <index>, end: <index> } }
```

Per-character IDs are NOT part of the op itself — they're minted by the
replay engine (`extension/src/replay/index.ts`) at the moment a character is
actually inserted into the live document, not by capture.

Two real wire formats feed this, both confirmed against captured traffic:
- **Live capture** (`extension/src/capture/`): the outbound `/save` POST and
  the inbound `/bind` realtime push channel, using Google's `is`/`ds`/`mlti`
  command vocabulary.
- **Retroactive history** (`extension/src/capture/history.ts`):
  `GET .../document/d/<id>/revisions/load?id=<id>&start=<n>&end=<n>`. The
  response has a `)]}'` XSSI prefix, then one JSON object with two top-level
  fields — `chunkedSnapshot` (a flat list of raw style/structure commands
  with no per-command author/timestamp; deliberately ignored) and
  `changelog` (the one that matters: entries shaped exactly like the bind
  channel's `[command, timestamp, authorId, rev, sessionId, ...]`). This
  took two rounds of live debugging to nail down — see `ME.MD`'s resolved
  item and the git history around 2026-06-28 if a future endpoint change
  breaks this again.

If the real endpoint format changes again in the future, fix the parsing in
`capture/index.ts` / `capture/history.ts` and update this section — don't let
it go stale the way the original guessed shape above did.

## Build order

1. ✅ Extension capture layer — done, confirmed against real captured traffic.
2. ✅ Extension replay engine (+ synthetic test suite) — done.
3. ✅ Extension structure + signals + narration — every F1-F8 requirement in
   `EXTENSION.MD` has an implementation (template detection, real Docs API
   structural elements, a concurrency boundary signal, empty-signal authors,
   named rule IDs per sentence). F5.5 (self-applied section tags) and
   F8.1/F8.3 (synthetic-scenario generator) remain genuinely unimplemented;
   several others need live validation against a real document, not more
   code — see `EXTENSION.MD`'s Current State / Remaining Work and `ME.MD`.
4. ⚠️ Backend (accounts, rosters, disclosure) — rebuilt and verified against
   real MongoDB (full CRUD chain, CSV import, cross-professor authorization,
   cascading deletes). **Licensing is explicitly deferred** — no payment
   processor chosen yet, no model/endpoints exist. See `BACKEND.md`.
5. ⚠️ Frontend (dashboard, evidence viewer) — rebuilt as Vite + React + TS +
   react-router, verified end-to-end in a real headless browser against the
   real backend and a real extension export. Licensing UI has nothing to
   show until backend licensing exists. See `FRONTEND.md`.
6. ✅ Database schema (in lockstep with backend) — pre-pivot collections
   dropped (no real data existed to preserve), rebuilt to match E2/E4-E9.
   E1 (Institution) and E3 (License) don't exist yet. See `DATABASE.md`.

For the full current-state breakdown and a dependency-ordered task list
across all four components, see `CLAUDE.md`'s "Current State" and "Remaining
Work" sections — kept current as of each work session, not just at a
point-in-time handover.