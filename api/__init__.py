# Shared REST API for control panel (device and cloud).
# Use create_blueprint(backend) to get a Flask blueprint; register it on the app.

import logging

import boto3
from flask import Blueprint, Response, jsonify, request

_log = logging.getLogger(__name__)

from control_panel.api.testcuts import (
    kiosk_to_hostname,
    list_testcut_ids,
    list_testcut_images,
    BUCKET as TESTCUTS_BUCKET,
)
from control_panel.api.bitting_calibration import list_bitting_dates, list_bitting_images
from control_panel.api.bump_tower_calibration import (
    list_bump_tower_runs,
    list_bump_tower_images,
)
from control_panel.api.grip_calibration import list_grip_runs, list_grip_images
from control_panel.api.gripper_cam_calibration import (
    list_gripper_cam_runs,
    list_gripper_cam_images,
)
from control_panel.api.gripper_leds_check import (
    list_gripper_leds_runs,
    list_gripper_leds_images,
)
from control_panel.api.overhead_cam_calibration import (
    list_overhead_cam_runs,
    list_overhead_cam_images,
)
from control_panel.api.pickup_y_calibration import (
    list_pickup_y_runs,
    list_pickup_y_images,
)
from control_panel.api.calibration_trace import (
    list_trace_runs,
    get_trace,
    dewarp_image,
)


def create_blueprint(backend):
    """
    Create the shared API blueprint.
    backend must implement: ping() -> dict (for GET /api/ping).
    """
    api = Blueprint('api', __name__, url_prefix='/api')

    @api.route('/ping', methods=['GET'])
    def ping():
        data = backend.ping()
        return jsonify(data)

    @api.route('/calibration/testcuts/ids', methods=['GET'])
    def calibration_testcuts_ids():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            ids = list_testcut_ids(s3, TESTCUTS_BUCKET, host)
            return jsonify(ids)
        except Exception as e:
            _log.exception("Testcuts list IDs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/testcuts/images', methods=['GET'])
    def calibration_testcuts_images():
        kiosk = request.args.get('kiosk')
        id_param = request.args.get('id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if id_param is None or id_param == '':
            return jsonify({'error': 'Missing required query parameter: id'}), 400
        try:
            id_int = int(id_param)
        except ValueError:
            return jsonify({'error': 'Parameter id must be an integer'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_testcut_images(s3, TESTCUTS_BUCKET, host, id_int)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Testcuts list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/bitting_calibration/dates', methods=['GET'])
    def calibration_bitting_dates():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            dates = list_bitting_dates(s3, TESTCUTS_BUCKET, host)
            return jsonify(dates)
        except Exception as e:
            _log.exception("Bitting calibration list dates failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/bitting_calibration/images', methods=['GET'])
    def calibration_bitting_images():
        kiosk = request.args.get('kiosk')
        date_param = request.args.get('date')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not date_param or not date_param.strip():
            return jsonify({'error': 'Missing required query parameter: date'}), 400
        date = date_param.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_bitting_images(s3, TESTCUTS_BUCKET, host, date)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Bitting calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/bump_tower_calibration/runs', methods=['GET'])
    def calibration_bump_tower_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_bump_tower_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Bump tower calibration list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/bump_tower_calibration/images', methods=['GET'])
    def calibration_bump_tower_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_bump_tower_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Bump tower calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/grip_calibration/runs', methods=['GET'])
    def calibration_grip_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_grip_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Grip calibration list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/grip_calibration/images', methods=['GET'])
    def calibration_grip_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_grip_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Grip calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/gripper_cam_calibration/runs', methods=['GET'])
    def calibration_gripper_cam_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_gripper_cam_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Gripper cam calibration list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/gripper_cam_calibration/images', methods=['GET'])
    def calibration_gripper_cam_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_gripper_cam_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Gripper cam calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/gripper_leds_check/runs', methods=['GET'])
    def calibration_gripper_leds_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_gripper_leds_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Gripper LEDs check list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/gripper_leds_check/images', methods=['GET'])
    def calibration_gripper_leds_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_gripper_leds_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Gripper LEDs check list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/overhead_cam_calibration/runs', methods=['GET'])
    def calibration_overhead_cam_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_overhead_cam_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Overhead cam calibration list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/overhead_cam_calibration/images', methods=['GET'])
    def calibration_overhead_cam_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_overhead_cam_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Overhead cam calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/pickup_y_calibration/runs', methods=['GET'])
    def calibration_pickup_y_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_pickup_y_runs(s3, TESTCUTS_BUCKET, host)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Pickup Y calibration list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/pickup_y_calibration/images', methods=['GET'])
    def calibration_pickup_y_images():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        host = kiosk_to_hostname(kiosk)
        if not host:
            return jsonify({'error': 'Invalid kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            sections = list_pickup_y_images(s3, TESTCUTS_BUCKET, host, run_id)
            return jsonify(sections)
        except Exception as e:
            _log.exception("Pickup Y calibration list images failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/trace/gripper_cam/runs', methods=['GET'])
    def calibration_trace_gripper_cam_runs():
        kiosk = request.args.get('kiosk')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        try:
            s3 = boto3.client('s3')
            runs = list_trace_runs(s3, TESTCUTS_BUCKET, kiosk)
            return jsonify(runs)
        except Exception as e:
            _log.exception("Calibration trace list runs failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/trace/gripper_cam', methods=['GET'])
    def calibration_trace_gripper_cam():
        kiosk = request.args.get('kiosk')
        run_id = request.args.get('run_id')
        if not kiosk:
            return jsonify({'error': 'Missing required query parameter: kiosk'}), 400
        if not run_id or not run_id.strip():
            return jsonify({'error': 'Missing required query parameter: run_id'}), 400
        run_id = run_id.strip()
        try:
            s3 = boto3.client('s3')
            trace = get_trace(s3, TESTCUTS_BUCKET, kiosk, run_id)
            if trace is None:
                return jsonify({'error': 'Trace not found'}), 404
            return jsonify(trace)
        except Exception as e:
            _log.exception("Calibration trace get failed")
            return jsonify({'error': str(e)}), 503

    @api.route('/calibration/trace/gripper_cam/dewarp', methods=['POST'])
    def calibration_trace_gripper_cam_dewarp():
        data = request.get_json(silent=True) or {}
        image_url = data.get('image_url')
        homography = data.get('homography')
        if not image_url:
            return jsonify({'error': 'Missing image_url'}), 400
        if not homography:
            return jsonify({'error': 'Missing homography matrix'}), 400
        png_bytes, err = dewarp_image(image_url, homography)
        if err:
            return jsonify({'error': err}), 400
        return Response(png_bytes, mimetype='image/png')

    return api
