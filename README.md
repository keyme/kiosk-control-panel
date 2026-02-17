# Control Panel

React UI with a Python backend: **WebSocket runs on the device** (kiosk control and status, ZeroMQ IPC to the rest of the stack); **REST API runs on the cloud**.

## Architecture

**Split:** The UI is served from the cloud. It calls the **cloud** for REST (config, reports, calibration data) and the **device** for real-time control and status over WebSocket. The device server does not run REST or serve JS; the cloud does not run WebSocket.

**Target architecture:**

```mermaid
flowchart LR
  subgraph clients [Clients / Users]
    Browser[Browser]
    ReactUI[React UI]
    Browser --- ReactUI
  end
  subgraph cloud [Cloud]
    CloudMain[cloud/main.py]
    CloudMain -->|REST API + static| Browser
  end
  subgraph kiosk [Kiosk]
    PyMain[python/main.py]
    Server[python/server.py]
    PyMain --> Server
    Server -->|ZeroMQ| Stack[Kiosk stack]
  end
  ReactUI -->|WebSocket| Server
  ReactUI -->|REST| CloudMain
```

- **Clients / Users:** The React single-page app runs in the user's browser. It is served (as static files) by the cloud and then communicates with both the cloud (REST) and the kiosk (WebSocket) at runtime.
- **Kiosk:** `python/main.py` starts the WebSocket server (`python/ws_server.py`) and IPC — no REST API, no static/JS serving. Bridges to the kiosk hardware stack via ZeroMQ.
- **Cloud:** `cloud/main.py` — FastAPI app with REST API router, serves the React build (`cloud/web/dist`), and proxies WebSocket to the device (path `/ws`, query `device=` from UI). Only the cloud subtree is a uv project; the kiosk side (`python/`) is unchanged.

**Components:**

| Layer | Location | Role |
|-------|----------|------|
| **React UI** | `cloud/web/` | Single-page app; built and served by cloud. Uses REST for data, WebSocket (to device) for live status and control. |
| **REST API + static** | `cloud/` — entrypoint `cloud/main.py` | FastAPI app; uv project in `cloud/` only. API routes for calibration, testcuts, reports, etc.; serves `cloud/web/dist`. Stateless; cloud-only. |
| **WebSocket server** | `python/` — entrypoint `python/main.py` (device) | Pure WebSocket (path `/ws`). Real-time events, panel status, terminals, IPC. Proxies commands to kiosk via ZeroMQ. No REST, no JS. |
| **Kiosk stack** | (other services) | Hardware and services on device; communicate with control panel over ZeroMQ. |

## Running (device)

The device runs the WebSocket server. Started by the manager as `control_panel/python/main.py`. Listens on the port in `config/ports.json` (`python`, default 2026), path `/ws`, with **WSS (TLS)**. At startup the device ensures a self-signed cert and key exist under `keyme.config.STATE_PATH/control_panel` (creates them if missing), then sends an IPC to **UPLOADER** (background_uploader) to upload the **public cert only** to S3. Build the web app first (see **Running (cloud)** for where the build is used).

**Web dev:** From repo root or `control_panel/cloud/web`:

```bash
cd control_panel/cloud/web && npm run dev
```

Vite runs on port 8081 and proxies `/ws` to the Python port (2026). Run the Python server separately (`control_panel/python/main.py`) so the WebSocket connects.

## Running (cloud)

The cloud is a FastAPI app managed with uv. It runs the REST API and serves the React build via `control_panel/cloud/main.py`. It also proxies WebSocket to the device: when the user selects a device in the UI, the browser connects to the cloud at `/ws?device=...` and the cloud forwards to that device. The cloud requires the same KeyMe token as the REST API, passed as the `token` query parameter; unauthenticated connections are closed. The web app lives under `cloud/web/`.

1. Build the web app: `cd control_panel/cloud/web && npm run build`
2. From **repo root**, run the cloud app with uv (only `control_panel/cloud` is a uv project):

```bash
uv run --project control_panel/cloud uvicorn control_panel.cloud.main:app --host 0.0.0.0 --port 8080
```

The app logs HTTP and WebSocket access itself (tokens are never logged). Use `--no-access-log` so uvicorn does not duplicate access logs. Port can be overridden with the `PORT` env var (e.g. `PORT=9000` before the command). Static root is resolved from the `cloud/main.py` file location, so `cloud/web/dist` is found regardless of CWD.

**Env (optional):**

- **`PORT`** — Server port (default 8080).
- **`API_ENV`** — Environment: `stg` or `prod`. Set when running in Docker or when you need the app to target staging vs production APIs.
- **`CONTROL_PANEL_STATIC_ROOT`** — Path to the React build (default: `cloud/web/dist` next to `main.py`). Set this if you deploy the static files elsewhere.

**Device certs (S3):** The cloud proxy connects to devices over **wss://** and verifies TLS using the device's public cert. Device certs are stored in S3 under the bucket and prefix defined in **`control_panel/shared.py`** (e.g. `s3://{bucket}/{WSS_CERTS_S3_PREFIX}/{KIOSK_NAME}/{filename}.crt`). The device uploads its cert via IPC to UPLOADER; the cloud fetches from S3, caches in memory, and on connection failure refetches and retries once (e.g. after device replacement). UPLOADER must have PutObject permission for the bucket; the cloud needs GetObject. WSS API key and related constants are also in `control_panel/shared.py` (single source of truth for device and cloud).

**Docker (build from control_panel dir):**

Build (includes JS build in image):

```bash
cd control_panel
docker build -f cloud/Dockerfile -t control-panel-cloud .
```

Run (port 8080). Set `API_ENV` to `stg` or `prod`:

```bash
docker run -p 8080:8080 -e API_ENV=stg control-panel-cloud
```

For production: `-e API_ENV=prod`.

**Runtime limits (recommended):**
This cloud service is used as a **WebSocket proxy** to devices, so it can hold many concurrent socket connections and consume file descriptors/conntrack entries and memory. It exposes `GET /health` which reports OS/container limits (ulimit, conntrack, memory) and will return warnings when they're too low.

- **Increase file descriptor limit (ulimit / nofile)** (recommended; helps with many concurrent WS connections):

```bash
docker run -p 8080:8080 \
  --ulimit nofile=200000:200000 \
  -e API_ENV=stg \
  control-panel-cloud
```

- **Increase conntrack limit (nf_conntrack_max)**:
This is a **host/node sysctl**, not an image setting. On the node:

```bash
sysctl -w net.netfilter.nf_conntrack_max=262144
```

- **Environment variables** (good for CI or injected secrets):

```bash
docker run -p 8080:8080 \
  -e API_ENV=stg \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e AWS_DEFAULT_REGION=us-east-1 \
  control-panel-cloud
```

- **Mount local AWS config** (reuse `~/.aws` from the host):

```bash
docker run -p 8080:8080 \
  -e API_ENV=stg \
  -v ~/.aws:/home/appuser/.aws:ro \
  -e HOME=/home/appuser \
  control-panel-cloud
```

(Use `-u $(id -u):$(id -g)` and a writable dir if the container user cannot read your `~/.aws`; or create a dedicated credentials file and mount that.)

- **IAM roles:** On ECS (task role), EKS (pod IRSA), or EC2 (instance profile), boto3 uses the role automatically; no env or mount needed.

## Testing (cloud API)

The cloud API has a pytest suite under `cloud/api/tests/`. Tests use [moto](https://github.com/getmoto/moto) to mock S3 so no AWS credentials are needed.

Install test dependencies and run from the **repo root**:

```bash
uv sync --project control_panel/cloud --extra test
uv run --project control_panel/cloud pytest control_panel/cloud/api/tests/ -v
```

## Config

- **`config/ports.json`:** `python` — WebSocket server port (2026). (Vite dev server uses port 8081, set in `cloud/web/vite.config.js`.)
- **`config/control_panel.json`:** Optional, e.g. `cache_ttl_fast_sec`, `cache_ttl_slow_sec` for status cache TTLs.

## REST API and cloud

REST API and JS serving run on the cloud via `control_panel/cloud/main.py` (FastAPI app; routes in `cloud/api/`). The device server (`python/main.py`) provides WebSocket only (path `/ws`). Cloud dependencies are managed with uv (`control_panel/cloud/pyproject.toml`). See **Running (cloud)** for how to start and configure the cloud server.
