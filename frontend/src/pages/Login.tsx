import { API_BASE } from "../api";

export function Login() {
  return (
    <div className="centered-page">
      <h1>GroupSync</h1>
      <p className="muted">Evidence tool for grading collaborative Google Docs work.</p>
      <a className="button" href={`${API_BASE}/auth/google`}>
        Sign in with Google
      </a>
    </div>
  );
}
