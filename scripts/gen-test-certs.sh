#!/usr/bin/env bash
#
# Regenerate the THROWAWAY test certificates under packages/core/test/fixtures/tls/.
#
# These keys are committed on purpose so the test suite can exercise mutual TLS,
# multi-CA trust and CRL revocation without a network fetch. They are
# self-signed test material: never use them outside the test suite.
#
# Produces:
#   ca.crt / ca.key            trusted CA (with a database so it can issue a CRL)
#   ca.crl                     CRL that revokes `revoked.crt`
#   ca2.crt / ca2.key          second trusted CA, for multi-CA trust tests
#   node-1, node-2             leaves signed by ca      (CN == node id)
#   ca2-node                   leaf signed by ca2
#   revoked                    leaf signed by ca, then revoked in ca.crl
#   rogue-ca, imposter         untrusted pair, for negative tests
#
#   ./scripts/gen-test-certs.sh
#
set -euo pipefail

OUT="$(cd "$(dirname "$0")/.." && pwd)/packages/core/test/fixtures/tls"
rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

DAYS=3650

# --- one self-signed CA per trust domain ------------------------------------
make_ca() {
  local name="$1"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -keyout "$name.key" -out "$name.crt" \
    -subj "/CN=actor-framework-test-$name" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
}

# --- an openssl CA config, so leaves can later be revoked -------------------
write_ca_config() {
  local name="$1"
  mkdir -p "$name-db/newcerts"
  : > "$name-db/index.txt"
  echo 1000 > "$name-db/serial"
  echo 1000 > "$name-db/crlnumber"
  cat > "$name.cnf" <<CFG
[ ca ]
default_ca = CA_default
[ CA_default ]
dir               = $OUT
database          = $OUT/$name-db/index.txt
new_certs_dir     = $OUT/$name-db/newcerts
certificate       = $OUT/$name.crt
private_key       = $OUT/$name.key
serial            = $OUT/$name-db/serial
crlnumber         = $OUT/$name-db/crlnumber
default_md        = sha256
default_days      = $DAYS
default_crl_days  = $DAYS
policy            = policy_any
x509_extensions   = leaf_ext
copy_extensions   = none
unique_subject    = no
[ policy_any ]
commonName        = supplied
[ leaf_ext ]
basicConstraints  = critical,CA:FALSE
keyUsage          = critical,digitalSignature,keyEncipherment
extendedKeyUsage  = serverAuth,clientAuth
subjectAltName    = DNS:localhost,IP:127.0.0.1,IP:::1
[ crl_ext ]
authorityKeyIdentifier = keyid:always
CFG
}

sign_leaf() {
  local name="$1" ca="$2"
  openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" -subj "/CN=$name" >/dev/null 2>&1
  openssl ca -batch -config "$ca.cnf" -in "$name.csr" -out "$name.crt" -notext >/dev/null 2>&1
  rm -f "$name.csr"
}

# --- trusted CA + leaves ----------------------------------------------------
make_ca ca
write_ca_config ca
sign_leaf node-1 ca
sign_leaf node-2 ca
sign_leaf revoked ca

# Revoke one leaf and publish the CRL.
openssl ca -batch -config ca.cnf -revoke revoked.crt >/dev/null 2>&1
openssl ca -batch -config ca.cnf -gencrl -out ca.crl >/dev/null 2>&1

# --- second trusted CA (multi-CA trust tests) -------------------------------
make_ca ca2
write_ca_config ca2
sign_leaf ca2-node ca2

# --- untrusted pair (negative tests) ----------------------------------------
make_ca rogue-ca
openssl req -newkey rsa:2048 -nodes -keyout imposter.key -out imposter.csr -subj "/CN=imposter" >/dev/null 2>&1
cat > imposter.ext <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in imposter.csr -CA rogue-ca.crt -CAkey rogue-ca.key -CAcreateserial \
  -out imposter.crt -days "$DAYS" -sha256 -extfile imposter.ext >/dev/null 2>&1
rm -f imposter.csr imposter.ext ./*.srl

chmod 600 ./*.key
echo "wrote test certificates to $OUT"
echo "--- sanity ---"
openssl verify -CAfile ca.crt node-1.crt node-2.crt
openssl verify -CAfile ca2.crt ca2-node.crt
echo -n "revoked.crt against ca.crl: "
if openssl verify -CAfile ca.crt -CRLfile ca.crl -crl_check revoked.crt >/dev/null 2>&1; then
  echo "ACCEPTED (unexpected!)"
  exit 1
else
  echo "REJECTED as expected"
fi
