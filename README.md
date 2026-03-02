# Control Panel

React UI and Python backend. **Cloud** serves the app and REST API and proxies WebSocket (WSS) to **devices**. **Device** runs the WebSocket server and talks to the kiosk stack via ZeroMQ.

## Architecture

- **Browser** → Cloud only (REST, static, WebSocket).
- **Cloud** (FastAPI) → Exposes same-origin `/ws`; client sends an auth message (no query params) and Cloud proxies to the chosen device over WSS (TLS). Auth message: `{ "event": "auth", "token", "device" }`.
- **Device** (`python/main.py`) → WebSocket on `/ws` (WSS), ZeroMQ to kiosk stack.

| Part        | Location        | Role |
|------------|-----------------|------|
| React UI   | `cloud/web/`    | SPA; built and served by cloud. |
| Cloud      | `cloud/main.py` | FastAPI: REST, static, WS proxy to device. |
| WS server  | `python/main.py`| WSS on port in `config/ports.json` (default 2026). |

Device TLS: self-signed cert/key under `keyme.config.STATE_PATH/control_panel`; public cert uploaded to S3 via UPLOADER. Cloud fetches device certs from S3 for WSS. See `control_panel/shared.py` for bucket, prefix, and WSS API key.

## Running (device)

Started by systemd; process `control_panel/python/main.py`. For web dev: run Vite from `control_panel/cloud/web` (`npm run dev`, port 8081) and the Python server separately so the UI can connect.

## Running (cloud)

**Local**

1. Build web: `cd control_panel/cloud/web && npm run build`
2. From repo root:

```bash
uv run --project control_panel/cloud uvicorn control_panel.cloud.main:app --host 0.0.0.0 --port 8080
```

Optional env: `PORT`, `API_ENV` (e.g. `stg` / `prod`), `CONTROL_PANEL_STATIC_ROOT`.

**Docker**

Build:

```bash
cd control_panel
DOCKER_BUILDKIT=1 docker build -f cloud/Dockerfile -t control-panel-cloud .
```

**Running (requires AI/log analysis):** You must set `OPENAI_API_KEY`; the entrypoint will run `codex login` and start the Codex app-server. If `OPENAI_API_KEY` is not set, the entrypoint exits with an error.

Example:

```bash
docker run -p 8080:8080 \
  -v ~/.aws:/home/appuser/.aws:ro -e HOME=/home/appuser \
  -e API_ENV=stg \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  control-panel-cloud
```

- **AWS credentials:** Needed for S3 (device certs) and other AWS APIs. Mount `~/.aws` as above, or set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION`, or use IAM (ECS/EKS/EC2).
- **Log analysis (Codex):** The container requires `OPENAI_API_KEY` and will exit if it is missing.
- **Scale:** For many WS connections use e.g. `--ulimit nofile=200000:200000`. `GET /health` reports limits and warnings.

## Testing

From repo root:

```bash
uv sync --project control_panel/cloud --extra test
uv run --project control_panel/cloud pytest control_panel/cloud/api/tests/ -v
```

Uses moto for S3; no AWS credentials needed.

## Config

- **`config/ports.json`** — `python`: WebSocket server port (2026).
- **`config/control_panel.json`** — Optional (e.g. cache TTLs).
