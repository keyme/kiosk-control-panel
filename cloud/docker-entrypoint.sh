#!/bin/sh
set -e
if [ -n "${NO_AI}" ]; then
  echo "WARNING: NO_AI is set. Codex AI log analysis (/ai) will be disabled." >&2
else
  if [ -z "${OPENAI_API_KEY}" ]; then
    echo "ERROR: OPENAI_API_KEY is not set. Log analysis (Codex) requires it. Set OPENAI_API_KEY or set NO_AI=1 to run without AI." >&2
    exit 1
  fi
  echo "$OPENAI_API_KEY" | codex login --with-api-key
  unset OPENAI_API_KEY
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
fi

exec "$@"
