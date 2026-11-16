---
name: 文档生成
description: 把内容生成 PPT/Word/Excel/Markdown 文件并保存到「导出」目录：什么场景选哪种格式、内容怎么组织、用 doc_generate 工具执行。
category: office
boards: docs
source: workbuddy-pptx / workbuddy-docx / workbuddy-sheetagent（适配工作台 doc_generate 工具）
---

# 文档生成

用户要「做一份 PPT / Word / 表格 / Markdown」时，按本说明书组织内容并用 `doc_generate` 工具落盘。文件会保存到导出目录，返回路径给用户。

## 格式选择

| 需求 | 类型 | 说明 |
|---|---|---|
| 汇报/演示/路演/答辩 | `pptx` | 每页一个标题 + 若干要点，用 `slides` 数组 |
| 报告/论文/纪要/公文/合同 | `docx` | Markdown 正文，用 `content` |
| 数据表/清单/对账/统计 | `xlsx` | 多个工作表，用 `sheets`（name + rows 二维数组） |
| 说明/笔记/README/速览 | `md` | 纯 Markdown 文本 |

不确定时问一句「要 PPT 还是 Word 还是表格」，别擅自决定格式。

## 内容组织纪律

- **PPT**：每页只讲一个点；标题是结论不是名词（「营收增长 32%」优于「营收情况」）；每页 bullets 3–6 条、每条一句、不写整段话；一页别塞超过 6 条。
- **Word**：用 Markdown 结构（# 标题、## 小节、- 列表、**加粗**）；先给结论再展开；长文分节。
- **Excel**：第一行是表头；每行一条记录；数值不混单位（单位写进表头或备注）；多维度数据分多个 sheet。

## 执行

调用 `doc_generate` 工具，参数按类型填：

- `type`: `pptx` / `docx` / `xlsx` / `md`
- `title`: 文档标题（同时作文件名）
- `pptx` 用 `slides: [{ title, bullets: [...] }]`
- `docx` / `md` 用 `content`（Markdown 正文）
- `xlsx` 用 `sheets: [{ name, rows: [[...]] }]`

生成成功后把返回的文件路径告诉用户。生成前先在心里过一遍内容是否完整、有没有遗漏用户要的要点。
