"use client"

import { useState } from "react"

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"]
const PDF_EXT = ".pdf"

function fileExt(name: string) {
  return name.slice(name.lastIndexOf(".")).toLowerCase()
}

export function AttachmentPreview({ name, url }: { name: string; url: string }) {
  const [expanded, setExpanded] = useState(false)
  const ext = fileExt(name)
  const canEmbed = ext === PDF_EXT || IMAGE_EXTS.includes(ext)

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-gray-400 text-sm">📎</span>
        <span className="text-sm text-gray-700 truncate max-w-xs">{name}</span>
        <a
          href={url}
          download={name}
          className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
        >
          Download
        </a>
        {canEmbed && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            {expanded ? "Hide" : "Preview"}
          </button>
        )}
      </div>

      {expanded && canEmbed && (
        <div className="rounded-lg border border-gray-200 overflow-hidden">
          {IMAGE_EXTS.includes(ext) ? (
            <img src={url} alt={name} className="max-w-full max-h-96 object-contain mx-auto block" />
          ) : (
            <iframe src={url} title={name} className="w-full h-96" />
          )}
        </div>
      )}
    </div>
  )
}
