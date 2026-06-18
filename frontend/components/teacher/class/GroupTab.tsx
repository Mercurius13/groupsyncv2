"use client"

import { useRef, useState } from "react"
import { authHeaders } from "@/lib/auth"

export interface GroupMember {
  id: string
  name: string
  email: string
}

export interface ClassGroup {
  id: string
  name: string
  class_id: string
  members: GroupMember[]
}

export function GroupTab({
  classId, students, groups, onGroupsChanged, onUploaded,
}: {
  classId: string
  students: GroupMember[]
  groups: ClassGroup[]
  onGroupsChanged: () => void
  onUploaded: () => void
}) {
  const [newGroupName, setNewGroupName] = useState("")
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ added: number; total: number } | null>(null)
  const [assigning, setAssigning] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [addName, setAddName] = useState("")
  const [addEmail, setAddEmail] = useState("")
  const [addingStudent, setAddingStudent] = useState(false)
  const [addResult, setAddResult] = useState<string | null>(null)

  const studentGroupMap: Record<string, string> = {}
  for (const g of groups) {
    for (const m of g.members) studentGroupMap[m.id] = g.id
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault()
    if (!newGroupName.trim()) return
    setCreatingGroup(true)
    const res = await fetch("http://localhost:8000/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ class_id: classId, name: newGroupName.trim() }),
    })
    if (res.ok) { await onGroupsChanged(); setNewGroupName("") }
    setCreatingGroup(false)
  }

  async function deleteGroup(groupId: string, name: string) {
    if (!confirm(`Delete group "${name}"? Students will become unassigned.`)) return
    await fetch(`http://localhost:8000/groups/${groupId}`, { method: "DELETE", headers: authHeaders() })
    onGroupsChanged()
  }

  async function assignStudent(studentId: string, groupId: string) {
    setAssigning(studentId)
    const currentGroupId = studentGroupMap[studentId]

    if (currentGroupId) {
      const currentGroup = groups.find((g) => g.id === currentGroupId)
      if (currentGroup) {
        const newMembers = currentGroup.members.filter((m) => m.id !== studentId).map((m) => m.id)
        await fetch(`http://localhost:8000/groups/${currentGroupId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ members: newMembers }),
        })
      }
    }

    if (groupId) {
      const targetGroup = groups.find((g) => g.id === groupId)
      if (targetGroup) {
        const newMembers = [...targetGroup.members.map((m) => m.id), studentId]
        await fetch(`http://localhost:8000/groups/${groupId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ members: newMembers }),
        })
      }
    }

    await onGroupsChanged()
    setAssigning(null)
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true); setUploadResult(null)
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`http://localhost:8000/classes/${classId}/roster`, {
      method: "POST", headers: authHeaders(), body: form,
    })
    if (res.ok) { setUploadResult(await res.json()); onUploaded() }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ""
  }

  async function addStudent(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!addName.trim() || !addEmail.trim()) return
    setAddingStudent(true); setAddResult(null)
    const res = await fetch(`http://localhost:8000/classes/${classId}/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: addName.trim(), email: addEmail.trim().toLowerCase() }),
    })
    if (res.ok) {
      const data = await res.json()
      setAddResult(data.added ? "Student added." : "Already enrolled.")
      setAddName(""); setAddEmail("")
      onUploaded()
    } else {
      setAddResult("Failed to add student.")
    }
    setAddingStudent(false)
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <h2 className="font-semibold text-gray-800">Groups</h2>
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <div key={g.id} className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 pl-3 pr-2 py-1">
              <span className="text-sm text-gray-700 font-medium">{g.name}</span>
              <span className="text-xs text-gray-400">({g.members.length})</span>
              <button
                onClick={() => deleteGroup(g.id, g.name)}
                className="ml-0.5 w-4 h-4 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 flex items-center justify-center text-xs transition-colors"
              >×</button>
            </div>
          ))}
          {groups.length === 0 && <p className="text-sm text-gray-400">No groups yet.</p>}
        </div>
        <form onSubmit={createGroup} className="flex gap-2">
          <input
            value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)}
            placeholder="New group name…"
            className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button type="submit" disabled={creatingGroup || !newGroupName.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: "#1B8CC4" }}>
            {creatingGroup ? "Creating…" : "+ Add Group"}
          </button>
        </form>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-gray-800">Students ({students.length})</h2>
            <div className="flex items-center gap-2">
              {uploading && <span className="text-sm text-gray-400">Uploading…</span>}
              {uploadResult && <span className="text-sm text-green-600">Added {uploadResult.added} new</span>}
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
              <button
                onClick={() => fileRef.current?.click()}
                className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
              >
                Import CSV
              </button>
            </div>
          </div>
          <form onSubmit={addStudent} className="flex gap-2">
            <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Full name" required
              className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            <input value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="Email address" type="email" required
              className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
            <button type="submit" disabled={addingStudent}
              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50 whitespace-nowrap"
              style={{ backgroundColor: "#1B8CC4" }}>
              {addingStudent ? "Adding…" : "+ Add Student"}
            </button>
          </form>
          {addResult && (
            <p className={`text-xs ${addResult === "Student added." ? "text-green-600" : "text-gray-500"}`}>{addResult}</p>
          )}
        </div>

        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-6 py-3 text-left">Name</th>
              <th className="px-6 py-3 text-left">Email</th>
              <th className="px-6 py-3 text-left">Group</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {students.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">{s.name}</td>
                <td className="px-6 py-3 text-gray-500">{s.email}</td>
                <td className="px-6 py-3">
                  <select
                    value={studentGroupMap[s.id] ?? ""}
                    disabled={assigning === s.id}
                    onChange={(e) => assignStudent(s.id, e.target.value)}
                    className="rounded-lg border border-gray-200 px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
                  >
                    <option value="">Unassigned</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr><td colSpan={3} className="px-6 py-10 text-center text-gray-400">No students yet. Add one above or import a CSV.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
