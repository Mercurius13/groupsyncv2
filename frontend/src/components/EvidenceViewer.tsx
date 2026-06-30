import type { ContentStrippedSummary } from "../types";

/**
 * FRONTEND.md F4 — presentation only. Renders exactly what the extension
 * produced; never recomputes or infers anything (N2). Signals are rendered
 * in their own visually distinct block, not buried in the section list
 * (F4.4). There is no claimed-vs-actual section to show (F4.5) — the
 * extension doesn't produce that data yet (EXTENSION.MD F5.5 gap).
 */
export function EvidenceViewer({ summary }: { summary: ContentStrippedSummary }) {
  return (
    <div className="evidence-viewer">
      <p className="disclaimer-banner">{summary.disclaimer}</p>

      <section>
        <h4>Per-section authorship</h4>
        {summary.sections.length === 0 ? (
          <p className="muted">No sections with surviving content.</p>
        ) : (
          summary.sections.map((section) => (
            <div key={section.sectionLabel} className="evidence-section">
              <strong>{section.sectionLabel}</strong>
              <ul>
                {section.sentences.map((sentence, i) => (
                  <li key={i}>{sentence}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {summary.signalNotes.length > 0 && (
        <section className="signals-block">
          <h4>Signals &amp; flags</h4>
          <ul>
            {summary.signalNotes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h4>Author counts</h4>
        <table>
          <thead>
            <tr>
              <th>Author</th>
              <th>Originated chars</th>
              <th>Doc-wide surviving chars</th>
              <th>Origin share</th>
            </tr>
          </thead>
          <tbody>
            {summary.authorCounts.map((a) => (
              <tr key={a.authorId}>
                <td>{a.authorName ? `${a.authorName} (${a.authorId})` : a.authorId}</td>
                <td>{a.originatedChars}</td>
                <td>{a.totalSurvivingChars}</td>
                <td>{(a.originShare * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <p className="muted">Generated {new Date(summary.generatedAt).toLocaleString()}</p>
    </div>
  );
}
