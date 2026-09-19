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
  const provider = byID<HTMLSelectElement>("ai-provider")!;
  const model = byID<HTMLSelectElement>("ai-model")!;
  const effort = byID<HTMLSelectElement>("ai-effort")!;
  const legacyURL = getPref("aiBaseURL") || "";
  if (
    getPref("aiProvider") === "openai" &&
    legacyURL &&
    !/^https:\/\/api\.openai\.com\/v1\/?$/i.test(legacyURL) &&
    !getAPIKey("custom")
  ) {
    const legacyKey = getAPIKey("openai");
    if (legacyKey) {
      await setAPIKey(legacyKey, "custom");
      setPref("aiProvider", "custom");
    }
  }
  enabled.checked = !!getPref("aiEnabled");
  baseURL.value = getPref("aiBaseURL") || "";
  provider.value = getPref("aiProvider") || "openai";
  for (const name of ["google", "openai", "anthropic", "custom"] as const) {
    const input = byID<HTMLInputElement>(`key-${name}`)!;
    input.value = getAPIKey(name);
    byID<HTMLButtonElement>(`confirm-${name}`)!.addEventListener(
      "command",
      async () => {
        await setAPIKey(input.value.trim(), name);
        if (name === "custom") setPref("aiBaseURL", baseURL.value.trim());
        if (provider.value === name) {
          const placeholder = _window.document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "请重新获取模型";
          model.replaceChildren(placeholder);
          model.disabled = true;
          setPref("aiModel", "");
        }
        _window.alert("已保存。添加或修改密钥后，请重新获取模型。");
      },
    );
  }
  const savedModel =
    getPref("aiModelProvider") === provider.value
      ? getPref("aiModel") || ""
      : "";
  if (savedModel) {
    const option = _window.document.createElement("option");
    option.value = savedModel;
    option.textContent = savedModel;
    model.replaceChildren(option);
    model.value = savedModel;
    model.disabled = false;
  }
  effort.value = getPref("aiReasoningEffort") || "";
  const save = async () => {
    setPref("aiEnabled", enabled.checked);
    setPref("aiProvider", provider.value);
    setPref("aiBaseURL", baseURL.value.trim());
    setPref("aiModel", model.value);
    setPref("aiModelProvider", provider.value);
    setPref("aiReasoningEffort", effort.value);
  };
  [enabled, baseURL, model, effort].forEach((element) =>
    element.addEventListener("change", () => void save()),
  );
  provider.addEventListener("change", () => {
    const placeholder = _window.document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请先获取模型";
    model.replaceChildren(placeholder);
    model.disabled = true;
    void save();
  });
  byID<HTMLButtonElement>("load-models")?.addEventListener(
    "command",
    async () => {
      const previous = model.value;
      await save();
      try {
        const names = await listModels();
        if (!names.length) throw new Error("服务返回了空的模型列表。");
        const placeholder = _window.document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "请选择模型";
        model.replaceChildren(
          placeholder,
          ...names.map((name) => {
            const option = _window.document.createElement("option");
            option.value = name;
            option.textContent = name;
            return option;
          }),
        );
        model.disabled = false;
        model.value = names.includes(previous) ? previous : "";
        setPref("aiModel", model.value);
        _window.alert(`已获取 ${names.length} 个模型，请从下拉列表选择。`);
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
      const progressWindow = new Zotero.ProgressWindow({
        window: _window,
        closeOnClick: false,
      });
      progressWindow.changeHeadline("AI 元数据检验");
      const progress = new progressWindow.ItemProgress(
        `chrome://${config.addonRef}/content/icons/favicon.png`,
        "正在测试 AI 连接…",
      );
      progress.setProgress(0);
      progressWindow.show();
      try {
        if (!enabled.checked) throw new Error("请先开启 AI 模式。");
        await checkAIConnection();
        progress.setText("正在读取文库条目…");
        const result = await verifyAllLibraries((done, total) => {
          const percentage = total ? Math.round((done / total) * 100) : 100;
          progress.setProgress(percentage);
          progress.setText(`正在检验：${done}/${total} 条`);
        });
        progress.setProgress(100);
        progress.setIcon("chrome://zotero/skin/tick.png");
        progress.setText(
          `检验完成：${result.scanned}/${result.total} 条，失败 ${result.failed} 条`,
        );
        progressWindow.startCloseTimer(8000);
        _window.alert(
          `AI 检验完成。已扫描 ${result.scanned}/${result.total} 条，失败 ${result.failed} 条。${result.firstError ? `\n首个错误：${result.firstError}` : ""}`,
        );
      } catch (error) {
        progress.setError();
        progress.setText(
          `检验失败：${error instanceof Error ? error.message : error}`,
        );
        progressWindow.startCloseTimer(12000);
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
