{% set allowed = salt['cp.get_file_str']('salt://allowed_ips.json') | load_json %}
{% if pillar.get('python_version', '') == '3.9' %}
{% set systemd_file_source = 'salt://control_panel-venv.systemd' %}
{% else %}
{% set systemd_file_source = 'salt://control_panel.systemd' %}
{% endif %}

# Flush and recreate the CONTROL_PANEL chain for idempotency
control-panel-iptables:
  cmd.run:
    - name: |
        iptables -D INPUT -p tcp --dport 2026 -j CONTROL_PANEL 2>/dev/null || true
        iptables -D INPUT -p udp --dport 2026 -j CONTROL_PANEL 2>/dev/null || true
        iptables -F CONTROL_PANEL 2>/dev/null || true
        iptables -X CONTROL_PANEL 2>/dev/null || true
        iptables -N CONTROL_PANEL
{%- for ip in allowed.ips %}
        iptables -A CONTROL_PANEL -s {{ ip }} -j ACCEPT
{%- endfor %}
        iptables -A CONTROL_PANEL -s 127.0.0.1 -j ACCEPT
        iptables -A CONTROL_PANEL -j DROP
        iptables -I INPUT -p tcp --dport 2026 -j CONTROL_PANEL
        iptables -I INPUT -p udp --dport 2026 -j CONTROL_PANEL

control-panel-iptables-save:
  cmd.run:
    - name: iptables-save > /etc/iptables/rules.v4 || iptables-save > /etc/iptables.rules
    - require:
      - cmd: control-panel-iptables

# Preload the control panel WSS API key into the kiosk user's keyring so the
# WebSocket server can authenticate immediately on startup.
control-panel-wss-api-key-keyring:
  cmd.run:
    - name: PYTHONPATH=/kiosk /usr/bin/env python3 /kiosk/control_panel/python/scripts/load_wss_api_key.py --require --no-jitter
    - runas: kiosk
    - cwd: /kiosk

# Ensure device WSS certs exist and upload public cert to S3.
control-panel-wss-device-certs:
  cmd.run:
    - name: /kiosk/control_panel/python/scripts/create_wss_cert_and_upload.py
    - runas: kiosk
    - cwd: /kiosk

control-panel-service:
  file.managed:
    - source: {{ systemd_file_source }}
    - name: /etc/systemd/system/keyme-control-panel.service
  module.wait:
    - name: service.systemctl_reload
    - watch:
      - file: control-panel-service
  service.enabled:
    - name: keyme-control-panel
    - require:
      - file: control-panel-service
      - cmd: control-panel-wss-api-key-keyring
      - cmd: control-panel-wss-device-certs

# Start the service after enable so it runs immediately (enable only sets boot behavior).
start-control-panel-service:
  cmd.run:
    - name: systemctl start keyme-control-panel.service
    - require:
      - service: control-panel-service

# Daily restart at 3 AM to free up any memory leaks. Just a preventative measure.
daily-restart-control-panel-service:
  cron.present:
    - name: 'systemctl restart keyme-control-panel.service'
    - user: root
    - minute: 0
    - hour: 3
    - require:
      - service: control-panel-service
