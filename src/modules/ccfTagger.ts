import { config } from "../../package.json";

type CCFTag = "CCF-A" | "CCF-B" | "CCF-C";

interface CCFEntry {
  tag: CCFTag;
  abbr?: string;
}

type CCFData = Record<string, CCFEntry>;

const CCF_JSON_PATH = `${rootURI}public/ccf.json`;
const VENUE_FIELDS = [
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "bookTitle",
  "seriesTitle",
];
const ORDINAL_BASE_WORDS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
  "hundredth",
];
const ORDINAL_TENS_WORDS = [
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];
const ORDINAL_UNIT_WORD_PATTERN =
  "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth";
const EDITION_WORD_PATTERN = [
  ORDINAL_BASE_WORDS.join("|"),
  ...ORDINAL_TENS_WORDS.map(
    (tens) => `${tens}[- ](?:${ORDINAL_UNIT_WORD_PATTERN})`,
  ),
].join("|");
const EDITION_WORD_REGEX = new RegExp(`\\b(?:${EDITION_WORD_PATTERN})\\b`, "g");

let ccfDataPromise: Promise<CCFData> | undefined;
let fullNameIndex: Map<string, CCFEntry> | undefined;
let abbrIndex: Map<string, CCFEntry> | undefined;
let sortedFullNameKeys: string[] | undefined;
let notifierID: string | undefined;
const suppressedModifyEvents = new Set<number>();

function stripEditionWords(value: string): string {
  EDITION_WORD_REGEX.lastIndex = 0;
  return value.replace(EDITION_WORD_REGEX, "");
}

function normalizeVenueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getItemFieldSafe(item: Zotero.Item, field: string) {
  try {
    return item.getField(field)?.trim();
  } catch (_) {
    return "";
  }
}

function getVenueNameVariants(name: string) {
  const normalized = normalizeVenueName(name);
  const variants = new Set<string>([normalized]);
  const normalizeSpaces = (value: string) => value.replace(/\s+/g, " ").trim();

  const withoutProceedingsPrefix = normalized.replace(
    /^proceedings of (the )?/,
    "",
  );
  variants.add(normalizeSpaces(withoutProceedingsPrefix));

  const withoutLeadingYear = withoutProceedingsPrefix.replace(
    /^(19|20)\d{2}\s+/,
    "",
  );
  variants.add(normalizeSpaces(withoutLeadingYear));

  const withoutEditionNumber = withoutLeadingYear.replace(
    /\b\d+(st|nd|rd|th)\b/g,
    "",
  );
  variants.add(normalizeSpaces(withoutEditionNumber));

  const withoutEditionWord = stripEditionWords(withoutEditionNumber);
  variants.add(normalizeSpaces(withoutEditionWord));

  return Array.from(variants).filter(Boolean);
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

      sortedFullNameKeys = Array.from(fullNameIndex.keys()).sort(
        (a, b) => b.length - a.length,
      );

      return parsed;
    })().catch((error) => {
      ztoolkit.log(`[${config.addonRef}] Failed to load CCF data`, error);
      ccfDataPromise = undefined;
      fullNameIndex = undefined;
      abbrIndex = undefined;
      sortedFullNameKeys = undefined;
      throw error;
    });
  }

  return ccfDataPromise;
}

function getVenueCandidates(item: Zotero.Item): string[] {
  const candidates: string[] = [];

  for (const field of VENUE_FIELDS) {
    const value = getItemFieldSafe(item, field);
    if (value) {
      candidates.push(value);
    }
  }

  return candidates;
}

async function findCCFEntryForItem(
  item: Zotero.Item,
): Promise<CCFEntry | undefined> {
  await loadCCFData();
  if (!fullNameIndex || !abbrIndex || !sortedFullNameKeys) return undefined;

  const candidates = getVenueCandidates(item);
  for (const venueName of candidates) {
    const variants = getVenueNameVariants(venueName);
    for (const key of variants) {
      const matchedByName = fullNameIndex.get(key);
      if (matchedByName) {
        return matchedByName;
      }

      const matchedByAbbr = abbrIndex.get(key);
      if (matchedByAbbr) {
        return matchedByAbbr;
      }

      const includedFullName = sortedFullNameKeys.find((fullName) =>
        key.includes(fullName),
      );
      if (includedFullName) {
        return fullNameIndex.get(includedFullName);
      }
    }
  }

  return undefined;
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
    if (typeof item.id === "number") {
      suppressedModifyEvents.add(item.id);
    }
    await item.saveTx();
  }

  return changed;
}

async function applyTagsToItemIDs(ids: Array<number | string>) {
  const fetchedItems = await Promise.all(
    ids.map((id) => Zotero.Items.getAsync(id)),
  );

  let scanned = 0;
  let tagged = 0;

  for (const item of fetchedItems) {
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

    const items = await Zotero.Items.getAll(
      library.libraryID,
      false,
      false,
      false,
    );
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

      if (event === "modify") {
        const activeIDs = ids.filter(
          (id): id is number => typeof id === "number",
        );
        const shouldSuppress = activeIDs.some((id) =>
          suppressedModifyEvents.delete(id),
        );
        if (shouldSuppress) {
          return;
        }
      }

      try {
        await applyTagsToItemIDs(ids);
      } catch (error) {
        ztoolkit.log(
          `[${config.addonRef}] Failed to apply tags from notifier`,
          error,
        );
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
