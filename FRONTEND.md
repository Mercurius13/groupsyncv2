GroupSync — Frontend Requirements


The frontend is a management dashboard and evidence viewer (Canvas-like).
It is NOT an analysis surface — attribution happens in the extension. The
dashboard manages accounts, licenses, rosters, disclosure, and displays
evidence the extension produced.


 It shouldn't — analysis lives in the extension. Its
real job is management + presentation: the professor's home base for setup,
licensing, and organizing the evidence cards the extension generates across a
semester. It feels redundant only because it still carries responsibilities the
extension took over. Strip those; keep management and viewing.

Current State (2026-06-29)

Rebuilt from the bare Vite scaffold into a working dashboard: **Vite + React +
TypeScript + react-router** (decided; not Next.js — avoids server-rendering
machinery this thin dashboard doesn't need). F1-F5 are all built and verified
end-to-end in a real headless browser against the real backend (login token
flow, class/assignment/group/roster CRUD including CSV import, disclosure
template/recording, and evidence intake/preview/save using the real
`extension/src/export/index.ts` payload) — see `ME.MD` if this needs
re-verifying after a dependency bump.

- `src/auth.ts`, `src/AuthContext.tsx` (F1) — token stored in `localStorage`;
  `RequireAuth` fetches `/auth/me` once and redirects to `/login` if it
  fails. **F1.2 (license tier/seat/billing display) is not built** — F2
  (licensing) was deferred on the backend, so there's nothing to display yet.
- `src/pages/Dashboard.tsx`, `ClassPage.tsx`, `AssignmentPage.tsx`,
  `GroupPage.tsx` (F2) — full CRUD chain matching the backend's
  Class→Assignment→Group→RosterMember hierarchy, including the CSV
  bulk-import file input (verified with a real CSV through the browser, not
  just the API).
- `ClassPage.tsx`'s disclosure section (F3) — fetches the real template,
  lets the professor edit/reset it, records it, and lists the append-only
  history. The institutional-sign-off reminder (F3.3) is a persistent
  highlighted callout, not a footnote. **Only at the class level** — the
  backend supports per-assignment disclosure too, but no UI surfaces that yet.
- `src/components/EvidenceViewer.tsx` (F4) — renders disclaimer, per-section
  sentences, a visually distinct "Signals & flags" block (pink/red
  highlight, satisfies F4.4), and an author-counts table. **F4.5 (claimed-
  vs-actual) has nothing to render** — the extension doesn't produce that
  data (EXTENSION.MD F5.5 gap), so this is N/A, not unbuilt-but-needed. F4.2
  ("organize evidence... across the term") is minimal — summaries are listed
  per-group, no cross-term/cross-class browsing view exists.
- `GroupPage.tsx`'s evidence-intake section (F5) — paste-JSON textarea →
  Preview (parses, renders via `EvidenceViewer`, nothing sent yet) → "Save to
  backend" (explicit, opt-in click → `POST /summaries`). Saved summaries list
  with delete (F5.3). Verified with the real `test1.json` export.

Remaining Work

1. **F1.2** — license tier/seat/billing display has nothing to show until
   backend F2 exists; revisit together once licensing is built.
2. **F4.2** — no cross-term/cross-class evidence browsing; currently only
   reachable by navigating to a specific group.
3. **Long evidence pages** — a real doc with ~400 paragraphs renders ~400
   section blocks in one unbroken list (confirmed during browser testing,
   not yet a usability problem investigated further); worth collapsing or
   paginating once a professor actually has a doc that large.
4. **Per-assignment disclosure UI** — the backend's `POST /disclosure`
   already accepts `assignment_id` instead of `class_id`; the frontend never
   sends that case.
5. No automated frontend test suite — verification so far is a manual
   Playwright-driven smoke test (see `ME.MD`), not a checked-in regression
   suite.
6. CSS is minimal/utilitarian, not a real design pass.

Functional Requirements

F1 — Account & licensing management


F1.1 Professor login (Google OAuth, via backend) and account settings.
F1.2 View/manage license tier, seats, billing.
F1.3 Institutional association where applicable.


F2 — Class / assignment / group setup


F2.1 Create and manage classes, assignments, and groups.
F2.2 Define group rosters — the expected members of each group — which
become the authoritative join source for resolving edit-log author IDs to named
students (fixes the prior anonymous-contributor bug).
F2.3 Associate each assignment with a doc reference (identifier the
professor uses to locate the doc; not its content).


F3 — Disclosure setup


F3.1 Present the template disclosure language for the professor to adopt or
adapt.
F3.2 Record, via the backend, that disclosure was set for a class/assignment
(compliance artifact, C2).
F3.3 Surface a reminder that institutional sign-off is required before
running on a graded class.


F4 — Evidence viewer (presentation only)


F4.1 Display the per-member evidence the extension produced: narration
sentences, section-by-section authorship, per-author timeline, and any
quarantine/paste/concurrency warnings.
F4.2 Organize evidence per class, assignment, and group, across the term.
F4.3 Always render the standing caveat header (on-document editing only;
evidence, not verdict — C5).
F4.4 Make the "uncertain attribution" and paste flags visually prominent,
not buried — they are first-class, not footnotes.
F4.5 Show self-applied section claims alongside actual authorship where
available, so claimed-vs-actual divergence is visible.


F5 — Evidence intake (content-stripped only)


F5.1 Receive evidence from the extension as a final, content-stripped
summary (narration + counts + section labels). Never raw mutations or
document text (C1).
F5.2 Saving a summary to the backend is opt-in per summary, default off.
F5.3 Provide deletion of any saved summary.


Non-Functional Requirements


N1 The frontend never receives or displays raw edit data — only
content-stripped summaries (C1).
N2 No analysis logic in the frontend; it presents, it does not compute (C3).
N3 Accessible, clear presentation of caveats and flags — the limits of the
tool must be as visible as its claims.
N4 Responsive dashboard suitable for a professor reviewing multiple groups
at grading time (a once-per-assignment review surface, not a live monitor).
N5 Stack per prior decisions (React/Next.js acceptable) — built with Vite +
React + TypeScript + react-router (decided 2026-06-29, not Next.js).


Out of Scope


Performing any attribution or analysis (extension's job)
Receiving or displaying raw mutation streams or document content
Live/continuous monitoring dashboards (review-at-grading-time model)
Presenting contribution percentages or single scores
Any ML-driven feature