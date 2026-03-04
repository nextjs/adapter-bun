#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Output runtime logs before shutdown.
LOG_FILE=".adapter-server.log"
PRE_SHUTDOWN_LOG_LINES=0
if [ -f "$LOG_FILE" ]; then
  echo "=== ${LOG_FILE} (pre-shutdown) ==="
  cat "$LOG_FILE"
  echo ""
  PRE_SHUTDOWN_LOG_LINES="$(wc -l < "$LOG_FILE" | tr -d '[:space:]')"
fi

# 2. Stop the server
PID_FILE=".adapter-server.pid"
if [ -f "$PID_FILE" ]; then
  while IFS= read -r SERVER_PID; do
    if [ -z "$SERVER_PID" ]; then
      continue
    fi
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true
      # Wait up to 5 seconds for graceful shutdown
      for i in $(seq 1 50); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
        sleep 0.1
      done
      # Force kill if still running
      if kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -9 "$SERVER_PID" 2>/dev/null || true
      fi
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# 3. Persist logs and output anything appended during shutdown.
if [ -f "$LOG_FILE" ]; then
  PERSIST_SERVER_LOG_PATH="${ADAPTER_BUN_PERSIST_SERVER_LOG:-/tmp/adapter-bun-last-server.log}"
  cp "$LOG_FILE" "$PERSIST_SERVER_LOG_PATH" 2>/dev/null || true

  POST_SHUTDOWN_LOG_LINES="$(wc -l < "$LOG_FILE" | tr -d '[:space:]')"
  if [ "$POST_SHUTDOWN_LOG_LINES" -gt "$PRE_SHUTDOWN_LOG_LINES" ]; then
    echo "=== ${LOG_FILE} (post-shutdown appended) ==="
    sed -n "$((PRE_SHUTDOWN_LOG_LINES + 1)),\$p" "$LOG_FILE"
    echo ""
  fi
fi
