import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api";
import type { ClassRecord } from "../types";

export function Dashboard() {
  const [classes, setClasses] = useState<ClassRecord[] | null>(null);
  const [name, setName] = useState("");
  const [term, setTerm] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reload() {
    apiFetch<ClassRecord[]>("/classes").then(setClasses);
  }

  useEffect(reload, []);

  async function createClass(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/classes", { method: "POST", body: JSON.stringify({ name, term: term || null }) });
      setName("");
      setTerm("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h2>Your classes</h2>
      <form onSubmit={createClass} className="inline-form">
        <input placeholder="Class name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="Term (optional)" value={term} onChange={(e) => setTerm(e.target.value)} />
        <button type="submit">Create class</button>
      </form>
      {error && <p className="error">{error}</p>}

      {classes === null ? (
        <p className="muted">Loading…</p>
      ) : classes.length === 0 ? (
        <p className="muted">No classes yet — create one above.</p>
      ) : (
        <ul className="record-list">
          {classes.map((c) => (
            <li key={c.id}>
              <Link to={`/classes/${c.id}`}>{c.name}</Link>
              {c.term && <span className="muted"> — {c.term}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
