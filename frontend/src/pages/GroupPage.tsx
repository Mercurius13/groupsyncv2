import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../api";
import { EvidenceViewer } from "../components/EvidenceViewer";
import type { ContentStrippedSummary, GroupRecord, SavedSummaryRecord } from "../types";

export function GroupPage() {
  const { classId, assignmentId, groupId } = useParams<{
    classId: string;
    assignmentId: string;
    groupId: string;
  }>();
  const [group, setGroup] = useState<GroupRecord | null>(null);
  const [expectedSize, setExpectedSize] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [pastedJson, setPastedJson] = useState("");
  const [preview, setPreview] = useState<ContentStrippedSummary | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [savedSummaries, setSavedSummaries] = useState<SavedSummaryRecord[] | null>(null);

  function reloadGroup() {
    apiFetch<GroupRecord[]>(`/groups?assignment_id=${assignmentId}`).then((all) => {
      const g = all.find((x) => x.id === groupId) ?? null;
      setGroup(g);
      setExpectedSize(g?.expected_size?.toString() ?? "");
    });
  }

  function reloadSummaries() {
    apiFetch<SavedSummaryRecord[]>(`/summaries?group_id=${groupId}`).then(setSavedSummaries);
  }

  useEffect(() => {
    reloadGroup();
    reloadSummaries();
  }, [assignmentId, groupId]);

  async function saveExpectedSize(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/groups/${groupId}`, {
        method: "PATCH",
        body: JSON.stringify({ expected_size: expectedSize ? Number(expectedSize) : null }),
      });
      reloadGroup();
    } catch (err) {
      setError((err as Error).message);
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
        <h3>Expected group size</h3>
        <p className="muted">
          A count only, for your own reference and license seat-tracking — the backend never stores
          an actual list of students. Names are resolved inside the extension (via the People API or
          Drive permissions), never sent here.
        </p>
        <form onSubmit={saveExpectedSize} className="inline-form">
          <input
            type="number"
            min={0}
            placeholder="e.g. 4"
            value={expectedSize}
            onChange={(e) => setExpectedSize(e.target.value)}
            style={{ width: 100 }}
          />
          <button type="submit">Save</button>
        </form>
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
