import { config } from "../../package.json";
import type { ReviewSuggestion } from "./aiTypes";

const listeners = new Set<() => void>();
export function onSuggestionsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notifyChanged() {
  listeners.forEach((listener) => listener());
}

const KEY = `${config.prefsPrefix}.reviewSuggestions`;

export function getSuggestions(): ReviewSuggestion[] {
  try {
    const value: unknown = JSON.parse(
      String(Zotero.Prefs.get(KEY, true) || "[]"),
    );
    return Array.isArray(value) ? (value as ReviewSuggestion[]) : [];
  } catch {
    return [];
  }
}

export function migrateLegacySuggestions(): void {
  const all = getSuggestions();
  const byItem = new Map<number, ReviewSuggestion>();
  for (const entry of all) {
    const cleaned: ReviewSuggestion = {
      ...entry,
      changes: entry.changes.filter((change) => !change.before),
      tagsToAdd: entry.tagsToAdd || [],
      tagsToRemove: [],
      formalVersion: undefined,
    };
    if (
      cleaned.status === "pending" &&
      !cleaned.changes.length &&
      !cleaned.tagsToAdd.length
    )
      cleaned.status = "rejected";
    const previous = byItem.get(cleaned.itemID);
    if (
      !previous ||
      (previous.status === "pending" && cleaned.status !== "pending")
    )
      byItem.set(cleaned.itemID, cleaned);
  }
  const migrated = [...byItem.values()];
  if (JSON.stringify(migrated) !== JSON.stringify(all))
    Zotero.Prefs.set(KEY, JSON.stringify(migrated), true);
}

export function saveSuggestion(suggestion: ReviewSuggestion): void {
  const all = getSuggestions();
  if (
    all.some(
      (entry) =>
        entry.itemID === suggestion.itemID && entry.status !== "pending",
    )
  )
    return;
  Zotero.Prefs.set(
    KEY,
    JSON.stringify([
      ...all.filter((entry) => entry.itemID !== suggestion.itemID),
      suggestion,
    ]),
    true,
  );
  notifyChanged();
}

export function markReviewed(
  itemID: number,
  status: "applied" | "rejected",
): void {
  const all = getSuggestions();
  const pending = all.find(
    (entry) => entry.itemID === itemID && entry.status === "pending",
  );
  if (!pending) return;
  Zotero.Prefs.set(
    KEY,
    JSON.stringify([
      ...all.filter((entry) => entry.itemID !== itemID),
      { ...pending, status },
    ]),
    true,
  );
  notifyChanged();
}
