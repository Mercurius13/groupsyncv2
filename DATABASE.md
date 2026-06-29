GroupSync — Database Requirements


The database persists identity, licensing, rosters, disclosure records, and
optional content-stripped summaries. It never stores raw mutation streams
or document content. Scope moves in lockstep with the backend.
Inherits all constraints from 00-architecture-overview.md.



The one rule that governs the schema

No collection/table stores raw edit data or document content. If a field
would hold a mutation stream, character-level history, or document text, it does
not belong here. The extension processes that data locally and discards it (C1).

Current State (2026-06-29)

The pre-pivot collections (`users`, `classes`, `groups`, `assignments`,
`submissions`, `tasks`, plus a leftover `contribution_reports` from before
that) have been dropped entirely — there was no real student/grading data in
any of them, so this was a clean rebuild, not a migration. The real MongoDB
database now has, and only has, collections matching E2/E4-E9 (E1 Institution
and E3 License are the two not yet realized — see below):

- `professors` (E2) — `{email, name, google_id, institution_id: null}`. No
  `role` field; professors are the only account type that exists (F1.4).
- `classes` (E4) — `{professor_id, name, term, created_at}`.
- `assignments` (E5) — `{class_id, name, doc_reference, created_at}`. No
  attachment/instructions/deadline fields — those belonged to the dead
  pre-pivot "run the assignment" model.
- `groups` (E6) — `{assignment_id, name}`. Scoped to assignment, not class —
  per BACKEND.md F3.1, the roster is the expected membership of a *group*,
  not a class-wide roster.
- `roster_members` (E7) — `{group_id, student_name, student_email,
  google_user_id: null}`. Verified end-to-end including CSV bulk import.
- `disclosure_records` (E8) — `{class_id, assignment_id, professor_id,
  disclosure_text, enabled_at}`. Append-only: no update/delete path exists in
  `disclosure.py` (N4 holds by omission, not by a guard check).
- `summaries` (E9) — `{assignment_id, group_id, created_at,
  content_stripped_payload}`. Verified against a real
  `extension/src/export/index.ts` export (`test1.json`) — the payload was
  accepted with no shape changes needed.
- N1 (content-free invariant) holds and has now been checked against a real
  example payload, not just asserted: `content_stripped_payload` is whatever
  JSON the extension sends, and the extension's own type system (no `text`
  field exists on `ExportedSection`) is what actually enforces N1 — the
  database/backend store it opaquely and can't independently verify it.

Remaining Work

1. **E1 (Institution) and E3 (License) don't exist yet** — `professors.institution_id`
   is a nullable field with nothing real behind it, and there's no `licenses`
   collection at all. Licensing was explicitly deferred (see BACKEND.md);
   Institution is low priority (F1.2 says "where applicable").
2. N2 (encryption at rest) and the broader N3-style security posture aren't
   configured — this is local dev MongoDB with no TLS/auth.
3. No schema validation (e.g. MongoDB JSON Schema / `$jsonSchema` validators)
   enforces these shapes at the database level — correctness currently rests
   entirely on the FastAPI/pydantic layer above it, not the database itself.

Entities

E1 — Institution


institution_id, name, billing/contact metadata.


E2 — Professor (User)


professor_id, name, email, google_user_id, institution_id (nullable),
auth metadata.


E3 — License


license_id, professor_id or institution_id, tier, status,
seat_count, billing_period, processor reference.
Stores who paid and what plan — no analysis content.


E4 — Class


class_id, professor_id, name, term.


E5 — Assignment


assignment_id, class_id, name, optional doc_reference (an identifier the
professor uses to locate the doc — not its content).


E6 — Group


group_id, assignment_id, name.


E7 — RosterMember


member_id, group_id, student_name, student_email,
google_user_id (nullable).
This is the authoritative join source for resolving edit-log author IDs to
named students. Directly addresses the prior failures: a one-person members
list against six editors, and a provided email surfacing as anonymous.
Identity metadata only; no edit content.


E8 — DisclosureRecord


disclosure_id, class_id or assignment_id, professor_id,
disclosure_text, enabled_at.
Compliance artifact (C2). Records that tracking was disclosed and when.


E9 — SavedSummary (optional, opt-in)


summary_id, assignment_id, group_id, created_at,
content_stripped_payload.
Payload = final per-author narration + counts + section labels only.
No raw mutations, no document text. Default off. Deletable by the professor.


Relationships

Institution 1—* Professor 1—* Class 1—* Assignment 1—* Group 1—* RosterMember
Professor   1—* License
Class/Assignment 1—* DisclosureRecord
Group 1—* SavedSummary   (optional)

Non-Functional Requirements


N1 Content-free invariant enforced at the schema level: no field holds
raw edit data or document content (C1). Document this invariant in the schema
and in code review checklists.
N2 Encryption at rest; access scoped per professor/institution.
N3 RosterMember and identity data limited to the minimum needed for author-
ID resolution.
N4 Disclosure records immutable once written (append-only audit trail) —
edits create new records rather than overwriting.
N5 SavedSummary supports hard delete (professor purge).
N6 MongoDB acceptable per prior decisions, provided N1 holds.


Out of Scope


Storing raw mutation streams or character-level history
Storing document content of any kind
Any table/collection that would make GroupSync a processor of student
education records