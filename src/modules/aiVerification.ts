import { getPref } from "../utils/prefs";
import { inspectWithAI } from "./aiClient";
import { searchAcademic, extractArxivID } from "./academicSearch";
import type { AcademicCandidate, ItemSnapshot } from "./aiTypes";
import { getSuggestions, markReviewed, saveSuggestion } from "./reviewStore";
import { getCCFTagsForVenue, getNatureTags } from "./ccfTagger";

const FIELDS = [
  "title",
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "bookTitle",
  "date",
  "DOI",
  "volume",
  "issue",
  "pages",
  "publisher",
  "ISSN",
  "url",
  "abstractNote",
];
let running = false;
const queued = new Set<number>();
let cancelled = false;

function safeField(item: Zotero.Item, field: string) {
  try {
    return item.getField(field).trim();
  } catch {
    return "";
  }
}
export function snapshot(item: Zotero.Item): ItemSnapshot {
  const fields = Object.fromEntries(
    FIELDS.map((field) => [field, safeField(item, field)]),
  );
  const creators = item.getCreatorsJSON().map((x) => ({
    firstName: x.firstName,
    lastName: x.lastName,
    name: x.name,
  }));
  const tags = item.getTags().map((x) => x.tag);
  return {
    id: item.id as number,
    libraryID: item.libraryID,
    itemType: item.itemType,
    fields,
    creators,
    tags,
    fingerprint: JSON.stringify({ fields, creators }),
  };
}
function needsSearch(data: ItemSnapshot) {
  const venue =
    data.fields.publicationTitle ||
    data.fields.proceedingsTitle ||
    data.fields.conferenceName ||
    data.fields.bookTitle;
  return (
    !data.fields.title || !data.fields.DOI || !venue || !!extractArxivID(data)
  );
}
function candidateChanges(item: ItemSnapshot, candidate: AcademicCandidate) {
  const map: Record<string, string | undefined> = {
    title: candidate.title,
    DOI: candidate.doi,
    publicationTitle: candidate.venue,
    date: candidate.date,
    volume: candidate.volume,
    issue: candidate.issue,
    pages: candidate.pages,
    publisher: candidate.publisher,
    ISSN: candidate.issn,
    url: candidate.url,
    abstractNote: candidate.abstract,
  };
  return Object.entries(map)
    .filter(([field, after]) => !!after && !item.fields[field])
    .map(([field, after]) => ({
      field,
      before: item.fields[field] || "",
      after: after as string,
      source: candidate.sourceURL,
    }));
}
function confidence(snapshot: ItemSnapshot, candidate: AcademicCandidate) {
  const title = (snapshot.fields.title || "").toLowerCase().replace(/\W/g, "");
  const other = (candidate.title || "").toLowerCase().replace(/\W/g, "");
  return (
    !!candidate.doi &&
    ((!!snapshot.fields.DOI &&
      snapshot.fields.DOI.toLowerCase() === candidate.doi.toLowerCase()) ||
      (title.length > 12 && (title.includes(other) || other.includes(title))))
  );
}
export async function verifyItem(item: Zotero.Item) {
  if (
    !getPref("aiEnabled") ||
    getSuggestions().some((entry) => entry.itemID === item.id) ||
    !item.isRegularItem() ||
    item.isAttachment() ||
    item.isNote()
  )
    return;
  const before = snapshot(item);
  let candidates: AcademicCandidate[] = [];
  if (needsSearch(before)) candidates = await searchAcademic(before);
  const judgement = await inspectWithAI(before, candidates);
  if (!candidates.length && judgement.queries.length)
    candidates = await searchAcademic(before, judgement.queries);
  const candidate =
    judgement.matchedCandidate !== null
      ? candidates[judgement.matchedCandidate]
      : undefined;
  const reliable =
    !!candidate && judgement.samePaper && confidence(before, candidate);
  const changes = reliable ? candidateChanges(before, candidate!) : [];
  const missing = changes;
  const existingVenue =
    before.fields.publicationTitle ||
    before.fields.proceedingsTitle ||
    before.fields.conferenceName ||
    before.fields.bookTitle ||
    "";
  const venue = existingVenue || (reliable ? candidate?.venue || "" : "");
  const desiredTags = [
    ...(await getCCFTagsForVenue(venue)),
    ...getNatureTags(venue),
  ];
  const tagsToAdd = desiredTags.filter((tag) => !before.tags.includes(tag));
  if (missing.length || tagsToAdd.length)
    saveSuggestion({
      id: String(before.id),
      itemID: before.id,
      fingerprint: before.fingerprint,
      status: "pending",
      changes: missing,
      tagsToAdd,
      tagsToRemove: [],
      summary: judgement.explanation,
      createdAt: Date.now(),
    });
}

export async function reviewItem(
  itemID: number,
  apply: boolean,
): Promise<boolean> {
  const suggestion = getSuggestions().find(
    (entry) => entry.itemID === itemID && entry.status === "pending",
  );
  if (!suggestion) return false;
  if (apply) {
    const item = await Zotero.Items.getAsync(itemID);
    // Re-check each value; stale suggestions never overwrite existing metadata.
    let changed = false;
    for (const change of suggestion.changes) {
      if (safeField(item, change.field)) continue;
      try {
        item.setField(change.field, change.after);
        changed = true;
      } catch (_) {
        // Field is unsupported by this Zotero item type.
      }
    }
    const existingTags = new Set(item.getTags().map((tag) => tag.tag));
    for (const tag of suggestion.tagsToAdd) {
      if (existingTags.has(tag)) continue;
      item.addTag(tag);
      changed = true;
    }
    if (changed) await item.saveTx();
  }
  markReviewed(itemID, apply ? "applied" : "rejected");
  return true;
}

export function enqueueVerification(id: number) {
  queued.add(id);
  void drain();
}
export async function verifyAllLibraries(
  onProgress?: (done: number, total: number) => void,
) {
  cancelled = false;
  const items: Zotero.Item[] = [];
  for (const library of Zotero.Libraries.getAll())
    if (Zotero.Libraries.isEditable(library.libraryID))
      items.push(
        ...(
          await Zotero.Items.getAll(library.libraryID, false, false, false)
        ).filter(
          (item) =>
            item.isRegularItem() && !item.isAttachment() && !item.isNote(),
        ),
      );
  let done = 0;
  let failed = 0;
  let firstError = "";
  onProgress?.(done, items.length);
  for (const item of items) {
    if (cancelled) break;
    try {
      await verifyItem(item);
    } catch (error) {
      ztoolkit.log("AI verification failed", error);
      failed += 1;
      if (!firstError)
        firstError = error instanceof Error ? error.message : String(error);
    }
    done += 1;
    onProgress?.(done, items.length);
  }
  return { scanned: done, total: items.length, failed, firstError, cancelled };
}
export function cancelVerification() {
  cancelled = true;
}
async function drain() {
  if (running) return;
  running = true;
  while (queued.size && getPref("aiEnabled")) {
    const [id] = queued;
    queued.delete(id);
    try {
      await verifyItem(await Zotero.Items.getAsync(id));
    } catch (error) {
      ztoolkit.log("AI verification failed", error);
    }
  }
  running = false;
}
