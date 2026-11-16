---
name: 文档生成
description: 把内容生成 PPT/Word/Excel/Markdown 文件并保存到「导出」目录：什么场景选哪种格式、内容怎么组织、PPT 怎么做成有图表/表格/学术配色的学术级幻灯片，用 doc_generate 工具执行。
category: office
boards: docs, research
source: workbuddy-pptx / workbuddy-docx / workbuddy-sheetagent（适配工作台 doc_generate 工具）
---

# 文档生成

用户要「做一份 PPT / Word / 表格 / Markdown」时，按本说明书组织内容并用 `doc_generate` 工具落盘。文件会保存到导出目录，返回路径给用户。

## 格式选择

| 需求 | 类型 | 说明 |
|---|---|---|
| 汇报/演示/路演/答辩 | `pptx` | 学术级幻灯片：图表 + 表格 + 标题页/章节页/双栏，用 `slides` 数组 |
| 报告/论文/纪要/公文/合同 | `docx` | Markdown 正文，用 `content` |
| 数据表/清单/对账/统计 | `xlsx` | 多个工作表，用 `sheets`（name + rows 二维数组） |
| 说明/笔记/README/速览 | `md` | 纯 Markdown 文本 |

不确定时问一句「要 PPT 还是 Word 还是表格」，别擅自决定格式。

## PPT 怎么做（重点）

**核心原则：能上图不上表、能上表不堆字。** 纯文字的 PPT 是失败的——有数据、趋势、对比、占比的内容必须可视化。

### 顶层参数

- `type`: `pptx`
- `title`: 标题（同时作文件名）
- `theme`: `academic`（默认，剑桥学术风：深海军蓝 + 剑桥蓝/青绿点缀 + 大量留白）｜`minimal`｜`corporate`
- `author`: 作者（标题页署名，可选）

### slides 每页字段

- `title` 页标题（结论，不是名词）
- `subtitle` 副标题（可选）
- `layout` 版式：`title`(标题页) / `section`(章节页) / `content`(正文，默认) / `twoCol`(双栏) / `blank`(空白)
- `bullets` 要点数组：字符串，或 `{text, sub:[...]}` 带子要点
- `charts` 图表数组（原生可编辑图表）：
  - 单系列：`{type, title, labels:[...], values:[...]}`
  - 多系列：`{type, title, labels:[...], series:[{name, values:[...]}]}`
  - `type` 取值 `bar`(柱) / `line`(折线) / `pie`(饼) / `doughnut`(环形) / `area`(面积) / `radar`(雷达)
- `table` 表格：`{headers:["列1","列2"], rows:[[...],[...]]}`
- `image` 图片绝对路径（可选，找不到会提示）
- `notes` 演讲者备注（论述细节写这里，不堆在页面上）

### 版式与结构

- 首尾用 `layout:"title"` 做标题页；每个大段开头用 `layout:"section"` 做章节页。
- 有图又有要点时，要点放左、图放右（自动布局）。
- 每页一个核心结论；每页 bullets 3–6 条、每条一句、不写整段话。

## 内容组织纪律

- **PPT**：见上「PPT 怎么做」。
- **Word**：用 Markdown 结构（# 标题、## 小节、- 列表、**加粗**）；先给结论再展开；长文分节。
- **Excel**：第一行是表头；每行一条记录；数值不混单位（单位写进表头或备注）；多维度数据分多个 sheet。

## 执行

调用 `doc_generate` 工具，参数按类型填（见上）。生成成功后把返回的文件路径告诉用户。生成前先在心里过一遍内容是否完整、该可视化的数据有没有配上图表。
