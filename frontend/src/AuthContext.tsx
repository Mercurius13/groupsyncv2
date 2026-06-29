import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { apiFetch } from "./api";
import { clearToken, getToken } from "./auth";
import type { Professor } from "./types";

const AuthContext = createContext<Professor | null>(null);

export function useProfessor(): Professor {
  const professor = useContext(AuthContext);
  if (!professor) throw new Error("useProfessor() called outside RequireAuth");
  return professor;
}

/** Gate for every authenticated route: fetches /auth/me once, redirects to
 *  /login if there's no token or it's invalid. Professors-only (F1.4) — no
 *  role check needed, there's only one kind of account. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ loading: boolean; professor: Professor | null }>({
    loading: true,
    professor: null,
  });

  useEffect(() => {
    if (!getToken()) {
      setState({ loading: false, professor: null });
      return;
    }
    apiFetch<Professor>("/auth/me")
      .then((professor) => setState({ loading: false, professor }))
      .catch(() => {
        clearToken();
        setState({ loading: false, professor: null });
      });
  }, []);

  if (state.loading) return <p className="centered-page">Loading…</p>;
  if (!state.professor) return <Navigate to="/login" replace />;

  return <AuthContext.Provider value={state.professor}>{children}</AuthContext.Provider>;
}
