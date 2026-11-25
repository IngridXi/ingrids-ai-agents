#!/bin/bash
# 伦理场景库 + 法务知识库 批量生成（分批限速，控温，跑完自动写 GitHub）
#
# 设计原则（应对"不要全量跑、怕烫"）：
#   - 每批只跑少量（法务 5 条 / 伦理 3 条）
#   - 批间强制冷却（sleep），让 CPU/GPU 降温
#   - 幂等续跑：脚本可随时 Ctrl+C / 重启，进度不丢
#   - 每 15 分钟做一次本地 git 快照；全部跑完后 push 到 GitHub
#
# 进度查看：tail -f ~/Dev/Ingrids-AI-Agents/agents/ethics-chat/batch-run.log
set -uo pipefail

DIR="$HOME/Dev/Ingrids-AI-Agents/agents/ethics-chat"
REPO="$HOME/Dev/Ingrids-AI-Agents"
LOG="$DIR/batch-run.log"
cd "$DIR" || exit 1
exec >>"$LOG" 2>&1

echo "================================================================="
echo "[batch] 启动 $(date '+%F %T')"
echo "================================================================="

LEGAL_BATCH=5         # 法务库每批条数（单模型，较快）
ETHICS_BATCH=3        # 伦理场景每批条数（双模型流水线，最烫）
COOLDOWN_LEGAL=90     # 法务批间冷却秒
COOLDOWN_ETHICS=150   # 伦理批间冷却秒
SNAPSHOT_INTERVAL=900 # 每 15 分钟做一次本地 git 快照

# ---- 屏幕常亮（防显示器/系统睡眠），脚本结束自动关闭 ----
caffeinate -dimsu &
CAFF_PID=$!
trap 'echo "[batch] 收尾：关闭屏幕常亮"; kill $CAFF_PID 2>/dev/null; true' EXIT INT TERM
echo "[batch] 屏幕常亮已开启 (caffeinate pid=$CAFF_PID)"

cooldown() { local s=$1; echo "--- 冷却 ${s}s（控温）$(date '+%T') ---"; sleep "$s"; }

git_snapshot() {
  cd "$REPO" || return
  git add -A
  git commit -m "自动：伦理场景/法务库批量生成进度快照 $(date '+%F %T')" --quiet || true
  cd "$DIR" || exit 1
}

count_done() {
  node -e "try{console.log(Object.keys(require('./run-progress.json')).length)}catch(e){console.log(0)}" 2>/dev/null || echo 0
}

# ================= 阶段 1：法务知识库补齐 =================
echo ""
echo ">>> [阶段1] 法务知识库补齐 <<<"
while true; do
  MISSING=$(node legal-generate.js --dry-run 2>&1 | sed -n 's/待生成 \([0-9]*\) 条.*/\1/p' | head -1)
  MISSING=${MISSING:-0}
  echo "[legal] 剩余 $MISSING 条"
  if [ "$MISSING" -le 0 ]; then echo ">>> 法务库全部生成完成 <<<"; break; fi
  node legal-generate.js --limit "$LEGAL_BATCH" || echo "[legal] 本轮存在失败项，继续下一批"
  cooldown "$COOLDOWN_LEGAL"
done
git_snapshot

# ================= 阶段 2：伦理场景归档 =================
echo ""
echo ">>> [阶段2] 伦理场景归档 <<<"
TOTAL=$(node -e "console.log(require('./scenes.json').length)" 2>/dev/null || echo 0)
LAST_SNAP=$(date +%s)
while true; do
  node run-scenes.js --limit "$ETHICS_BATCH" || echo "[ethics] 本轮存在失败项，继续下一批"
  DONE=$(count_done)
  echo "[ethics] 已完成 $DONE / $TOTAL"
  if [ "$DONE" -ge "$TOTAL" ]; then echo ">>> 伦理场景全部完成 <<<"; break; fi
  NOW=$(date +%s)
  if [ $((NOW - LAST_SNAP)) -ge "$SNAPSHOT_INTERVAL" ]; then
    git_snapshot
    LAST_SNAP=$NOW
  fi
  cooldown "$COOLDOWN_ETHICS"
done

# ================= 收尾：回填基线 + 写 GitHub =================
echo ""
echo ">>> [收尾] 回填答案基线 + 写 GitHub <<<"
node run-scenes.js --dry-run >/dev/null 2>&1 || true

cd "$REPO" || exit 1
git add -A
git commit -m "完成：伦理场景库 304 场景归档 + 法务知识库 154 条全量生成" --quiet || true
git push origin main && echo "[batch] 已推送到 GitHub" || echo "[batch] push 失败，请稍后手动 push"

echo "================================================================="
echo "[batch] 全部完成 $(date '+%F %T')"
echo "================================================================="
