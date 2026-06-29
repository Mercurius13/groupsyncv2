import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useProfessor } from "../AuthContext";
import { clearToken } from "../auth";

export function Layout({ children }: { children: ReactNode }) {
  const professor = useProfessor();
  const navigate = useNavigate();

  function signOut() {
    clearToken();
    navigate("/login", { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/" className="app-title">
          GroupSync
        </Link>
        <div className="app-header-right">
          <span className="muted">{professor.name}</span>
          <button onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
