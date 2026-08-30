import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { useProfessor } from "../AuthContext";
import type { LicenseRecord } from "../types";

/**
 * The frontend's one authenticated page (FRONTEND.md, pivoted 2026-07-03):
 * onboarding + account/plan surface. No class organization (Canvas owns
 * that), no analysis display (the extension popup owns that), no student
 * data of any kind (C1/N1).
 */

const TIER_LABELS: Record<LicenseRecord["tier"], string> = {
  free: "Free",
  professor: "Per-professor",
  institution: "Institutional",
};

/** F3.1 — informational only. Formerly served by the backend's disclosure
 *  router; that router (and its stored records) was removed in the pivot
 *  because the backend no longer models classes. Nothing about adopting
 *  this text is collected or stored anywhere. */
const DISCLOSURE_TEMPLATE =
  "For this assignment, I will use GroupSync, a browser extension that analyzes " +
  "the edit history of your shared Google Doc to produce a character-level " +
  "breakdown of who contributed what, as evidence to support my evaluation of " +
  "individual contribution to group work. This analysis runs locally in my " +
  "browser; your document's content and edit history are never uploaded to a " +
  "server or third party. The analysis only reflects on-document editing — it " +
  "cannot detect work done outside the document (planning, discussion, research " +
  "done elsewhere) and does not by itself determine your grade.";

function LicenseSection() {
  const [license, setLicense] = useState<LicenseRecord | null>(null);

  useEffect(() => {
    apiFetch<LicenseRecord>("/licenses/me").then(setLicense);
  }, []);

  if (!license) return <p className="muted">Loading license…</p>;

  return (
    <div className="license-card">
      <strong>{TIER_LABELS[license.tier] ?? license.tier} license</strong>
      <span className={license.status === "active" ? "license-status-active" : "error"}>
        {license.status}
      </span>
      {license.tier === "institution" && license.seat_count !== null && (
        <span className="muted">Seats: {license.seat_count}</span>
      )}
      {license.term_end && <span className="muted">Term ends {license.term_end}</span>}
      {license.billing_period === null && (
        <span className="muted">Payments aren't enabled yet — every account is on the free tier.</span>
      )}
    </div>
  );
}

export function Account() {
  const professor = useProfessor();

  return (
    <div>
      <h2>Account</h2>
      <p>
        Signed in as <strong>{professor.name}</strong> <span className="muted">({professor.email})</span>
      </p>

      <section>
        <h3>Plan</h3>
        <LicenseSection />
      </section>

      <section>
        <h3>The extension is where everything happens</h3>
        <p className="muted">
          GroupSync's analysis runs entirely in the browser extension, on your machine: open any
          shared Google Doc you can edit, click the GroupSync icon, and fetch the doc's full edit
          history. Results render in the extension popup and never leave your browser — this site
          holds only your account and plan. Organize your classes where you already do (e.g.
          Canvas); GroupSync doesn't need or store any of it.
        </p>
        <p className="muted">
          Install: load the extension from the <code>extension/</code> directory via{" "}
          <code>chrome://extensions</code> → "Load unpacked" (Chrome Web Store listing pending).
        </p>
      </section>

      <section className="disclosure-section">
        <h3>Before you run this on a graded class</h3>
        <div className="callout">
          Disclose the use of this tool to students (syllabus / assignment brief) <em>and</em> obtain
          your institution's sign-off under its student-data policy before running it on real graded
          work. Edit permission on the doc is not authority by itself.
        </div>
        <p className="muted">Template disclosure language you can adopt or adapt:</p>
        <blockquote className="disclaimer-banner">{DISCLOSURE_TEMPLATE}</blockquote>
      </section>
    </div>
  );
}
