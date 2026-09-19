import { config } from "../../package.json";
import type { ReviewSuggestion } from "./aiTypes";
const KEY = `${config.prefsPrefix}.reviewSuggestions`;
export function getSuggestions(): ReviewSuggestion[] {
  try {
    return JSON.parse(String(Zotero.Prefs.get(KEY, true) || "[]"));
  } catch {
    return [];
  }
}
export function saveSuggestion(suggestion: ReviewSuggestion) {
  const all = getSuggestions().filter(
    (x) =>
      x.id !== suggestion.id &&
      !(
        x.itemID === suggestion.itemID &&
        x.fingerprint === suggestion.fingerprint &&
        x.status === "rejected"
      ),
  );
  all.push(suggestion);
  Zotero.Prefs.set(KEY, JSON.stringify(all.slice(-500)), true);
}
export function updateSuggestion(
  id: string,
  update: Partial<ReviewSuggestion>,
) {
  Zotero.Prefs.set(
    KEY,
    JSON.stringify(
      getSuggestions().map((x) => (x.id === id ? { ...x, ...update } : x)),
    ),
    true,
  );
}
