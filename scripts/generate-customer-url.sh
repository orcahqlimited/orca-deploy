#!/bin/bash
set -euo pipefail

# Generate a time-limited SAS URL for a customer to download the ORCA Deploy CLI.
# Usage: bash scripts/generate-customer-url.sh [customer-name] [days-valid]
#
# The URL is sent to the customer. They run it in Azure Cloud Shell:
#   curl -o orca.tar.gz "THE_URL"
#   tar xzf orca.tar.gz && cd orca-deploy && npm install --production && node dist/index.js

CUSTOMER="${1:-customer}"
DAYS="${2:-7}"
VERSION="0.2.0"
ACCOUNT="orcahqblobsuks"
CONTAINER="releases"
BLOB="orca-deploy-v${VERSION}.tar.gz"

echo ""
echo "  ORCA Deploy — Customer URL Generator"
echo "  ────────────────────────────────────"
echo "  Customer:  ${CUSTOMER}"
echo "  Version:   ${VERSION}"
echo "  Valid for: ${DAYS} days"
echo ""

# Calculate expiry date
EXPIRY=$(date -u -v+${DAYS}d '+%Y-%m-%dT%H:%MZ' 2>/dev/null || date -u -d "+${DAYS} days" '+%Y-%m-%dT%H:%MZ')

# Get account key and generate SAS URL
KEY=$(az storage account keys list --account-name "$ACCOUNT" --query "[0].value" -o tsv)

SAS_URL=$(az storage blob generate-sas \
  --account-name "$ACCOUNT" \
  --account-key "$KEY" \
  --container-name "$CONTAINER" \
  --name "$BLOB" \
  --permissions r \
  --expiry "$EXPIRY" \
  --full-uri \
  -o tsv)

echo "  ────────────────────────────────────"
echo "  Send the following to ${CUSTOMER}:"
echo "  ────────────────────────────────────"
echo ""
echo "  1. Open Azure Cloud Shell: https://shell.azure.com"
echo "  2. Run:"
echo ""
echo "     curl -o orca.tar.gz \"${SAS_URL}\""
echo "     tar xzf orca.tar.gz && cd orca-deploy && npm install --production && node dist/index.js"
echo ""
echo "  ────────────────────────────────────"
echo "  URL expires: ${EXPIRY}"
echo "  ────────────────────────────────────"
echo ""
