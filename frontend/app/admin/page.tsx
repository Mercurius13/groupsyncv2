"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchMe, authHeaders, type User } from "@/lib/auth"
import { Sidebar } from "@/components/sidebar"

type Role = "admin" | "instructor" | "student"

const ROLE_STYLES: Record<Role, string> = {
  admin:      "bg-purple-100 text-purple-800 border-purple-300",
  instructor: "bg-blue-100   text-blue-800   border-blue-300",
  student:    "bg-gray-100   text-gray-800   border-gray-300",
}

interface DBUser {
  id: string
  email: string
  name: string
  role: Role
}

export default function AdminDashboard() {
  const router = useRouter()
  const [me, setMe] = useState<User | null>(null)
  const [users, setUsers] = useState<DBUser[]>([])
  const [saving, setSaving] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u || u.role !== "admin") { router.replace("/"); return }
      setMe(u)
      loadUsers()
    })
  }, [router])

  async function loadUsers() {
    const res = await fetch("http://localhost:8000/admin/users", { headers: authHeaders() })
    if (res.ok) setUsers(await res.json())
  }

  async function changeRole(userId: string, role: Role) {
    setSaving(userId)
    await fetch(`http://localhost:8000/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ role }),
    })
    setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role } : u))
    setSaving(null)
  }

  const filtered = query.trim()
    ? users.filter((u) => {
        const q = query.toLowerCase()
        return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
      })
    : users

  if (!me) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  return (
    <div className="flex min-h-screen bg-gray-100">
    <Sidebar role="admin" userName={me.name || me.email} />
    <div className="ml-20 flex-1 min-h-screen">
      {/* Top bar */}
      <div className="bg-white border-b border-gray-200 px-8 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Admin</h1>
        <p className="text-sm text-gray-500">{me.email}</p>
      </div>

      <div className="p-8 max-w-4xl space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
            <h2 className="font-semibold text-gray-800">All Users ({filtered.length})</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 w-64"
            />
          </div>

          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
              <tr>
                <th className="px-6 py-3 text-left">Name</th>
                <th className="px-6 py-3 text-left">Email</th>
                <th className="px-6 py-3 text-left">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-gray-900">{u.name}</td>
                  <td className="px-6 py-3 text-gray-500">{u.email}</td>
                  <td className="px-6 py-3">
                    <select
                      value={u.role}
                      disabled={saving === u.id || u.email === me.email}
                      onChange={(e) => changeRole(u.id, e.target.value as Role)}
                      className={`rounded-md border px-2 py-1 text-sm font-medium cursor-pointer
                        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-blue-400
                        disabled:opacity-50 disabled:cursor-not-allowed
                        ${ROLE_STYLES[u.role]}`}
                    >
                      <option value="student"    className="bg-white text-gray-900">Student</option>
                      <option value="instructor" className="bg-white text-gray-900">Instructor</option>
                      <option value="admin"      className="bg-white text-gray-900">Admin</option>
                    </select>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-6 py-8 text-center text-gray-400">
                    {query.trim() ? "No users match your search" : "No users yet"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    </div>
  )
}
