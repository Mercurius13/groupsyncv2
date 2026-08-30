export interface Professor {
  id: string;
  email: string;
  name: string;
  institution_id: string | null;
}

/** Backend E3 — the ONLY entity besides the professor's own account. The
 *  frontend never receives student data or analysis output (C1): analysis
 *  lives and dies in the extension popup, and class organization lives in
 *  Canvas. Payments are deferred, so every professor holds an
 *  auto-provisioned active free-tier license until a processor exists. */
export interface LicenseRecord {
  id: string;
  professor_id: string;
  tier: "free" | "professor" | "institution";
  status: string;
  /** Purchased seat capacity, institutional tier only (null otherwise) —
   *  a plan number, never derived from any student list. */
  seat_count: number | null;
  term_end: string | null;
  billing_period: string | null;
  processor_ref: string | null;
  created_at: string | null;
}
