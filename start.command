#!/bin/bash
# THE SILENT MERIDIAN — local launcher (double-click to run)
cd "$(dirname "$0")" || exit 1
PORT=8123
echo "◈ THE SILENT MERIDIAN"
echo "  Local server: http://127.0.0.1:$PORT/"
echo "  Run the single-file build directly: dist/silent-meridian.html"
echo "  Press Ctrl+C to quit."
open "http://127.0.0.1:$PORT/" 2>/dev/null &
python3 -m http.server "$PORT" --bind 127.0.0.1
