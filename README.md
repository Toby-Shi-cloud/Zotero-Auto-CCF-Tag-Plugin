# Zotero Auto CCF Tag Plugin

为 Zotero 文献自动添加 CCF 标签的插件。

## 功能

- 读取 `public/ccf.json` 中的 CCF 会议/期刊映射数据。
- 当新条目导入并完成元数据更新后，自动按会议/期刊名称添加标签：
  - CCF-A：添加 `CCF-A` + 对应简称（若有）
  - CCF-B / CCF-C：添加对应等级标签
  - 未匹配：不添加标签
- 在插件设置页提供“一键全库补全 CCF 标签”按钮。
- 标签添加为幂等操作，不会重复添加同一标签。
- AI 检验仅提出缺失字段和缺失标签的补全建议，不覆盖已有内容。
- Zotero 条目详情侧栏显示待确认文章和建议来源；应用或跳过后记录确认状态，后续检验不再处理该文章。

## 开发

```bash
npm install
npm run lint:check
npm run build
npm test
```
