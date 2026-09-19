export interface ItemSnapshot {
  id: number;
  libraryID: number;
  itemType: string;
  fields: Record<string, string>;
  creators: Array<{ firstName?: string; lastName?: string; name?: string }>;
  tags: string[];
  fingerprint: string;
}

export interface AcademicCandidate {
  source: "crossref" | "semantic-scholar" | "arxiv";
  sourceURL: string;
  title?: string;
  doi?: string;
  venue?: string;
  date?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  issn?: string;
  url?: string;
  abstract?: string;
  creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
  arxivID?: string;
  journalRef?: string;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
  source: string;
}
export interface ReviewSuggestion {
  id: string;
  itemID: number;
  fingerprint: string;
  status: "pending" | "rejected" | "applied";
  changes: FieldChange[];
  tagsToAdd: string[];
  tagsToRemove: string[];
  formalVersion?: AcademicCandidate;
  summary: string;
  createdAt: number;
}
