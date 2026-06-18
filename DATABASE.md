# GroupSync Database

NoSQL (MongoDB) — stores all users, roles, classes, groups, assignments, submissions, tasks, and contribution reports.

---

## How to start MongoDB

MongoDB is installed as a binary tarball at `~/.local/groupsync-mongo` (Homebrew won't install on this machine due to outdated Xcode CLT).

```bash
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongod \
  --dbpath ~/.local/groupsync-mongo/data \
  --fork \
  --logpath ~/.local/groupsync-mongo/mongod.log
```

- `--fork` runs it as a background daemon so the terminal is free
- Listens on `localhost:27017` (default)
- Log output goes to `~/.local/groupsync-mongo/mongod.log`
- Data is persisted at `~/.local/groupsync-mongo/data`

**Check it started:**
```bash
curl -s http://localhost:8000/health
# Returns {"status":"ok"} if backend is also running
```

**To stop MongoDB:**
```bash
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongod \
  --dbpath ~/.local/groupsync-mongo/data --shutdown
```

**To connect with the Mongo shell:**
```bash
~/.local/groupsync-mongo/mongodb-macos-aarch64--8.0.24/bin/mongosh
# Then: use groupsync
```

---

## Collections

| Collection | What's in it |
|---|---|
| `users` | `{ _id, email, name, google_id, role: admin\|instructor\|student }` |
| `classes` | `{ _id, name, instructor_id, students: [user_id], created_at }` |
| `groups` | `{ _id, class_id, name, members: [user_id] }` |
| `assignments` | `{ _id, class_id, title, instructions, deadline, created_at, attachment_name, attachment_path }` |
| `submissions` | `{ _id, assignment_id, group_id, doc_url, submitted_at }` |
| `tasks` | `{ _id, group_id, title, assigned_to, created_by, created_at }` |
| `contribution_reports` | `{ _id, submission_id, scores: [{ user_id, name, email, edits, chars_added, score }], generated_at }` |

Connection string (in `.env`): `MONGODB_URI=mongodb://localhost:27017/groupsync`