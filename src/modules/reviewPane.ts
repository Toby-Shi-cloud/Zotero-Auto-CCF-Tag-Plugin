import { config } from "../../package.json";
import {
  getSuggestions,
  migrateLegacySuggestions,
  onSuggestionsChanged,
} from "./reviewStore";
import { reviewItem } from "./aiVerification";

const PANE_ID = `${config.addonRef}-reviews`;
const refreshers = new Map<HTMLDivElement, () => void>();
let unsubscribe: (() => void) | undefined;

async function render(doc: Document, body: HTMLDivElement) {
  body.replaceChildren();
  const entries = getSuggestions();
  const pending = entries.filter((entry) => entry.status === "pending");
  const reviewed = entries.filter((entry) => entry.status !== "pending");
  const heading = doc.createElement("p");
  heading.textContent = `待确认 ${pending.length} 篇 · 已确认 ${reviewed.length} 篇`;
  body.append(heading);
  for (const entry of [...pending, ...reviewed]) {
    const item = await Zotero.Items.getAsync(entry.itemID);
    const card = doc.createElement("div");
    card.style.cssText =
      "padding:8px;margin:6px 0;border:1px solid var(--fill-quinary,#ccc);border-radius:5px;";
    const title = doc.createElement("strong");
    title.textContent = item?.getField("title") || `条目 ${entry.itemID}`;
    card.append(title);
    const identity = doc.createElement("p");
    identity.textContent = `Zotero 条目 ${entry.itemID}`;
    card.append(identity);
    const status = doc.createElement("p");
    status.textContent =
      entry.status === "pending"
        ? "待确认补全"
        : entry.status === "applied"
          ? "已应用，后续跳过"
          : "已检查，后续跳过";
    card.append(status);
    for (const change of entry.changes) {
      const detail = doc.createElement("p");
      detail.textContent = `${change.field}：${change.after}`;
      card.append(detail);
      if (change.source) {
        const source = doc.createElement("p");
        source.textContent = `来源：${change.source}`;
        card.append(source);
      }
    }
    if (entry.tagsToAdd.length) {
      const tags = doc.createElement("p");
      tags.textContent = `新增标签：${entry.tagsToAdd.join("、")}`;
      card.append(tags);
    }
    if (entry.status === "pending") {
      for (const [label, apply] of [
        ["应用补全", true],
        ["已检查，跳过", false],
      ] as const) {
        const button = doc.createElement("button");
        button.textContent = label;
        button.style.marginRight = "6px";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await reviewItem(entry.itemID, apply);
          } catch (error) {
            ztoolkit.log("Review failed", error);
            button.disabled = false;
          }
        });
        card.append(button);
      }
    }
    body.append(card);
  }
}

export function registerReviewPane() {
  migrateLegacySuggestions();
  unsubscribe = onSuggestionsChanged(() =>
    refreshers.forEach((refresh) => refresh()),
  );
  Zotero.ItemPaneManager.registerSection({
    paneID: PANE_ID,
    pluginID: config.addonID,
    sidenav: {
      icon: `chrome://${config.addonRef}/content/icons/favicon.png`,
      l10nID: "review-pane-tooltip",
    },
    header: {
      icon: `chrome://${config.addonRef}/content/icons/favicon.png`,
      l10nID: "review-pane-title",
    },
    onInit: ({ body, refresh }) => {
      refreshers.set(body, refresh);
    },
    onDestroy: ({ body }) => {
      refreshers.delete(body);
    },
    onAsyncRender: async ({ doc, body }) => {
      await render(doc, body);
    },
  });
}

export function unregisterReviewPane() {
  unsubscribe?.();
  refreshers.clear();
  Zotero.ItemPaneManager.unregisterSection(PANE_ID);
}
