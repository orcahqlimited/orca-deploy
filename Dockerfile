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

FROM mcr.microsoft.com/azure-cli:2.84.0

LABEL org.opencontainers.image.source="https://github.com/orcahqlimited/orca-deploy"
LABEL org.opencontainers.image.description="ORCA platform installer — one-command customer install"
LABEL org.opencontainers.image.licenses="Proprietary"

# Install Node.js 20 (NodeSource apt repo) and build basics
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends \
    nodejs \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# kubectl — version bundled with az CLI. az aks install-cli drops the binary
# into /usr/local/bin.
RUN az aks install-cli 2>&1 | tail -3

# helm — official installer script
RUN curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o /tmp/get-helm-3.sh \
  && chmod +x /tmp/get-helm-3.sh \
  && /tmp/get-helm-3.sh \
  && rm -f /tmp/get-helm-3.sh

# Copy installer sources
WORKDIR /orca
COPY package.json package-lock.json ./
RUN npm install --production --silent
COPY dist/ ./dist/
# The PEM is copied into dist/licence/ by the build script, but belt-and-braces
# for Docker builds that COPY the pre-built dist without running npm run build.
COPY src/licence/orca-hq-licence.pub.pem ./dist/licence/

# Smoke-test the installer loads (catches missing modules before a customer
# pulls the image, at build time not runtime).
RUN node -e "import('./dist/licence/verify.js').then(() => console.log('verify ok'))"

# Default envs — customer overrides these at docker run.
ENV NODE_ENV=production

# The installer prompts interactively. docker run -it must be used.
ENTRYPOINT ["node", "/orca/dist/index.js"]
