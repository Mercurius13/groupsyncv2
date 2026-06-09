"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchMe, clearToken, type User } from "@/lib/auth"

export default function StudentDashboard() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me || me.role !== "student") { router.replace("/"); return }
      setUser(me)
    })
  }, [router])

  if (!user) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Student Dashboard</h1>
          <button
            onClick={() => { clearToken(); router.replace("/") }}
            className="text-sm text-gray-500 hover:text-gray-800"
          >
            Sign out
          </button>
        </div>
        <p className="text-gray-500">Welcome, {user.name}. Assignments and groups coming in Phase 4.</p>
      </div>
    </main>
  )
}
