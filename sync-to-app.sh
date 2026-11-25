#!/bin/bash
# 把 Dev 目录源码同步到「Ingrid's AI Agents.app」打包副本
#
# 背景：双击运行的 .app 是打包后的应用，加载的是 App 包内的
# Contents/Resources/app/ 代码副本，而不是 ~/Dev/Ingrids-AI-Agents。
# 所以改完源码后必须跑本脚本同步，否则 App 里看不到更新。
#
# 用法：bash sync-to-app.sh
set -e

SRC="$HOME/Dev/Ingrids-AI-Agents/"
DST="$HOME/Applications/Ingrid's AI Agents.app/Contents/Resources/app/"

if [ ! -d "$DST" ]; then
  echo "❌ 未找到打包副本：$DST"
  echo "   请确认「Ingrid's AI Agents.app」存在于 ~/Applications/ 下。"
  exit 1
fi

rsync -av \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '__pycache__/' \
  --exclude 'build/' \
  --exclude 'dist/' \
  --exclude 'data/' \
  --exclude 'vendor/' \
  --exclude 'venv_mermaid/' \
  --exclude '.workbuddy/' \
  --exclude 'mermaid转ppt/' \
  --exclude '.DS_Store' \
  "$SRC" "$DST"

# 补齐 node_modules 运行时依赖。
# 根因：electron-builder 打包时会把各包（cheerio/docx/exceljs/pptxgenjs/tsdav 等）的
# dist/lib 编译产物精简掉，导致 require() 报 "Cannot find module .../dist/..."，
# 表现为「读 PPT/生成文档」时报「缺 XX 模块」。这里从 Dev 的完整 node_modules 补齐。
echo ""
echo "🔧 补齐 node_modules 运行时依赖（补缺失的 dist/lib）..."
NM_SRC="$SRC/node_modules/"
NM_DST="$DST/node_modules/"
if [ -d "$NM_SRC" ] && [ -d "$NM_DST" ]; then
  rsync -a \
    --exclude 'electron/' \
    --exclude '@electron/' \
    "$NM_SRC" "$NM_DST"
  echo "✅ node_modules 运行时依赖已补齐。"
else
  echo "⚠️ 跳过 node_modules 补齐（目录缺失，请先 npm install）。"
fi

echo ""
echo "✅ 已同步到打包副本。"
echo "   ⚠️ 请完全退出「Ingrid's AI Agents」应用（Cmd+Q）后重新打开，以加载最新代码。"
