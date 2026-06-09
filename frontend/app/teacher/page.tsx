"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchMe, clearToken, authHeaders, type User } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import Link from "next/link"

interface Class {
  id: string
  name: string
  student_count: number
}

export default function TeacherDashboard() {
  const router = useRouter()
  const [me, setMe] = useState<User | null>(null)
  const [classes, setClasses] = useState<Class[]>([])
  const [newName, setNewName] = useState("")
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u || u.role !== "instructor") { router.replace("/"); return }
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
      setNewName("")
    }
    setCreating(false)
  }

  if (!me) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-6">

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Teacher Dashboard</h1>
            <p className="text-sm text-gray-500 mt-1">{me.email}</p>
          </div>
          <button onClick={() => { clearToken(); router.replace("/") }} className="text-sm text-gray-500 hover:text-gray-800">
            Sign out
          </button>
        </div>

        {/* Create class */}
        <form onSubmit={createClass} className="flex gap-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New class name…"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <Button type="submit" disabled={creating || !newName.trim()} size="sm">
            {creating ? "Creating…" : "Create Class"}
          </Button>
        </form>

        {/* Class list */}
        <div className="grid gap-4">
          {classes.map((cls) => (
            <Link
              key={cls.id}
              href={`/teacher/classes/${cls.id}`}
              className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-6 py-4 shadow-sm hover:shadow-md transition-shadow"
            >
              <span className="font-semibold text-gray-900">{cls.name}</span>
              <span className="text-sm text-gray-400">{cls.student_count} students →</span>
            </Link>
          ))}
          {classes.length === 0 && (
            <p className="text-center py-12 text-gray-400 text-sm">No classes yet. Create one above.</p>
          )}
        </div>

      </div>
    </main>
  )
}
