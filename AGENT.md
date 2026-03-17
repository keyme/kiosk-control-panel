# Control Panel — Agent Guidance

This document provides guidance for AI agents (and humans) working on the **control_panel** subproject of the kiosk repo. It defines project structure, conventions, and constraints.

---

## Project Overview

**Control Panel** is a web application for remotely managing and monitoring KeyMe kiosks. It consists of:

| Component      | Location      | Stack / Role |
|----------------|---------------|--------------|
| **React UI**   | `cloud/web/`  | SPA; Vite, React 18, Tailwind 4, Radix UI; built and served by cloud |
| **Cloud API**  | `cloud/api/`  | FastAPI: REST API, static assets, WebSocket proxy to devices |
| **Device WS**  | `python/`     | WebSocket server on each kiosk; talks to kiosk stack via ZeroMQ |

**Data flow:**

```
┌─────────┐      REST / WSS     ┌─────────┐  WSS proxy/API key   ┌─────────┐
│ Browser │ ◄─────────────────► │  Cloud  │ ◄─────────────────► │ Device  │
└─────────┘   KEYME-TOKEN auth  └─────────┘   device cert (S3)   └─────────┘
```

- Browser → Cloud only (REST, static, WebSocket).
- Cloud proxies WebSocket (`/ws`) to the selected device over WSS (TLS).
- Cloud proxies WebSocket (`/ai`) for AI log analysis (Codex).

**Auth:** Token-based via KeyMe ANF service. `KEYME-TOKEN` header for REST; first message `{ event: "auth", token, device }` for WebSockets.

---

## Architecture Principles

- **Device WS** runs as a process/service on the device. The full list of services can be found in `manager/config/master_process_list.json`.
- **Device WS** is one of many services on a kiosk. The kiosk uses a **modular monolith architecture**, similar to Comma AI.
- **Device WS — IPC via pylib** — Device WS is a facade for IPC calls using pylib.
- **Cloud as single entry point** — Browser never connects directly to devices; all traffic goes through the cloud.
- **Device certs from S3** — Cloud fetches device public certs from `keyme-calibration/wss_certs/{KIOSK_NAME}/{fqdn}.crt` for WSS.
- **Auth router vs protected router** — `create_auth_router()` handles login/logout (no auth); `create_router()` includes `Depends(get_current_user)` for all other routes.

### Python version
- **Device WS** — Python 3.6 (planned upgrade to 3.11).
- **Cloud** — Python 3.13; upgrades are straightforward.

---

## Testing

**Cloud API** tests live under `cloud/api/tests/` and use **pytest** with **uv**. Run them from the cloud app directory so `uv` uses `cloud/pyproject.toml` and its dev dependencies (e.g. pytest). Set `API_ENV=prod` because the API reads it at import time.

```bash
cd control_panel/cloud && API_ENV=prod uv run pytest api/tests/ -v --tb=short
```

---

## Performance Constraints

### Resource priority (CPU and memory)
**Device/kiosk** is the most critical resource and should be considered first. When developing or optimizing, push heavy work to the cloud or browser. Device WS should remain a thin wrapper. Priority order:

1. device/kiosk
2. browser/client/employee
3. cloud

### Idling
Device WS is idle almost 99% of the time. It is mostly used when a kiosk is being installed, monitored, fixed, calibrated, or during tech visits. Otherwise it should be idle. Use lazy imports and optimize module loading. Device WS is restarted (via systemd) every 24 hours for this reason — to avoid consuming significant resources that could affect normal kiosk operation.

### Data usage
Data usage originates only from **Device WS**. One reason most pages require manual **fetch** is to avoid unintended data use. When adding features, be mindful of data usage, especially for continuous pull/push. Cloud-to-browser data transfer (mainly REST calls) is effectively free.

### Scripts vs IPC calls
Use IPC calls where possible, but there are exceptions. Some well-established scripts (often calibration) are better invoked as subprocesses: importing them would be too heavy, and calling them frees resources and simplifies maintenance. Ask for clarification if unsure.

### Python dependencies
- **Device WS** — Be mindful when adding dependencies to `setup/salt/salt/requirements.python3.6.txt`; each one increases deployment data usage. Kiosks are deployed by fetching from git and running install scripts that download packages if not already installed.
- **Cloud** — No significant constraint.
---

## Security

```
Browser (VPN) ──KEYME-TOKEN / WSS auth──► Cloud ──WSS+API key+TLS──► Device (internal :2026)
No auth: /api/login, /api/logout, /api/status. All other /api/* require auth.
```

- **Device/Kiosk** — Access restricted to internal network IPs. Only machines on the internal network can access port 2026. Ensure this remains unchanged and never allow public exposure.
- The main goal is not only to protect individual kiosks, but also to safeguard the entire fleet—over 10,000 kiosks—from potential security threats and attacks.
- **Cloud** also could be a target for attacks because it is the single entry point for all kiosks so make sure it stays secured and protected. It is also can only be accessed over VPN

## DO / DON'T

### DO
- Ensure Cloud logs user actions so they are auditable and traceable.
- Use `KEYME-TOKEN` header (never token in URL) for authenticated requests.
- Add new calibration types to `create_router()` in `cloud/api/__init__.py` following existing patterns.

### DON'T
- Put tokens in WebSocket URL query params; use auth message only.
- Log raw tokens or secrets (especially the WSS API key).
- Introduce global variables that already exist in pylib or shared.py.
