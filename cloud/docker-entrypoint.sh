#!/bin/sh
set -e
if [ -z "${OPENAI_API_KEY}" ]; then
  echo "ERROR: OPENAI_API_KEY is not set. Log analysis (Codex) requires it." >&2
  exit 1
fi
echo "$OPENAI_API_KEY" | codex login --with-api-key

# Start Codex app-server in background so /ai WebSocket can use it. Listen on default URL
# (cloud client uses CODEX_APP_SERVER_WS_URL, default ws://127.0.0.1:4500). Run with cwd
# set to kiosk repo so the server's default context is the kiosk repo.
KIOSK_REPO="${KIOSK_REPO_PATH:-/app/kiosk_repo}"
if [ -d "$KIOSK_REPO" ]; then
  (
    cd "$KIOSK_REPO" && \
    env -i \
      PATH="/usr/bin:/bin:/usr/local/bin" \
      HOME="$HOME" \
      codex app-server --listen ws://127.0.0.1:4500
  ) &
  sleep 1
fi

exec "$@"
