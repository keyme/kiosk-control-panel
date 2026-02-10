# Control Panel

React UI with a Python backend: **Socket.IO runs on the device** (kiosk control and status, ZeroMQ IPC to the rest of the stack); **REST API runs on the cloud**.

## Architecture

**Split:** The UI is served from the cloud. It calls the **cloud** for REST (config, reports, calibration data) and the **device** for real-time control and status over Socket.IO. The device server does not run REST or serve JS; the cloud does not run Socket.IO.

**Target architecture:**

```mermaid
flowchart LR
  subgraph device [Device]
    PyMain[python/main.py]
    Server[python/server.py]
    PyMain --> Server
    Server -->|Socket.IO only| UI[React UI elsewhere]
    Server -->|ZeroMQ| Stack[Kiosk stack]
  end
  subgraph cloud [Cloud]
    CloudMain[cloud/main.py]
    CloudMain -->|REST plus static| UI
  end
```

- **Device:** `python/main.py` starts `python/server.py` — Socket.IO only; no REST API, no static/JS serving. Bridges to the kiosk stack via ZeroMQ.
- **Cloud:** `cloud/main.py` — Flask app with REST API blueprint and serves the React build (`cloud/web/dist`); no Socket.IO.

**Components:**

| Layer | Location | Role |
|-------|----------|------|
| **React UI** | `cloud/web/` | Single-page app; built and served by cloud. Uses REST for data, Socket.IO (to device) for live status and control. |
| **REST API + static** | `cloud/` — entrypoint `cloud/main.py` | Flask app: blueprints for calibration, testcuts, reports, etc.; serves `cloud/web/dist`. Stateless; cloud-only. |
| **Socket.IO server** | `python/` — entrypoint `python/main.py` (device) | Flask + Socket.IO only. Real-time events, panel status, terminals, IPC. Proxies commands to kiosk via ZeroMQ. No REST, no JS. |
| **Kiosk stack** | (other services) | Hardware and services on device; communicate with control panel over ZeroMQ. |

## Running (device)

The device runs the Socket.IO server. Started by the manager as `control_panel/python/main.py`. Listens on the port in `config/ports.json` (`python`, default 2026). Build the web app first (see **Running (cloud)** for where the build is used).

**Web dev:** From repo root or `control_panel/cloud/web`:

```bash
cd control_panel/cloud/web && npm run dev
```

Vite runs on port 8081 and proxies `/socket.io` to the Python port (2026). Run the Python server separately (`control_panel/python/main.py`) so the socket connects.

## Running (cloud)

The cloud runs REST API and serves the React build via `control_panel/cloud/main.py`. No Socket.IO. The web app lives under `cloud/web/`.

1. Build the web app: `cd control_panel/cloud/web && npm run build`
2. From repo root (or with `CONTROL_PANEL_STATIC_ROOT` set to the built `cloud/web/dist` path), run:

```bash
python -m control_panel.cloud.main
```

Static root is resolved from the `cloud/main.py` file location, so `cloud/web/dist` is found regardless of CWD when running the cloud server.

**Env (optional):**

- **`PORT`** — Server port (default 8080).
- **`CONTROL_PANEL_STATIC_ROOT`** — Path to the React build (default: `cloud/web/dist` next to `main.py`). Set this if you deploy the static files elsewhere.

## Config

- **`config/ports.json`:** `python` — Flask/Socket.IO server port (2026); `react` — Vite dev server port (8081).
- **`config/control_panel.json`:** Optional, e.g. `max_decode_packets` for Engine.IO.

## REST API and cloud

REST API and JS serving run on the cloud via `control_panel/cloud/main.py` (uses the blueprints in `cloud/`). The device server (`python/main.py`) provides Socket.IO only. See **Running (cloud)** for how to start and configure the cloud server.
