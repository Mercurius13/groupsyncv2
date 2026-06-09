# GroupSync — Handover

## What is this

A classroom tool for teachers to organise students into groups, manage Google Docs/Slides assignments, and auto-generate contribution scores per student from edit history.

**Three roles:** Admin (`jason.dsouza.here@gmail.com` only) → Instructor → Student.

---

## How to run it

### Prerequisites
- Python 3.14 (venv already exists at `backend/.venv`)
- Node.js / npm (frontend already has `node_modules`)
- MongoDB running locally on port 27017 — start it with:
  ```bash
  brew services start mongodb-community
  # or
  mongod --dbpath /usr/local/var/mongodb
  ```
- Google OAuth redirect URI `http://localhost:8000/auth/callback` must be added to your Google Cloud Console OAuth credentials (Authorised Redirect URIs)

### Start the backend
```bash
cd backend
.venv/bin/uvicorn main:app --reload
# Runs on http://localhost:8000
```

### Start the frontend
```bash
cd frontend
npm run dev
# Runs on http://localhost:3000
```

### Environment variables (`.env` in repo root)
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
JWT_SECRET=...
ADMIN_EMAIL=jason.dsouza.here@gmail.com
MONGODB_URI=mongodb://localhost:27017/groupsync
```

---

## Current state — what's built

### Phase 1 — Foundation ✅ DONE

**Backend (`backend/`)**

| File | What it does |
|---|---|
| `main.py` | FastAPI app, CORS set to allow `localhost:3000` |
| `config.py` | Loads all env vars from `../.env` |
| `database.py` | Motor async MongoDB client, `db` = `groupsync` database |
| `routers/auth.py` | All auth routes (see below) |
| `requirements.txt` | Pinned deps |

**Auth routes**

| Route | What it does |
|---|---|
| `GET /auth/google` | Redirects browser to Google OAuth consent screen |
| `GET /auth/callback?code=...` | Exchanges code for token, creates user in MongoDB if new, issues JWT, redirects to `localhost:3000/auth/callback?token=...` |
| `GET /auth/me` | Reads `Authorization: Bearer <token>`, returns `{ id, email, name, role }` |

First-time sign-in logic:
- If email == `ADMIN_EMAIL` → role = `admin`
- Otherwise → role = `student` (instructor role must be granted by admin in Phase 2)

**Frontend (`frontend/`)**

| File | What it does |
|---|---|
| `app/page.tsx` | Login page — "Sign in with Google" button → hits `/auth/google` |
| `app/auth/callback/page.tsx` | Receives `?token=` from backend, stores in `localStorage`, calls `/auth/me`, redirects to role dashboard |
| `app/admin/page.tsx` | Admin dashboard stub — guards for `role === admin` |
| `app/teacher/page.tsx` | Teacher dashboard stub — guards for `role === instructor` |
| `app/student/page.tsx` | Student dashboard stub — guards for `role === student` |
| `lib/auth.ts` | `getToken`, `setToken`, `clearToken`, `fetchMe`, `roleDashboard` helpers |
| `lib/utils.ts` | `cn()` utility for Tailwind class merging |
| `components/ui/button.tsx` | shadcn/ui Button component |

Token storage: JWT lives in `localStorage` as `gs_token`. All API calls send `Authorization: Bearer <token>`.

---

## What's left — phases 2–5

### Phase 2 — Admin Dashboard
Backend:
- `GET /admin/users` — list all users from MongoDB
- `PATCH /admin/users/:id/role` — update a user's role (admin only)

Frontend:
- `/admin` page: table of all users, dropdown to set role to `instructor` or `student`
- Guard: 403 if not `admin`

---

### Phase 3 — Teacher Dashboard
Backend:
- `POST /classes`, `GET /classes` — class CRUD (instructor scoped)
- `POST /classes/:id/roster` — CSV upload (Canvas export format), bulk-creates student user records
- `GET /classes/:id/students` — list students in a class
- `POST /classes/:id/groups`, `PATCH /groups/:id` — group CRUD, assign students to groups
- `POST /invites` — sends invite emails via Resend API (`RESEND_API_KEY` needed)
- `POST /assignments`, `GET /assignments/:class_id` — assignment CRUD

Frontend:
- `/teacher` — class list, create class button
- `/teacher/classes/:id` — class detail: roster view, group organiser (drag-and-drop via `dnd-kit`), assignment list
- Group organiser: drag students between group columns
- Assignment form: title, instructions (textarea), deadline (date picker)
- "Send Invites" button per group

Env var needed: `RESEND_API_KEY`

---

### Phase 4 — Student Dashboard
Backend:
- `GET /student/assignments` — assignments for the logged-in student's class
- `GET /student/group` — group members for logged-in student
- `POST /submissions` — `{ assignment_id, doc_url }` — submit Google Doc/Slides URL
- `POST /tasks`, `GET /tasks/:group_id` — task distribution log (who is doing what)

Frontend:
- `/student` — assignment list + group members panel
- Task distribution UI: assign tasks to group members, visible to all members
- Submission: paste Google Doc/Slides URL → show embedded iframe preview

---

### Phase 5 — Contribution Engine
Backend:
- Google Docs API integration — fetch revision history for a doc URL
- Google Slides API integration — same for presentations
- Algorithm: count edits + character delta per user, normalise to 0–100
- `GET /contributions/:submission_id` — triggers scoring on first call, caches result in `contribution_reports` collection

Frontend:
- Teacher view per group submission: horizontal bar chart showing each student's score

Env var needed: Google service account credentials or `drive.readonly` + `docs.readonly` OAuth scope added to the existing OAuth flow.

---

## MongoDB collections (all in `groupsync` db)

| Collection | Shape |
|---|---|
| `users` | `{ _id, email, name, google_id, role: admin\|instructor\|student }` |
| `classes` | `{ _id, name, instructor_id, students: [user_id], created_at }` |
| `groups` | `{ _id, class_id, name, members: [user_id] }` |
| `assignments` | `{ _id, class_id, title, instructions, deadline, created_at }` |
| `submissions` | `{ _id, assignment_id, group_id, doc_url, submitted_at }` |
| `contribution_reports` | `{ _id, submission_id, scores: [{ user_id, score }], generated_at }` |
