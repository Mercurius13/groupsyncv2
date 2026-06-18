"use client"

import Link from "next/link"

export interface ClassItem {
  id: string
  name: string
  student_count: number
}

const CARD_COLORS = [
  "#1B8CC4", "#E66000", "#2E6A4F", "#8B5E3C",
  "#6A0572", "#C1121F", "#0D5C8C", "#B07D00",
]

function colorFor(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xfffffff
  return CARD_COLORS[h % CARD_COLORS.length]
}

export function ClassCard({ cls, onDelete }: { cls: ClassItem; onDelete: (id: string, name: string) => void }) {
  const color = colorFor(cls.id)
  return (
    <div className="rounded-lg overflow-hidden border border-gray-200 bg-white shadow-sm hover:shadow-md transition-shadow flex flex-col">
      <Link href={`/teacher/classes/${cls.id}`} className="block">
        <div className="h-14 w-full" style={{ backgroundColor: color }} />
        <div className="p-4 pb-2">
          <h2 className="font-semibold text-gray-900 truncate hover:text-blue-700 transition-colors">{cls.name}</h2>
          <p className="text-sm text-gray-500 mt-1">{cls.student_count} students</p>
        </div>
      </Link>
      <div className="px-4 pb-4 pt-2 flex items-center justify-between border-t border-gray-100 mt-auto">
        <Link href={`/teacher/classes/${cls.id}`}>
          <span className="text-xs font-medium px-3 py-1 rounded-full text-white" style={{ backgroundColor: color }}>
            Open →
          </span>
        </Link>
        <button
          onClick={() => onDelete(cls.id, cls.name)}
          className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-400 hover:border-red-400 hover:text-red-500 transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}
