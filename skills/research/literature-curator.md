---
name: 文献管家
description: Zotero 文献自动入库与治理：扫描 Downloads 新 PDF 自动导入、CrossRef 补元数据、按主题自动分组打标签、生成处理报告；Zotero 未开则静默跳过、下次自动补做。
category: research
boards: research
source: 工作台 scripts/zotero/auto_ingest.py（本地 Zotero API + CrossRef，零 token 消耗）
---

# 文献管家

Ingrid 的文献库「无人值守」管家。核心脚本在工作台内：`scripts/zotero/auto_ingest.py`，由工作台定时任务每 2 小时自动运行一次（`main.js` 的 `SCHEDULED_COMMANDS` 里的 `zotero-ingest`）。

## 它自动做什么

1. **扫描新 PDF**：扫描 `~/Downloads` 下新下载的 PDF（用 `state.json` 幂等去重，不重复导入）。
2. **导入 Zotero**：通过 Zotero 本地 API（`localhost:23119`）导入，自动识别标题/作者/年份/DOI；识别失败用 CrossRef 按文件名兜底。
3. **补元数据**：CrossRef 补缺失年份与作者（只写高置信结果）。
4. **自动分组**：按标题 + 标签分类到对应收藏夹；新主题自动新建文件夹；`99. To Review` 只放未处理文献，处理完即移出。
5. **打标签**：按标题关键词打受控主题标签。
6. **生成报告**：写当日处理摘要到数据目录 `data/zotero-automation/reports/`。

## 关键行为

- **Zotero 没开**：静默跳过，不算错误；下次（约 2 小时后）Zotero 打开会自动补做积压的 PDF。
- **不耗 API token**：走 Zotero 本地接口 + 免费 CrossRef，零额度消耗。
- **安全**：写操作带版本保护；删除是硬删除，删除前必须先备份数据库。

## 手动触发

```bash
python3 ~/Dev/Ingrids-AI-Agents/scripts/zotero/auto_ingest.py             # 立即入库 + 处理 + 出摘要
python3 ~/Dev/Ingrids-AI-Agents/scripts/zotero/auto_ingest.py --dry-run   # 只预览不写入
python3 ~/Dev/Ingrids-AI-Agents/scripts/zotero/auto_ingest.py --report weekly  # 周报
```

## 技术细节

本地 API 的坑都记在 `docs/zotero-local-api.md`：识别是异步的、导入未指定 collection 会落到当前选中文件夹、`/unread` 是系统标签要排除、DELETE 是硬删除等。
