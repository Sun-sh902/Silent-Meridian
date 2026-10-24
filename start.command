#!/bin/bash
# The Silent Meridian — local launcher (double-click to run)
cd "$(dirname "$0")" || exit 1
PORT=8123
echo "◈ THE SILENT MERIDIAN"
echo "  Local server: http://127.0.0.1:$PORT/"
echo "  Single-file build (no server): dist/silent-meridian.html"
echo "  Ctrl+C to stop."
open "http://127.0.0.1:$PORT/" 2>/dev/null &
python3 -m http.server "$PORT" --bind 127.0.0.1
