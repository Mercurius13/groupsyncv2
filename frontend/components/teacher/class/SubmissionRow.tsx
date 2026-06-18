"use client"

import { useState } from "react"
import { authHeaders } from "@/lib/auth"
import { Button } from "@/components/ui/button"

export interface TeacherSubmission {
  id: string
  group_id: string
  group_name: string
  doc_url: string
  submitted_at: string
}

interface Score {
  user_id: string | null
  name: string
  email: string
  edits: number
  chars_added: number
  score: number
}

export function SubmissionRow({ submission }: { submission: TeacherSubmission }) {
  const [scores, setScores] = useState<Score[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadReport() {
    setLoading(true); setError(null)
    const res = await fetch(`http://localhost:8000/contributions/${submission.id}`, { headers: authHeaders() })
    if (res.ok) setScores((await res.json()).scores)
    else setError((await res.json().catch(() => null))?.detail ?? "Failed to generate report")
    setLoading(false)
  }

  return (
    <div className="rounded-lg bg-white border border-gray-200 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-800">{submission.group_name}</p>
          <p className="text-xs text-gray-400">Submitted {new Date(submission.submitted_at).toLocaleString()}</p>
        </div>
        <div className="flex gap-3 items-center">
          <a href={submission.doc_url} target="_blank" rel="noreferrer"
            className="text-xs text-blue-500 hover:text-blue-700 whitespace-nowrap">Open doc ↗</a>
          {!scores && (
            <Button size="sm" variant="outline" onClick={loadReport} disabled={loading}>
              {loading ? "Analysing…" : "Contribution report"}
            </Button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {scores && (
        <div className="space-y-1.5 pt-1">
          {scores.map((s) => (
            <div key={s.email} className="flex items-center gap-3">
              <span className="w-36 truncate text-xs text-gray-600" title={s.email}>{s.name}</span>
              <div className="flex-1 h-3 rounded-full bg-gray-200 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${s.score}%`, backgroundColor: "#1B8CC4" }} />
              </div>
              <span className="w-12 text-right text-xs font-semibold text-gray-700">{s.score}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
