# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project: GroupSync

An **evidence tool** for professors grading collaborative Google Docs work — not a scoring tool.
It attributes authorship at the character level inside a browser extension (local-only, never
transmitted) and produces a plain-language, per-person breakdown the professor uses as evidence,
applying all judgment themselves.

**`HANDOVER.md` is the source of truth for architecture and non-negotiable constraints (C1–C5)
and overrides anything below if they conflict.** Read it first. `EXTENSION.MD`, `BACKEND.md`,
`FRONTEND.md`, `DATABASE.md` hold the four per-component specs (functional requirements, current
state, and a remaining-work list each) — `EXTENSION.MD` is NOT a duplicate of `HANDOVER.md`, it's
the extension's own detailed F1–F8 requirements doc, parallel to the other three.

This is a **fat-extension / local-analysis** architecture (pivoted from an earlier thin-client /
server-side-scoring design — that old design is dead, do not resurrect it):

| Component | Role | Touches student edit data? |
|---|---|---|
| **Extension** (`extension/`) | The analysis engine: capture + replay + structure + signals + narration. Runs entirely in the professor's browser. | YES — locally only, never transmitted |
| **Frontend** (`frontend/`) | Management dashboard + evidence viewer. Account, licensing, roster, disclosure. Displays evidence the extension produced. | NO raw data — only opt-in, content-stripped summaries |
| **Backend** (`backend/`) | Identity, licensing/billing, rosters, disclosure records. Content-free. | NO |
| **Database** | Accounts, licenses, rosters, disclosure records, optional content-stripped summaries. | NO raw mutations, ever |

### Tech Stack
- **Extension**: TypeScript, esbuild, vitest, Chrome Manifest V3 (`extension/`)
- **Frontend**: Vite + React + TypeScript + react-router (decided 2026-06-29, not Next.js)
- **Backend**: FastAPI (Python 3.14, venv already at `backend/.venv`)
- **Database**: MongoDB
- **Auth**: Google OAuth 2.0 (professors only — students are roster entries, not accounts)

---

## Current State (as of 2026-06-29)

Full per-component detail (purpose, functional requirements, current state, remaining work) now
lives in each component's own doc — `EXTENSION.MD`, `BACKEND.md`, `FRONTEND.md`, `DATABASE.md`.
This section is a summary; check the component doc before assuming something below is stale.

### Extension — every F1-F8 requirement now has an implementation; several need live validation
- ✅ Capture (live `/save` + `/bind`, confirmed against real traffic) and retroactive history
  (`.../revisions/load`, confirmed against a real response 2026-06-28 — see `ME.MD`'s resolved
  envelope item: the real shape is `{chunkedSnapshot, changelog}`, only `changelog` matters).
- ✅ Replay, structure detection (newline paragraphs OR real Docs API heading/table ranges — F5.1-
  F5.4, new this session), 9 named signals (paste/quarantine/integrator/late-concentration/
  narration-phrase/revision-depth/concurrent-edit-boundary/non-roster-authorship/missing-roster-
  member — F6.3/F6.6/F4.2/F7.5 closed this session), narration with a named rule ID per sentence
  (F7.2) and form-aware hedging when Docs structure is known (F7.3), content-stripped export — all
  wired into the popup, 121 tests passing, exercised by a real end-to-end test export (`test1.json`).
- F4.2/F7.5 required a locally-typed "expected roster" textarea in the popup (never fetched over
  the network — C1 only permits Google API calls from the extension, not calls to our own backend,
  even though a real roster now exists server-side — see `EXTENSION.MD`'s remaining work for the
  scope question this raises).
- ⚠️ **Real, interpretive gaps still worth your read** (not just pending validation): F6.6's
  concurrency signal is a "boundary" flag, not literal per-character "shared" attribution — the
  confirmed real data format gives every command exactly one author, so there's no positional
  ambiguity within replay itself to represent; see its code comment and `EXTENSION.MD`. F5's Docs
  API integration doesn't detect inline equations or distinguish lists from prose (a real, narrow
  limitation, documented in `EXTENSION.MD`). F5.5 (self-claimed sections) and F8.1/F8.3 (fixture
  generator) remain genuinely unimplemented — no input source / lower priority, respectively.
- Still-open validation items (Docs API index-alignment, concurrency thresholds, People API
  non-contact resolution, paragraph-boundary assumption, narration wording): tracked in `ME.MD`.

### Backend, Frontend, Database — F1/F3/F4/F5 built and browser-verified; F2 (licensing) deferred
- **Backend**: rebuilt to spec. Dead pre-pivot routers (`admin`/`invites`/`student`/`submissions`/
  `tasks`) deleted. `auth`/`classes`/`assignments`/`groups`/`roster`/`disclosure`/`summaries`
  implement F1/F3/F4/F5, verified against real MongoDB (full CRUD chain, CSV import, cross-
  professor authorization, cascading deletes, `/summaries` accepting the extension's real export
  unmodified). **F2 (licensing) explicitly deferred by decision — not started.** See `BACKEND.md`.
- **Frontend**: rebuilt from the bare Vite scaffold into Vite + React + TS + react-router. F1
  (login), F2 (class/assignment/group/roster CRUD), F3 (disclosure setup), F4 (evidence viewer),
  F5 (evidence intake) all built and verified end-to-end in a real headless browser against the
  real backend, using the real extension export — zero console errors. See `FRONTEND.md`.
- **Database**: rebuilt — pre-pivot collections dropped (no real data existed to preserve);
  real collections now match E2/E4–E9. E1 (Institution) and E3 (License) don't exist yet
  (License tracks F2's deferral). See `DATABASE.md`.

---

## Remaining Work (in dependency order — do not skip ahead per HANDOVER.md's build order)

> Manual setup steps and things that need live validation against a real Google account/doc are
> tracked in `ME.MD`. Per-component task detail lives in each component's own doc (linked below)
> — this list is the cross-component sequencing, not a restatement of every item.

1. ✅ ~~Extension capture + retroactive history (C4)~~ — done and confirmed against real traffic,
   including the `revisions/load` envelope (`ME.MD`'s resolved item).
2. ✅ ~~Author-name resolution~~ — done in `extension/src/identity/people.ts`. **Still open** (see
   `ME.MD`): (a) register the OAuth redirect URI in Google Cloud Console (manual), (b) confirm live
   whether People API resolves non-contact collaborators or the Drive-permissions fallback is needed.
3. ✅ ~~Extension structure + signals + narration + export~~ — every F1-F8 requirement now has an
   implementation (F4.2, F5.1-F5.4, F6.3, F6.6, F7.2, F7.5 all closed this session). **F5.5 and
   F8.1/F8.3 remain genuinely unimplemented** (no input source / lower priority); several others
   need live validation, not more code — see `EXTENSION.MD`'s Current State / Remaining Work and
   `ME.MD`.
4. ✅ ~~Backend rebuild (F1/F3/F4/F5)~~ — done, verified against real MongoDB. **F2 (licensing)
   explicitly deferred** — needs a payment processor decision first (see `ME.MD`).
5. ✅ ~~Database rebuild~~ — done in lockstep with the backend.
6. ✅ ~~Frontend rebuild (F1-F5)~~ — done, verified end-to-end in a real browser. See `FRONTEND.md`'s
   Remaining Work for polish items (license display once F2 exists, long-evidence-page UX, a real
   design pass).
7. **Institutional/compliance step (C2)**: before running on any real graded class, confirm
   NJIT (or relevant institution) student-data sign-off — this is a gate, not a code task, but
   don't build features that assume it's already cleared.

---

## Coding Principles

### 1. Think Before Coding
State assumptions explicitly before writing code. If a request has multiple valid interpretations, present them and ask. Push back when the proposed approach seems wrong. If requirements are unclear, stop and ask rather than guess.

### 2. Simplicity First
Write the minimum code that satisfies the request. No features beyond what was asked, no abstractions built for single-use code, no "flexibility" that wasn't requested, no error handling for scenarios that can't happen given the context.

### 3. Surgical Changes
Don't improve adjacent code. Don't refactor things that aren't broken. Match the existing style of the file you're editing. If you notice pre-existing dead code, mention it — don't silently delete it. Only remove imports/variables/functions that *your* changes made unused.

### 4. Goal-Driven Execution
Transform tasks into verifiable goals before starting. For multi-step tasks, state a brief plan first. Don't keep going past what was asked.
