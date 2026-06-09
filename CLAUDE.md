# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project: GroupSync

A classroom tool for teachers to organize students into groups, manage Google Docs/Slides-based assignments, and automatically generate contribution scores per student based on edit history.

---

## Architecture

### Tech Stack
- **Frontend**: Next.js (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- **Backend**: FastAPI (Python 3.14, venv already at `backend/.venv`)
- **Database**: MongoDB (NoSQL — stores users, roles, classes, groups, assignments, contribution reports)
- **Auth**: Google OAuth 2.0 (all users authenticate via Google; role is stored in DB)
- **Email**: Resend API (for sending student group invites)
- **External API**: Google Docs / Google Slides API (for reading edit history and calculating contribution scores)

### Roles
| Role | Access | How assigned |
|---|---|---|
| Admin | Admin Dashboard | Hardcoded to `jason.dsouza.here@gmail.com` |
| Instructor | Teacher Dashboard | Admin promotes a user via Admin Dashboard |
| Student | Student Dashboard | Invited by Instructor via email |

### Core Data Models (MongoDB collections)
- **users** — `{ _id, email, name, role: admin|instructor|student, google_id }`
- **classes** — `{ _id, name, instructor_id, students: [user_id], created_at }`
- **groups** — `{ _id, class_id, name, members: [user_id] }`
- **assignments** — `{ _id, class_id, title, instructions, deadline, created_at }`
- **submissions** — `{ _id, assignment_id, group_id, doc_url, submitted_at }`
- **contribution_reports** — `{ _id, submission_id, scores: [{ user_id, score }], generated_at }`

### Contribution Score Algorithm
Triggered when a teacher views a group's submission. Backend calls the Google Docs/Slides API to fetch revision history. Each revision is attributed to an author; scores are weighted by edit count and character delta per user, normalized to 100.

---

## Feature Breakdown & Build Order

### Phase 1 — Foundation
- [ ] Backend: FastAPI app scaffold, MongoDB connection, env config (`.env`)
- [ ] Backend: Google OAuth routes (`/auth/google`, `/auth/callback`, `/auth/me`)
- [ ] Backend: JWT session middleware
- [ ] Frontend: Next.js scaffold with Tailwind + shadcn/ui
- [ ] Frontend: Google Sign-In flow, session cookie handling, role-based redirect

### Phase 2 — Admin Dashboard
- [ ] Backend: `GET /admin/users` — list all users; `PATCH /admin/users/:id/role` — set role
- [ ] Frontend: Admin page (`/admin`) — table of all users with role dropdown (instructor/student)
- [ ] Guard: only accessible to `jason.dsouza.here@gmail.com`

### Phase 3 — Teacher Dashboard
- [ ] Backend: `POST /classes`, `GET /classes`, class CRUD
- [ ] Backend: CSV roster import endpoint — parses Canvas export, creates student user records
- [ ] Backend: `POST /classes/:id/groups`, drag-and-drop group assignment endpoints
- [ ] Backend: `POST /invites` — sends group invite emails via Resend API
- [ ] Backend: Assignment CRUD (`POST /assignments`, `GET /assignments/:class_id`)
- [ ] Frontend: Teacher dashboard — class list, create class, upload roster
- [ ] Frontend: Group organizer — drag-and-drop students across groups (dnd-kit)
- [ ] Frontend: Assignment creation form with deadline picker
- [ ] Frontend: Send invites button

### Phase 4 — Student Dashboard
- [ ] Backend: `GET /student/assignments` — assignments for the student's class
- [ ] Backend: `GET /student/group` — group members for the logged-in student
- [ ] Backend: `POST /submissions` — submit Google Doc/Slides URL for a group assignment
- [ ] Backend: Task distribution log — `POST /tasks`, `GET /tasks/:group_id`
- [ ] Frontend: Student dashboard — assignment list, group members panel
- [ ] Frontend: Task distribution UI — assign tasks to members, log shown to all group members
- [ ] Frontend: Submission — paste Google Doc/Slides URL, embedded iframe preview

### Phase 5 — Contribution Engine
- [ ] Backend: Google Docs API integration — fetch revision history for a doc
- [ ] Backend: Google Slides API integration — fetch revision history for a presentation
- [ ] Backend: Contribution score algorithm — normalize edits per user to 0–100
- [ ] Backend: `GET /contributions/:submission_id` — trigger scoring, return/cache report
- [ ] Frontend: Teacher contribution view — per-group, per-student score breakdown with visual bar

---

## Key External Services
- **Google OAuth**: needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, redirect URI
- **Google Docs/Slides API**: needs service account or OAuth scope `drive.readonly` + `docs.readonly`
- **Resend**: needs `RESEND_API_KEY`
- **MongoDB**: needs `MONGODB_URI`

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
