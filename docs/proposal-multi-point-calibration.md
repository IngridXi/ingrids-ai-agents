# 知识沉淀官 · methodology 提案（待人工审批）

> 按 `knowledge-settler-core.js` 的 `submit()` 字段组织，供人工 `approve()` 前审阅。
> 预标注 category = `methodology`（可跨案例复用），附 `verification`（方法论入库硬要求）。
> 对应 Obsidian 经验沉淀《编辑器缺子系统时坐标会静默错位》。

## 一、提交项（可直接喂给 settler.submit）

```json
{
  "source": "manual",
  "rule": "multi_point_calibration",
  "title": "编辑器/模拟器缺子系统导致坐标静默错位：用多点仿射校准（拖锚点人机协作），而非单点对齐或让 AI 反复猜根因",
  "evidence": "Unity 编辑器（非真机）点击采集物总是偏移：点宝箱采到香蕉、校准红块跑出十万八千里；改碰撞体/屏幕空间命中/单点平移/两点线性插值均只缓解不根治；最终三点仿射校准（金币堆/苹果/金宝箱）后全部采集正常",
  "rootCause": "编辑器没有 AR 子系统，ARCameraManager/ARCameraBackground 空转、其渲染钩子干扰相机矩阵，使 WorldToScreenPoint 与屏幕实际渲染位置静默错位——缺失子系统不报错，静默破坏某个坐标假设",
  "fixApproach": "选 3 个特征差异大的锚点解 2D 仿射映射（平移+缩放+旋转/剪切）；锚点做成可拖拽红块、由用户拖到所见物体上（人机协作校正）；参数 PlayerPrefs 持久化（一次校准反复用）；编辑器禁用空转的 AR 组件",
  "category": "methodology",
  "verification": "编辑器与真机各跑一次采集，命中点与渲染位置一致；新增同类采集物无需重新校准（映射泛化到全屏）"
}
```

## 二、提炼后的 insight（`_distill` 自动生成格式）

> 现象：编辑器/模拟器缺子系统导致坐标静默错位：用多点仿射校准（拖锚点人机协作），而非单点对齐或让 AI 反复猜根因｜根因：编辑器没有 AR 子系统，ARCameraManager/ARCameraBackground 空转、其渲染钩子干扰相机矩阵，使 WorldToScreenPoint 与屏幕实际渲染位置静默错位——缺失子系统不报错，静默破坏某个坐标假设｜修复：选 3 个特征差异大的锚点解 2D 仿射映射（平移+缩放+旋转/剪切）；锚点做成可拖拽红块、由用户拖到所见物体上（人机协作校正）；参数 PlayerPrefs 持久化；编辑器禁用空转的 AR 组件

## 三、为什么是 methodology 而非 conclusion

- 不含一次性事实（无批次/日期/金额/门店等结论信号），不会误判为 conclusion。
- 可迁移到**任何**「模拟环境缺子系统 → 坐标/状态静默错位」的场景：AR/VR/传感器/GPS/硬件加速/摄像头在编辑器与真机不一致时都适用。
- 核心手法「多点锚定拟合 + 人机协作校正」是通用方法论，非 cityverse-ar 专属。

## 四、skill 化建议（approve 后由主 agent 用 skill-creator 完成）

- 提炼成一条可复用 skill 的内核：`detect-silent-offset → place-anchors(特征差异大) → solve-affine → drag-to-calibrate → persist`。
- 关键词锚点：`静默错位 / 仿射 / 标定 / 校准 / 编辑器真机差异 / 人机协作`。

## 五、边界（approve 时请人工确认）

1. 本条只登记「待 skill 化」，不在此自动生成 skill。
2. 「人机协作校正比 AI 猜根因更可靠」是本条的方法论内核，与「AI 反幻觉」经验同属一条更大的准则——**能让人多拖几个锚点就不要 AI 反复猜**。
