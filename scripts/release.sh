#!/bin/bash
set -euo pipefail

# Build and upload a new release of the ORCA Deploy CLI.
# Usage: bash scripts/release.sh [version]
# Example: bash scripts/release.sh 0.2.0

VERSION="${1:-$(node -e "console.log(require('./package.json').version)")}"
ACCOUNT="orcahqblobsuks"
CONTAINER="releases"
BLOB="orca-deploy-v${VERSION}.tar.gz"

echo ""
echo "  ORCA Deploy — Release Builder"
echo "  ────────────────────────────────"
echo "  Version: ${VERSION}"
echo ""

# Build TypeScript
echo "  Building..."
npm run build

# Package
echo "  Packaging..."
rm -rf /tmp/orca-deploy-pkg
mkdir -p /tmp/orca-deploy-pkg/orca-deploy/dist
cp -r dist/* /tmp/orca-deploy-pkg/orca-deploy/dist/
cp package.json package-lock.json /tmp/orca-deploy-pkg/orca-deploy/
cd /tmp/orca-deploy-pkg
tar czf /tmp/${BLOB} orca-deploy/

SIZE=$(ls -lh /tmp/${BLOB} | awk '{print $5}')
echo "  Package: ${BLOB} (${SIZE})"

# Upload
echo "  Uploading to blob storage..."
az storage blob upload \
  --account-name "$ACCOUNT" \
  --container-name "$CONTAINER" \
  --name "$BLOB" \
  --file "/tmp/${BLOB}" \
  --auth-mode login \
  --overwrite \
  -o none

echo ""
echo "  ✓ Released v${VERSION}"
echo "  Blob: ${ACCOUNT}/${CONTAINER}/${BLOB}"
echo ""
echo "  Generate customer URL:"
echo "    bash scripts/generate-customer-url.sh [customer-name] [days]"
echo ""
