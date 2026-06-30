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
| **Extension** (`extension/`) | The analysis engine: capture + replay + structure + signals + narration + identity resolution. Runs entirely in the professor's browser. Never connects to our own backend, in either direction. | YES — locally only, never transmitted |
| **Frontend** (`frontend/`) | Management dashboard + evidence viewer. Account, licensing, class/assignment/group setup (group size as a count only, never a named roster), disclosure. Displays evidence the extension produced. | NO raw data — only opt-in, content-stripped summaries |
| **Backend** (`backend/`) | Identity, licensing/billing, class/group metadata + seat counts, disclosure records. Content-free, and never stores an actual list of named students. | NO |
| **Database** | Accounts, licenses, class/group metadata, disclosure records, optional content-stripped summaries. | NO raw mutations, ever |

### Tech Stack
- **Extension**: TypeScript, esbuild, vitest, Chrome Manifest V3 (`extension/`)
- **Frontend**: Vite + React + TypeScript + react-router (decided 2026-06-29, not Next.js)
- **Backend**: FastAPI (Python 3.14, venv already at `backend/.venv`)
- **Database**: MongoDB
- **Auth**: Google OAuth 2.0 (professors only — students are never accounts; name resolution
  happens entirely inside the extension via People API + Drive permissions, never via the backend)

---

## Current State (as of 2026-06-29)

Full per-component detail (purpose, functional requirements, current state, remaining work) now
lives in each component's own doc — `EXTENSION.MD`, `BACKEND.md`, `FRONTEND.md`, `DATABASE.md`.
This section is a summary; check the component doc before assuming something below is stale.

### Extension — capture through export all real and tested; identity resolution had a real bug, now fixed
- ✅ Capture (live `/save` + `/bind`, confirmed against real traffic) and retroactive history
  (`.../revisions/load`, confirmed against a real response 2026-06-28 — see `ME.MD`'s resolved
  envelope item: the real shape is `{chunkedSnapshot, changelog}`, only `changelog` matters).
- ✅ Replay, structure detection (newline paragraphs OR real Docs API heading/table ranges — F5.1-
  F5.4), 7 named signals (paste/quarantine/integrator/late-concentration/narration-phrase/
  revision-depth/concurrent-edit-boundary), narration with a named rule ID per sentence (F7.2) and
  form-aware hedging when Docs structure is known (F7.3), content-stripped export — all wired into
  the popup, 129 tests passing.
- ⚠️→✅ **Name resolution had a real, confirmed bug, now fixed.** Clicking "Resolve author names"
  completed the OAuth flow but resolved nothing — People API only resolves the professor's own
  contacts/connections, not an arbitrary doc collaborator (the common classroom case). Fixed with
  `extension/src/identity/drive.ts`: falls back to the Drive API's file-permissions list for
  anything People API didn't resolve. New OAuth scope, new host_permission, explicit C1 addition
  in `HANDOVER.md`. **Still unconfirmed**: that a Drive permission's `id` equals the collab
  stream's author ID — the new load-bearing assumption (see `ME.MD`).
- ✅ Section labels in exports now use real heading text (e.g. "Executive Summary") when a section
  has one, instead of unusable "Paragraph N" placeholders — required a scoped, documented
  exception to C1 (short heading/title text only, never prose body; see `HANDOVER.md`).
- ❌ **F4.2 (non-roster authorship) and F7.5 (missing roster member) were built last session, then
  REMOVED by decision 2026-06-29.** They required a professor-typed "expected roster" textarea in
  the popup, which (a) was confusing — looked related to the unrelated, automatic People-API name
  resolution — and (b) provided little real value. No replacement input source is planned; the
  extension-backend boundary stays closed regardless (C1).
- ⚠️ Other interpretive gaps still worth your read (see `EXTENSION.MD`/`ME.MD`): F6.6's concurrency
  signal is a "boundary" flag, not literal per-character "shared" attribution (the confirmed real
  data format gives every command exactly one author). F5's Docs API integration doesn't detect
  inline equations or distinguish lists from prose. F5.5 (self-claimed sections) and F8.1/F8.3
  (fixture generator) remain genuinely unimplemented.

### Backend, Frontend, Database — F1/F3(scoped down)/F4/F5 built and browser-verified; F2 (licensing) deferred
- **Backend**: rebuilt to spec, then **F3 scoped down further 2026-06-29**: `roster.py` and the
  `RosterMember` model (an actual per-group list of named students) were built, verified, then
  REMOVED by decision — name resolution turned out to belong entirely in the extension (People
  API + Drive fallback above), so the backend never needed to store student identities at all.
  `groups.expected_size` (a plain count) replaced it, for the professor's reference and license
  seat-tracking only. Dead pre-pivot routers (`admin`/`invites`/`student`/`submissions`/`tasks`)
  also deleted. `auth`/`classes`/`assignments`/`groups`/`disclosure`/`summaries` implement
  F1/F3/F4/F5, verified against real MongoDB. **F2 (licensing) explicitly deferred — not
  started.** See `BACKEND.md`.
- **Frontend**: rebuilt from the bare Vite scaffold into Vite + React + TS + react-router, then
  **its roster CRUD/CSV-import UI removed 2026-06-29** along with the backend feature it managed
  — `GroupPage.tsx` now has a single `expected_size` number field instead. F1 (login), F2
  (class/assignment/group setup), F3 (disclosure setup), F4 (evidence viewer), F5 (evidence
  intake) verified end-to-end in a real headless browser against the real backend. See
  `FRONTEND.md`.
- **Database**: rebuilt — pre-pivot collections dropped (no real data existed to preserve); real
  collections now match E2/E4/E5/E6/E8/E9. **E7 RosterMember removed 2026-06-29** (see Backend
  above) — `groups` carries `expected_size` instead. E1 (Institution) and E3 (License) don't exist
  yet. See `DATABASE.md`.

---

## Remaining Work (in dependency order — do not skip ahead per HANDOVER.md's build order)

> Manual setup steps and things that need live validation against a real Google account/doc are
> tracked in `ME.MD`. Per-component task detail lives in each component's own doc (linked below)
> — this list is the cross-component sequencing, not a restatement of every item.

1. ✅ ~~Extension capture + retroactive history (C4)~~ — done and confirmed against real traffic,
   including the `revisions/load` envelope (`ME.MD`'s resolved item).
2. ✅ ~~Author-name resolution~~ — People API alone confirmed broken for non-contacts (live test);
   fixed with a Drive-permissions fallback (`extension/src/identity/drive.ts`). **Still open** (see
   `ME.MD`): confirm live that a Drive permission's `id` actually equals the collab-stream author ID.
3. ✅ ~~Extension structure + signals + narration + export~~ — done, with two features (F4.2, F7.5)
   built then deliberately removed (see `EXTENSION.MD`). **F5.5 and F8.1/F8.3 remain genuinely
   unimplemented**; several others need live validation, not more code — see `EXTENSION.MD`'s
   Current State / Remaining Work and `ME.MD`.
4. ✅ ~~Backend rebuild (F1/F3/F4/F5)~~ — done, verified against real MongoDB, **then F3 scoped
   down 2026-06-29** (counts only, no named roster — see `BACKEND.md`). **F2 (licensing)
   explicitly deferred** — needs a payment processor decision first (see `ME.MD`).
5. ✅ ~~Database rebuild~~ — done in lockstep with the backend, including the F3 scope-down.
6. ✅ ~~Frontend rebuild (F1-F5)~~ — done, verified end-to-end in a real browser, **then its roster
   UI removed in lockstep with the backend**. See `FRONTEND.md`'s Remaining Work for polish items
   (license display once F2 exists, long-evidence-page UX, a real design pass).
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
