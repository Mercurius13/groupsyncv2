# GroupSync

**Evidence for grading group work in Google Docs — not a score.**

When a group turns in one shared doc, the professor has no reliable way to see who actually wrote
what. GroupSync reconstructs the document's complete edit history, attributes every surviving
character to the person who originally typed it, and produces a plain-language breakdown per
student — each sentence traceable to a named rule you can show a student who contests it.

It deliberately stops short of grading. It reports what the edit data does and does not show; the
conclusion is yours.

## How it works

A Chrome extension watches Google Docs' internal collaboration endpoints (the same source the
"Draftback" approach uses) to obtain the ordered mutation log from the moment the document was
created. It replays that log from an empty document, so every character in the final text carries
the ID of the author who originated it, and every deletion is recorded as "who deleted whose text".

From there it segments the document into real structural units — paragraphs, list items, headings,
and tables — via the Google Docs API, weights them by form (a table counts for more than a
paragraph of prose), and derives a set of named signals: large single-action pastes, sessions where
so much was deleted that attribution is unreliable, contributors who edited broadly but originated
little, activity concentrated in the last stretch before the deadline, and moments where two people
edited the same spot at the same time.

**All of this happens on your machine.** Document content and edit history are never uploaded to
GroupSync's server — there is no endpoint to receive them. Captured data lives in Chrome's session
storage and is discarded when you close the browser. The only thing that can leave is an export you
click yourself: narration text, character counts, and short section headings, copied to your
clipboard, with document prose stripped out.

## Repository layout

| Path | What it is |
|---|---|
| `extension/` | The product. Chrome MV3 extension, TypeScript, no runtime dependencies. Capture, replay, structure, signals, narration, export, popup UI. |
| `backend/` | FastAPI. Professor accounts (Google OAuth) and licensing/entitlement — nothing else. Holds no student data, no documents, no analysis output. |
| `frontend/` | Vite + React. Sign-in, plan/account page, install instructions, disclosure template. |

## Setup

Requires Node 18+, Python 3.14 (venv provided at `backend/.venv`), and MongoDB.

### Extension

```bash
cd extension
npm install
npm run build
```

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the
`extension/` directory. (A Chrome Web Store listing is pending.)

### Backend and frontend

Create a root `.env` with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`, and
`MONGODB_URI`, then:

```bash
# MongoDB (local binary install)
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongod \
  --dbpath ~/.local/groupsync-mongo/data --fork --logpath ~/.local/groupsync-mongo/mongod.log

# API on :8000
cd backend && .venv/bin/uvicorn main:app --reload --port 8000

# Web app on :5173
cd frontend && npm install && npm run dev
```

The web app is optional for analysis — the extension works on its own. Payments are not wired up;
every account is auto-provisioned an active free-tier license.

## Using it

1. Open the group's shared Google Doc in a tab you have edit access to.
2. Click the GroupSync icon → **Fetch full history (retroactive)**. This pulls the doc's changelog
   from revision 1, so you don't need to have had the extension installed while students worked.
3. If authors are still unnamed, open **File → Version history → See version history** in the doc and
   scroll the revision list once, then reopen the popup. Analysis stays hidden until names are
   available — showing attribution against raw IDs invites misattribution.
4. Click **Fetch document structure** to switch from newline-paragraph segmentation to real elements
   (tables, lists, headings) with form weighting. This is the one step that asks for a Google
   authorization; it requests read-only Docs access and fetches structural metadata only — index
   ranges, styles, table dimensions — never your document's text.
5. Under **Who counts as a student**, any author version history won't name is assumed to be you —
   the account running the extension always appears unnamed there — and is left out of the
   assessment. If one of them is actually a student, give them a name and they'll be counted. Check
   a named author to exclude a co-instructor or TA as well.
6. Read the per-author cards and per-section detail. **Export evidence summary** copies a
   content-stripped JSON summary to your clipboard.

## Before you run this on a graded class

Disclose the use of the tool to students in the syllabus or assignment brief *before* work begins,
and get your institution's sign-off under its student-data policy. Edit permission on a document is
not authority by itself. The account page carries template disclosure language you can adapt.

## What it cannot see

It measures on-document editing, and only that. Work drafted elsewhere and pasted in, in-person
contribution, research, planning, and discussion are all invisible to it — and it cannot tell a
paste of the author's own prior draft from text written by someone else. Absence of captured edits
is not evidence of absence of contribution. Use it as evidence, not as a verdict.

## Development

```bash
cd extension
npm test        # vitest — 164 tests across the parsers, replay, structure, signals, narration, export
npm run typecheck
npm run build   # dist/ is committed, since load-unpacked reads it — rebuild after editing src/
```

See [CLAUDE.md](CLAUDE.md) for architecture detail, the invariants that hold the design together,
and the known open assumption around Docs API index alignment.
