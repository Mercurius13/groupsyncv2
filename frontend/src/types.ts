export interface Professor {
  id: string;
  email: string;
  name: string;
  institution_id: string | null;
}

export interface ClassRecord {
  id: string;
  name: string;
  term: string | null;
  professor_id: string;
  created_at: string;
}

export interface AssignmentRecord {
  id: string;
  class_id: string;
  name: string;
  doc_reference: string | null;
  created_at: string;
}

export interface GroupRecord {
  id: string;
  assignment_id: string;
  name: string;
  /** Count only, for the professor's reference / license seat-tracking
   *  (decided 2026-06-29) — the backend never stores an actual roster of
   *  named students. Name resolution happens in the extension. */
  expected_size: number | null;
}

export interface DisclosureRecordEntry {
  id: string;
  class_id: string | null;
  assignment_id: string | null;
  professor_id: string;
  disclosure_text: string;
  enabled_at: string;
}

/** Mirrors extension/src/export/index.ts's ContentStrippedSummary exactly —
 *  this is the only shape evidence ever takes once it leaves the extension
 *  (FRONTEND.md F5.1, C1). Never add a `text`/excerpt field here. */
export interface ExportedSection {
  sectionLabel: string;
  sentences: string[];
}

export interface AuthorCount {
  authorId: string;
  authorName: string | null;
  originatedChars: number;
  totalSurvivingChars: number;
  originShare: number;
}

export interface ContentStrippedSummary {
  disclaimer: string;
  generatedAt: number;
  sections: ExportedSection[];
  signalNotes: string[];
  authorCounts: AuthorCount[];
}

export interface SavedSummaryRecord {
  id: string;
  assignment_id: string;
  group_id: string;
  created_at: string;
  content_stripped_payload: ContentStrippedSummary;
}
