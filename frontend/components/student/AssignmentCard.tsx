"use client"

import { useState } from "react"
import { authHeaders } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { AttachmentPreview } from "@/components/AttachmentPreview"

export interface StudentAssignment {
  id: string
  class_id: string
  class_name: string
  title: string
  instructions: string
  deadline: string
  attachment_name?: string | null
  attachment_url?: string | null
  submission: { id: string; doc_url: string; submitted_at: string } | null
}

function previewUrl(docUrl: string): string {
  const m = docUrl.match(/^https:\/\/docs\.google\.com\/(document|presentation)\/d\/([a-zA-Z0-9_-]+)/)
  return m ? `https://docs.google.com/${m[1]}/d/${m[2]}/preview` : docUrl
}

export function AssignmentCard({ assignment, onSubmitted }: {
  assignment: StudentAssignment
  onSubmitted: () => void
}) {
  const [url, setUrl] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resubmitting, setResubmitting] = useState(false)

  const overdue = new Date(assignment.deadline) < new Date()
  const sub = assignment.submission

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError(null)
    const res = await fetch("http://localhost:8000/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ assignment_id: assignment.id, doc_url: url.trim() }),
    })
    if (res.ok) {
      setUrl(""); setResubmitting(false); onSubmitted()
    } else {
      setError((await res.json().catch(() => null))?.detail ?? "Submission failed")
    }
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4">
        <div className="flex justify-between items-start gap-4">
          <h3 className="font-semibold text-gray-900">{assignment.title}</h3>
          <span className={`text-xs whitespace-nowrap ${overdue && !sub ? "text-red-500 font-medium" : "text-gray-400"}`}>
            {overdue && !sub ? "Overdue · " : "Due "}
            {new Date(assignment.deadline).toLocaleDateString()}
          </span>
        </div>
        <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{assignment.instructions}</p>
        {assignment.attachment_name && assignment.attachment_url && (
          <AttachmentPreview name={assignment.attachment_name} url={assignment.attachment_url} />
        )}
      </div>

      <div className="px-6 pb-5 border-t border-gray-100 pt-4">
        {sub && !resubmitting ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-green-600 font-semibold">✓ Submitted {new Date(sub.submitted_at).toLocaleString()}</span>
              <div className="flex gap-3">
                <a href={sub.doc_url} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:text-blue-700">Open in Google Docs ↗</a>
                <button onClick={() => setResubmitting(true)} className="text-xs text-gray-400 hover:text-gray-700">Resubmit</button>
              </div>
            </div>
            <iframe
              src={previewUrl(sub.doc_url)}
              className="w-full h-72 rounded-lg border border-gray-200"
              title={`Submission for ${assignment.title}`}
            />
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-2">
            <div className="flex gap-2">
              <input
                value={url} onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste Google Docs or Slides URL…" required
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
              <Button type="submit" size="sm" disabled={saving || !url.trim()}>
                {saving ? "Submitting…" : "Submit"}
              </Button>
              {resubmitting && (
                <Button type="button" size="sm" variant="outline" onClick={() => { setResubmitting(false); setError(null) }}>Cancel</Button>
              )}
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </form>
        )}
      </div>
    </div>
  )
}
