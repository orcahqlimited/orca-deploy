# ORCA installer — single-image customer installer.
#
# Runs the entire deploy CLI inside a hermetic container. Starting with
# v0.2.4 (INTENT-104 §104-O) the container owns its own Azure CLI session
# via a named Docker volume, so the customer never has to share their host
# `~/.azure` directory. First run into an empty volume runs
# `az login --use-device-code` inside the container; subsequent runs reuse
# the persisted token.
#
# Usage:
#   docker volume create orca-azure-session        # once, per workstation
#   docker run --rm -it \
#     -v orca-azure-session:/root/.azure \
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
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/azure-cli.list \
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

# PowerShell 7 + MicrosoftTeams module + sqlcmd (INTENT-ORCAHQ-104 §104-R + §104-A).
#
# pwsh is needed for grantApplicationAccessPolicy + the orca-estate-report
# script — the Teams CsApplicationAccessPolicy + Get-InstalledModule surfaces
# only exist in PowerShell. sqlcmd is needed so createSqlServer() can apply
# the PII vault DDL inline during deploy rather than deferring to a manual
# post-install step.
#
# We install the `packages-microsoft-prod` package rather than just dropping
# the .list file, because the .list from packages.microsoft.com is signed
# by a different GPG key than the azure-cli one (Microsoft reuses
# ARCHIVE-KEYING-KEY for the prod repo, not the azure-cli key). Installing
# the .deb handles the key + list in one shot and is the path Microsoft's
# docs recommend on Debian 12.
RUN curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
      -o /tmp/packages-microsoft-prod.deb \
  && dpkg -i /tmp/packages-microsoft-prod.deb \
  && rm -f /tmp/packages-microsoft-prod.deb \
  && apt-get update \
  && apt-get install -y --no-install-recommends powershell \
  && ACCEPT_EULA=Y apt-get install -y --no-install-recommends mssql-tools18 unixodbc-dev sqlcmd \
  && rm -rf /var/lib/apt/lists/* \
  && pwsh -NoProfile -Command "Set-PSRepository -Name PSGallery -InstallationPolicy Trusted; Install-Module -Name MicrosoftTeams -Scope AllUsers -Force"

# Installer sources. dist/ contains the compiled JS, type decls, and the
# licence public key (copied by the npm run build script). scripts/ carries
# the PowerShell estate-report + SQL DDL that the runtime reads on demand.
WORKDIR /orca
COPY package.json package-lock.json ./
RUN npm install --production --silent
COPY dist/ ./dist/
COPY scripts/ ./scripts/

# Smoke-test the installer loads (catches missing modules at build time).
RUN node -e "import('./dist/licence/verify.js').then(() => console.log('verify ok'))"

ENV NODE_ENV=production

# Container-owned Azure CLI session volume (INTENT-104 §104-O). Customers
# mount a named Docker volume at this path instead of the host `~/.azure`
# directory, avoiding the CL-0115/0116/0117 failure modes around Windows
# file sharing, stale host sessions, and multi-tenant host profiles. First
# run of the installer into an empty volume runs `az login --use-device-code`
# inline; subsequent runs reuse the persisted token.
#
#   docker volume create orca-azure-session   # once
#   docker run --rm -it -v orca-azure-session:/root/.azure ...
VOLUME ["/root/.azure"]

ENTRYPOINT ["node", "/orca/dist/index.js"]
