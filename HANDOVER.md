# GroupSync — Handover

## What is this

A classroom tool for teachers to organise students into groups, manage Google Docs/Slides assignments, and auto-generate per-student contribution scores from Google Drive edit history. Styled after Canvas LMS.

**Three roles:** Admin (`jason.dsouza.here@gmail.com` only) → Instructor → Student.

---

## How to run it

### Prerequisites

- Python 3.14 — venv already exists at `backend/.venv`
- Node.js / npm — `frontend/node_modules` already present
- MongoDB running locally on port 27017. Homebrew's `mongodb-community` won't install on this machine (outdated Xcode CLT), so the official binary tarball lives at `~/.local/groupsync-mongo`.

### Start everything (3 terminals)

```bash
# 1. MongoDB
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongod \
  --dbpath ~/.local/groupsync-mongo/data \
  --fork --logpath ~/.local/groupsync-mongo/mongod.log

# 2. Backend
cd ~/groupsyncv2/backend
.venv/bin/uvicorn main:app --port 8000

# 3. Frontend
cd ~/groupsyncv2/frontend
npm run dev
```

- Backend: http://localhost:8000
- Frontend: http://localhost:3000

### Environment variables — `groupsyncv2/.env`

```
GOOGLE_CLIENT_ID=1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
JWT_SECRET=<long random string>
ADMIN_EMAIL=jason.dsouza.here@gmail.com
MONGODB_URI=mongodb://localhost:27017/groupsync
GOOGLE_SERVICE_ACCOUNT_KEY=service-account.json
```

`GOOGLE_SERVICE_ACCOUNT_KEY` points to `backend/service-account.json` (relative to backend dir), which contains the GCP service account credentials used for Drive revision history. This file is gitignored — do not commit it.

### Google Cloud project

- Project: `primal-duality-497216-e7`
- OAuth client: `1064467429480-2qtbblj3v9iv2g7no6cd56hijfufvek0.apps.googleusercontent.com`
- Authorised redirect URI: `http://localhost:8000/auth/callback`
- Service account: `groupsync@primal-duality-497216-e7.iam.gserviceaccount.com`
- APIs enabled: Google Drive API, Google Docs API
- App is in **testing mode** — add user emails at console.cloud.google.com/auth/audience before they can sign in
- OAuth scopes requested: `openid email profile` only (no Drive scope from users — Drive is accessed via service account instead)

---

## Current state — everything that is built

### Auth flow

1. User clicks "Sign in with Google" on the landing page
2. Backend redirects to Google OAuth (`/auth/google`)
3. Google redirects back to `/auth/callback?code=...`
4. Backend exchanges code, upserts user in MongoDB, issues a JWT
5. Frontend stores JWT in `localStorage` as `gs_token`, calls `/auth/me`, redirects by role:
   - `admin` → `/teacher` (plus ⚙ Admin link in sidebar)
   - `instructor` → `/teacher`
   - `student` → `/student`

First sign-in role assignment:
- Email matches `ADMIN_EMAIL` → `admin`
- Otherwise → `student` (instructor role must be granted by admin)

### Role: Admin

- Lands on the teacher dashboard (can do everything an instructor can)
- Sidebar shows a ⚙ **Admin** link that goes to `/admin`
- `/admin` page: table of all users with searchable name/email, role dropdown to promote/demote (cannot change own role)
- Backend guards: `PATCH /admin/users/:id/role`, `GET /admin/users`

### Role: Instructor

Dashboard at `/teacher`:
- Course cards with coloured banners (colour is deterministic per course ID)
- **Create Course** button opens an inline form
- Each card has a visible **Delete** button — deletes the course, all its groups, assignments, and submissions but does NOT delete student user accounts

Course detail at `/teacher/classes/:id`:
- `[← Courses]` button + course name in the header
- Three tabs: **Assignments**, **Grades**, **Groups**

**Assignments tab:**
- Create assignment: title, instructions, date-picker for due date, optional file attachment (stored in `backend/uploads/`, served via `GET /assignments/:id/attachment`)
- Each assignment card has **Edit** and **Delete** buttons
- Edit opens an inline form; attachment can be replaced or removed
- Delete has a confirmation dialog
- Submissions expand in a panel below each assignment (own bordered row, click to toggle)
- Each submission shows group name, submitted time, "Open doc" link, and a **Contribution report** button

**Grades tab:**
- Gradebook-style table: students as rows, assignments as columns
- Each cell shows:
  - `—` — student has no group
  - `Not submitted` — group hasn't submitted
  - `Generate` button — submitted but no report yet; clicking it calls the contribution engine
  - Score % with a colour-coded bar (blue ≥50%, orange ≥25%, red <25%)

**Groups tab (formerly People & Groups):**
- Groups section: chips showing group name + member count, × to delete a group (students become unassigned)
- Create group: text field + button
- Students section:
  - Manual add: Name + Email inputs + **+ Add Student** button — adds a single student immediately. If the email already exists in the system, reuses that user record (no duplicate). If already enrolled in this class, reports "Already enrolled."
  - **Import CSV** button — parses Canvas export or any CSV with `name`/`email` columns
  - Student table: Name, Email, Group dropdown — changing the dropdown immediately reassigns the student
- Each instructor only sees their own classes and students (scoped by `instructor_id`). Student user records are shared globally (no duplicate accounts) but class membership is per-class, so a student added to Teacher A's class does not appear in Teacher B's class automatically.

### Role: Student

Dashboard at `/student`:
- Left panel lists enrolled courses; clicking switches the main view
- Main area shows assignments for the selected course with:
  - Title, due date (red if overdue and not submitted)
  - Instructions text
  - Attachment download link (if one was uploaded)
  - Service account sharing notice: instructs student to share their doc with the service account email before submitting
  - Submitted state: green "✓ Submitted" badge, link to open in Google Docs, embedded iframe preview, Resubmit button
  - Unsubmitted state: paste Google Docs/Slides URL + Submit button
- Right sidebar:
  - **Group panel**: group name, member list, task log (assign tasks to members), "Assign" form
  - **Coming Up**: next 5 unsubmitted assignments sorted by due date
  - **Missing**: overdue unsubmitted assignments

---

## Contribution engine

**How it works:**

1. Teacher clicks "Contribution report" on a submission
2. Backend calls `GET /contributions/:submission_id`
3. Backend loads `backend/service-account.json`, authenticates with Google as the service account
4. Calls Drive v3 `revisions.list` on the submitted document's file ID (extracted from the URL)
5. For each revision, exports as `text/plain` to get character count, attributes delta to `lastModifyingUser`
6. Score formula: `(edits × 200 + chars_added)` per user, normalised to sum to 100
7. Report is cached in `contribution_reports` collection; subsequent calls return the cache

**Prerequisite for students:** The submitted Google Doc/Slides must be shared (Viewer access) with:
`groupsync@primal-duality-497216-e7.iam.gserviceaccount.com`

If not shared, the API returns 403 and the frontend shows an error message explaining what to do.

**Grades endpoint:** `GET /contributions/grades/:class_id` returns a full matrix (all students × all assignments) with statuses (`not_submitted`, `pending`, `scored`, `no_group`, `no_contribution`) — used by the Grades tab.

---

## Email invites

Currently **disabled**. The `POST /invites` endpoint exists and accepts `{ group_id }` but immediately returns `{ sent: 0 }` without calling Resend. To re-enable, restore the Resend logic in `backend/routers/invites.py` and set `RESEND_API_KEY` in `.env`.

---

## Backend file map

| File | Routes | Notes |
|---|---|---|
| `main.py` | — | FastAPI app, CORS (localhost:3000), includes all routers |
| `config.py` | — | Loads `.env` |
| `database.py` | — | Motor async MongoDB client |
| `dependencies.py` | — | `get_current_user` JWT middleware |
| `routers/auth.py` | `GET /auth/google`, `GET /auth/callback`, `GET /auth/me` | OAuth, JWT issue |
| `routers/admin.py` | `GET /admin/users`, `PATCH /admin/users/:id/role` | Admin only |
| `routers/classes.py` | `GET/POST /classes`, `GET /classes/:id`, `GET /classes/:id/students`, `POST /classes/:id/students`, `POST /classes/:id/roster`, `DELETE /classes/:id` | Class CRUD + student management |
| `routers/groups.py` | `GET/POST /groups`, `PATCH /groups/:id`, `DELETE /groups/:id` | Group CRUD + member assignment |
| `routers/assignments.py` | `GET/POST /assignments`, `PUT /assignments/:id`, `GET /assignments/:id/attachment`, `DELETE /assignments/:id` | Assignment CRUD + file upload |
| `routers/invites.py` | `POST /invites` | No-op (disabled) |
| `routers/student.py` | `GET /student/assignments`, `GET /student/group` | Student-scoped views |
| `routers/submissions.py` | `POST /submissions`, `GET /submissions?assignment_id=` | Doc URL submission |
| `routers/tasks.py` | `POST /tasks`, `GET /tasks/:group_id` | Task distribution log |
| `routers/contributions.py` | `GET /contributions/grades/:class_id`, `GET /contributions/service-account-email`, `GET /contributions/:submission_id` | Contribution engine + grades matrix |

File attachments are stored in `backend/uploads/` (gitignored). The service account key is at `backend/service-account.json` (gitignored).

---

## MongoDB collections

| Collection | Shape |
|---|---|
| `users` | `{ _id, email, name, google_id, role: admin\|instructor\|student }` |
| `classes` | `{ _id, name, instructor_id, students: [user_id], created_at }` |
| `groups` | `{ _id, class_id, name, members: [user_id] }` |
| `assignments` | `{ _id, class_id, title, instructions, deadline, created_at, attachment_name, attachment_path }` |
| `submissions` | `{ _id, assignment_id, group_id, doc_url, submitted_at }` |
| `tasks` | `{ _id, group_id, title, assigned_to, created_by, created_at }` |
| `contribution_reports` | `{ _id, submission_id, scores: [{ user_id, name, email, edits, chars_added, score }], generated_at }` |

---

## Known gaps / next steps

- **Email invites disabled** — restore Resend integration when ready (`routers/invites.py`)
- **Google OAuth app is in testing mode** — must add each user's email to the test user list at console.cloud.google.com/auth/audience, or publish the app
- **No student removal** — there is no UI or endpoint to remove a student from a class once added
- **No assignment submission from teacher side** — teacher can see submissions but cannot submit on a group's behalf
- **Contribution report cache** — once generated, a report is cached permanently. If a student makes more edits after the report is generated, the teacher must delete the `contribution_reports` document manually in MongoDB to force a refresh (no UI for this yet)
- **Service account must be shared on each doc** — if a student forgets to share with the service account, the teacher gets an error and the student must re-share and resubmit
- **Hard-coded `localhost:8000`** — all frontend `fetch` calls point to `http://localhost:8000`. If deploying, do a find-and-replace with the actual API URL or use an env variable (`NEXT_PUBLIC_API_URL`)
- **No HTTPS** — development only; production deployment needs SSL and updated Google OAuth redirect URIs
