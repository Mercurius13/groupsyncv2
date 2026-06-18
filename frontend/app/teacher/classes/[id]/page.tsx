"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { authHeaders, fetchMe, type User } from "@/lib/auth"
import { Sidebar } from "@/components/sidebar"
import { AssignmentsTab } from "@/components/teacher/class/AssignmentsTab"
import { GradesTab } from "@/components/teacher/class/GradesTab"
import { GroupTab, type ClassGroup, type GroupMember } from "@/components/teacher/class/GroupTab"
import type { TeacherAssignment } from "@/components/teacher/class/AssignmentCard"

type Tab = "assignments" | "grades" | "group"

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: "assignments", label: "Assignments" },
  { key: "grades", label: "Grades" },
  { key: "group", label: "Groups" },
]

export default function ClassDetailPage() {
  const { id: classId } = useParams<{ id: string }>()
  const router = useRouter()

  const [me, setMe] = useState<User | null>(null)
  const [className, setClassName] = useState("")
  const [students, setStudents] = useState<GroupMember[]>([])
  const [groups, setGroups] = useState<ClassGroup[]>([])
  const [assignments, setAssignments] = useState<TeacherAssignment[]>([])
  const [tab, setTab] = useState<Tab>("assignments")

  useEffect(() => {
    fetchMe().then((u) => {
      if (!u || (u.role !== "instructor" && u.role !== "admin")) { router.replace("/"); return }
      setMe(u)
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

  async function refreshGroups() {
    const r = await fetch(`http://localhost:8000/groups?class_id=${classId}`, { headers: authHeaders() })
    if (r.ok) setGroups(await r.json())
  }

  if (!me) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  return (
    <div className="flex min-h-screen bg-gray-100">
    <Sidebar role={me.role} userName={me.name || me.email} />
    <div className="ml-20 flex-1 min-h-screen">
      <div className="bg-white border-b border-gray-200">
        <div className="px-8 py-4 border-b border-gray-100 flex items-center gap-3">
          <Link
            href="/teacher"
            className="flex-shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            ← Courses
          </Link>
          <h1 className="text-xl font-semibold text-gray-900">{className || "Loading…"}</h1>
        </div>
        <div className="px-8 flex gap-1">
          {TAB_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-8">
        {tab === "assignments" && (
          <AssignmentsTab
            classId={classId}
            assignments={assignments}
            onCreated={(a) => setAssignments((prev) => [...prev, a])}
            onUpdated={(a) => setAssignments((prev) => prev.map((x) => x.id === a.id ? a : x))}
            onDeleted={(id) => setAssignments((prev) => prev.filter((a) => a.id !== id))}
          />
        )}
        {tab === "grades" && <GradesTab classId={classId} />}
        {tab === "group" && (
          <GroupTab
            classId={classId}
            students={students}
            groups={groups}
            onGroupsChanged={refreshGroups}
            onUploaded={loadAll}
          />
        )}
      </div>
    </div>
    </div>
  )
}
