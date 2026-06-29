import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../api";
import { EvidenceViewer } from "../components/EvidenceViewer";
import type { ContentStrippedSummary, GroupRecord, RosterMemberRecord, SavedSummaryRecord } from "../types";

export function GroupPage() {
  const { classId, assignmentId, groupId } = useParams<{
    classId: string;
    assignmentId: string;
    groupId: string;
  }>();
  const [group, setGroup] = useState<GroupRecord | null>(null);
  const [roster, setRoster] = useState<RosterMemberRecord[] | null>(null);
  const [studentName, setStudentName] = useState("");
  const [studentEmail, setStudentEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const [pastedJson, setPastedJson] = useState("");
  const [preview, setPreview] = useState<ContentStrippedSummary | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [savedSummaries, setSavedSummaries] = useState<SavedSummaryRecord[] | null>(null);

  function reloadGroup() {
    apiFetch<GroupRecord[]>(`/groups?assignment_id=${assignmentId}`).then((all) => {
      setGroup(all.find((g) => g.id === groupId) ?? null);
    });
  }

  function reloadRoster() {
    apiFetch<RosterMemberRecord[]>(`/groups/${groupId}/roster`).then(setRoster);
  }

  function reloadSummaries() {
    apiFetch<SavedSummaryRecord[]>(`/summaries?group_id=${groupId}`).then(setSavedSummaries);
  }

  useEffect(() => {
    reloadGroup();
    reloadRoster();
    reloadSummaries();
  }, [assignmentId, groupId]);

  async function addRosterMember(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/groups/${groupId}/roster`, {
        method: "POST",
        body: JSON.stringify({ student_name: studentName, student_email: studentEmail }),
      });
      setStudentName("");
      setStudentEmail("");
      reloadRoster();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeRosterMember(memberId: string) {
    await apiFetch(`/roster/${memberId}`, { method: "DELETE" });
    reloadRoster();
  }

  async function importCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      await apiFetch(`/groups/${groupId}/roster/import`, { method: "POST", body: formData });
      reloadRoster();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  function previewPasted() {
    setParseError(null);
    try {
      setPreview(JSON.parse(pastedJson) as ContentStrippedSummary);
    } catch {
      setPreview(null);
      setParseError("That doesn't look like valid JSON — paste the exact clipboard contents from the extension's \"Export evidence summary\" button.");
    }
  }

  async function saveSummary() {
    if (!preview) return;
    setError(null);
    try {
      await apiFetch("/summaries", {
        method: "POST",
        body: JSON.stringify({ assignment_id: assignmentId, group_id: groupId, content_stripped_payload: preview }),
      });
      setPastedJson("");
      setPreview(null);
      reloadSummaries();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteSummary(summaryId: string) {
    await apiFetch(`/summaries/${summaryId}`, { method: "DELETE" });
    reloadSummaries();
  }

  return (
    <div>
      <p><Link to={`/classes/${classId}/assignments/${assignmentId}`}>&larr; Assignment</Link></p>
      <h2>{group?.name ?? "…"}</h2>
      {error && <p className="error">{error}</p>}

      <section>
        <h3>Roster</h3>
        <form onSubmit={addRosterMember} className="inline-form">
          <input placeholder="Student name" value={studentName} onChange={(e) => setStudentName(e.target.value)} required />
          <input placeholder="Student email" value={studentEmail} onChange={(e) => setStudentEmail(e.target.value)} required />
          <button type="submit">Add</button>
        </form>
        <div className="inline-form">
          <label className="muted">Or bulk-import CSV (e.g. Canvas roster export):</label>
          <input ref={csvInputRef} type="file" accept=".csv" onChange={importCsv} />
        </div>
        {roster === null ? (
          <p className="muted">Loading…</p>
        ) : roster.length === 0 ? (
          <p className="muted">No roster members yet — this is the authoritative join source for resolving edit-log author IDs (F3.3).</p>
        ) : (
          <ul className="record-list">
            {roster.map((m) => (
              <li key={m.id}>
                {m.student_name} — <span className="muted">{m.student_email}</span>{" "}
                <button onClick={() => removeRosterMember(m.id)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Evidence intake</h3>
        <p className="muted">
          Paste the exact clipboard JSON from the extension's "Export evidence summary" button.
          Nothing is sent to the backend until you explicitly click Save below (F5.2).
        </p>
        <textarea
          rows={6}
          placeholder="Paste content-stripped summary JSON here…"
          value={pastedJson}
          onChange={(e) => setPastedJson(e.target.value)}
        />
        <div>
          <button onClick={previewPasted} disabled={!pastedJson.trim()}>
            Preview
          </button>
          {preview && <button onClick={saveSummary}>Save to backend</button>}
        </div>
        {parseError && <p className="error">{parseError}</p>}
        {preview && (
          <div className="preview-box">
            <h4>Preview (not yet saved)</h4>
            <EvidenceViewer summary={preview} />
          </div>
        )}
      </section>

      <section>
        <h3>Saved evidence summaries</h3>
        {savedSummaries === null ? (
          <p className="muted">Loading…</p>
        ) : savedSummaries.length === 0 ? (
          <p className="muted">None saved yet.</p>
        ) : (
          savedSummaries.map((s) => (
            <div key={s.id} className="saved-summary">
              <div className="saved-summary-header">
                <span className="muted">Saved {new Date(s.created_at).toLocaleString()}</span>
                <button onClick={() => deleteSummary(s.id)}>Delete</button>
              </div>
              <EvidenceViewer summary={s.content_stripped_payload} />
            </div>
          ))
        )}
      </section>
    </div>
  );
}
