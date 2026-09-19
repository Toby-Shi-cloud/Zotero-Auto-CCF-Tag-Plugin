import { getPref } from "../utils/prefs";
import { inspectWithAI } from "./aiClient";
import { searchAcademic, extractArxivID } from "./academicSearch";
import type {
  AcademicCandidate,
  ItemSnapshot,
  ReviewSuggestion,
} from "./aiTypes";
import {
  saveSuggestion,
  getSuggestions,
  updateSuggestion,
} from "./reviewStore";
import {
  getCCFTagsForVenue,
  getNatureTags,
  getPluginOwnedTags,
} from "./ccfTagger";

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
    .filter(([field, after]) => !!after && after !== item.fields[field])
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
  const missing = changes.filter((x) => !x.before);
  const conflicts = changes.filter((x) => x.before);
  const existingVenue =
    before.fields.publicationTitle ||
    before.fields.proceedingsTitle ||
    before.fields.conferenceName ||
    before.fields.bookTitle ||
    "";
  const venue = reliable ? candidate?.venue || existingVenue : existingVenue;
  const desiredTags = [
    ...(await getCCFTagsForVenue(venue)),
    ...getNatureTags(venue),
  ];
  const ccfTags = before.tags.filter((x) => /^CCF-[ABC]$/.test(x));
  const ownedTags = getPluginOwnedTags(before.id);
  const tagsToRemove = reliable
    ? [
        ...ccfTags,
        ...ownedTags.filter((tag) => before.tags.includes(tag)),
      ].filter(
        (tag, index, all) =>
          !desiredTags.includes(tag) && all.indexOf(tag) === index,
      )
    : [];
  const tagsToAdd = desiredTags.filter((tag) => !before.tags.includes(tag));
  const venueConflict = conflicts.some((change) =>
    [
      "publicationTitle",
      "proceedingsTitle",
      "conferenceName",
      "bookTitle",
    ].includes(change.field),
  );
  // Missing, reliable values are applied without review. Existing values and all destructive changes remain reviewable.
  if (missing.length || (tagsToAdd.length && !venueConflict))
    await applyChanges(
      item,
      before.fingerprint,
      missing,
      venueConflict ? [] : tagsToAdd,
      [],
    );
  if (
    conflicts.length ||
    tagsToRemove.length ||
    (extractArxivID(before) && candidate && candidate.source !== "arxiv")
  ) {
    const suggestion: ReviewSuggestion = {
      id: `${item.id}:${Date.now()}`,
      itemID: item.id as number,
      fingerprint: before.fingerprint,
      status: "pending",
      changes: conflicts,
      tagsToAdd: venueConflict ? tagsToAdd : [],
      tagsToRemove,
      formalVersion:
        extractArxivID(before) && candidate && candidate.source !== "arxiv"
          ? candidate
          : undefined,
      summary: judgement.explanation,
      createdAt: Date.now(),
    };
    saveSuggestion(suggestion);
  }
}
async function applyChanges(
  item: Zotero.Item,
  fingerprint: string,
  changes: Array<{ field: string; before: string; after: string }>,
  add: string[],
  remove: string[],
) {
  if (snapshot(item).fingerprint !== fingerprint || !getPref("aiEnabled"))
    return;
  for (const change of changes) {
    if (!safeField(item, change.field)) {
      try {
        item.setField(change.field, change.after);
      } catch (_) {
        // Field is unsupported by this Zotero item type.
      }
    }
  }
  add.forEach((tag) => item.addTag(tag));
  remove.forEach((tag) => item.removeTag(tag));
  if (changes.length || add.length || remove.length) await item.saveTx();
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
export async function applySuggestion(
  id: string,
  selectedFields?: string[],
  applyTags = true,
  addFormalVersion = true,
) {
  const s = getSuggestions().find((x) => x.id === id);
  if (!s || s.status !== "pending") return;
  const item = await Zotero.Items.getAsync(s.itemID);
  if (snapshot(item).fingerprint !== s.fingerprint) return;
  const changes = selectedFields
    ? s.changes.filter((change) => selectedFields.includes(change.field))
    : s.changes;
  for (const change of changes) {
    try {
      item.setField(change.field, change.after);
    } catch (_) {
      // Field is unsupported by this Zotero item type.
    }
  }
  if (applyTags) {
    s.tagsToAdd.forEach((tag) => item.addTag(tag));
    s.tagsToRemove.forEach((tag) => item.removeTag(tag));
  }
  if (addFormalVersion && s.formalVersion)
    await createOrRelateFormalVersion(item, s.formalVersion);
  await item.saveTx();
  updateSuggestion(id, { status: "applied" });
}
export function rejectSuggestion(id: string) {
  updateSuggestion(id, { status: "rejected" });
}

async function createOrRelateFormalVersion(
  item: Zotero.Item,
  candidate: AcademicCandidate,
) {
  const doi = candidate.doi?.toLowerCase();
  const all = await Zotero.Items.getAll(item.libraryID, false, false, false);
  const existing =
    doi &&
    all.find(
      (other) =>
        other.id !== item.id && safeField(other, "DOI").toLowerCase() === doi,
    );
  if (existing) {
    item.addRelatedItem(existing);
    existing.addRelatedItem(item);
    await existing.saveTx();
    return;
  }
  const formal = new Zotero.Item(
    candidate.venue ? "conferencePaper" : "journalArticle",
  );
  formal.libraryID = item.libraryID;
  const fields: Record<string, string | undefined> = {
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
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    try {
      formal.setField(field, value);
    } catch (_) {
      // Field is unsupported by the chosen item type.
    }
  }
  if (candidate.creators?.length)
    formal.setCreators(
      candidate.creators.map((creator) => ({
        ...creator,
        creatorType: "author",
      })),
    );
  item
    .getCollections()
    .forEach((collectionID) => formal.addToCollection(collectionID));
  formal.addTag("正式发表版本");
  await formal.saveTx();
  item.addRelatedItem(formal);
  formal.addRelatedItem(item);
  await formal.saveTx();
}
