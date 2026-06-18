"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { fetchMe, authHeaders, type User } from "@/lib/auth"
import { Sidebar } from "@/components/sidebar"
import { AssignmentCard, type StudentAssignment } from "@/components/student/AssignmentCard"
import { GroupPanel, type StudentGroup } from "@/components/student/GroupPanel"

export default function StudentDashboard() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [groups, setGroups] = useState<StudentGroup[]>([])
  const [assignments, setAssignments] = useState<StudentAssignment[]>([])
  const [serviceEmail, setServiceEmail] = useState<string>("")
  const [activeClass, setActiveClass] = useState<string | null>(null)

  useEffect(() => {
    fetchMe().then((me) => {
      if (!me || me.role !== "student") { router.replace("/"); return }
      setUser(me)
      loadAll()
    })
  }, [router])

  useEffect(() => {
    fetch("http://localhost:8000/contributions/service-account-email", { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : { email: "" })
      .then((d) => setServiceEmail(d.email || ""))
      .catch(() => {})
  }, [])

  async function loadAll() {
    const [groupsRes, assignmentsRes] = await Promise.all([
      fetch("http://localhost:8000/student/group", { headers: authHeaders() }),
      fetch("http://localhost:8000/student/assignments", { headers: authHeaders() }),
    ])
    if (groupsRes.ok) setGroups(await groupsRes.json())
    if (assignmentsRes.ok) {
      const data = await assignmentsRes.json()
      setAssignments(data)
      if (data.length > 0 && !activeClass) setActiveClass(data[0].class_id)
    }
  }

  if (!user) return <div className="flex min-h-screen items-center justify-center text-sm text-gray-400">Loading…</div>

  const classesSeen = new Map<string, string>()
  for (const a of assignments) classesSeen.set(a.class_id, a.class_name)
  const classGroups = groups.reduce<Record<string, StudentGroup>>((acc, g) => { acc[g.class_id] = g; return acc }, {})

  const classIds = [...classesSeen.keys()]
  const currentClassAssignments = assignments.filter((a) => a.class_id === activeClass)
  const currentGroup = activeClass ? classGroups[activeClass] : null
  const currentClassName = activeClass ? classesSeen.get(activeClass) : ""

  const now = new Date()
  const upcoming = assignments.filter((a) => !a.submission && new Date(a.deadline) > now)
    .sort((a, b) => new Date(a.deadline).getTime() - new Date(b.deadline).getTime())
    .slice(0, 5)
  const missing = assignments.filter((a) => !a.submission && new Date(a.deadline) < now)

  return (
    <div className="flex min-h-screen bg-gray-100">
    <Sidebar role="student" userName={user.name || user.email} />
    <div className="ml-20 flex-1 min-h-screen">
      <div className="bg-white border-b border-gray-200 px-8 py-4">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500">{user.email}</p>
      </div>

      <div className="flex min-h-[calc(100vh-73px)]">
        {classIds.length > 0 && (
          <div className="w-56 flex-shrink-0 bg-white border-r border-gray-200 p-4 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3 px-2">My Courses</p>
            {classIds.map((cid) => (
              <button
                key={cid}
                onClick={() => setActiveClass(cid)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeClass === cid ? "bg-blue-50 text-blue-700" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                {classesSeen.get(cid)}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 p-8 min-w-0">
          {classIds.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-gray-400">
              <div className="text-5xl mb-4">📚</div>
              <p className="text-lg font-medium text-gray-500">No courses yet</p>
              <p className="text-sm mt-1">Your teacher will add you to a course.</p>
            </div>
          ) : (
            <div className="flex gap-8">
              <div className="flex-1 min-w-0 space-y-4">
                <h2 className="text-lg font-semibold text-gray-900">{currentClassName}</h2>

                {serviceEmail && (
                  <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
                    <strong>Before submitting:</strong> share your Google Doc/Slides with{" "}
                    <code className="bg-blue-100 px-1 rounded select-all text-xs">{serviceEmail}</code>{" "}
                    (Viewer access) so your teacher can generate a contribution report.
                  </div>
                )}

                {currentClassAssignments.length === 0 ? (
                  <p className="text-sm text-gray-400 py-8 text-center">No assignments for this course yet.</p>
                ) : (
                  currentClassAssignments.map((a) => (
                    <AssignmentCard key={a.id} assignment={a} onSubmitted={loadAll} />
                  ))
                )}
              </div>

              <div className="w-72 flex-shrink-0 space-y-4">
                {currentGroup ? (
                  <GroupPanel group={currentGroup} me={user} />
                ) : (
                  <div className="bg-white rounded-xl border border-gray-200 p-4 text-sm text-gray-400 text-center">
                    Not in a group for this course yet.
                  </div>
                )}

                {upcoming.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-700">Coming Up</h3>
                    {upcoming.map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-2">
                        <p className="text-sm text-gray-800 truncate">{a.title}</p>
                        <p className="text-xs text-gray-400 whitespace-nowrap">{new Date(a.deadline).toLocaleDateString()}</p>
                      </div>
                    ))}
                  </div>
                )}

                {missing.length > 0 && (
                  <div className="bg-white rounded-xl border border-red-200 p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-red-600">Missing ({missing.length})</h3>
                    {missing.map((a) => (
                      <p key={a.id} className="text-sm text-gray-700 truncate">{a.title}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  )
}
