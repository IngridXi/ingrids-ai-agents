#!/bin/bash
# 一键部署：把 ~/Dev/Ingrids-AI-Agents 源码同步进打包版 .app 并重启，让改动真正生效。
#
# 背景：双击运行的 .app 加载的是包内 Contents/Resources/app/ 的独立代码副本，
#       改源码后不部署，工作台界面永远是旧的（此前多轮「没刷新/没修复」的根因）。
#
# 用法：
#   bash deploy.sh              完整部署：退出 App → 同步+重签 → 重启 → 验证
#   bash deploy.sh --sync-only  只同步+重签，不退出不重启（供 git hook 用，避免打断）
#
# 依赖：sync-to-app.sh（rsync 同步 + node build/resign-app.cjs 重签，证书 Ingrids AI Agents Signing）
set -uo pipefail

SRC="$HOME/Dev/Ingrids-AI-Agents"
APP="$HOME/Applications/Ingrid's AI Agents.app"
USERDATA="$HOME/Library/Application Support/Ingrid's AI Agents"
LOCK="$USERDATA/SingletonLock"
SYNC_ONLY=0
[ "${1:-}" = "--sync-only" ] && SYNC_ONLY=1

# 从 SingletonLock 软链读主进程 PID（软链目标形如 Ingrids-MacBook-Pro.local-27109）
get_pid() {
  [ -L "$LOCK" ] || return 1
  local t
  t="$(readlink "$LOCK" 2>/dev/null)" || return 1
  echo "${t##*.}"
}
is_running() { [ -L "$LOCK" ]; }

echo "== 部署 Ingrid's AI Agents $([ $SYNC_ONLY -eq 1 ] && echo '(仅同步)' || echo '(完整)') =="

# 1) 退出正在运行的实例（完整部署才做）
if [ $SYNC_ONLY -eq 0 ] && is_running; then
  pid="$(get_pid || true)"
  echo "→ 退出运行中的工作台 (PID ${pid:-?})..."
  case "$pid" in
    ''|*[!0-9]*) echo "  无法识别 PID，跳过退出，继续同步";;
    *) kill "$pid" 2>/dev/null || true;;
  esac
  for _ in $(seq 1 20); do is_running || break; sleep 0.5; done
  if is_running; then
    echo "✗ 退出失败，请手动 Cmd+Q 后重试"
    exit 1
  fi
  echo "✓ 已退出"
fi

# 2) 同步 + 重签（复用现有脚本）
echo "→ 同步源码 + 重签..."
if ! bash "$SRC/sync-to-app.sh"; then
  echo "✗ 同步失败"
  exit 1
fi

# 3) 重启（完整部署才做）
if [ $SYNC_ONLY -eq 0 ]; then
  echo "→ 重新打开工作台..."
  open "$APP"
  for _ in $(seq 1 20); do is_running && break; sleep 0.5; done
  if is_running; then
    echo "✓ 工作台已重启 (PID $(get_pid))"
  else
    echo "⚠ 未检测到启动，请手动打开 $APP"
  fi
fi

echo "✓ 部署完成。"
