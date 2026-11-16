---
name: 第二大脑
description: 本地「第二大脑」知识库：收件箱 raw/ → ingest 提炼成结构化 wiki（sources/entities/concepts/synthesis + index.md + 双向链接）→ 检索提问 → lint 健康检查。用 brain_ingest / brain_lint / brain_index 工具执行。
category: research
boards: research
source: NicholasSpisak/second-brain（LLM Wiki 模式，适配工作台 brain_* 工具）
---

# 第二大脑（Second Brain）

把 Obsidian 库（或任意目录）组织成一个「收件箱 → 结构化 wiki → 双向链接」的第二大脑，让知识越用越值钱，而不是一堆散落的笔记。

## 目录结构

```
<库>/
├── raw/             收件箱：丢原始材料（文章、笔记、转录、网页抓取）
│   └── archive/     ingest 后自动归档
└── wiki/            结构化知识（AI 维护）
    ├── sources/     每个来源一篇总结
    ├── entities/    人物·组织·产品·工具
    ├── concepts/    概念·框架·理论·方法
    ├── synthesis/   对比·分析·主题综合
    ├── index.md     总目录
    └── log.md       操作记录
```

## 工作流

1. **收集**：把要沉淀的材料写进 `raw/`（用户丢进来的，或你抓取/转录后放进去）。
2. **ingest**：调 `brain_ingest`（可传 `vault` 指定库，默认主库）。它会用 LLM 把每份材料提炼成分类 wiki 页面 + `[[双链]]`，更新 index.md / log.md，并归档原文件。无 LLM 时降级为「直接归档到 sources/」。
3. **提问**：调 `db_query` 检索已 ingest 的内容；或在 Obsidian 里顺着 `[[双链]]` 和图谱视图浏览。
4. **lint**：定期调 `brain_lint` 查坏 `[[双链]]` 和 index 不同步；调 `brain_index` 重建总目录。

## 页面分类（category）

- `sources`：对一份来源/文章的**整体总结**。
- `entities`：核心是**一个人/组织/产品/工具**。
- `concepts`：核心是一个**概念/框架/理论/方法**。
- `synthesis`：**多来源对比、分析、主题综合**。

## 双向链接铁律

- 页面正文用 `[[概念名词]]` 链接到相关概念/实体，每篇 2–6 个，链接写简短名词、不带路径。
- 链接指向**还不存在的页面**是正常的（红链=待补），用 `brain_lint` 能列出所有红链，按需补页面。

## 职责边界

- AI 是「图书管理员」，用户是「策展人」：AI 负责 ingest / 维护链接 / 建索引，**不替用户判断某材料值不值得留**。
- 只 ingest `raw/` 里用户明确放进去的材料，不擅自扫描、不擅自删用户手写笔记。
- 一个库一套 wiki，别把多个用途混进同一个 vault。
