GroupSync — Backend Requirements


The backend owns identity, licensing, rosters, and disclosure records.
It is content-free: it never receives or stores student edit data.



Purpose

Provide the persistent, cross-session infrastructure that makes GroupSync a
business (accounts, paid licenses) and a compliant tool (rosters, disclosure
records) — without ever becoming a processor of student education records.

The scope decision (why this is narrow)

The original backend was designed to receive edit data and run analysis. That
role is dead: analysis moved into the extension (C1, local-only). What
remains is identity and metadata. If a requirement here would cause the backend
to receive raw mutations or document content, it is wrong by definition.

Current State (2026-06-29)

Rebuilt to spec for F1, F3, F4, F5 — verified end-to-end against a real
MongoDB instance (full CRUD chain, CSV import, cross-professor authorization,
cascading deletes, and `/summaries` accepting the extension's real exported
payload unmodified). **F2 (licensing) is explicitly deferred** — skipped this
pass by decision, tracked below, not started.

- `auth.py`/`dependencies.py` (F1) — rebuilt. Professors are their own
  collection (`db.professors`), not `users`; the OAuth callback only ever
  creates a professor record. The old `role`/admin-promotion concept is gone
  entirely — `admin.py` was deleted (no admin/instructor/student model exists
  anymore; nothing in F1-F5 needs it).
- `classes.py`, `assignments.py`, `groups.py` (F3) — rebuilt to the
  Class→Assignment→Group→RosterMember chain (DATABASE.md E4-E7).
  `assignments.py` now stores just `{class_id, name, doc_reference}` — the
  old file-attachment upload/deadline/instructions feature was dropped, since
  F2.3 only wants a `doc_reference` identifier (decided, not still open).
  Every router checks the requesting professor owns the class up the chain
  (verified: a second professor gets 404, not the first professor's data).
- `roster.py` (new, F3) — `RosterMember` is its own collection
  (`db.roster_members`), scoped to a group, with single-add and CSV-bulk-
  import endpoints (`POST /groups/{id}/roster`, `POST
  /groups/{id}/roster/import`). Never touches the professors collection.
- `disclosure.py` (new, F4) — `GET /disclosure/template` returns real
  template language (not a placeholder); `POST /disclosure` is append-only
  (no PATCH/DELETE route exists, satisfying DATABASE.md N4); `GET
  /disclosure` is the audit-trail/has-it-been-set-yet query the frontend
  will need.
- `summaries.py` (new, F5) — `POST /summaries` accepts
  `{assignment_id, group_id, content_stripped_payload}` and was verified
  against a real `extension/src/export/index.ts` export (`test1.json`) with
  no shape changes needed. `DELETE /summaries/{id}` purges; ownership checked
  via the group's assignment's class.
- `invites.py`, `student.py`, `submissions.py`, `tasks.py` — deleted (decided:
  none map to F1-F5; student accounts/task logs/doc-URL submission all
  contradict F1.4 or have no spec equivalent).
- CORS origin updated to `http://localhost:5173` (Vite default) now that the
  frontend stack is decided (Vite + React + TS, not Next.js).

Remaining Work

1. **F2 (licensing) — deferred by decision, not started at all.** No model,
   no endpoints, no payment processor. Needs its own pass once a processor
   (e.g. Stripe) is chosen; tracked as a manual setup item in `ME.MD`.
2. Institution (E1) isn't its own collection yet — `professors.institution_id`
   exists as a nullable field but nothing writes to a real `institutions`
   collection. Low priority (F1.2 says "where applicable").
3. No automated test suite for these routers yet (the original backend never
   had one beyond a deleted `test_contributions.py`) — verification so far is
   a manual smoke test against real MongoDB, not a checked-in regression
   suite. Worth adding once the frontend exercises these endpoints for real.
4. Standard SaaS security (N3 — encryption at rest/in transit) isn't
   configured; this is local dev (`mongodb://localhost:27017`) with no TLS.

Functional Requirements

F1 — Accounts & authentication


F1.1 Professor account creation and login (Google OAuth, server-side).
F1.2 Associate a professor with an institution where applicable.
F1.3 Session management for the frontend dashboard.
F1.4 No student accounts are required for the core product; students are
roster entries, not users (see F3).


F2 — Licensing & billing


F2.1 Support the two tiers from the business plan: per-professor /
institutional license, and (if retained) student seats.
F2.2 Track license status, seat counts, billing periods.
F2.3 Integrate a payment processor; store who paid and what plan, never
any analysis content.
F2.4 Gate extension/dashboard features by license status.


F3 — Rosters & class/group metadata


F3.1 Let a professor define classes, assignments, and the expected
membership of each group (the roster).
F3.2 Store student identifiers needed to map edit-log author IDs to named
students: name, institutional email, Google user ID where available.
F3.3 This directly fixes the earlier bug where members held one person
while six edited the doc, and where a provided email (jm2635) came back as an
anonymous "Contributor". The roster is the authoritative join source.
F3.4 Roster data is metadata (identity), not edit content — permitted.


F4 — Disclosure & consent records


F4.1 Record that a professor enabled tracking for a class/assignment and
acknowledged the disclosure obligation (C2).
F4.2 Store the disclosure language used and the date it was set, as a
compliance artifact usable in a dispute.
F4.3 Provide the template disclosure text to the frontend for the professor
to adopt.


F5 — Optional content-stripped summary storage


F5.1 IF a professor explicitly chooses to save an evidence summary, accept
only the final, content-stripped per-author breakdown (narration + counts +
section labels). No raw mutations, no document text.
F5.2 This is opt-in per summary, defaulting to off.
F5.3 Provide deletion: a professor can purge any saved summary.


API surface (as built — F2's /licenses doesn't exist yet, deferred)


GET /auth/google, GET /auth/callback, GET /auth/me — professor login/session
GET/POST/PATCH/DELETE /classes, /classes/{id}
GET/POST/PATCH/DELETE /assignments, /assignments/{id}
GET/POST/PATCH/DELETE /groups, /groups/{id}
GET/POST /groups/{id}/roster, POST /groups/{id}/roster/import (CSV), DELETE /roster/{id}
POST /disclosure — record disclosure for a class/assignment (append-only)
GET /disclosure/template — fetch template language
GET /disclosure?class_id=|assignment_id= — audit trail
GET/POST /summaries, DELETE /summaries/{id} — opt-in content-stripped summary storage



No endpoint accepts a mutation stream or document content. If one appears to,
it is a design error.



Non-Functional Requirements


N1 Content-free guarantee: no endpoint accepts raw edit data or document
content (C1).
N2 Roster/identity data is the minimum needed to resolve author IDs to
students.
N3 Standard SaaS security: encrypted at rest and in transit, access scoped
per professor/institution.
N4 Auditability of disclosure records (who enabled tracking, when, with
what language).
N5 Stack per prior decisions (FastAPI acceptable), provided the content-free
guarantee holds.


Out of Scope


Receiving, processing, or storing raw mutation streams or document content
Running any attribution analysis (that lives in the extension)
Any ML/model training infrastructure
Cloud LLM calls on student data