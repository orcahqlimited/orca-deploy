#!/usr/bin/env bash
# issue-licence.sh — issue an ORCA install licence for a customer.
#
# Only the Founder runs this. Produces a JWT the customer pastes into
# ORCA_LICENCE_KEY when they run the installer.
#
# Usage:
#   ./scripts/issue-licence.sh <customer-slug> <tenant-id> [tier] [connectors] [days]
#
# Example:
#   ./scripts/issue-licence.sh agilecadence \
#     27525d97-58a8-4d55-ba8c-696f769f97f6 \
#     lighthouse \
#     freeagent,ado,isms \
#     30
#
# Defaults:
#   tier:        lighthouse
#   connectors:  freeagent,freshworks,isms,ado,azure-security
#   days:        30
#
# Requires:
#   - az CLI logged in to ORCA HQ tenant
#   - Read access to kv-orcahq-uks for `license-service-jwt-key`

set -euo pipefail

LICENSE_SERVICE_URL="${LICENSE_SERVICE_URL:-https://orca-license-service.icyplant-8c8bf272.uksouth.azurecontainerapps.io}"
KV_NAME="${KV_NAME:-kv-orcahq-uks}"
KV_SECRET_NAME="${KV_SECRET_NAME:-license-service-jwt-key}"

if [ $# -lt 2 ]; then
  cat <<EOF >&2
Usage: $0 <customer-slug> <tenant-id> [tier] [connectors] [days]

Example:
  $0 agilecadence 27525d97-58a8-4d55-ba8c-696f769f97f6 lighthouse freeagent,ado,isms 30

Defaults: tier=lighthouse, connectors=freeagent,freshworks,isms,ado,azure-security, days=30
EOF
  exit 1
fi

CUSTOMER_SLUG="$1"
TENANT_ID="$2"
TIER="${3:-lighthouse}"
CONNECTORS_CSV="${4:-freeagent,freshworks,isms,ado,azure-security}"
DAYS="${5:-30}"

# Validate customer slug format
if [[ ! "$CUSTOMER_SLUG" =~ ^[a-z0-9]{3,10}$ ]]; then
  echo "ERROR: customer slug must be 3-10 lowercase alphanumeric characters. Got: '$CUSTOMER_SLUG'" >&2
  exit 1
fi

# Validate tenant id is a GUID
if [[ ! "$TENANT_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "ERROR: tenant id must be a GUID. Got: '$TENANT_ID'" >&2
  exit 1
fi

echo "  Customer slug : $CUSTOMER_SLUG"
echo "  Tenant ID     : $TENANT_ID"
echo "  Tier          : $TIER"
echo "  Connectors    : $CONNECTORS_CSV"
echo "  Valid for     : $DAYS days"
echo

# 1. Fetch admin JWT signing key from Key Vault (HS256, shared with the licence
#    service — used to sign admin tokens that authorise /api/license/issue).
echo "▸ Fetching admin signing key from Key Vault..."
ADMIN_SIGNING_KEY="$(az keyvault secret show \
  --vault-name "$KV_NAME" \
  --name "$KV_SECRET_NAME" \
  --query "value" -o tsv 2>/dev/null)"

if [ -z "$ADMIN_SIGNING_KEY" ]; then
  echo "ERROR: could not read $KV_SECRET_NAME from $KV_NAME — are you logged in with Key Vault Secrets User?" >&2
  exit 1
fi

# 2. Mint a short-lived admin JWT (HS256, role=ORCA.Founder, 5-minute expiry)
#    that authorises the /api/license/issue call.
NOW=$(date +%s)
EXP=$((NOW + 300))
ADMIN_TOKEN="$(python3 -c "
import hmac, hashlib, base64, json, sys
key = '$ADMIN_SIGNING_KEY'.encode()
header = base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT'}, separators=(',',':')).encode()).rstrip(b'=').decode()
payload = base64.urlsafe_b64encode(json.dumps({'role':'ORCA.Founder','iat':$NOW,'exp':$EXP}, separators=(',',':')).encode()).rstrip(b'=').decode()
sig = hmac.new(key, f'{header}.{payload}'.encode(), hashlib.sha256).digest()
sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b'=').decode()
print(f'{header}.{payload}.{sig_b64}')
")"

# 3. Build the connectors array payload
CONNECTORS_JSON="$(python3 -c "
import json, sys
print(json.dumps('$CONNECTORS_CSV'.split(',')))
")"

# 4. Call the licence service
echo "▸ Requesting licence from $LICENSE_SERVICE_URL..."
RESP=$(curl -fsSL -X POST "$LICENSE_SERVICE_URL/api/license/issue" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(cat <<JSON
{
  "customerTenantId": "$TENANT_ID",
  "customerId": "$CUSTOMER_SLUG",
  "tier": "$TIER",
  "connectors": $CONNECTORS_JSON,
  "gracePeriodDays": $DAYS
}
JSON
)")

# 5. Extract the master token
MASTER_TOKEN="$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('master', {}).get('token', ''))
")"

if [ -z "$MASTER_TOKEN" ]; then
  echo "ERROR: licence service returned no master token. Response:" >&2
  echo "$RESP" >&2
  exit 1
fi

EXPIRES_AT="$(echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('master', {}).get('expiresAt', '?'))
")"

echo
echo "═══ ORCA installer licence for $CUSTOMER_SLUG ═══"
echo
echo "Expires: $EXPIRES_AT"
echo
echo "Send the customer this command (single line):"
echo
echo "  docker run --rm -it \\"
echo "    -v ~/.azure:/root/.azure \\"
echo "    -e ORCA_LICENCE_KEY='$MASTER_TOKEN' \\"
echo "    ghcr.io/orcahqlimited/orca-installer:latest"
echo
echo "The licence itself (bare token) for your records:"
echo
echo "$MASTER_TOKEN"
echo
