import { applyCCFTagsToAllLibraries } from "./ccfTagger";
import {
  checkAIConnection,
  getAPIKey,
  listModels,
  setAPIKey,
} from "./aiClient";
import {
  applySuggestion,
  rejectSuggestion,
  verifyAllLibraries,
} from "./aiVerification";
import { getSuggestions } from "./reviewStore";
import { getPref, setPref } from "../utils/prefs";
import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  const button = _window.document.querySelector(
    `#zotero-prefpane-${config.addonRef}-run-library-tagging`,
  ) as XUL.Button;

  if (!button) return;

  const byID = <T extends Element>(id: string) =>
    _window.document.querySelector<T>(
      `#zotero-prefpane-${config.addonRef}-${id}`,
    );
  const enabled = byID<HTMLInputElement>("ai-enabled")!;
  const baseURL = byID<HTMLInputElement>("ai-base-url")!;
  const key = byID<HTMLInputElement>("ai-key")!;
  const model = byID<HTMLInputElement>("ai-model")!;
  const effort = byID<HTMLSelectElement>("ai-effort")!;
  enabled.checked = !!getPref("aiEnabled");
  baseURL.value = getPref("aiBaseURL") || "https://api.openai.com/v1";
  key.value = getAPIKey();
  model.value = getPref("aiModel") || "";
  effort.value = getPref("aiReasoningEffort") || "";
  const save = async () => {
    setPref("aiEnabled", enabled.checked);
    setPref("aiBaseURL", baseURL.value.trim() || "https://api.openai.com/v1");
    setPref("aiModel", model.value.trim());
    setPref("aiReasoningEffort", effort.value);
    await setAPIKey(key.value.trim());
  };
  [enabled, baseURL, key, model, effort].forEach((element) =>
    element.addEventListener("change", () => void save()),
  );
  byID<HTMLButtonElement>("load-models")?.addEventListener(
    "command",
    async () => {
      await save();
      try {
        const names = await listModels();
        const list = byID<HTMLDataListElement>("models")!;
        list.replaceChildren(
          ...names.map((name) => {
            const option = _window.document.createElement("option");
            option.value = name;
            return option;
          }),
        );
      } catch (error) {
        _window.alert(
          `加载模型失败：${error instanceof Error ? error.message : error}`,
        );
      }
    },
  );
  byID<HTMLButtonElement>("test-ai")?.addEventListener("command", async () => {
    await save();
    try {
      await checkAIConnection();
      _window.alert("连接成功。");
    } catch (error) {
      _window.alert(
        `连接失败：${error instanceof Error ? error.message : error}`,
      );
    }
  });
  byID<HTMLButtonElement>("run-ai-library")?.addEventListener(
    "command",
    async (event: Event) => {
      await save();
      const target = event.currentTarget as HTMLButtonElement;
      target.disabled = true;
      try {
        const result = await verifyAllLibraries();
        _window.alert(
          `AI 检验完成。已扫描 ${result.scanned}/${result.total} 条。`,
        );
      } catch (error) {
        _window.alert(
          `AI 检验失败：${error instanceof Error ? error.message : error}`,
        );
      } finally {
        target.disabled = false;
      }
    },
  );
  byID<HTMLButtonElement>("view-reviews")?.addEventListener(
    "command",
    async () => {
      const pending = getSuggestions().filter((x) => x.status === "pending");
      if (!pending.length) return _window.alert("没有待确认结果。");
      for (const suggestion of pending) {
        const selected = suggestion.changes
          .filter((change) =>
            _window.confirm(
              `条目 ${suggestion.itemID}\n${suggestion.summary}\n\n应用此字段？\n${change.field}:\n${change.before} → ${change.after}`,
            ),
          )
          .map((change) => change.field);
        const applyTags =
          (!suggestion.tagsToAdd.length && !suggestion.tagsToRemove.length) ||
          _window.confirm(
            `条目 ${suggestion.itemID}\n\n应用标签变更？\n新增：${suggestion.tagsToAdd.join(", ") || "无"}\n删除：${suggestion.tagsToRemove.join(", ") || "无"}`,
          );
        const addFormal =
          !suggestion.formalVersion ||
          _window.confirm(
            `条目 ${suggestion.itemID}\n\n新增并关联正式发表版本？\n${suggestion.formalVersion.title || ""}\n${suggestion.formalVersion.venue || ""}\n${suggestion.formalVersion.doi || ""}`,
          );
        if (selected.length || applyTags || addFormal)
          await applySuggestion(suggestion.id, selected, applyTags, addFormal);
        else rejectSuggestion(suggestion.id);
      }
    },
  );

  button.addEventListener("command", async () => {
    button.disabled = true;
    try {
      const result = await applyCCFTagsToAllLibraries();
      _window.alert(
        `CCF 标签处理完成。已扫描 ${result.scanned} 条， 新增标签 ${result.tagged} 条。`,
      );
    } catch (error) {
      ztoolkit.log("Failed to apply CCF tags for library", error);
      _window.alert("批量添加 CCF 标签失败，请查看 Zotero 日志。");
    } finally {
      button.disabled = false;
    }
  });
}
