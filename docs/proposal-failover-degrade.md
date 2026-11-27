# 知识沉淀官 · methodology 提案（待人工审批）

> 按 `knowledge-settler-core.js` 的 `submit()` 字段组织，供人工 `approve()` 前审阅。
> 预标注 category = `methodology`（可跨案例复用），附 `verification`。
> 对应 Obsidian 经验沉淀《声明表要对齐实际执行器》。

## 一、提交项（可直接喂给 settler.submit）

```json
{
  "source": "manual",
  "rule": "fallback_degrade",
  "title": "声明表/配置必须对齐实际执行器，并加可用性兜底降级：宁可降级次优引擎，不让任务静默白跑",
  "evidence": "任务面板选自动分拣，TASK_TYPES 里 coding→codex、review→claude-code 等 8 种 engine 不在后台 CHAT_ENDPOINTS 里，任务创建即 failed: 未知引擎 codex；用户以为在烧 codex 额度，实际一行都没跑过，任务全白丢",
  "rootCause": "声明表（TASK_TYPES）与执行器注册表（CHAT_ENDPOINTS）不一致，声明了不存在的引擎，后台循环一查就 fail——「声明可用」与「实际能跑」之间没有兜底对齐",
  "fixApproach": "声明表全部改成后台真有的引擎，无后台通道的标 noBackground 并指回对应 agent；classify 加可用性兜底：engine 不在注册表就降级 deepseek 并回 downgradedFrom",
  "category": "methodology",
  "verification": "跑一遍全部分类任务，无一 failed: 未知引擎；降级路径有 downgradedFrom 回执可审计（证明确实是降级而非白跑）"
}
```

## 二、提炼后的 insight（`_distill` 自动生成格式）

> 现象：声明表/配置必须对齐实际执行器，并加可用性兜底降级：宁可降级次优引擎，不让任务静默白跑｜根因：声明表（TASK_TYPES）与执行器注册表（CHAT_ENDPOINTS）不一致，声明了不存在的引擎，后台循环一查就 fail——「声明可用」与「实际能跑」之间没有兜底对齐｜修复：声明表全部改成后台真有的引擎，无后台通道的标 noBackground 并指回对应 agent；classify 加可用性兜底：engine 不在注册表就降级 deepseek 并回 downgradedFrom

## 三、为什么是 methodology 而非 conclusion

- 不含一次性事实，`_classify` 预标注即 methodology（含「兜底/降级/对齐」手法词）。
- 这是「配置分层系统」的通用健壮性原则：任何「声明表 vs 执行器」「配置 vs 实际能力」「路由表 vs 实现」的分层都要兜底对齐，广泛适用于任务路由、插件注册、服务发现、降级开关等。

## 四、skill 化建议（approve 后由主 agent 用 skill-creator 完成）

- 内核：`对齐声明与执行器 → 兜底降级 → 回执可审计（downgradedFrom）`。
- 关键词锚点：`兜底 / 降级 / 对齐 / 声明表 / 执行器 / 路由 / 静默失败`。

## 五、边界（approve 时请人工确认）

1. 本条只登记「待 skill 化」，不在此自动生成 skill。
2. 配套的「贵引擎三条判据同时满足才用」是**成本治理**规则，与本条的「兜底降级」同属「健壮性 + 成本」双目标，approve 时可一起过。
