"use client"

import { useEffect, useState } from "react"
import { authHeaders } from "@/lib/auth"

interface GradeCell {
  status: "not_submitted" | "pending" | "scored" | "no_group" | "no_contribution"
  value?: number
  submission_id?: string
}

interface GradesData {
  assignments: { id: string; title: string; deadline: string }[]
  students: { id: string; name: string; email: string; scores: Record<string, GradeCell> }[]
}

function GradeCellView({ cell, onGenerate, loading }: {
  cell: GradeCell | undefined
  onGenerate: (id: string) => void
  loading: string | null
}) {
  if (!cell || cell.status === "no_group") return <span className="text-xs text-gray-300">—</span>
  if (cell.status === "not_submitted") return <span className="text-xs text-gray-400 italic">Not submitted</span>
  if (cell.status === "no_contribution") return <span className="text-xs text-gray-400">0%</span>
  if (cell.status === "pending") {
    const isLoading = loading === cell.submission_id
    return (
      <button onClick={() => onGenerate(cell.submission_id!)} disabled={isLoading || loading !== null}
        className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:opacity-50 transition-colors">
        {isLoading ? "…" : "Generate"}
      </button>
    )
  }
  if (cell.status === "scored" && cell.value !== undefined) {
    const pct = cell.value
    const color = pct >= 50 ? "#1B8CC4" : pct >= 25 ? "#E66000" : "#C1121F"
    return (
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm font-semibold" style={{ color }}>{pct}%</span>
        <div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
        </div>
      </div>
    )
  }
  return null
}

export function GradesTab({ classId }: { classId: string }) {
  const [data, setData] = useState<GradesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<string | null>(null)

  useEffect(() => {
    fetch(`http://localhost:8000/contributions/grades/${classId}`, { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { setData(d); setLoading(false) })
  }, [classId])

  async function generateReport(submissionId: string) {
    setGenerating(submissionId)
    await fetch(`http://localhost:8000/contributions/${submissionId}`, { headers: authHeaders() })
    const r = await fetch(`http://localhost:8000/contributions/grades/${classId}`, { headers: authHeaders() })
    if (r.ok) setData(await r.json())
    setGenerating(null)
  }

  if (loading) return <div className="text-sm text-gray-400 py-8">Loading grades…</div>
  if (!data) return <div className="text-sm text-red-400 py-8">Failed to load grades.</div>
  if (data.assignments.length === 0) return (
    <div className="text-center py-16 text-gray-400">
      <div className="text-4xl mb-3">📊</div>
      <p>No assignments yet.</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Contribution Grades</h2>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="px-5 py-3 text-left font-semibold text-gray-700 w-48">Student</th>
              {data.assignments.map((a) => (
                <th key={a.id} className="px-4 py-3 text-center font-semibold text-gray-700 min-w-36">
                  <div className="truncate max-w-36">{a.title}</div>
                  <div className="text-xs font-normal text-gray-400">Due {new Date(a.deadline).toLocaleDateString()}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.students.map((student) => (
              <tr key={student.id} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <p className="font-medium text-gray-900 truncate">{student.name}</p>
                  <p className="text-xs text-gray-400 truncate">{student.email}</p>
                </td>
                {data.assignments.map((a) => (
                  <td key={a.id} className="px-4 py-3 text-center">
                    <GradeCellView cell={student.scores[a.id]} onGenerate={generateReport} loading={generating} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
