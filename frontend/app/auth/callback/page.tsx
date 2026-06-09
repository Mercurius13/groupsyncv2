"use client"

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { setToken, fetchMe, roleDashboard } from "@/lib/auth"

export default function AuthCallback() {
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const token = searchParams.get("token")
    if (!token) {
      router.replace("/")
      return
    }
    setToken(token)
    fetchMe().then((user) => {
      if (!user) {
        router.replace("/")
        return
      }
      router.replace(roleDashboard(user.role))
    })
  }, [router, searchParams])

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-gray-500 text-sm">Signing you in…</p>
    </main>
  )
}
