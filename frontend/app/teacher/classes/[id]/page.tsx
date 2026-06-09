"use client"

import { useEffect, useRef, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { useDraggable } from "@dnd-kit/core"
import Link from "next/link"
import { authHeaders, fetchMe } from "@/lib/auth"
import { Button } from "@/components/ui/button"

// ─── Types ────────────────────────────────────────────────────────────────────

interface Student {
  id: string
  name: string
  email: string
}

interface Group {
  id: string
  name: string
  class_id: string
  members: Student[]
}

interface Assignment {
  id: string
  title: string
  instructions: string
  deadline: string
}

type Tab = "groups" | "assignments" | "roster"

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ClassDetailPage() {
  const { id: classId } = useParams<{ id: string }>()
  const router = useRouter()

  const [className, setClassName] = useState("")
  const [students, setStudents] = useState<Student[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [tab, setTab] = useState<Tab>("groups")
  const [draggingStudent, setDraggingStudent] = useState<Student | null>(null)

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u || u.role !== "instructor") { router.replace("/"); return }
      loadAll()
    })
  }, [classId])

  async function loadAll() {
    const [clsRes, studentsRes, groupsRes, assignmentsRes] = await Promise.all([
      fetch(`http://localhost:8000/classes/${classId}`, { headers: authHeaders() }),
      fetch(`http://localhost:8000/classes/${classId}/students`, { headers: authHeaders() }),
      fetch(`http://localhost:8000/groups?class_id=${classId}`, { headers: authHeaders() }),
      fetch(`http://localhost:8000/assignments?class_id=${classId}`, { headers: authHeaders() }),
    ])
    if (clsRes.ok) setClassName((await clsRes.json()).name)
    if (studentsRes.ok) setStudents(await studentsRes.json())
    if (groupsRes.ok) setGroups(await groupsRes.json())
    if (assignmentsRes.ok) setAssignments(await assignmentsRes.json())
  }

  // Students not assigned to any group
  const assignedIds = new Set(groups.flatMap((g) => g.members.map((m) => m.id)))
  const unassigned = students.filter((s) => !assignedIds.has(s.id))

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragStart(event: DragStartEvent) {
    const s = students.find((s) => s.id === event.active.id)
    setDraggingStudent(s ?? null)
  }

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingStudent(null)
    const studentId = event.active.id as string
    const targetGroupId = event.over?.id as string | undefined
    if (!targetGroupId) return

    // Remove from current group
    const updatedGroups = groups.map((g) => ({
      ...g,
      members: g.members.filter((m) => m.id !== studentId),
    }))

    const student = students.find((s) => s.id === studentId)
    if (!student) return

    // Add to target group (unless dropping back on "unassigned")
    if (targetGroupId !== "unassigned") {
      const idx = updatedGroups.findIndex((g) => g.id === targetGroupId)
      if (idx !== -1) updatedGroups[idx].members.push(student)
    }

    setGroups(updatedGroups)

    // Persist — update every group that changed
    for (const g of updatedGroups) {
      const original = groups.find((og) => og.id === g.id)
      const changed =
        original &&
        JSON.stringify(original.members.map((m) => m.id).sort()) !==
          JSON.stringify(g.members.map((m) => m.id).sort())
      if (changed) {
        await fetch(`http://localhost:8000/groups/${g.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ members: g.members.map((m) => m.id) }),
        })
      }
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center gap-4">
          <Link href="/teacher" className="text-sm text-gray-400 hover:text-gray-700">← Back</Link>
          <h1 className="text-2xl font-bold text-gray-900">{className || "Loading…"}</h1>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {(["groups", "assignments", "roster"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? "border-b-2 border-blue-600 text-blue-600"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Groups tab */}
        {tab === "groups" && (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex gap-4 overflow-x-auto pb-4">
              {/* Unassigned column */}
              <DroppableColumn id="unassigned" title="Unassigned" students={unassigned} classId={classId} />

              {/* Group columns */}
              {groups.map((g) => (
                <DroppableColumn
                  key={g.id}
                  id={g.id}
                  title={g.name}
                  students={g.members}
                  classId={classId}
                  groupId={g.id}
                  onGroupDeleted={() => setGroups((prev) => prev.filter((x) => x.id !== g.id))}
                  onInviteSent={() => {}}
                />
              ))}

              {/* Add group */}
              <AddGroupColumn classId={classId} onCreated={(g) => setGroups((prev) => [...prev, g])} />
            </div>

            <DragOverlay>
              {draggingStudent && <StudentCard student={draggingStudent} dragging />}
            </DragOverlay>
          </DndContext>
        )}

        {/* Assignments tab */}
        {tab === "assignments" && (
          <AssignmentsTab classId={classId} assignments={assignments} onCreated={(a) => setAssignments((prev) => [...prev, a])} />
        )}

        {/* Roster tab */}
        {tab === "roster" && (
          <RosterTab classId={classId} students={students} onUploaded={loadAll} />
        )}

      </div>
    </main>
  )
}

// ─── Droppable column ─────────────────────────────────────────────────────────

function DroppableColumn({
  id, title, students, classId, groupId, onGroupDeleted, onInviteSent,
}: {
  id: string
  title: string
  students: Student[]
  classId: string
  groupId?: string
  onGroupDeleted?: () => void
  onInviteSent?: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  const [inviting, setInviting] = useState(false)

  async function sendInvites() {
    if (!groupId) return
    setInviting(true)
    await fetch("http://localhost:8000/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ group_id: groupId }),
    })
    setInviting(false)
  }

  async function deleteGroup() {
    if (!groupId || !onGroupDeleted) return
    if (!confirm(`Delete group "${title}"?`)) return
    await fetch(`http://localhost:8000/groups/${groupId}`, { method: "DELETE", headers: authHeaders() })
    onGroupDeleted()
  }

  return (
    <div className="flex-shrink-0 w-52">
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</span>
        {groupId && (
          <div className="flex gap-1">
            <button onClick={sendInvites} disabled={inviting} title="Send invites" className="text-xs text-blue-500 hover:text-blue-700 disabled:opacity-40">
              {inviting ? "…" : "✉"}
            </button>
            <button onClick={deleteGroup} title="Delete group" className="text-xs text-red-400 hover:text-red-600">✕</button>
          </div>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-40 rounded-xl p-2 space-y-2 transition-colors ${
          isOver ? "bg-blue-50 ring-2 ring-blue-300" : "bg-white border border-gray-200"
        }`}
      >
        {students.map((s) => <StudentCard key={s.id} student={s} />)}
        {students.length === 0 && (
          <p className="text-xs text-gray-300 text-center pt-4">Drop here</p>
        )}
      </div>
    </div>
  )
}

// ─── Draggable student card ───────────────────────────────────────────────────

function StudentCard({ student, dragging }: { student: Student; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: student.id })
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`rounded-lg border px-3 py-2 text-sm cursor-grab select-none transition-shadow ${
        dragging ? "shadow-lg bg-white border-blue-400 opacity-90" : "bg-white border-gray-200 hover:border-gray-300"
      }`}
    >
      <p className="font-medium text-gray-800 truncate">{student.name}</p>
      <p className="text-xs text-gray-400 truncate">{student.email}</p>
    </div>
  )
}

// ─── Add group column ─────────────────────────────────────────────────────────

function AddGroupColumn({ classId, onCreated }: { classId: string; onCreated: (g: Group) => void }) {
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setCreating(true)
    const res = await fetch("http://localhost:8000/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ class_id: classId, name: name.trim() }),
    })
    if (res.ok) { onCreated(await res.json()); setName("") }
    setCreating(false)
  }

  return (
    <div className="flex-shrink-0 w-52">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2 px-1">New Group</div>
      <form onSubmit={submit} className="rounded-xl border-2 border-dashed border-gray-200 p-3 space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name…"
          className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Button type="submit" size="sm" className="w-full" disabled={creating || !name.trim()}>
          {creating ? "Adding…" : "+ Add Group"}
        </Button>
      </form>
    </div>
  )
}

// ─── Assignments tab ──────────────────────────────────────────────────────────

function AssignmentsTab({
  classId, assignments, onCreated,
}: {
  classId: string
  assignments: Assignment[]
  onCreated: (a: Assignment) => void
}) {
  const [title, setTitle] = useState("")
  const [instructions, setInstructions] = useState("")
  const [deadline, setDeadline] = useState("")
  const [saving, setSaving] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const res = await fetch("http://localhost:8000/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ class_id: classId, title, instructions, deadline }),
    })
    if (res.ok) {
      onCreated(await res.json())
      setTitle(""); setInstructions(""); setDeadline("")
    }
    setSaving(false)
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">New Assignment</h2>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Instructions…"
          rows={4}
          required
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
        <div className="flex items-center gap-4">
          <label className="text-sm text-gray-600">Deadline</label>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            required
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Create"}
          </Button>
        </div>
      </form>

      <div className="space-y-3">
        {assignments.map((a) => (
          <div key={a.id} className="bg-white rounded-xl border border-gray-200 px-6 py-4">
            <div className="flex justify-between items-start">
              <h3 className="font-semibold text-gray-900">{a.title}</h3>
              <span className="text-xs text-gray-400">Due {new Date(a.deadline).toLocaleString()}</span>
            </div>
            <p className="text-sm text-gray-500 mt-1 whitespace-pre-wrap">{a.instructions}</p>
          </div>
        ))}
        {assignments.length === 0 && (
          <p className="text-center py-8 text-gray-400 text-sm">No assignments yet.</p>
        )}
      </div>
    </div>
  )
}

// ─── Roster tab ───────────────────────────────────────────────────────────────

function RosterTab({
  classId, students, onUploaded,
}: {
  classId: string
  students: Student[]
  onUploaded: () => void
}) {
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<{ added: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setResult(null)
    const form = new FormData()
    form.append("file", file)
    const res = await fetch(`http://localhost:8000/classes/${classId}/roster`, {
      method: "POST",
      headers: authHeaders(),
      body: form,
    })
    if (res.ok) {
      setResult(await res.json())
      onUploaded()
    }
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ""
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
        <h2 className="font-semibold text-gray-800">Upload Roster (CSV)</h2>
        <p className="text-sm text-gray-500">
          Accepts Canvas exports or any CSV with <code className="bg-gray-100 px-1 rounded">name</code> and <code className="bg-gray-100 px-1 rounded">email</code> columns.
        </p>
        <div className="flex items-center gap-4">
          <input ref={inputRef} type="file" accept=".csv" onChange={handleFile} className="text-sm text-gray-600" />
          {uploading && <span className="text-sm text-gray-400">Uploading…</span>}
          {result && (
            <span className="text-sm text-green-600">
              Added {result.added} new students ({result.total} total)
            </span>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-800">Enrolled Students ({students.length})</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 uppercase text-xs tracking-wide">
            <tr>
              <th className="px-6 py-3 text-left">Name</th>
              <th className="px-6 py-3 text-left">Email</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {students.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-medium text-gray-900">{s.name}</td>
                <td className="px-6 py-3 text-gray-500">{s.email}</td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={2} className="px-6 py-8 text-center text-gray-400">No students enrolled yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
