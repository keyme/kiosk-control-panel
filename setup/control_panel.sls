{% set allowed = salt['cp.get_file_str']('salt://allowed_ips.json') | load_json %}

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
    - name: /kiosk/control_panel/python/scripts/load_wss_api_key.py --require --no-jitter
    - runas: kiosk
    - cwd: /kiosk
