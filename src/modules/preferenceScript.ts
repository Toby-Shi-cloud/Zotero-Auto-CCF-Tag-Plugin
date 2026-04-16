import { applyCCFTagsToAllLibraries } from "./ccfTagger";
import { config } from "../../package.json";

export async function registerPrefsScripts(_window: Window) {
  const button = _window.document.querySelector(
    `#zotero-prefpane-${config.addonRef}-run-library-tagging`,
  ) as XUL.Button;

  if (!button) return;

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
