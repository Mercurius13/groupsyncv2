import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../api";
import type { AssignmentRecord, GroupRecord } from "../types";

export function AssignmentPage() {
  const { classId, assignmentId } = useParams<{ classId: string; assignmentId: string }>();
  const [assignment, setAssignment] = useState<AssignmentRecord | null>(null);
  const [groups, setGroups] = useState<GroupRecord[] | null>(null);
  const [groupName, setGroupName] = useState("");
  const [docRef, setDocRef] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reloadAssignment() {
    apiFetch<AssignmentRecord[]>(`/assignments?class_id=${classId}`).then((all) => {
      const a = all.find((x) => x.id === assignmentId) ?? null;
      setAssignment(a);
      setDocRef(a?.doc_reference ?? "");
    });
  }

  function reloadGroups() {
    apiFetch<GroupRecord[]>(`/groups?assignment_id=${assignmentId}`).then(setGroups);
  }

  useEffect(() => {
    reloadAssignment();
    reloadGroups();
  }, [classId, assignmentId]);

  async function saveDocRef(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/assignments/${assignmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ doc_reference: docRef }),
      });
      reloadAssignment();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/groups", { method: "POST", body: JSON.stringify({ assignment_id: assignmentId, name: groupName }) });
      setGroupName("");
      reloadGroups();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <p><Link to={`/classes/${classId}`}>&larr; Class</Link></p>
      <h2>{assignment?.name ?? "…"}</h2>
      {error && <p className="error">{error}</p>}

      <section>
        <h3>Document reference</h3>
        <p className="muted">An identifier for locating the doc — never its content (F2.3).</p>
        <form onSubmit={saveDocRef} className="inline-form">
          <input
            placeholder="https://docs.google.com/document/d/..."
            value={docRef}
            onChange={(e) => setDocRef(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit">Save</button>
        </form>
      </section>

      <section>
        <h3>Groups</h3>
        <form onSubmit={createGroup} className="inline-form">
          <input placeholder="Group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} required />
          <button type="submit">Create group</button>
        </form>
        {groups === null ? (
          <p className="muted">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="muted">No groups yet.</p>
        ) : (
          <ul className="record-list">
            {groups.map((g) => (
              <li key={g.id}>
                <Link to={`/classes/${classId}/assignments/${assignmentId}/groups/${g.id}`}>{g.name}</Link>
                {g.expected_size != null && <span className="muted"> — expected size {g.expected_size}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
