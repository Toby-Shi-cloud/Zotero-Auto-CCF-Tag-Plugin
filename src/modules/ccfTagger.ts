import { CCF_CATALOG, CCFLevel } from "./ccfCatalog";

const CCF_TAGS: Record<CCFLevel, string> = {
  A: "CCF-A",
  B: "CCF-B",
  C: "CCF-C",
};

const venueLookup = new Map<string, CCFLevel>();
Object.entries(CCF_CATALOG).forEach(([level, aliases]) => {
  aliases.forEach((alias) => {
    const normalized = normalizeVenueName(alias);
    if (normalized) {
      venueLookup.set(normalized, level as CCFLevel);
    }
  });
});

const pendingTaggingTasks = new Map<number, number>();
const RETRY_DELAY_MS = 1500;
const MAX_RETRIES = 5;

export function normalizeVenueName(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectCCFLevelByVenueNames(
  venueNames: string[],
): CCFLevel | null {
  for (const venueName of venueNames) {
    const normalized = normalizeVenueName(venueName);
    if (!normalized) {
      continue;
    }
    const level = venueLookup.get(normalized);
    if (level) {
      return level;
    }
  }
  return null;
}

function getCandidateVenueNames(item: Zotero.Item): string[] {
  const fieldNames = [
    "publicationTitle",
    "proceedingsTitle",
    "conferenceName",
    "bookTitle",
    "journalAbbreviation",
  ];
  const names = fieldNames
    .map((field) => String(item.getField(field) || "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function shouldRetry(venueNames: string[], attempts: number) {
  return venueNames.length === 0 && attempts < MAX_RETRIES;
}

async function tagItemByCCF(itemID: number, attempts = 0): Promise<void> {
  const item = (await Zotero.Items.getAsync(itemID)) as Zotero.Item | undefined;
  if (!item || !item.isRegularItem()) {
    return;
  }

  const venueNames = getCandidateVenueNames(item);
  const matchedLevel = detectCCFLevelByVenueNames(venueNames);
  if (!matchedLevel && shouldRetry(venueNames, attempts)) {
    scheduleCCFTagging(itemID, attempts + 1);
    return;
  }

  const desiredTag = matchedLevel ? CCF_TAGS[matchedLevel] : null;
  const existingTags = (item.getTags() || []).map((tag) => tag.tag);
  const existingCCFTags = existingTags.filter((tag) =>
    Object.values(CCF_TAGS).includes(tag as (typeof CCF_TAGS)[CCFLevel]),
  );

  let changed = false;
  for (const existingCCFTag of existingCCFTags) {
    if (existingCCFTag !== desiredTag) {
      item.removeTag(existingCCFTag);
      changed = true;
    }
  }

  if (desiredTag && !existingTags.includes(desiredTag)) {
    item.addTag(desiredTag);
    changed = true;
  }

  if (changed) {
    await item.saveTx();
  }
}

function scheduleCCFTagging(itemID: number, attempts = 0) {
  const pendingTask = pendingTaggingTasks.get(itemID);
  if (pendingTask) {
    clearTimeout(pendingTask);
  }
  const timeoutID = setTimeout(() => {
    pendingTaggingTasks.delete(itemID);
    void tagItemByCCF(itemID, attempts);
  }, RETRY_DELAY_MS) as unknown as number;
  pendingTaggingTasks.set(itemID, timeoutID);
}

export function scheduleCCFTaggingForItems(ids: Array<string | number>) {
  ids.forEach((id) => {
    const itemID = Number(id);
    if (Number.isInteger(itemID) && itemID > 0) {
      scheduleCCFTagging(itemID);
    }
  });
}

export function clearCCFTaggingTasks() {
  pendingTaggingTasks.forEach((timeoutID) => clearTimeout(timeoutID));
  pendingTaggingTasks.clear();
}
