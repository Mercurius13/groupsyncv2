"use client"

import { useRef, useState } from "react"
import { authHeaders } from "@/lib/auth"
import { AttachmentPicker } from "./AttachmentPicker"
import { AttachmentPreview } from "@/components/AttachmentPreview"
import { SubmissionRow, type TeacherSubmission } from "./SubmissionRow"

export interface TeacherAssignment {
  id: string
  title: string
  instructions: string
  deadline: string
  attachment_name?: string | null
  attachment_url?: string | null
}

export function AssignmentCard({ assignment, onUpdated, onDeleted }: {
  assignment: TeacherAssignment
  onUpdated: (a: TeacherAssignment) => void
  onDeleted: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [submissions, setSubmissions] = useState<TeacherSubmission[] | null>(null)

  const [title, setTitle] = useState(assignment.title)
  const [instructions, setInstructions] = useState(assignment.instructions)
  const [deadline, setDeadline] = useState(assignment.deadline.split("T")[0])
  const [file, setFile] = useState<File | null>(null)
  const [removeExisting, setRemoveExisting] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const overdue = new Date(assignment.deadline) < new Date()

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && submissions === null) {
      const res = await fetch(`http://localhost:8000/submissions?assignment_id=${assignment.id}`, { headers: authHeaders() })
      setSubmissions(res.ok ? await res.json() : [])
    }
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const form = new FormData()
    form.append("title", title)
    form.append("instructions", instructions)
    form.append("deadline", deadline)
    form.append("remove_attachment", String(removeExisting && !file))
    if (file) form.append("file", file)
    const res = await fetch(`http://localhost:8000/assignments/${assignment.id}`, {
      method: "PUT", headers: authHeaders(), body: form,
    })
    if (res.ok) {
      onUpdated(await res.json())
      setEditing(false); setFile(null); setRemoveExisting(false)
    }
    setSaving(false)
  }

  async function deleteAssignment() {
    if (!confirm(`Delete "${assignment.title}"?\n\nThis will also remove all submissions for this assignment.`)) return
    await fetch(`http://localhost:8000/assignments/${assignment.id}`, { method: "DELETE", headers: authHeaders() })
    onDeleted(assignment.id)
  }

  if (editing) {
    return (
      <form onSubmit={saveEdit} className="bg-white rounded-xl border border-blue-200 p-6 space-y-4 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-blue-700">Editing assignment</p>
          <button type="button" onClick={() => { setEditing(false); setFile(null); setRemoveExisting(false) }}
            className="text-gray-400 hover:text-gray-700 text-lg leading-none">×</button>
        </div>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={4} required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none" />
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Due date</label>
            <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} required
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500 font-medium">Attachment</label>
            <AttachmentPicker
              file={file} onChange={setFile} inputRef={fileRef}
              existingName={removeExisting ? null : assignment.attachment_name}
              onRemoveExisting={() => setRemoveExisting(true)}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <button type="submit" disabled={saving}
            className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: "#1B8CC4" }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
          <button type="button" onClick={() => { setEditing(false); setFile(null); setRemoveExisting(false) }}
            className="px-5 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900">{assignment.title}</h3>
            <p className={`text-xs mt-0.5 ${overdue ? "text-red-500" : "text-gray-400"}`}>
              Due {new Date(assignment.deadline).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={() => setEditing(true)}
              className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
              Edit
            </button>
            <button onClick={deleteAssignment}
              className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-red-400 hover:text-red-600 transition-colors">
              Delete
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{assignment.instructions}</p>
        {assignment.attachment_name && assignment.attachment_url && (
          <AttachmentPreview name={assignment.attachment_name} url={assignment.attachment_url} />
        )}
      </div>

      <div className="border-t border-gray-100 px-6 py-3">
        <button onClick={toggle} className="text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center gap-1.5">
          <span>{open ? "▾" : "▸"}</span>
          <span>Submissions{submissions !== null ? ` (${submissions.length})` : ""}</span>
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-6 py-4 space-y-3">
          {submissions === null && <p className="text-sm text-gray-400">Loading…</p>}
          {submissions?.map((s) => <SubmissionRow key={s.id} submission={s} />)}
          {submissions?.length === 0 && <p className="text-sm text-gray-400">No submissions yet.</p>}
        </div>
      )}
    </div>
  )
}
