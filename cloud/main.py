"""Cloud entrypoint: re-export app from api. Entrypoint for uvicorn: control_panel.cloud.main:app"""
from control_panel.cloud.api.main import app

__all__ = ["app"]
