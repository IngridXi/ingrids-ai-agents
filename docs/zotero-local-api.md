# Zotero 本地 API 技术文档

Zotero 7 的本地 HTTP API 运行在 `http://localhost:23119`，可读写当前打开的文库。以下内容为实测验证过的用法（Zotero 7.x）。

## 一、鉴权

| 项 | 值来源 |
|----|--------|
| userID | 数据库 `~/Zotero/zotero.sqlite` → `SELECT userID FROM users LIMIT 1` |
| Server-ID | 同库 → `SELECT value FROM settings WHERE setting='localAPI' AND key='serverID'` |
| API-Key | `~/Library/Application Support/Zotero/Profiles/<profile>/localAPIKeys.json` → `keys[0].key` |

- **GET 读取无需鉴权**，直接请求即可。
- **写操作**（POST/PATCH/DELETE）需要两个请求头：

```
Zotero-Server-ID: <serverID>
Zotero-API-Key: <apiKey>
```

- PATCH/DELETE 还需带版本保护头：`If-Unmodified-Since-Version: <version>`（version 从 GET 响应或 `Last-Modified-Version` 头获取）。

## 二、常用端点

Base：`http://localhost:23119/api/users/{userID}`

| 操作 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 列集合 | GET | `/collections?limit=100` | 返回集合数组，`data.parentCollection` 为 false 表示顶层 |
| 读集合条目 | GET | `/collections/{key}/items` | 返回该集合直接条目 |
| 创建集合 | POST | `/collections` | **body 必须是 JSON 数组**，如 `[{"name":"X","parentCollection":false}]` |
| 重命名集合 | PATCH | `/collections/{key}` | body `{"name":"新名"}`，带版本头 |
| 删除集合 | DELETE | `/collections/{key}` | 带版本头 |
| 读条目 | GET | `/items/{key}` | 返回 `{key, version, data}` |
| 改条目 | PATCH | `/items/{key}` | body 里放要改的字段，带版本头 |
| 删条目 | DELETE | `/items/{key}` | **硬删除**，带版本头 |
| 创建条目 | POST | `/items` | body 为 JSON 数组 `[{...}]`，返回 `successful.0.key` |

## 二之补充：导入 PDF（connector 端点）

这些端点走 `http://localhost:23119/connector/...`，**无需鉴权**（无 API-Key/Server-ID），用于把 PDF 导入 Zotero 并自动识别元数据。

| 操作 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 导入 PDF 并识别 | POST | `/connector/saveStandaloneAttachment` | `Content-Type: application/pdf` + `X-Metadata: {"sessionID":"x","url":"file://...","title":"文件名.pdf"}`，body 为 PDF 二进制。返回 `{"canRecognize":true}`(201)。Zotero 后台识别元数据并创建父条目 |
| 创建条目 | POST | `/connector/saveItems` | body `{"items":[{...}],"uri":"...","sessionID":"x"}`，返回 201（不返回 key） |

要点：
- `saveStandaloneAttachment` 识别是**异步**的：先建 attachment（title=文件名），识别成功后新建 parent 并把 attachment 挂上去，且 attachment 的 title 会被改写为 "PDF"。因此定位新条目不能只靠 title==文件名，要靠 `dateAdded > 上传前时间戳` 找新建的 PDF 附件，再查其 `parentItem`。
- 识别失败的 PDF 只会留下独立 attachment（无 parent），需 CrossRef 按文件名兜底或人工处理。
- ⚠️ **默认落点坑（2026-11-27 踩过）**：`X-Metadata` 若不指定 collection，Zotero 会把新条目保存到**用户当前选中的集合**（桌面端正在浏览的文件夹）。如果用户当时恰好点开了某个文件夹（如 14），新导入的 PDF 会全部被塞进那个文件夹，而不是「未分类/To Review」。**修复**：导入成功后立即 PATCH 新 parent 的 `collections` 强制置为 `99. To Review`，再由 process_pending 正确分类（见 `auto_ingest.py::_reset_to_toreview`）。

## 三、移动条目到集合（重要）

⚠️ `POST /collections/{key}/items` 会返回 **405 Method not allowed**（本地 API 不支持）。

正确做法是 **PATCH 条目的 `collections` 字段**：

```python
# 读取当前归属，合并目标集合 key，避免覆盖
item = get("/items/{itemKey}")
cols = set(item["data"].get("collections") or [])
cols.add(target_collection_key)
patch("/items/{itemKey}", {"collections": sorted(cols)}, version=item["version"])
```

## 四、删除语义（重要）

- 本地 API 的 `DELETE /items/{key}` 是**硬删除**，直接物理移除，**不进回收站**。
- `deletedItems` 表只记录「同步用」的历史删除，本地 API 不会写它。
- 删除父条目时，其子附件（attachment）和笔记（note）会一并删除。
- **因此删除前必须备份数据库**，并征得用户同意。

## 五、数据库关键表（只读诊断用）

| 表 | 关键列 | 用途 |
|----|--------|------|
| `items` | itemID, key, dateAdded, itemTypeID, libraryID | 所有条目（含附件/笔记） |
| `itemTypes` | itemTypeID, typeName | 类型：journalArticle/book/attachment/note/annotation/dataset 等 |
| `collections` | collectionID, key, collectionName, parentCollectionID | 收藏夹（parentCollectionID=0 为顶层） |
| `collectionItems` | collectionID, itemID | 条目↔收藏夹 多对多 |
| `itemData`/`itemDataValues`/`fields` | 通过 fieldID 关联 | 元数据（title/DOI/date 等） |
| `itemCreators`/`creators` | creatorID, lastName | 作者 |
| `itemTags`/`tags` | tagID, name | 标签 |
| `itemAttachments` | parentItemID | 附件 |
| `itemNotes` | parentItemID | 笔记 |
| `deletedItems` | itemID, dateDeleted | 同步用删除记录（本地 API 不写） |

**取元数据字段的惯用 SQL**（title 为例）：

```sql
SELECT idv.value FROM itemData id
JOIN itemDataValues idv ON id.valueID = idv.valueID
WHERE id.itemID = ? AND id.fieldID = (SELECT fieldID FROM fields WHERE fieldName='title')
```

## 六、条目类型过滤

统计「文献」时要排除附属条目：`typeName NOT IN ('attachment','note','annotation')`。

## 七、注意事项

- 用户可能在对话过程中**实时编辑** Zotero，写操作前重读最新状态。
- 写集合用 JSON 数组；单个对象会被忽略或报错。
- 版本号用字符串传递，不要转成数字。
