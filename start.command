#!/bin/bash
# 寂静子午线 — 本地启动脚本（双击运行）
cd "$(dirname "$0")" || exit 1
PORT=8123
echo "◈ 寂静子午线 · THE SILENT MERIDIAN"
echo "  本地服务器： http://127.0.0.1:$PORT/"
echo "  直接运行单文件版本： dist/silent-meridian.html"
echo "  按 Ctrl+C 结束。"
open "http://127.0.0.1:$PORT/" 2>/dev/null &
python3 -m http.server "$PORT" --bind 127.0.0.1
