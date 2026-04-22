# ORCA installer — single-image customer installer.
#
# Runs the entire deploy CLI inside a hermetic container. Customer mounts
# their Azure CLI session (~/.azure) so the installer inherits their auth.
#
# Usage:
#   docker run --rm -it \
#     -v ~/.azure:/root/.azure \
#     -e ORCA_LICENCE_KEY=<your licence> \
#     ghcr.io/orcahqlimited/orca-installer:latest
#
# Base: node:20-bookworm-slim (Debian 12). We add az CLI via Microsoft's
# Debian apt repo, then kubectl + helm. Using a Node-first base avoids the
# non-Debian azure-cli base image which NodeSource doesn't support.

FROM node:20-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/orcahqlimited/orca-deploy"
LABEL org.opencontainers.image.description="ORCA platform installer — one-command customer install"
LABEL org.opencontainers.image.licenses="Proprietary"

SHELL ["/bin/bash", "-eo", "pipefail", "-c"]

# Core OS deps + az CLI from Microsoft's Debian apt repo
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    lsb-release \
    apt-transport-https \
    git \
    jq \
    openssh-client \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
  && AZ_DIST="$(lsb_release -cs)" \
  && echo "Types: deb\nURIs: https://packages.microsoft.com/repos/azure-cli/\nSuites: ${AZ_DIST}\nComponents: main\nArchitectures: $(dpkg --print-architecture)\nSigned-by: /etc/apt/keyrings/microsoft.gpg" \
    > /etc/apt/sources.list.d/azure-cli.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends azure-cli \
  && rm -rf /var/lib/apt/lists/*

# kubectl — use az to get a version-matched binary into /usr/local/bin
RUN az aks install-cli 2>&1 | tail -3

# helm — official installer
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o /tmp/get-helm-3.sh \
  && chmod +x /tmp/get-helm-3.sh \
  && /tmp/get-helm-3.sh \
  && rm -f /tmp/get-helm-3.sh

# Installer sources. dist/ contains the compiled JS, type decls, and the
# licence public key (copied by the npm run build script).
WORKDIR /orca
COPY package.json package-lock.json ./
RUN npm install --production --silent
COPY dist/ ./dist/

# Smoke-test the installer loads (catches missing modules at build time).
RUN node -e "import('./dist/licence/verify.js').then(() => console.log('verify ok'))"

ENV NODE_ENV=production

ENTRYPOINT ["node", "/orca/dist/index.js"]
