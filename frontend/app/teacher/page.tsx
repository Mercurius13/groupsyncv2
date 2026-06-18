"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchMe, authHeaders, type User } from "@/lib/auth"
import { Sidebar } from "@/components/sidebar"
import { ClassCard, type ClassItem } from "@/components/teacher/ClassCard"

export default function TeacherDashboard() {
  const router = useRouter()
  const [me, setMe] = useState<User | null>(null)
  const [classes, setClasses] = useState<ClassItem[]>([])
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u || (u.role !== "instructor" && u.role !== "admin")) { router.replace("/"); return }
      setMe(u)
      loadClasses()
    })
  }, [router])

  async function loadClasses() {
    const res = await fetch("http://localhost:8000/classes", { headers: authHeaders() })
    if (res.ok) setClasses(await res.json())
  }

  async function createClass(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    const res = await fetch("http://localhost:8000/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (res.ok) {
      const cls = await res.json()
      setClasses((prev) => [cls, ...prev])
      setNewName(""); setShowForm(false)
    }
    setCreating(false)
  }

  async function deleteClass(id: string, name: string) {
    if (!confirm(`Delete "${name}"? This will remove all assignments and groups but not the students.`)) return
    await fetch(`http://localhost:8000/classes/${id}`, { method: "DELETE", headers: authHeaders() })
    setClasses((prev) => prev.filter((c) => c.id !== id))
  }

  if (!me) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  return (
    <div className="flex min-h-screen bg-gray-100">
    <Sidebar role={me.role} userName={me.name || me.email} />
    <div className="ml-20 flex-1 min-h-screen">
      <div className="bg-white border-b border-gray-200 px-8 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
            <p className="text-sm text-gray-500">{me.email}</p>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ backgroundColor: "#1B8CC4" }}
          >
            + Create Course
          </button>
        </div>

        {showForm && (
          <form onSubmit={createClass} className="mt-4 flex gap-3 max-w-md">
            <input
              autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
              placeholder="Course name…"
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2"
              style={{ "--tw-ring-color": "#1B8CC4" } as React.CSSProperties}
            />
            <button type="submit" disabled={creating || !newName.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 transition-colors"
              style={{ backgroundColor: "#1B8CC4" }}>
              {creating ? "Creating…" : "Create"}
            </button>
            <button type="button" onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">
              Cancel
            </button>
          </form>
        )}
      </div>

      <div className="p-8">
        {classes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <div className="text-5xl mb-4">📚</div>
            <p className="text-lg font-medium text-gray-500">No courses yet</p>
            <p className="text-sm mt-1">Click &ldquo;Create Course&rdquo; to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {classes.map((cls) => (
              <ClassCard key={cls.id} cls={cls} onDelete={deleteClass} />
            ))}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
