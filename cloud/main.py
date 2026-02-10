#!/usr/bin/env python3
"""
Cloud entrypoint: REST API + static JS serving. No Socket.IO.
Run with static root and port via env (see README).
"""
import os

from flask import Flask, request, send_from_directory
from flask_cors import CORS

from control_panel.cloud import create_blueprint
from control_panel.cloud.backends import CloudBackend

app = Flask(__name__)
CORS(app)
app.config['CORS_HEADERS'] = 'Content-Type'

app.register_blueprint(create_blueprint(CloudBackend()))

# Static root: env CONTROL_PANEL_STATIC_ROOT or default cloud/web/dist (resolved absolute)
_default_static = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web', 'dist')
_STATIC_ROOT = os.path.abspath(os.environ.get('CONTROL_PANEL_STATIC_ROOT', _default_static))


def _send_index_html():
    resp = send_from_directory(_STATIC_ROOT, 'index.html')
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    resp.headers['Pragma'] = 'no-cache'
    resp.headers['Expires'] = '0'
    return resp


@app.route('/')
def root():
    if os.path.isfile(os.path.join(_STATIC_ROOT, 'index.html')):
        return _send_index_html()
    return 'Control panel UI not built. Set CONTROL_PANEL_STATIC_ROOT or run npm run build in control_panel/cloud/web.', 404


@app.route('/assets/<path:path>')
def static_asset(path):
    resp = send_from_directory(os.path.join(_STATIC_ROOT, 'assets'), path)
    resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return resp


@app.errorhandler(404)
def spa_fallback(error):
    """SPA fallback: non-API paths serve index.html."""
    if request.path.startswith('/api'):
        return error
    if os.path.isfile(os.path.join(_STATIC_ROOT, 'index.html')):
        return _send_index_html()
    return error


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    app.run(host='0.0.0.0', port=port)
