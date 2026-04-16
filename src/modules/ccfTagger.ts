import { config } from "../../package.json";

type CCFTag = "CCF-A" | "CCF-B" | "CCF-C";

interface CCFEntry {
  tag: CCFTag;
  abbr?: string;
}

type CCFData = Record<string, CCFEntry>;

const CCF_JSON_PATH = `${rootURI}public/ccf.json`;
const VENU_FIELDS = [
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "bookTitle",
  "seriesTitle",
];

let ccfDataPromise: Promise<CCFData> | undefined;
let fullNameIndex: Map<string, CCFEntry> | undefined;
let abbrIndex: Map<string, CCFEntry> | undefined;
let notifierID: string | undefined;

function normalizeVenueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function loadCCFData() {
  if (!ccfDataPromise) {
    ccfDataPromise = (async () => {
      const raw = await Zotero.File.getContentsFromURLAsync(CCF_JSON_PATH);
      const parsed = JSON.parse(raw) as CCFData;

      fullNameIndex = new Map<string, CCFEntry>();
      abbrIndex = new Map<string, CCFEntry>();

      for (const [fullName, entry] of Object.entries(parsed)) {
        fullNameIndex.set(normalizeVenueName(fullName), entry);
        if (entry.abbr) {
          const normalizedAbbr = normalizeVenueName(entry.abbr);
          if (!abbrIndex.has(normalizedAbbr)) {
            abbrIndex.set(normalizedAbbr, entry);
          }
        }
      }

      return parsed;
    })().catch((error) => {
      ztoolkit.log(`[${config.addonRef}] Failed to load CCF data`, error);
      ccfDataPromise = undefined;
      fullNameIndex = undefined;
      abbrIndex = undefined;
      throw error;
    });
  }

  return ccfDataPromise;
}

function getVenueCandidates(item: Zotero.Item): string[] {
  const candidates: string[] = [];

  for (const field of VENU_FIELDS) {
    const value = item.getField(field)?.trim();
    if (value) {
      candidates.push(value);
    }
  }

  return candidates;
}

async function findCCFEntryForItem(item: Zotero.Item): Promise<CCFEntry | undefined> {
  await loadCCFData();
  if (!fullNameIndex || !abbrIndex) return;

  const candidates = getVenueCandidates(item);
  for (const venueName of candidates) {
    const key = normalizeVenueName(venueName);
    const matchedByName = fullNameIndex.get(key);
    if (matchedByName) {
      return matchedByName;
    }

    const matchedByAbbr = abbrIndex.get(key);
    if (matchedByAbbr) {
      return matchedByAbbr;
    }
  }
}

function getTagsByEntry(entry: CCFEntry): string[] {
  if (entry.tag === "CCF-A") {
    return entry.abbr ? ["CCF-A", entry.abbr] : ["CCF-A"];
  }
  return [entry.tag];
}

export async function applyCCFTagsToItem(item: Zotero.Item): Promise<boolean> {
  if (!item.isRegularItem() || item.isAttachment() || item.isNote()) {
    return false;
  }

  const entry = await findCCFEntryForItem(item);
  if (!entry) {
    return false;
  }

  let changed = false;
  for (const tag of getTagsByEntry(entry)) {
    if (item.addTag(tag)) {
      changed = true;
    }
  }

  if (changed) {
    await item.saveTx();
  }

  return changed;
}

async function applyTagsToItemIDs(ids: Array<number | string>) {
  const items = await Zotero.Items.getAsync(ids);
  const normalizedItems = Array.isArray(items) ? items : [items];

  let scanned = 0;
  let tagged = 0;

  for (const item of normalizedItems) {
    scanned += 1;
    if (await applyCCFTagsToItem(item)) {
      tagged += 1;
    }
  }

  return { scanned, tagged };
}

export async function applyCCFTagsToAllLibraries() {
  await loadCCFData();

  let scanned = 0;
  let tagged = 0;

  for (const library of Zotero.Libraries.getAll()) {
    if (!Zotero.Libraries.isEditable(library.libraryID)) {
      continue;
    }

    const items = await Zotero.Items.getAll(library.libraryID, false, false, false);
    for (const item of items) {
      scanned += 1;
      if (await applyCCFTagsToItem(item)) {
        tagged += 1;
      }
    }
  }

  return { scanned, tagged };
}

export function registerCCFNotifier() {
  if (notifierID) return;

  const callback = {
    notify: async (
      event: string,
      type: string,
      ids: Array<number | string>,
      _extraData: Record<string, unknown>,
    ) => {
      if (!addon.data.alive || type !== "item") {
        return;
      }

      if (event !== "add" && event !== "modify") {
        return;
      }

      try {
        await applyTagsToItemIDs(ids);
      } catch (error) {
        ztoolkit.log(`[${config.addonRef}] Failed to apply tags from notifier`, error);
      }
    },
  };

  notifierID = Zotero.Notifier.registerObserver(callback, ["item"]);

  Zotero.Plugins.addObserver({
    shutdown: ({ id }) => {
      if (id === addon.data.config.addonID) {
        unregisterCCFNotifier();
      }
    },
  });
}

export function unregisterCCFNotifier() {
  if (!notifierID) return;
  Zotero.Notifier.unregisterObserver(notifierID);
  notifierID = undefined;
}
