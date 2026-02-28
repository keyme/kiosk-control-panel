#!/bin/sh
set -e
if [ -z "${OPENAI_API_KEY}" ]; then
  echo "ERROR: OPENAI_API_KEY is not set. Log analysis (Codex) requires it." >&2
  exit 1
fi
echo "$OPENAI_API_KEY" | codex login --with-api-key
exec "$@"
