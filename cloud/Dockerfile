# Stage 1: Build React frontend
FROM 821954540415.dkr.ecr.us-east-1.amazonaws.com/node:22.8.0-alpine AS web-build

WORKDIR /web-build

ENV DEBIAN_FRONTEND=noninteractive

# Copy dependency manifests first for better layer caching (build context: control_panel/)
COPY cloud/web/package.json cloud/web/package-lock.json ./
RUN npm ci

# Copy the rest of the frontend and build
COPY cloud/web/ ./
RUN npm run build

# Stage 2: Install Python dependencies
FROM 821954540415.dkr.ecr.us-east-1.amazonaws.com/python:3.13-slim AS builder

WORKDIR /app

ENV TZ=UTC
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install uv

# Install only dependencies (do not build/install the project; we run from PYTHONPATH)
RUN uv pip install --system \
    fastapi \
    "uvicorn[standard]" \
    boto3 \
    numpy \
    opencv-python-headless \
    httpx \
    cachetools \
    "websockets>=12.0"

# Stage 3: Runtime
FROM 821954540415.dkr.ecr.us-east-1.amazonaws.com/python:3.13-slim AS runtime

WORKDIR /app

ENV TZ=UTC
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
# Log analysis: full kiosk repo (with submodules), workspace for worktrees, cache for log slices
ENV KIOSK_REPO_PATH=/app/kiosk_repo
ENV LOG_ANALYSIS_WORKSPACE_BASE=/app/workspace
ENV LOG_ANALYSIS_CACHE_DIR=/app/log_analysis_cache
ENV LOG_ANALYSIS_CACHE_TTL_DAYS=2

# Runtime deps: opencv; git for log-analysis worktrees; nodejs/npm for Codex CLI; ripgrep (rg) for log search
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    git \
    nodejs \
    npm \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Kiosk repo is provided by CI as part of the build context (see Jenkinsfile).
# It must include .git metadata because log analysis uses git worktrees.
COPY kiosk_repo /app/kiosk_repo

# Workspace base for log-analysis worktrees; cache dir for log slices (TTL in days above)
RUN mkdir -p /app/workspace /app/log_analysis_cache

# Install Codex CLI via npm (OpenAI Codex; requires Node 18+)
RUN npm install -g @openai/codex

# Entrypoint: requires OPENAI_API_KEY and runs codex login before starting the app
COPY cloud/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Copy installed Python env from builder
COPY --from=builder /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code (context is control_panel/ -> /app/control_panel/)
COPY . ./control_panel/

# Copy built frontend from web-build stage
COPY --from=web-build /web-build/dist ./control_panel/cloud/web/dist

# Compile only the control panel code (avoid compiling an embedded kiosk_repo/ if present in build context).
RUN python -m compileall \
    control_panel/cloud \
    control_panel/shared.py

# Non-root user; ensure workspace and kiosk_repo are writable for worktrees
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["uvicorn", "control_panel.cloud.main:app", "--host", "0.0.0.0", "--port", "8080"]
