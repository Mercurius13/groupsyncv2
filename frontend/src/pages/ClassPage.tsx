import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../api";
import type { AssignmentRecord, ClassRecord, DisclosureRecordEntry } from "../types";

export function ClassPage() {
  const { classId } = useParams<{ classId: string }>();
  const [cls, setCls] = useState<ClassRecord | null>(null);
  const [assignments, setAssignments] = useState<AssignmentRecord[] | null>(null);
  const [name, setName] = useState("");
  const [docRef, setDocRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [template, setTemplate] = useState("");
  const [disclosureText, setDisclosureText] = useState("");
  const [disclosures, setDisclosures] = useState<DisclosureRecordEntry[] | null>(null);

  function reloadAssignments() {
    apiFetch<AssignmentRecord[]>(`/assignments?class_id=${classId}`).then(setAssignments);
  }

  function reloadDisclosures() {
    apiFetch<DisclosureRecordEntry[]>(`/disclosure?class_id=${classId}`).then(setDisclosures);
  }

  useEffect(() => {
    apiFetch<ClassRecord>(`/classes/${classId}`).then(setCls);
    reloadAssignments();
    reloadDisclosures();
    apiFetch<{ disclosure_text: string }>("/disclosure/template").then((t) => {
      setTemplate(t.disclosure_text);
      setDisclosureText(t.disclosure_text);
    });
  }, [classId]);

  async function createAssignment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/assignments", {
        method: "POST",
        body: JSON.stringify({ class_id: classId, name, doc_reference: docRef || null }),
      });
      setName("");
      setDocRef("");
      reloadAssignments();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function recordDisclosure(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/disclosure", {
        method: "POST",
        body: JSON.stringify({ class_id: classId, disclosure_text: disclosureText }),
      });
      reloadDisclosures();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <p><Link to="/">&larr; Your classes</Link></p>
      <h2>{cls?.name ?? "…"}</h2>
      {error && <p className="error">{error}</p>}

      <section>
        <h3>Assignments</h3>
        <form onSubmit={createAssignment} className="inline-form">
          <input placeholder="Assignment name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input
            placeholder="Doc URL (optional)"
            value={docRef}
            onChange={(e) => setDocRef(e.target.value)}
          />
          <button type="submit">Create assignment</button>
        </form>
        {assignments === null ? (
          <p className="muted">Loading…</p>
        ) : assignments.length === 0 ? (
          <p className="muted">No assignments yet.</p>
        ) : (
          <ul className="record-list">
            {assignments.map((a) => (
              <li key={a.id}>
                <Link to={`/classes/${classId}/assignments/${a.id}`}>{a.name}</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="disclosure-section">
        <h3>Disclosure</h3>
        <p className="callout">
          Per institutional policy (HANDOVER.md C2), edit access plus disclosure is not enough on
          its own — confirm your institution's student-data sign-off before running this on a real
          graded class.
        </p>
        <form onSubmit={recordDisclosure}>
          <textarea
            rows={6}
            value={disclosureText}
            onChange={(e) => setDisclosureText(e.target.value)}
          />
          <div>
            <button type="button" onClick={() => setDisclosureText(template)}>
              Reset to template
            </button>
            <button type="submit">Record disclosure for this class</button>
          </div>
        </form>
        <h4>Disclosure history (append-only)</h4>
        {disclosures === null ? (
          <p className="muted">Loading…</p>
        ) : disclosures.length === 0 ? (
          <p className="muted">No disclosure recorded yet for this class.</p>
        ) : (
          <ul className="record-list">
            {disclosures.map((d) => (
              <li key={d.id}>
                <span className="muted">{new Date(d.enabled_at).toLocaleString()}</span> — {d.disclosure_text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
