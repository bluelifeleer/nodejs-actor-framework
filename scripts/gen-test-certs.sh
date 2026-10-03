#!/usr/bin/env bash
#
# Regenerate the THROWAWAY test certificates under test/fixtures/tls/.
#
# These keys are committed on purpose so the test suite can exercise mutual TLS
# without a network fetch. They are self-signed test material: never use them
# outside the test suite.
#
#   ./scripts/gen-test-certs.sh
#
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/test/fixtures/tls"
mkdir -p "$OUT"
cd "$OUT"

DAYS=3650

# --- two certificate authorities: one trusted, one for the "rogue" cases -----
for ca in ca rogue-ca; do
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -keyout "$ca.key" -out "$ca.crt" \
    -subj "/CN=actor-framework-test-$ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
done

# --- leaf certificates -------------------------------------------------------
# CN must equal the node id, because TLS_VERIFY_NODE_ID binds nodeId to the CN.
make_leaf() {
  local name="$1" ca="$2"
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -keyout "$name.key" -out "$name.csr" -subj "/CN=$name" >/dev/null 2>&1

  cat > "$name.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,DNS:$name,IP:127.0.0.1,IP:::1
EXT

  openssl x509 -req -in "$name.csr" -CA "$ca.crt" -CAkey "$ca.key" -CAcreateserial \
    -out "$name.crt" -days "$DAYS" -sha256 -extfile "$name.ext" >/dev/null 2>&1
  rm -f "$name.csr" "$name.ext"
}

make_leaf node-1 ca
make_leaf node-2 ca
make_leaf imposter rogue-ca   # signed by the wrong CA: must be rejected

rm -f ./*.srl
chmod 600 ./*.key
echo "wrote test certificates to $OUT"
ls -1 "$OUT"
