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
    cachetools

# Stage 3: Runtime
FROM 821954540415.dkr.ecr.us-east-1.amazonaws.com/python:3.13-slim

WORKDIR /app

ENV TZ=UTC
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# Runtime deps for opencv (used by calibration_trace). libgl1 replaces libgl1-mesa-glx on newer Debian
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python env from builder
COPY --from=builder /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code (context is control_panel/ -> /app/control_panel/)
COPY . ./control_panel/

# Copy built frontend from web-build stage
COPY --from=web-build /web-build/dist ./control_panel/cloud/web/dist

RUN python -m compileall control_panel/

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

CMD ["uvicorn", "control_panel.cloud.main:app", "--host", "0.0.0.0", "--port", "8080"]
