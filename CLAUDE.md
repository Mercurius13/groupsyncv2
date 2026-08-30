# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What GroupSync is

An **evidence tool** for professors grading collaborative Google Docs work — explicitly *not* a
scoring tool. It reconstructs a shared doc's edit history, attributes every surviving character to
an origin author, and renders a plain-language, per-person breakdown with a named rule ID behind
every sentence. The professor applies all judgment; the tool never issues a verdict.

## Architecture (fat extension / local-only analysis)

| Component | Role | Sees student edit data? |
|---|---|---|
| `extension/` | The entire analysis engine: capture → replay → structure → signals → narration → export. Runs in the professor's browser. **Never talks to our backend, in either direction.** | Yes — locally, in `chrome.storage.session` only |
| `backend/` | FastAPI. Two jobs only: professor Google-OAuth accounts, and licensing/entitlement. | No |
| `frontend/` | Vite + React. Login, then one page: account, plan, install instructions, disclosure template. | No |
| MongoDB | `professors` and `licenses` collections. Nothing else. | No |

The class/assignment/group/roster/evidence-viewer layer that used to live in the backend and
frontend was **deleted in the 2026-07-03 pivot** (see `git show daa2975`, `3ac3039`). Canvas owns
class organization; the extension popup owns analysis display. Do not resurrect either.

## Non-negotiable constraints

These are carried in code comments as `C1`–`C5` / `N1` / `F…` / `E…` tags. Keep the tags when you
touch tagged code; they are the audit trail.

- **C1 — Local-only residency.** Raw mutation data and document content are processed and discarded
  inside the extension. Never transmitted to our backend, never persisted in raw form, never sent to
  any cloud service or LLM. Op/name/structure state lives in `chrome.storage.session`, which clears
  on browser close. The only export is user-initiated, content-stripped, and goes to the clipboard —
  there is deliberately **no server-side destination** for it.
- **C2 — Authorization.** Access derives from the professor's existing Edit permission on the doc
  plus disclosure to students, not from a student consent checkbox. Graders/TAs are excluded from
  assessment rather than silently counted.
- **C3 — Deterministic, auditable attribution.** Every user-visible claim carries a `ruleId`
  (`RuledSentence` in `narration.ts`) traceable to a named rule. No black-box inference anywhere in
  the attribution or narration path.
- **C4 — Capture is load-bearing.** The pipeline needs the *complete ordered mutation log from doc
  creation*, taken from Google's internal collaboration endpoints (the Draftback approach) — **not**
  by diffing rendered version-history snapshots.
- **C5 — Conservative "no role".** Never state that a student contributed nothing. Low/absent edits
  are reported as what the data does and does not show, always with the off-document caveat.

## Extension pipeline

Flat module layout in [extension/src/](extension/src/) (flattened from directories in `3ac3039` — no
subfolders, no `index.ts` barrels; keep it that way).

**Ingest**
1. [inject.ts](extension/src/inject.ts) — MAIN-world content script at `document_start`. Monkey-patches
   `XMLHttpRequest.open/send` and `window.fetch`, classifies URLs as `save` / `bind` / `tiles`, and
   `postMessage`s the request body + response text to the page.
2. [content.ts](extension/src/content.ts) — isolated-world relay; forwards those messages to the worker.
3. [background.ts](extension/src/background.ts) — service worker. Message router and the only owner of
   session state, keyed `groupsync-{ops,names,excluded,structure}-<docId>`.

**Parse**
4. [capture.ts](extension/src/capture.ts) — `/save` form body (`bundles` → `is`/`ds`/`mlti` commands,
   attributed to the local `ouid`) and `/bind` push channel (length-prefixed `<len>\n<json>` chunks,
   server-attributed). Only `is`/`ds`/`mlti` survive; structural commands are dropped.
5. [history.ts](extension/src/history.ts) — retroactive `/revisions/load` paging (1000 revs/page), max
   revision found by doubling then binary search, `)]}'` XSSI prefix stripped, `userMap` harvested.
   A full-history fetch **replaces** stored ops (appending would duplicate live-captured ones).
6. [tiles.ts](extension/src/tiles.ts) — `/revisions/tiles` `userMap` → real names + anonymous IDs, in the
   same authorId namespace as the changelog.

**Analyse**
7. [replay.ts](extension/src/replay.ts) — deterministic replay from an empty doc into `LiveChar[]`
   (per-char `charId` + origin `authorId`), plus an actor→target deletion log. Unobserved positions
   are padded as null-origin chars. Inserts split by UTF-16 code unit (`split("")`, not
   `Array.from`) so emoji don't shift alignment.
8. [structure.ts](extension/src/structure.ts) — opt-in Docs API `documents.get` with a fields mask that
   requests **structure only, never text**; classifies elements and segments the char array into
   weighted sections (table ×3, numeric ×1.5, list ×1.25, prose/heading ×1). Falls back to newline
   paragraphs, unweighted, until the structure fetch runs.
9. [signals.ts](extension/src/signals.ts) — named signals with exported thresholds: paste, quarantined
   high-churn session, integrator pattern, late concentration, revision depth, concurrent-edit
   boundary; plus exclusion application and per-author contribution profiles.
10. [narration.ts](extension/src/narration.ts) — `RuledSentence[]` per section, per author, per signal.
11. [export.ts](extension/src/export.ts) — content-stripped summary (narration text, counts, short
    heading labels — never prose body or raw mutations).
12. [popup.ts](extension/src/popup.ts) — orchestrates the above in `render()` and builds the UI.
    Panels are **built and appended in reading order**, never prepended ad hoc.
    [popup.html](extension/src/popup.html) holds all styling as CSS custom properties: light values on
    `:root`, dark redefined under `prefers-color-scheme`. The six `--series-*` slots are a validated
    categorical palette (separately stepped per surface for contrast and colorblind separation — not
    an automatic flip). `authorColorSlots()` assigns them **by an author's first appearance in the
    mutation log**, so naming or excluding someone never repaints anybody else; authors past six
    share the neutral slot. Don't reassign colors by rank or share.

**Pipeline order in `render()` matters**: replay → segment → *apply exclusions* → footprints →
profiles → narrate. Exclusions are applied POST-replay to sections and op-derived signals, never by
filtering the mutation log (which would corrupt replay positions).

### Behaviour worth not breaking

- **Results are gated on names.** If no author names have been retrieved, the popup shows a prompt
  instead of analysis — misattribution is worse than no output.
- **Any unnamed author is assumed to be the grader** (`graderExcludedAuthorIds` in `signals.ts`) and
  is excluded from assessment. The account running the extension always appears unnamed in version
  history, so this covers both authors Google reports as anonymous (`null`) and authors no response
  named at all (absent from the map) — the two must stay equivalent here. The professor names an
  unnamed author in the roster panel to promote them back to a student, and can additionally check
  named co-instructors/TAs to exclude them.
- **Tables are one collapsed unit credited by winner-take-all cell ownership** (`buildTableSection`),
  ties broken toward the earliest origin. This deliberately protects the person who *built* a table
  from a later reviser. Do not switch it back to raw character counts over the table span.

### Open assumption to be careful around

`segmentByElements` slices the replayed `LiveChar[]` (mutation-stream `ibi`/`si`/`ei` space) using
Docs API `startIndex`/`endIndex`. **That the two index spaces coincide is unvalidated.** It lines up
for plain text, but tables burn structural index positions (1 per table + 1 per row + 1 per cell) and
the mutation parser drops structural commands, so they exist only as padded null slots. Verify on a
real table doc via the popup's Debug block → `structurePreview.reconstructedText` before trusting
table attribution; if text is shifted, add a running-offset correction walking `body.content`. Also
note `chunkedSnapshot` is ignored — if a doc's history doesn't start empty, all offsets drift.

## Commands

```bash
# Extension — dist/ IS COMMITTED (load-unpacked needs it); rebuild after editing src/
cd extension && npm run build      # esbuild → dist/{background,content,inject,popup}.js
cd extension && npm test           # vitest, 164 tests
cd extension && npm run typecheck  # tsc --noEmit

# Backend (venv already at backend/.venv)
cd backend && .venv/bin/uvicorn main:app --reload --port 8000

# MongoDB — binary tarball, NOT Homebrew (brew won't install here)
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongod \
  --dbpath ~/.local/groupsync-mongo/data --fork --logpath ~/.local/groupsync-mongo/mongod.log
kill -TERM $(pgrep -x mongod)      # `--shutdown` no longer exists in Mongo 8
# no mongosh: use `cd backend && .venv/bin/python`, then `from database import db` (async motor)

# Frontend
cd frontend && npm run dev         # Vite on :5173
```

Loading the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.

## Conventions

- **TypeScript strict**, incl. `noUncheckedIndexedAccess`. Extension has no runtime dependencies.
- **Doc comments** on every exported function: 2–3 lines saying what it does *and why it's shaped
  that way* (which constraint or requirement it serves). Match the existing density.
- **Tests are colocated** (`foo.ts` ↔ `foo.test.ts`) and cover parsers, replay, structure, signals,
  narration, export. Wire-format parsers are tested against real captured response shapes — keep it
  that way rather than inventing fixtures.
- **Secrets** live in the gitignored root `.env` (`GOOGLE_CLIENT_ID/SECRET`, `JWT_SECRET`,
  `MONGODB_URI`). The extension's OAuth client ID is in [extension/src/config.ts](extension/src/config.ts)
  (public by design). Never commit `.env` or `service-account.json`.
- Backend routers are thin; the license router lazily auto-provisions a free-tier license, and
  **no endpoint lets a client change its own license** — that stays for a payment processor's
  webhooks, which is deferred.
