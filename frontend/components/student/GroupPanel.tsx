"use client"

import { useEffect, useState } from "react"
import { authHeaders, type User } from "@/lib/auth"
import { Button } from "@/components/ui/button"

interface Member {
  id: string
  name: string
  email: string
}

export interface StudentGroup {
  id: string
  name: string
  class_id: string
  class_name: string
  members: Member[]
}

interface Task {
  id: string
  title: string
  assigned_to_name: string
  created_by_name: string
  created_at: string
}

export function GroupPanel({ group, me }: { group: StudentGroup; me: User }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState("")
  const [assignee, setAssignee] = useState(me.id)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`http://localhost:8000/tasks/${group.id}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then(setTasks)
  }, [group.id])

  async function addTask(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    const res = await fetch("http://localhost:8000/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ group_id: group.id, title: title.trim(), assigned_to: assignee }),
    })
    if (res.ok) { const task = await res.json(); setTasks((prev) => [...prev, task]); setTitle("") }
    setSaving(false)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
      <div>
        <h3 className="font-semibold text-gray-900 text-sm">{group.name}</h3>
        <p className="text-xs text-gray-400">{group.class_name}</p>
      </div>

      <ul className="space-y-1">
        {group.members.map((m) => (
          <li key={m.id} className="text-sm text-gray-700 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
            <span className="truncate">
              {m.name}{m.id === me.id && <span className="text-gray-400"> (you)</span>}
            </span>
          </li>
        ))}
      </ul>

      <div className="pt-2 border-t border-gray-100 space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Task Log</h4>
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {tasks.map((t) => (
            <div key={t.id} className="text-xs bg-gray-50 rounded px-2 py-1.5">
              <p className="text-gray-800 font-medium">{t.title}</p>
              <p className="text-gray-400">→ {t.assigned_to_name} · {new Date(t.created_at).toLocaleDateString()}</p>
            </div>
          ))}
          {tasks.length === 0 && <p className="text-xs text-gray-300">No tasks logged yet.</p>}
        </div>

        <form onSubmit={addTask} className="space-y-1.5 pt-1">
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task…"
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-1.5">
            <select
              value={assignee} onChange={(e) => setAssignee(e.target.value)}
              className="flex-1 rounded border border-gray-200 px-2 py-1.5 text-xs bg-white focus:outline-none"
            >
              {group.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <Button type="submit" size="sm" disabled={saving || !title.trim()} className="text-xs px-2 py-1 h-auto">
              {saving ? "…" : "Assign"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
