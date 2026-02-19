import logging

import boto3
import httpx
from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse, Response

from control_panel.cloud.api.auth import ANF_BASE_URL, _token_cache, get_current_user

_log = logging.getLogger(__name__)

from control_panel.cloud.api.testcuts import (
    kiosk_to_hostname,
    list_testcut_ids,
    list_testcut_images,
    BUCKET as TESTCUTS_BUCKET,
)
from control_panel.cloud.api.bitting_calibration import list_bitting_dates, list_bitting_images
from control_panel.cloud.api.bump_tower_calibration import (
    list_bump_tower_runs,
    list_bump_tower_images,
)
from control_panel.cloud.api.grip_calibration import list_grip_runs, list_grip_images
from control_panel.cloud.api.gripper_cam_calibration import (
    list_gripper_cam_runs,
    list_gripper_cam_images,
)
from control_panel.cloud.api.gripper_leds_check import (
    list_gripper_leds_runs,
    list_gripper_leds_images,
)
from control_panel.cloud.api.overhead_cam_calibration import (
    list_overhead_cam_runs,
    list_overhead_cam_images,
)
from control_panel.cloud.api.pickup_y_calibration import (
    list_pickup_y_runs,
    list_pickup_y_images,
)
from control_panel.cloud.api.calibration_trace import (
    list_trace_runs,
    get_trace,
    dewarp_image,
)


def create_auth_router() -> APIRouter:
    """Create the **unprotected** auth router (login / logout proxies + health check)."""
    router = APIRouter(tags=["auth"])

    @router.get("/ping")
    def ping():
        _log.info("api ping")
        return {"status": "ok", "source": "cloud"}

    @router.post("/login")
    def login(body: dict = Body(...)):
        """Proxy login to ANF. Returns keyme_token on success."""
        _log.info(f"login attempt email={body.get('email')}")
        try:
            resp = httpx.post(
                f"{ANF_BASE_URL}/api/login",
                json=body,
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            _log.warning(f"ANF login request failed: {exc}")
            return JSONResponse({"error": "Login service unavailable"}, status_code=502)
        return JSONResponse(resp.json(), status_code=resp.status_code)

    @router.post("/logout")
    def logout(body: dict = Body(...)):
        """Proxy logout to ANF and evict the token from the local cache."""
        session_token = body.get("session_token", "")
        _log.info("logout request")
        # Evict from local cache so the token is no longer trusted locally.
        _token_cache.pop(session_token, None)
        try:
            resp = httpx.post(
                f"{ANF_BASE_URL}/api/logout",
                json=body,
                timeout=10.0,
            )
        except httpx.HTTPError as exc:
            _log.warning(f"ANF logout request failed: {exc}")
            return JSONResponse({"error": "Logout service unavailable"}, status_code=502)
        return JSONResponse(resp.json(), status_code=resp.status_code)

    return router


def create_router():
    """Create the cloud API router (all routes require auth)."""
    router = APIRouter(dependencies=[Depends(get_current_user)])

    @router.get("/calibration/testcuts/ids")
    def calibration_testcuts_ids(kiosk: str = Query(None)):
        _log.info(f"calibration testcuts ids {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            ids = list_testcut_ids(s3, TESTCUTS_BUCKET, host)
            return ids
        except Exception as e:
            _log.exception("Testcuts list IDs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/testcuts/images")
    def calibration_testcuts_images(kiosk: str = Query(None), id: str = Query(None)):
        _log.info(f"calibration testcuts images {kiosk=} {id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if id is None or id == "":
            return JSONResponse({"error": "Missing required query parameter: id"}, status_code=400)
        try:
            id_int = int(id)
        except ValueError:
            return JSONResponse({"error": "Parameter id must be an integer"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_testcut_images(s3, TESTCUTS_BUCKET, host, id_int)
            return sections
        except Exception as e:
            _log.exception("Testcuts list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/bitting_calibration/dates")
    def calibration_bitting_dates(kiosk: str = Query(None)):
        _log.info(f"calibration bitting_calibration dates {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            dates = list_bitting_dates(s3, TESTCUTS_BUCKET, host)
            return dates
        except Exception as e:
            _log.exception("Bitting calibration list dates failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/bitting_calibration/images")
    def calibration_bitting_images(kiosk: str = Query(None), date: str = Query(None)):
        _log.info(f"calibration bitting_calibration images {kiosk=} {date=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not date or not date.strip():
            return JSONResponse({"error": "Missing required query parameter: date"}, status_code=400)
        date_val = date.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_bitting_images(s3, TESTCUTS_BUCKET, host, date_val)
            return sections
        except Exception as e:
            _log.exception("Bitting calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/bump_tower_calibration/runs")
    def calibration_bump_tower_runs(kiosk: str = Query(None)):
        _log.info(f"calibration bump_tower_calibration runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_bump_tower_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Bump tower calibration list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/bump_tower_calibration/images")
    def calibration_bump_tower_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration bump_tower_calibration images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_bump_tower_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Bump tower calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/grip_calibration/runs")
    def calibration_grip_runs(kiosk: str = Query(None)):
        _log.info(f"calibration grip_calibration runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_grip_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Grip calibration list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/grip_calibration/images")
    def calibration_grip_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration grip_calibration images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_grip_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Grip calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/gripper_cam_calibration/runs")
    def calibration_gripper_cam_runs(kiosk: str = Query(None)):
        _log.info(f"calibration gripper_cam_calibration runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_gripper_cam_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Gripper cam calibration list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/gripper_cam_calibration/images")
    def calibration_gripper_cam_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration gripper_cam_calibration images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_gripper_cam_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Gripper cam calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/gripper_leds_check/runs")
    def calibration_gripper_leds_runs(kiosk: str = Query(None)):
        _log.info(f"calibration gripper_leds_check runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_gripper_leds_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Gripper LEDs check list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/gripper_leds_check/images")
    def calibration_gripper_leds_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration gripper_leds_check images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_gripper_leds_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Gripper LEDs check list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/overhead_cam_calibration/runs")
    def calibration_overhead_cam_runs(kiosk: str = Query(None)):
        _log.info(f"calibration overhead_cam_calibration runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_overhead_cam_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Overhead cam calibration list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/overhead_cam_calibration/images")
    def calibration_overhead_cam_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration overhead_cam_calibration images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_overhead_cam_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Overhead cam calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/pickup_y_calibration/runs")
    def calibration_pickup_y_runs(kiosk: str = Query(None)):
        _log.info(f"calibration pickup_y_calibration runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_pickup_y_runs(s3, TESTCUTS_BUCKET, host)
            return runs
        except Exception as e:
            _log.exception("Pickup Y calibration list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/pickup_y_calibration/images")
    def calibration_pickup_y_images(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration pickup_y_calibration images {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return JSONResponse({"error": "Invalid kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            sections = list_pickup_y_images(s3, TESTCUTS_BUCKET, host, run_id_val)
            return sections
        except Exception as e:
            _log.exception("Pickup Y calibration list images failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/trace/gripper_cam/runs")
    def calibration_trace_gripper_cam_runs(kiosk: str = Query(None)):
        _log.info(f"calibration trace gripper_cam runs {kiosk=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        try:
            s3 = boto3.client("s3")
            runs = list_trace_runs(s3, TESTCUTS_BUCKET, kiosk)
            return runs
        except Exception as e:
            _log.exception("Calibration trace list runs failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.get("/calibration/trace/gripper_cam")
    def calibration_trace_gripper_cam(kiosk: str = Query(None), run_id: str = Query(None)):
        _log.info(f"calibration trace gripper_cam {kiosk=} {run_id=}")
        if not kiosk:
            return JSONResponse({"error": "Missing required query parameter: kiosk"}, status_code=400)
        if not run_id or not run_id.strip():
            return JSONResponse({"error": "Missing required query parameter: run_id"}, status_code=400)
        run_id_val = run_id.strip()
        try:
            s3 = boto3.client("s3")
            trace = get_trace(s3, TESTCUTS_BUCKET, kiosk, run_id_val)
            if trace is None:
                return JSONResponse({"error": "Trace not found"}, status_code=404)
            return trace
        except Exception as e:
            _log.exception("Calibration trace get failed")
            return JSONResponse({"error": str(e)}, status_code=503)

    @router.post("/calibration/trace/gripper_cam/dewarp")
    def calibration_trace_gripper_cam_dewarp(body: dict = Body(default=None)):
        data = body or {}
        image_url = data.get("image_url")
        homography = data.get("homography")
        _log.info(f"calibration trace gripper_cam dewarp image_url={image_url[:80] + '...' if isinstance(image_url, str) and len(image_url) > 80 else image_url}")
        if not image_url:
            return JSONResponse({"error": "Missing image_url"}, status_code=400)
        if not homography:
            return JSONResponse({"error": "Missing homography matrix"}, status_code=400)
        png_bytes, err = dewarp_image(image_url, homography)
        if err:
            return JSONResponse({"error": err}, status_code=400)
        return Response(content=png_bytes, media_type="image/png")

    return router
