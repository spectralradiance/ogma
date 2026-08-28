#!/usr/bin/env bash
# Starts the Ogma API and frontend dev servers together in one terminal.
# Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

.venv/Scripts/python.exe -m uvicorn api.main:app --reload --port 8000 &
API_PID=$!

(cd frontend && npm run dev) &
FRONTEND_PID=$!

trap 'kill "$API_PID" "$FRONTEND_PID" 2>/dev/null' EXIT INT TERM

wait
