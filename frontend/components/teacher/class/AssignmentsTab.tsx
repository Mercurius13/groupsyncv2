"use client"

import { useRef, useState } from "react"
import { authHeaders } from "@/lib/auth"
import { AttachmentPicker } from "./AttachmentPicker"
import { AssignmentCard, type TeacherAssignment } from "./AssignmentCard"

export function AssignmentsTab({
  classId, assignments, onCreated, onUpdated, onDeleted,
}: {
  classId: string
  assignments: TeacherAssignment[]
  onCreated: (a: TeacherAssignment) => void
  onUpdated: (a: TeacherAssignment) => void
  onDeleted: (id: string) => void
}) {
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState("")
  const [instructions, setInstructions] = useState("")
  const [deadline, setDeadline] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const form = new FormData()
    form.append("class_id", classId)
    form.append("title", title)
    form.append("instructions", instructions)
    form.append("deadline", deadline)
    if (file) form.append("file", file)
    const res = await fetch("http://localhost:8000/assignments", {
      method: "POST", headers: authHeaders(), body: form,
    })
    if (res.ok) {
      onCreated(await res.json())
      setTitle(""); setInstructions(""); setDeadline(""); setFile(null)
      if (fileRef.current) fileRef.current.value = ""
      setShowForm(false)
    }
    setSaving(false)
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Assignments</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white"
          style={{ backgroundColor: "#1B8CC4" }}
        >
          {showForm ? "Cancel" : "+ New Assignment"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4 shadow-sm">
          <input
            autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Assignment title" required
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <textarea
            value={instructions} onChange={(e) => setInstructions(e.target.value)}
            placeholder="Instructions for students…" rows={4} required
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
          />
          <div className="flex flex-wrap items-start gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Due date</label>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} required
                className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500 font-medium">Attachment</label>
              <AttachmentPicker file={file} onChange={setFile} inputRef={fileRef} />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={saving}
              className="px-5 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "#1B8CC4" }}>
              {saving ? "Saving…" : "Create Assignment"}
            </button>
            <button type="button" onClick={() => setShowForm(false)}
              className="px-5 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">
              Cancel
            </button>
          </div>
        </form>
      )}

      {assignments.length === 0 && !showForm && (
        <div className="text-center py-16 text-gray-400">
          <div className="text-4xl mb-3">📋</div>
          <p>No assignments yet. Click &ldquo;New Assignment&rdquo; to create one.</p>
        </div>
      )}

      {assignments.map((a) => (
        <AssignmentCard key={a.id} assignment={a} onUpdated={onUpdated} onDeleted={onDeleted} />
      ))}
    </div>
  )
}
