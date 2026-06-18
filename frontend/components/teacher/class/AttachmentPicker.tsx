"use client"

import React from "react"

export function AttachmentPicker({
  file, onChange, existingName, onRemoveExisting, inputRef,
}: {
  file: File | null
  onChange: (f: File | null) => void
  existingName?: string | null
  onRemoveExisting?: () => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
  const displayName = file?.name ?? existingName ?? null

  return (
    <div className="space-y-1.5">
      <input ref={inputRef} type="file" onChange={(e) => onChange(e.target.files?.[0] ?? null)} className="hidden" />
      {displayName ? (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm max-w-xs">
          <span className="text-gray-500">📎</span>
          <span className="flex-1 truncate text-gray-700">{displayName}</span>
          <button
            type="button"
            onClick={() => {
              onChange(null)
              if (inputRef.current) inputRef.current.value = ""
              if (!file && onRemoveExisting) onRemoveExisting()
            }}
            className="text-gray-400 hover:text-red-500 transition-colors font-bold leading-none"
          >×</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="px-3 py-2 rounded-lg border border-dashed border-gray-300 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          + Add Attachment
        </button>
      )}
    </div>
  )
}
