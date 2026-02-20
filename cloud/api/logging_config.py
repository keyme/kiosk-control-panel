"""
Logging configuration for the control panel cloud API service.
"""

import json
import logging
import os
import sys
from datetime import UTC, datetime
from typing import Any, Dict

# Read env only; do not import auth (validates API_ENV at import time).
_env = os.environ.get("API_ENV", "prod")
_level_override = os.environ.get("CONTROL_PANEL_LOG_LEVEL", "").upper()

if _level_override in ("DEBUG", "INFO", "WARNING", "ERROR"):
    LOG_LEVEL = getattr(logging, _level_override)
elif _env == "stg":
    LOG_LEVEL = logging.DEBUG
else:
    LOG_LEVEL = logging.INFO


class JSONLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_obj: Dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "message": record.getMessage(),
        }

        # Optional request context (from middleware via `extra={...}`)
        if hasattr(record, "duration"):
            log_obj["duration_ms"] = round(record.duration * 1000, 2)  # type: ignore
        if hasattr(record, "client"):
            log_obj["client"] = record.client  # type: ignore
        if hasattr(record, "path"):
            log_obj["path"] = record.path  # type: ignore
        if hasattr(record, "method"):
            log_obj["method"] = record.method  # type: ignore

        # Optional request ID (if you use correlation IDs)
        if hasattr(record, "request_id"):
            log_obj["request_id"] = record.request_id  # type: ignore

        # Add exception info if available
        if record.exc_info:
            log_obj["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_obj)


def setup_logging() -> None:
    """Configure JSON formatted logging."""
    # Root logger configuration
    root_logger = logging.getLogger()
    root_logger.setLevel(LOG_LEVEL)

    # Create console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(JSONLogFormatter())

    # Remove existing handlers and add our JSON handler
    for handler in root_logger.handlers:
        root_logger.removeHandler(handler)
    root_logger.addHandler(console_handler)

    # Set uvicorn loggers to use the same configuration
    for logger_name in ["uvicorn", "uvicorn.access", "uvicorn.error"]:
        logger = logging.getLogger(logger_name)
        for handler in logger.handlers:
            logger.removeHandler(handler)
        logger.propagate = True

    # Application logger
    app_logger = logging.getLogger("app")
    app_logger.setLevel(LOG_LEVEL)
