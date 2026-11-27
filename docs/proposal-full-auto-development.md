# 知识沉淀官 · methodology 提案（待人工审批）

> 按 `knowledge-settler-core.js` 的 `submit()` 字段组织，供人工 `approve()` 前审阅。
> 预标注 category = `methodology`（可跨案例复用），附 `verification`（方法论入库的硬要求）。

## 一、提交项（可直接喂给 settler.submit）

```json
{
  "source": "manual",
  "rule": "full_auto_dev",
  "title": "全自动持续开发：常驻调度 + 产出落地 + 自动接力 + 编排汇总",
  "evidence": "cityverse-ar 端到端验证：shell 接力 #19→#20、orchestrator 读三路前置产出生成决策并投下一棒均跑通；测试数据清理后队列回到 #17",
  "rootCause": "对话 agent 没有进程，每次被叫醒只活几分钟、无状态；产物只留在 stdout/自述里会随会话消失；单棒任务做完就停，没有下一棒接力",
  "fixApproach": "常驻 daemon（launchd）轮询 agent_jobs 队列 + 产出强制落地 docs/chief-runs/<id>-<kind>.md + --then/children 自动接力 + orchestrator 编排 worker（读多份产出→生成决策→落地→投下一棒）",
  "category": "methodology",
  "verification": "report 只读 DB、队列 id 单调递增；docs/chief-runs 存在对应 <id>-decision.md；git log 显示所有改动皆由人提交"
}
```

## 二、提炼后的 insight（`_distill` 自动生成格式）

> 现象：全自动持续开发：常驻调度 + 产出落地 + 自动接力 + 编排汇总｜根因：对话 agent 没有进程，每次被叫醒只活几分钟、无状态；产物只留在 stdout/自述里会随会话消失；单棒任务做完就停，没有下一棒接力｜修复：常驻 daemon（launchd）轮询 agent_jobs 队列 + 产出强制落地 docs/chief-runs/<id>-<kind>.md + --then/children 自动接力 + orchestrator 编排 worker（读多份产出→生成决策→落地→投下一棒）

## 三、为什么是 methodology 而非 conclusion

- 它是一套**可跨案例复用**的手法：任何「对话 agent + 常驻总控」的持续开发场景都适用，不绑定 cityverse-ar 这一个仓库。
- 不含一次性事实（无批次/日期/金额/门店等结论信号），`_classify` 不会误判为 conclusion。

## 四、关联经验（建议同批审阅）

- 工作台 `Agent建设准则/08-工作台实战经验` 第三节「反幻觉：`chief report`」是这条的**前半条**——它只写了「汇报前先跑确定性命令」，本条补全「常驻调度 + 自动接力 + 编排」的完整闭环。
- 两端合起来才是完整经验：**确定性汇报（反幻觉）+ 确定性推进（自动接力）**。

## 五、边界（approve 时请人工确认）

1. 本条只登记「待 skill 化」，不在此自动生成 skill（由主 agent 用 skill-creator 完成）。
2. git 提交权、拍板权仍留给人，不属于"全自动"范畴——这是设计，不是缺口。
