"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { clearToken, type Role } from "@/lib/auth"

interface NavItem {
  label: string
  href: string
  icon: string
  exact?: boolean
}

const NAV: Record<Role, NavItem[]> = {
  student: [
    { label: "Dashboard", href: "/student", icon: "⊞", exact: true },
  ],
  instructor: [
    { label: "Dashboard", href: "/teacher", icon: "⊞", exact: false },
  ],
  admin: [
    { label: "Dashboard", href: "/teacher", icon: "⊞", exact: false },
    { label: "Admin", href: "/admin", icon: "⚙", exact: true },
  ],
}

export function Sidebar({ role, userName }: { role: Role; userName: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const items = NAV[role]

  function isActive(item: NavItem) {
    return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/")
  }

  return (
    <aside
      className="fixed top-0 left-0 h-full w-20 flex flex-col items-center py-4 gap-1 z-20"
      style={{ backgroundColor: "#2D3B45" }}
    >
      {/* Logo */}
      <div className="mb-4 w-14 h-14 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-3xl select-none">
        G
      </div>

      <div className="w-12 h-px bg-white/10 mb-2" />

      {/* Nav items */}
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          title={item.label}
          className="w-full flex flex-col items-center py-3 gap-1 text-white/60 hover:text-white hover:bg-white/10 transition-colors rounded-lg px-1"
          style={isActive(item) ? { color: "white", backgroundColor: "rgba(255,255,255,0.15)" } : {}}
        >
          <span className="text-2xl leading-none">{item.icon}</span>
          <span className="text-[10px] font-medium leading-none">{item.label}</span>
        </Link>
      ))}

      <div className="flex-1" />

      {/* Sign out */}
      <button
        onClick={() => { clearToken(); router.replace("/") }}
        title="Sign out"
        className="w-full flex flex-col items-center py-3 gap-1 text-white/50 hover:text-white hover:bg-white/10 transition-colors rounded-lg px-1"
      >
        <span className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-sm font-bold text-white">
          {userName.charAt(0).toUpperCase()}
        </span>
        <span className="text-[10px] leading-none">Sign out</span>
      </button>
    </aside>
  )
}
