#!/usr/bin/env bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <hostname>"
  echo "Example: $0 ns3512.keymekiosk.com"
  exit 1
fi

HOST="$1"
DAYS=365
KEY_FILE="${HOST}.key"
CRT_FILE="${HOST}.crt"
TMP_CONF="$(mktemp)"

cat > "$TMP_CONF" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
C = US
ST = Pennsylvania
L = Pittsburgh
O = KeyMe
OU = Kiosk
CN = ${HOST}

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${HOST}
EOF

openssl req -x509 -nodes -days $DAYS \
  -newkey rsa:2048 \
  -keyout "$KEY_FILE" \
  -out "$CRT_FILE" \
  -config "$TMP_CONF"

rm "$TMP_CONF"

echo "✔ Certificate generated:"
echo "   Key:  $KEY_FILE"
echo "   Cert: $CRT_FILE"

